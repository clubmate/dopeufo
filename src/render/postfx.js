import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'

/**
 * Post stack.
 *
 *   RenderPass    scene -> HDR half-float buffer (no tonemapping yet)
 *   GTAOPass      ground-truth ambient occlusion at HALF resolution, reading
 *                 the beauty pass's own depth rather than re-rendering the
 *                 scene, blended SUBTLY. AO's job is to seat objects on the
 *                 ground and darken tight creases, not to paint grey halos
 *                 around everything. blendIntensity is well under 1.
 *   UnrealBloom   half-res input, high threshold, low strength. Only the sun
 *                 disc, hot speculars and muzzle flashes should ever bloom.
 *   OutputPass    tonemap (AgX) + sRGB. Everything after this is
 *                 display-referred.
 *   SMAAPass      geometric AA (the renderer is created with antialias:false
 *                 because MSAA cannot work through a composer).
 *   GradePass     lift/gamma/gain + saturation + filmic S-curve, then a cool
 *                 shadow bleed and a matte print floor, then vignette,
 *                 edge-only chromatic aberration and a fine film grain.
 *
 * Measured cost at 1920x1080 on an M-series Mac (toggling one pass at a time,
 * median of 70 GPU-flushed frames). Total frame 23.7 ms / 42 fps, down from
 * 33.5 ms / 30 fps:
 *
 *   scene render (RenderPass + OutputPass)   19.7 ms
 *   shadow map (4096, whole board)            1.3 ms
 *   ---- everything below is this file ----   2.7 ms total
 *   GTAO (half res, shared depth)            ~0.3 ms
 *   UnrealBloom (quarter-res mips)           ~0.6 ms
 *   SMAA                                     ~0.4 ms
 *   GradePass                                ~0.3 ms
 *
 * The individual post passes are now inside measurement noise of each other;
 * the frame is dominated by the scene render, which is world/ and units/
 * territory (2 M tris). There is nothing left in this file worth cutting — the
 * next 60 fps has to come from geometry or draw calls.
 *
 * Quality gating:
 *   low     -> no composer at all; the engine renders direct.
 *   medium  -> bloom + output + FXAA + grade (no AO, no SMAA)
 *   high    -> + GTAO (6 samples) + SMAA
 *   ultra   -> + GTAO (8 samples)
 */

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVignette: { value: 0.24 },
    uVignetteSoft: { value: 0.70 },
    uGrain: { value: 0.022 },
    // UV offset at the extreme corner works out around 2 px at 1600 wide.
    uChroma: { value: 0.0075 },
    uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
    uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    // Near-neutral. The warmth in this game comes from the sun and the sky,
    // where it belongs; a warm gain here just re-tints the shadows too.
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.985) },
    uSaturation: { value: 1.30 },
    // Two separate contrast controls, because they do different jobs.
    //
    // uContrast blends in a smoothstep S — a symmetric toe AND shoulder. It is
    // gentle now (it used to be 0.24, which was digging an extra hole under
    // everything already sitting in the toe of the tone curve).
    //
    // uContrastGain is a straight slope about a mid-grey pivot, and it is the
    // one that matters. AgX buys its highlight behaviour with a low midtone
    // slope, so a two-stop key-to-fill ratio in the scene arrives at the
    // display as a much smaller step and the battlefield reads flat. This puts
    // the stop back without touching the shoulder or the toe.
    uContrast: { value: 0.12 },
    uContrastGain: { value: 1.30 },
    uPivot: { value: 0.42 },
    // Cool light bleeding into the shadow side. Weighted to the darkest values
    // only (see uShadowRange) so it never fogs the midtones.
    uShadowTint: { value: new THREE.Vector3(0.004, 0.013, 0.036) },
    uShadowRange: { value: 0.40 },
    // Matte print black. Guarantees nothing in the frame is ever a dead hole:
    // the floor is a cool dark slate at roughly sRGB 0.11-0.15, which is where
    // XCOM 2's shadow interiors actually sit.
    uFloor: { value: new THREE.Vector3(0.010, 0.014, 0.024) },
    uEnabled: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uVignette;
    uniform float uVignetteSoft;
    uniform float uGrain;
    uniform float uChroma;
    uniform vec3  uLift;
    uniform vec3  uGamma;
    uniform vec3  uGain;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uContrastGain;
    uniform float uPivot;
    uniform vec3  uShadowTint;
    uniform float uShadowRange;
    uniform vec3  uFloor;
    uniform float uEnabled;
    varying vec2 vUv;

    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // Lateral chromatic aberration: quartic falloff so the centre of frame —
      // where the player is actually reading the tactical situation — is
      // untouched and only the extreme corners fringe.
      float ca = uChroma * r2 * r2 * uEnabled;
      vec2 off = d * ca;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv - off).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv + off).b;

      if (uEnabled > 0.5) {
        // lift / gamma / gain
        c = c * uGain + uLift;
        c = max(c, vec3(0.0));
        c = pow(c, 1.0 / uGamma);

        // filmic S-curve (toe + shoulder), blended by contrast amount
        vec3 s = c * c * (3.0 - 2.0 * c);
        c = mix(c, s, uContrast);

        // straight slope about a mid-grey pivot — the actual "how keyed does
        // this map look" control (see uContrastGain)
        c = max(vec3(0.0), (c - uPivot) * uContrastGain + uPivot);

        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSaturation);

        // Cool shadow bleed, then a matte print floor. Together these are what
        // keep the dark half of the frame legible: the tint puts sky colour
        // into the shadow side (so it reads as shadow, not as absence), and
        // the floor compresses the bottom of the range into a slate rather
        // than letting it run all the way to zero.
        c += uShadowTint * (1.0 - smoothstep(0.0, uShadowRange, l));
        c = uFloor + c * (1.0 - uFloor);

        // vignette, in aspect-corrected space so it stays circular
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        float rr = length(d * vec2(aspect, 1.0)) / 0.72;
        float v = 1.0 - uVignette * smoothstep(uVignetteSoft, 1.35, rr);
        c *= v;

        // fine film grain, weighted toward the shadows like real stock
        float g = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 917.0)) - 0.5;
        c += g * uGrain * (1.0 - l * 0.72);
      }

      gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    }`,
}

/**
 * Tone curve.
 *
 * three's ACESFilmicToneMapping is the Narkowicz/Hill fit, and its highlight
 * shoulder is notoriously hue-skewed: as a warm light overdrives a channel the
 * remaining channels roll off faster, so a bright surface under a golden key
 * does not go toward white, it goes toward *orange*, and every material under
 * the key converges on the same rust. That is the single biggest reason lit
 * ground here stopped reading as ground.
 *
 * AgX has a per-channel-decorrelated shoulder that desaturates as it clips, so
 * a hot warm surface bleaches toward white and its albedo stays distinguishable
 * a good two stops further up. It also has a longer, gentler toe, which is what
 * keeps shadow detail alive. Override with ?tonemap=aces|agx|neutral|cineon.
 */
const TONEMAPS = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  cineon: THREE.CineonToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear: THREE.LinearToneMapping,
  none: THREE.NoToneMapping,
}
const DEFAULT_TONEMAP = 'agx'

export function createPostFX(ctx) {
  const { renderer, scene, camera, quality } = ctx

  const tmName = new URLSearchParams(location.search).get('tonemap')
  renderer.toneMapping = TONEMAPS[tmName] ?? TONEMAPS[DEFAULT_TONEMAP]

  if (quality === 'low') {
    return {
      composer: null,
      enabled: false,
      passes: {},
      params: {},
      setEnabled() {},
      setSize() {},
      dispose() {},
    }
  }

  const useAO = quality === 'ultra' || quality === 'high'
  const useSMAA = quality === 'ultra' || quality === 'high'

  const size = renderer.getSize(new THREE.Vector2())

  const composer = new EffectComposer(renderer)
  composer.setSize(size.x, size.y)
  // Size everything off the composer's own target, not off renderer.getSize()
  // times the pixel ratio. EffectComposer applies the pixel ratio itself, and
  // engine.js hands it CSS pixels — doing that multiply here as well silently
  // squares it on a retina display and every downstream pass allocates 4x too
  // much.
  const bufW = composer.renderTarget1.width
  const bufH = composer.renderTarget1.height

  // AO and bloom are both low-frequency by nature; neither needs native
  // resolution, and at 1920x1080 they were the two most expensive things in
  // the stack. Half res for both — and note UnrealBloom already starts at half
  // of whatever it is handed, so this puts its first mip at quarter res, a 4x
  // fill saving across all five levels.
  const AO_SCALE = 0.5
  const BLOOM_SCALE = 0.5
  const scaled = (w, h, s) => [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))]
  const [aoW, aoH] = scaled(bufW, bufH, AO_SCALE)

  const passes = {}
  const order = []
  /** @type {THREE.DepthTexture|null} depth shared from the beauty pass into GTAO */
  let aoSharedDepth = null
  /** @type {THREE.DepthTexture[]|null} depth attached to [renderTarget1, renderTarget2] */
  let aoDepthPair = null

  passes.render = new RenderPass(scene, camera)
  order.push('render')

  if (useAO) {
    const ao = new GTAOPass(scene, camera, aoW, aoH)
    ao.output = GTAOPass.OUTPUT.Default
    // Radius is in world units, and GTAOPass multiplies the WHOLE beauty by the
    // AO term, not just the indirect part. At the old radius 2.2 m / scale 1.35
    // / blend 0.9 it was a full-frame darkening pass: every crate threw a metre
    // of grey over the ground and the shadow side lost what little range it had.
    // 0.9 m keeps occlusion in the creases where cover props meet the ground.
    ao.updateGtaoMaterial({
      radius: 0.9,
      distanceExponent: 1.0,
      thickness: 0.6,
      distanceFallOff: 1.0,
      scale: 1.0,
      samples: quality === 'ultra' ? 8 : 6,
      screenSpaceRadius: false,
    })
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 3, radiusExponent: 1, rings: 2, samples: 4 })
    ao.blendIntensity = 0.5

    // By default GTAOPass builds its own G-buffer, which means a SECOND full
    // render of the scene every frame with an override material — at 2 M tris
    // that was ~6 ms and by far the most expensive thing in the stack, all of
    // it to recover depth the beauty pass already computed. So we hand GTAO the
    // beauty pass's own depth instead. With no normal texture supplied GTAO
    // reconstructs normals from depth, which at a 0.9 m radius is fine.
    //
    // WHICH TARGET holds that depth is the whole ballgame, and an earlier
    // version got it exactly backwards — it attached to renderTarget1 on the
    // reasoning that "RenderPass always writes there". It does not:
    //   EffectComposer starts with writeBuffer = rt1, readBuffer = rt2
    //   RenderPass renders into readBuffer  (RenderPass.js: setRenderTarget(readBuffer))
    // so the scene lands in rt2. needsSwap = false doesn't pin it to rt1, it
    // pins it to rt2. Swap parity over the frame is even, so rt1 is NEVER the
    // read buffer — the attached depth only ever held the clear value 1.0, the
    // GTAO shader's `if (depth >= 1.0) discard` rejected every fragment, the AO
    // target stayed pure white and the multiply blend scaled the beauty by
    // exactly 1.0. Mathematically zero AO on every frame, while looking
    // perfectly configured from the outside.
    //
    // Attaching to both targets and repointing at composer.readBuffer each
    // frame keeps this correct even if pass order (and thus swap parity)
    // changes later.
    //
    // setGBuffer() is called once by the constructor with no arguments, so
    // normalRenderTarget already exists by the time we call it again — which is
    // what keeps this off the crash path inside setGBuffer/dispose.
    try {
      const mkDepth = () => {
        const d = new THREE.DepthTexture(bufW, bufH)
        d.format = THREE.DepthFormat
        d.type = THREE.UnsignedIntType
        d.minFilter = THREE.NearestFilter
        d.magFilter = THREE.NearestFilter
        return d
      }
      const depth1 = mkDepth()
      const depth2 = mkDepth()
      composer.renderTarget1.depthTexture = depth1
      composer.renderTarget2.depthTexture = depth2
      // rt2 is the read buffer at the time GTAO runs, so start pointed there.
      ao.setGBuffer(depth2)
      aoSharedDepth = depth2
      aoDepthPair = [depth1, depth2]
    } catch (err) {
      console.warn('[render/postfx] depth sharing for GTAO failed — using its own G-buffer', err)
    }

    passes.ao = ao
    order.push('ao')
  }

  // Bloom sits BEFORE the tonemapper, so its threshold is in scene-referred
  // linear light. 0.86 meant every sunlit road surface bloomed; at a 5.6 key
  // that is most of the frame, and it is half of why lit areas looked like they
  // were melting. 1.35 restricts it to the sun disc, hot speculars and muzzle
  // flashes — things that genuinely overshoot white.
  passes.bloom = new UnrealBloomPass(new THREE.Vector2(...scaled(bufW, bufH, BLOOM_SCALE)), 0.18, 0.7, 1.35)
  order.push('bloom')

  passes.output = new OutputPass()
  order.push('output')

  if (useSMAA) {
    passes.smaa = new SMAAPass(bufW, bufH)
    order.push('smaa')
  } else {
    passes.fxaa = new ShaderPass(FXAAShader)
    passes.fxaa.material.uniforms.resolution.value.set(1 / bufW, 1 / bufH)
    order.push('fxaa')
  }

  passes.grade = new ShaderPass(GradeShader)
  passes.grade.material.uniforms.uResolution.value.set(bufW, bufH)
  passes.grade.renderToScreen = true
  order.push('grade')

  for (const k of order) composer.addPass(passes[k])

  // EffectComposer.addPass() and setSize() both fan out to every pass at FULL
  // resolution, so the half-res passes have to be put back afterwards — at boot
  // as well as on every resize, or they quietly run at 1:1 and the saving
  // evaporates.
  function applyPassScales() {
    const w = composer.renderTarget1.width
    const h = composer.renderTarget1.height
    passes.grade.material.uniforms.uResolution.value.set(w, h)
    passes.fxaa?.material.uniforms.resolution.value.set(1 / w, 1 / h)
    passes.ao?.setSize(...scaled(w, h, AO_SCALE))
    passes.bloom?.setSize(...scaled(w, h, BLOOM_SCALE))
  }
  applyPassScales()

  // --- live tuning surface -------------------------------------------------
  const g = passes.grade.material.uniforms
  const params = {
    bloom: {
      get strength() {
        return passes.bloom.strength
      },
      set strength(v) {
        passes.bloom.strength = v
      },
      get radius() {
        return passes.bloom.radius
      },
      set radius(v) {
        passes.bloom.radius = v
      },
      get threshold() {
        return passes.bloom.threshold
      },
      set threshold(v) {
        passes.bloom.threshold = v
      },
    },
    ao: {
      get intensity() {
        return passes.ao?.blendIntensity ?? 0
      },
      set intensity(v) {
        if (passes.ao) passes.ao.blendIntensity = v
      },
      set radius(v) {
        passes.ao?.updateGtaoMaterial({ radius: v })
      },
      set samples(v) {
        passes.ao?.updateGtaoMaterial({ samples: v })
      },
      set output(v) {
        if (passes.ao) passes.ao.output = v
      },
    },
    grade: {
      get vignette() {
        return g.uVignette.value
      },
      set vignette(v) {
        g.uVignette.value = v
      },
      get grain() {
        return g.uGrain.value
      },
      set grain(v) {
        g.uGrain.value = v
      },
      get chroma() {
        return g.uChroma.value
      },
      set chroma(v) {
        g.uChroma.value = v
      },
      get saturation() {
        return g.uSaturation.value
      },
      set saturation(v) {
        g.uSaturation.value = v
      },
      get contrast() {
        return g.uContrast.value
      },
      set contrast(v) {
        g.uContrast.value = v
      },
      get contrastGain() {
        return g.uContrastGain.value
      },
      set contrastGain(v) {
        g.uContrastGain.value = v
      },
      get pivot() {
        return g.uPivot.value
      },
      set pivot(v) {
        g.uPivot.value = v
      },
      lift: g.uLift.value,
      gamma: g.uGamma.value,
      gain: g.uGain.value,
      shadowTint: g.uShadowTint.value,
      floor: g.uFloor.value,
      get shadowRange() {
        return g.uShadowRange.value
      },
      set shadowRange(v) {
        g.uShadowRange.value = v
      },
    },
    get toneMapping() {
      return renderer.toneMapping
    },
    set toneMapping(v) {
      renderer.toneMapping = typeof v === 'string' ? (TONEMAPS[v] ?? renderer.toneMapping) : v
    },
    get exposure() {
      return renderer.toneMappingExposure
    },
    set exposure(v) {
      renderer.toneMappingExposure = v
    },
  }

  function setEnabled(name, on) {
    const p = passes[name]
    if (!p) return false
    p.enabled = !!on
    return true
  }

  const stopUpdate = ctx.onUpdate((dt) => {
    g.uTime.value += dt

    // Point GTAO at whichever composer target actually holds this frame's scene
    // depth. Engine updaters run before composer.render(), and RenderPass draws
    // into readBuffer without swapping, so readBuffer here is the buffer GTAO
    // will be sampling. Doing this every frame rather than once at setup means
    // reordering the pass chain can't silently zero out AO again.
    const ao = passes.ao
    if (ao?.enabled && aoDepthPair) {
      const live = composer.readBuffer?.depthTexture
      if (live && live !== aoSharedDepth) {
        aoSharedDepth = live
        if (ao.gtaoMaterial?.uniforms?.tDepth) ao.gtaoMaterial.uniforms.tDepth.value = live
        if (ao.pdMaterial?.uniforms?.tDepth) ao.pdMaterial.uniforms.tDepth.value = live
        if (ao.normalMaterial?.uniforms?.tDepth) ao.normalMaterial.uniforms.tDepth.value = live
      }
    }
  })

  const onResize = applyPassScales
  ctx.bus.on('engine:resize', onResize)

  return {
    composer,
    enabled: true,
    passes,
    order,
    params,
    setEnabled,
    isEnabled: (name) => !!passes[name]?.enabled,
    setSize(w, h) {
      composer.setSize(w, h)
      onResize()
    },
    dispose() {
      stopUpdate()
      ctx.bus.off('engine:resize', onResize)
      for (const k of order) passes[k].dispose?.()
      for (const d of aoDepthPair || []) d?.dispose()
      composer.renderTarget1.dispose()
      composer.renderTarget2.dispose()
    },
  }
}
