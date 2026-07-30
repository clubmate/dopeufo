import * as THREE from 'three'

/**
 * Tactical ground overlay: move-range field, path ribbon, hover reticle,
 * destination marker with cover pips, and enemy target reticles.
 *
 * The range field is two instanced draw calls over one shared instance buffer:
 *
 *   1. FILL — a *multiply tint*, not a painted quad. CustomBlending is set up as
 *      `src = DST_COLOR`, `dst = ONE_MINUS_SRC_ALPHA`, which resolves to
 *          out = dst * (srcRGB + 1 - srcA)
 *      and, writing `srcRGB = tint * k`, `srcA = k`, becomes exactly
 *          out = dst * mix(vec3(1.0), tint, k)
 *      i.e. a photographic colour filter laid *under* the art. Every bit of
 *      asphalt grain, every decal and kerb survives, because the ground is
 *      scaled per-channel rather than blended toward a flat colour.
 *
 *   2. EDGE — a thin, low-contrast additive line on the OUTER boundary of each
 *      tier only (plus a barely-there lift so the tier still reads in shadow,
 *      where a pure multiply has nothing to bite on). No internal lattice: grid
 *      lines on every tile are what makes an overlay read as a debug view.
 *
 * Depth: transparent, depthWrite off, polygonOffset so it projects onto terrain
 * like a decal instead of z-fighting with it.
 */

const TYPE = { BLUE: 0, DASH: 1, DANGER: 2 }

// ---------------------------------------------------------------- shader src

const TILE_VERT = /* glsl */ `
attribute float aType;
attribute float aBorder;
attribute float aDelay;
attribute float aDist;

uniform float uReveal;
uniform float uTile;

varying vec2  vUv;
varying vec2  vWorld;
varying float vType;
varying float vBorder;
varying float vReveal;
varying float vDist;

void main() {
  vUv    = vec2(position.x / uTile + 0.5, position.z / uTile + 0.5);
  vType  = aType;
  vBorder = aBorder;
  vDist  = aDist;

  float r = clamp((uReveal - aDelay) / 0.26, 0.0, 1.0);
  r = 1.0 - pow(1.0 - r, 3.0);
  vReveal = r;

  // tiles pop in from slightly under-size; the field assembles itself
  vec3 p = position * mix(0.72, 1.0, r);
  vec4 world = instanceMatrix * vec4(p, 1.0);
  vWorld = world.xz;
  gl_Position = projectionMatrix * modelViewMatrix * world;
}
`

// Shared boundary maths. `vBorder` is a 4-bit mask of the edges that face OUT
// of this tier, so interior edges contribute nothing — there is no lattice.
const TILE_COMMON = /* glsl */ `
float bit(float v, float b) { return step(1.0, mod(floor(v / b), 2.0)); }

float boundaryDist(vec2 uv, float mask) {
  float dW = uv.x, dE = 1.0 - uv.x, dN = uv.y, dS = 1.0 - uv.y;
  float bd = 1.0;
  bd = min(bd, mix(1.0, dN, bit(mask, 1.0)));
  bd = min(bd, mix(1.0, dE, bit(mask, 2.0)));
  bd = min(bd, mix(1.0, dS, bit(mask, 4.0)));
  bd = min(bd, mix(1.0, dW, bit(mask, 8.0)));
  return bd;
}
`

// --- pass 1: multiply tint. gl_FragColor is a *filter*, not a colour. -------
const TILE_FILL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uOpacity;
uniform vec3  uTintMove;
uniform vec3  uTintDash;
uniform vec3  uTintDanger;
uniform vec3  uStrength;   // x = move, y = dash, z = danger

varying vec2  vUv;
varying vec2  vWorld;
varying float vType;
varying float vBorder;
varying float vReveal;
varying float vDist;

${TILE_COMMON}

void main() {
  float dash = step(0.5, vType);
  float danger = step(1.5, vType);

  vec3 tint = mix(mix(uTintMove, uTintDash, dash), uTintDanger, danger);
  float k = mix(mix(uStrength.x, uStrength.y, dash), uStrength.z, danger);

  // Low-amplitude life: a lazy world-space swell plus an outward ripple from
  // the unit. Both stay under ±12% so the field breathes instead of strobing.
  float flow = sin(vWorld.x * 0.23 + vWorld.y * 0.17 - uTime * 0.55);
  float ripple = smoothstep(0.55, 1.0, sin(uTime * 0.9 - vDist * 0.5));
  k *= 1.0 + flow * 0.07 + ripple * 0.11;

  // Tiers separate by *pattern*, not by volume: the 2-AP band carries a soft
  // diagonal hatch and the hazard band a harder one. Both stay quiet.
  float hatch = smoothstep(0.42, 0.58, fract((vWorld.x - vWorld.y) * 0.55 - uTime * 0.10));
  k *= mix(1.0, 0.68 + hatch * 0.58, dash * (1.0 - danger));
  k *= mix(1.0, 0.60 + hatch * 0.75, danger);

  // feather the last centimetres at the outer rim so the filter doesn't end on
  // a hard stair-step against untinted ground
  float bd = boundaryDist(vUv, vBorder);
  k *= smoothstep(0.0, 0.030, bd);

  k = clamp(k * vReveal * uOpacity, 0.0, 0.95);

  // out = dst * mix(vec3(1.0), tint, k)   -- see blend setup in decalFlags()
  gl_FragColor = vec4(tint * k, k);
}
`

// --- pass 2: thin additive outer boundary + a whisper of lift ---------------
const TILE_EDGE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uOpacity;
uniform vec3  uColMove;
uniform vec3  uColDash;
uniform vec3  uColDanger;
uniform vec3  uEdgeGain;   // x = move, y = dash, z = danger
uniform vec3  uLift;       // flat additive floor per tier

varying vec2  vUv;
varying vec2  vWorld;
varying float vType;
varying float vBorder;
varying float vReveal;
varying float vDist;

${TILE_COMMON}

void main() {
  float dash = step(0.5, vType);
  float danger = step(1.5, vType);

  vec3 col = mix(mix(uColMove, uColDash, dash), uColDanger, danger);
  float gain = mix(mix(uEdgeGain.x, uEdgeGain.y, dash), uEdgeGain.z, danger);
  float lift = mix(mix(uLift.x, uLift.y, dash), uLift.z, danger);

  float bd = boundaryDist(vUv, vBorder);
  float aa = max(fwidth(bd) * 1.2, 0.0014);

  float line = 1.0 - smoothstep(0.019 - aa, 0.019 + aa, bd);
  float halo = pow(1.0 - smoothstep(0.019, 0.13, bd), 2.0);

  // the 2-AP tier's outline is literally dashed — a tier cue that costs no
  // extra brightness. The pattern is world-space so it runs continuously
  // around the region instead of restarting on every tile.
  float ticks = smoothstep(0.40, 0.46, fract((vWorld.x + vWorld.y) * 0.62 - uTime * 0.06));
  line *= mix(1.0, 0.22 + ticks * 0.78, dash * (1.0 - danger));

  // pulse travels outward from the unit; amplitude is deliberately small
  float pulse = 1.0 + 0.16 * smoothstep(0.5, 1.0, sin(uTime * 0.9 - vDist * 0.5));

  float a = (line * gain + halo * gain * 0.22 + lift) * pulse * vReveal * uOpacity;
  a = clamp(a, 0.0, 1.0);

  // premultiplied: blending is ONE / ONE, so brightness lives in the rgb term
  gl_FragColor = vec4(col * a, a);
}
`

const PATH_VERT = /* glsl */ `
attribute float aLen;
varying float vU;
varying float vV;
void main() {
  vU = uv.x;
  vV = aLen;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const PATH_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uOpacity;
uniform float uTotal;
uniform vec3  uColor;
varying float vU;
varying float vV;

void main() {
  float across = abs(vU - 0.5) * 2.0;      // 0 centre, 1 edge
  float aa  = max(fwidth(across) * 1.2, 0.004);
  float sil   = 1.0 - smoothstep(0.94 - aa, 0.94 + aa, across);  // ribbon silhouette
  float inner = 1.0 - smoothstep(0.66 - aa, 0.80 + aa, across);
  float rim   = clamp(sil - inner, 0.0, 1.0);                    // dark casing

  // chevrons: the v phase is skewed across the ribbon so each band becomes an
  // arrowhead pointing down the path
  float ph = fract(vV * 1.0 - uTime * 1.2 + across * 0.32);
  float chev = (1.0 - smoothstep(0.0, 0.28, ph)) * smoothstep(0.0, 0.02, ph);

  // fade the very start so it grows out of the soldier's feet
  float head = smoothstep(0.0, 0.9, vV);
  float tail = 1.0 - smoothstep(uTotal - 0.35, uTotal, vV);

  float spine = pow(1.0 - across, 2.0);
  // restrained: a tinted lane with a dark casing and soft chevrons, not a
  // white light-tube. The route is read by its shape, not its wattage.
  float a = (rim * 0.42 + inner * (0.20 + spine * 0.08 + chev * 0.26)) * head * tail * uOpacity;
  vec3 col = mix(vec3(0.010, 0.016, 0.030), uColor * (0.80 + spine * 0.18), inner);
  col = mix(col, mix(uColor, vec3(1.0), 0.40), chev * inner);

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const RETICLE_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uOpacity;
uniform float uMode;    // 0 = hover tile, 1 = destination, 2 = enemy target
uniform vec3  uColor;
varying vec2 vUv;

float ring(float d, float r, float w) {
  return 1.0 - smoothstep(w, w * 2.2, abs(d - r));
}

// Bracket coverage for a square of half-extent r, bar t thick, arms of length arm.
float brackets(vec2 ap, float r, float t, float arm, float aa) {
  vec2 q = ap / r;
  float insideX = smoothstep(1.0 + aa, 1.0 - aa, q.x);
  float insideY = smoothstep(1.0 + aa, 1.0 - aa, q.y);
  float barX = smoothstep(1.0 - t - aa, 1.0 - t + aa, q.x) * insideX * insideY
             * smoothstep(1.0 - arm - aa, 1.0 - arm + aa, q.y);
  float barY = smoothstep(1.0 - t - aa, 1.0 - t + aa, q.y) * insideX * insideY
             * smoothstep(1.0 - arm - aa, 1.0 - arm + aa, q.x);
  return clamp(barX + barY, 0.0, 1.0);
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  vec2 ap = abs(p);
  float d = length(p);
  float aa = max(fwidth(d) * 1.3, 0.004);

  float ink = 0.0;   // bright graphic
  float pad = 0.0;   // dark casing behind it, so the shape reads on any ground
  vec3 col = uColor;

  if (uMode < 0.5) {
    // hover: four crisp corner brackets, breathing slightly
    float br = 0.95 + 0.035 * sin(uTime * 3.2);
    ink = brackets(ap, br, 0.085, 0.42, aa);
    pad = brackets(ap, br, 0.165, 0.50, aa);
    ink += ring(d, 0.10, 0.022) * 0.8;
    pad += 0.16;                                        // faint tile wash
  } else if (uMode < 1.5) {
    // destination: tick ring, thin inner ring, centre diamond
    float ang = atan(p.y, p.x);
    float ticks = smoothstep(0.70, 0.76, fract((ang / 6.2831853) * 16.0 + uTime * 0.10));
    ink += ring(d, 0.78, 0.060) * ticks;
    ink += ring(d, 0.78, 0.014) * 0.55;
    ink += ring(d, 0.46, 0.012) * 0.45;
    float diam = smoothstep(0.030, 0.0, abs(ap.x + ap.y - 0.17)) * step(ap.x + ap.y, 0.24);
    ink += diam;
    pad = ring(d, 0.78, 0.10) * 0.75 + smoothstep(0.50, 0.0, d) * 0.35;
  } else {
    // enemy target: converging brackets + spinning dashed ring
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
    float r = 0.70 + 0.05 * pulse;
    ink = brackets(ap, r, 0.075, 0.32, aa);
    pad = brackets(ap, r, 0.16, 0.40, aa);
    float ang = atan(p.y, p.x) + uTime * 0.9;
    float dash = smoothstep(0.48, 0.52, fract((ang / 6.2831853) * 8.0));
    ink += ring(d, 0.95, 0.024) * dash * 0.85;
    ink += ring(d, 0.05, 0.035);
  }

  ink = clamp(ink, 0.0, 1.0);
  pad = clamp(pad, 0.0, 1.0);

  float a = max(ink, pad * 0.62) * uOpacity;
  vec3 outCol = mix(vec3(0.012, 0.018, 0.032), col * 1.25 + vec3(0.35) * ink, ink);

  gl_FragColor = vec4(outCol, clamp(a, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const RETICLE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// ------------------------------------------------------------- cover glyphs

function shieldTexture(kind) {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  const path = new Path2D()
  const cx = S / 2
  path.moveTo(cx, 10)
  path.lineTo(S - 20, 30)
  path.lineTo(S - 20, S * 0.55)
  path.quadraticCurveTo(S - 24, S - 22, cx, S - 10)
  path.quadraticCurveTo(24, S - 22, 20, S * 0.55)
  path.lineTo(20, 30)
  path.closePath()

  // Half cover reads as *half a shield silhouette* — the shape itself must
  // differ, a differently-shaded full shield is unreadable at gameplay zoom.
  g.save()
  if (kind === 'half') {
    g.beginPath()
    g.rect(-4, S * 0.46, S + 8, S * 0.6)
    g.clip()
  }
  g.lineJoin = 'round'
  g.lineWidth = 20
  g.strokeStyle = 'rgba(0,0,0,0.85)' // dark casing so it reads on bright ground
  g.stroke(path)
  g.fillStyle = 'rgba(255,255,255,0.95)'
  g.fill(path)
  g.lineWidth = 8
  g.strokeStyle = 'rgba(255,255,255,1)'
  g.stroke(path)
  g.restore()

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

// ------------------------------------------------------------------- module

export function createHighlights(ctx) {
  const grid = ctx.grid
  const TILE = grid.TILE
  const MAX = grid.W * grid.H

  const root = new THREE.Group()
  root.name = 'input:highlights'
  root.userData.noOcclude = true
  root.renderOrder = 20
  ctx.scene.add(root)

  const COL = {
    move: new THREE.Color(0x38b4ff),
    dash: new THREE.Color(0xff9012),
    danger: new THREE.Color(0xff2b1e),
    hover: new THREE.Color(0xd6f2ff),
    dest: new THREE.Color(0x7fdcff),
    enemy: new THREE.Color(0xff4436),
  }

  /**
   * mode:
   *   'normal'   straight alpha (ribbon, reticles)
   *   'add'      premultiplied additive (thin boundary lines, light beams)
   *   'multiply' colour filter: out = dst * mix(vec3(1), tint, k), fed by
   *              gl_FragColor = vec4(tint * k, k). Ground texture survives
   *              intact because the blend is a per-channel gain on dst.
   */
  function decalFlags(mat, mode = 'normal') {
    mat.transparent = true
    mat.depthWrite = false
    mat.depthTest = true
    mat.side = THREE.DoubleSide
    if (mode === 'add') {
      mat.blending = THREE.CustomBlending
      mat.blendSrc = THREE.OneFactor
      mat.blendDst = THREE.OneFactor
      mat.blendEquation = THREE.AddEquation
      mat.toneMapped = false
    } else if (mode === 'multiply') {
      mat.blending = THREE.CustomBlending
      mat.blendSrc = THREE.DstColorFactor
      mat.blendDst = THREE.OneMinusSrcAlphaFactor
      mat.blendEquation = THREE.AddEquation
      mat.toneMapped = false // the fragment is a blend factor, not a colour
    } else {
      mat.blending = THREE.NormalBlending
      mat.toneMapped = true
    }
    mat.polygonOffset = true
    mat.polygonOffsetFactor = -6
    mat.polygonOffsetUnits = -12
    mat.__isHighlight = true
    return mat
  }

  // --- range field --------------------------------------------------------

  const tileGeo = new THREE.PlaneGeometry(TILE, TILE, 1, 1)
  tileGeo.rotateX(-Math.PI / 2)

  const aType = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
  const aBorder = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
  const aDelay = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
  const aDist = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
  for (const a of [aType, aBorder, aDelay, aDist]) a.setUsage(THREE.DynamicDrawUsage)
  tileGeo.setAttribute('aType', aType)
  tileGeo.setAttribute('aBorder', aBorder)
  tileGeo.setAttribute('aDelay', aDelay)
  tileGeo.setAttribute('aDist', aDist)

  /**
   * Tuning. `strength` is the multiply-filter mix toward the tint (0 = ground
   * untouched, 1 = fully tinted); `edgeGain` is the additive brightness of the
   * ~4 cm outer boundary line; `lift` is a flat additive floor so a tier still
   * reads where the ground is too dark for a multiply to bite.
   */
  const TUNE = {
    // multiply filters — >1 in a channel lifts it, <1 absorbs it
    tintMove: new THREE.Vector3(0.34, 0.82, 1.34),
    tintDash: new THREE.Vector3(1.18, 0.76, 0.30),
    tintDanger: new THREE.Vector3(1.42, 0.36, 0.30),
    // dash needs a higher number to land at the *same perceived* weight as
    // blue: the battlefield is warm, so a warm filter has less to push against
    strength: new THREE.Vector3(0.38, 0.42, 0.30), // move / dash / danger
    edgeGain: new THREE.Vector3(0.22, 0.20, 0.20),
    lift: new THREE.Vector3(0.011, 0.013, 0.010),
  }

  const fieldUniforms = {
    uTime: { value: 0 },
    uReveal: { value: 0 },
    uOpacity: { value: 1 },
    uTile: { value: TILE },
  }

  const fillMat = decalFlags(
    new THREE.ShaderMaterial({
      vertexShader: TILE_VERT,
      fragmentShader: TILE_FILL_FRAG,
      uniforms: {
        ...fieldUniforms,
        uTintMove: { value: TUNE.tintMove },
        uTintDash: { value: TUNE.tintDash },
        uTintDanger: { value: TUNE.tintDanger },
        uStrength: { value: TUNE.strength },
      },
    }),
    'multiply'
  )

  const edgeMat = decalFlags(
    new THREE.ShaderMaterial({
      vertexShader: TILE_VERT,
      fragmentShader: TILE_EDGE_FRAG,
      uniforms: {
        ...fieldUniforms,
        uColMove: { value: COL.move },
        uColDash: { value: COL.dash },
        uColDanger: { value: COL.danger },
        uEdgeGain: { value: TUNE.edgeGain },
        uLift: { value: TUNE.lift },
      },
    }),
    'add'
  )

  const field = new THREE.InstancedMesh(tileGeo, fillMat, MAX)
  field.frustumCulled = false
  field.count = 0
  field.renderOrder = 20
  field.userData.noOcclude = true
  root.add(field)

  // Second pass over the *same* instance buffer — one extra draw call, zero
  // extra geometry, and the only way to have a multiply fill and an additive
  // rim in the same overlay.
  const fieldEdge = new THREE.InstancedMesh(tileGeo, edgeMat, MAX)
  fieldEdge.instanceMatrix = field.instanceMatrix
  fieldEdge.frustumCulled = false
  fieldEdge.count = 0
  fieldEdge.renderOrder = 21
  fieldEdge.userData.noOcclude = true
  root.add(fieldEdge)


  const _m = new THREE.Matrix4()
  const _v = new THREE.Vector3()

  const rangeState = { reveal: 0, opacity: 0, want: 0, count: 0 }

  /** Accepts Set/Array of keys (`x + z*W`), `"x,z"` strings, or `{x,z}` objects. */
  function decodeSet(src, out) {
    if (!src) return out
    const push = (v) => {
      if (v == null) return
      if (typeof v === 'number') {
        out.set(v, { x: v % grid.W, z: Math.floor(v / grid.W) })
      } else if (typeof v === 'string') {
        const p = v.split(/[,:|]/).map(Number)
        if (p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          out.set(grid.key(p[0], p[1]), { x: p[0], z: p[1] })
      } else if (typeof v.x === 'number' && typeof v.z === 'number') {
        out.set(grid.key(v.x, v.z), { x: v.x, z: v.z })
      }
    }
    if (src instanceof Set || Array.isArray(src)) for (const v of src) push(v)
    else if (src instanceof Map) for (const v of src.values()) push(v)
    return out
  }

  function tileTop(x, z) {
    let e = 0
    try {
      e = ctx.world?.getTile?.(x, z)?.elevation || 0
    } catch {
      e = 0
    }
    return e * grid.ELEV_STEP
  }

  /**
   * @param {{blue?:any, dash?:any, danger?:any, origin?:{x,z}}} sets
   */
  function setRange(sets) {
    const blue = decodeSet(sets?.blue, new Map())
    const dash = decodeSet(sets?.dash, new Map())
    const danger = decodeSet(sets?.danger, new Map())
    // dash is additive over blue in XCOM; make it exclusive for a clean border
    for (const k of blue.keys()) dash.delete(k)

    const total = blue.size + dash.size + danger.size
    if (!total) {
      clearRange()
      return
    }

    const origin = sets?.origin || null
    const owner = new Map() // key -> type
    for (const k of blue.keys()) owner.set(k, TYPE.BLUE)
    for (const k of dash.keys()) owner.set(k, TYPE.DASH)
    for (const k of danger.keys()) if (!owner.has(k)) owner.set(k, TYPE.DANGER)

    let i = 0
    let maxD = 1
    const write = (map, type) => {
      for (const [key, t] of map) {
        if (owner.get(key) !== type) continue
        if (i >= MAX) break
        const x = t.x
        const z = t.z
        grid.toWorld(x, z, 0, _v)
        _v.y = tileTop(x, z) + 0.03
        _m.makeTranslation(_v.x, _v.y, _v.z)
        field.setMatrixAt(i, _m)

        // border mask: neighbour missing OR of a different tier
        let mask = 0
        if (owner.get(grid.key(x, z - 1)) !== type || !grid.inBounds(x, z - 1)) mask |= 1
        if (owner.get(grid.key(x + 1, z)) !== type || !grid.inBounds(x + 1, z)) mask |= 2
        if (owner.get(grid.key(x, z + 1)) !== type || !grid.inBounds(x, z + 1)) mask |= 4
        if (owner.get(grid.key(x - 1, z)) !== type || !grid.inBounds(x - 1, z)) mask |= 8

        const d = origin ? Math.max(Math.abs(x - origin.x), Math.abs(z - origin.z)) : 0
        if (d > maxD) maxD = d

        aType.array[i] = type
        aBorder.array[i] = mask
        aDist.array[i] = d
        aDelay.array[i] = d
        i++
      }
    }
    write(blue, TYPE.BLUE)
    write(dash, TYPE.DASH)
    write(danger, TYPE.DANGER)

    // normalise the stagger so big and small ranges reveal in the same time
    for (let k = 0; k < i; k++) aDelay.array[k] = (aDelay.array[k] / maxD) * 0.55

    field.count = i
    fieldEdge.count = i
    field.instanceMatrix.needsUpdate = true
    for (const a of [aType, aBorder, aDelay, aDist]) a.needsUpdate = true
    rangeState.count = i
    rangeState.reveal = 0
    rangeState.want = 1
    field.visible = true
    fieldEdge.visible = true
  }

  function clearRange() {
    rangeState.want = 0
  }

  // --- path ribbon --------------------------------------------------------

  const pathGeo = new THREE.BufferGeometry()
  const PATH_MAX = 512
  pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_MAX * 3), 3))
  pathGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(PATH_MAX * 2), 2))
  pathGeo.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array(PATH_MAX), 1))
  pathGeo.setDrawRange(0, 0)

  const pathMat = decalFlags(
    new THREE.ShaderMaterial({
      vertexShader: PATH_VERT,
      fragmentShader: PATH_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uTotal: { value: 1 },
        uColor: { value: COL.move.clone() },
      },
    })
  )
  const pathMesh = new THREE.Mesh(pathGeo, pathMat)
  pathMesh.frustumCulled = false
  pathMesh.renderOrder = 22
  pathMesh.userData.noOcclude = true
  root.add(pathMesh)

  const pathState = { opacity: 0, want: 0 }

  function pathToWorld(path) {
    const pts = []
    for (const p of path) {
      if (!p) continue
      let v
      if (p.isVector3) v = p.clone()
      else if (typeof p.x === 'number' && typeof p.z === 'number')
        v = grid.toWorld(p.x, p.z, p.elevation != null ? p.elevation : 0, new THREE.Vector3())
      else continue
      if (p.elevation == null && !p.isVector3) v.y = tileTop(p.x, p.z)
      pts.push(v)
    }
    return pts
  }

  function setPath(path, tier = 'blue') {
    const raw = Array.isArray(path) ? pathToWorld(path) : []
    if (raw.length < 2) {
      clearPath()
      return
    }
    // smooth the 8-way staircase into a flowing ribbon, then re-seat on terrain
    const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal', 0.35)
    const segs = Math.min(PATH_MAX / 2 - 2, Math.max(12, (raw.length - 1) * 7))
    const samples = curve.getPoints(segs)

    const pos = pathGeo.attributes.position.array
    const uvs = pathGeo.attributes.uv.array
    const lens = pathGeo.attributes.aLen.array

    const half = 0.28
    let run = 0
    const up = new THREE.Vector3(0, 1, 0)
    const dir = new THREE.Vector3()
    const side = new THREE.Vector3()
    let n = 0

    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]
      const a = samples[Math.max(0, i - 1)]
      const b = samples[Math.min(samples.length - 1, i + 1)]
      dir.copy(b).sub(a)
      dir.y = 0
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1)
      dir.normalize()
      side.crossVectors(up, dir).normalize().multiplyScalar(half)
      if (i > 0) run += p.distanceTo(samples[i - 1])

      // hug the terrain rather than floating over steps
      const g = grid.toGrid(p)
      const y = tileTop(g.x, g.z) + 0.07

      pos[n * 3 + 0] = p.x - side.x
      pos[n * 3 + 1] = y + 0.03
      pos[n * 3 + 2] = p.z - side.z
      uvs[n * 2 + 0] = 0
      uvs[n * 2 + 1] = run
      lens[n] = run
      n++

      pos[n * 3 + 0] = p.x + side.x
      pos[n * 3 + 1] = y + 0.03
      pos[n * 3 + 2] = p.z + side.z
      uvs[n * 2 + 0] = 1
      uvs[n * 2 + 1] = run
      lens[n] = run
      n++
    }

    const idx = []
    for (let i = 0; i < n / 2 - 1; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    pathGeo.setIndex(idx)
    pathGeo.setDrawRange(0, idx.length)
    pathGeo.attributes.position.needsUpdate = true
    pathGeo.attributes.uv.needsUpdate = true
    pathGeo.attributes.aLen.needsUpdate = true
    pathMat.uniforms.uTotal.value = Math.max(run, 0.01)
    pathMat.uniforms.uColor.value.copy(tier === 'dash' ? COL.dash : COL.move)
    pathState.want = 1
    pathMesh.visible = true

    // destination marker rides the end of the path
    const end = samples[samples.length - 1]
    const g = grid.toGrid(end)
    setDestination(end.x, tileTop(g.x, g.z) + 0.05, end.z, tier)
  }

  function clearPath() {
    pathState.want = 0
    destState.want = 0
    coverGroup.visible = false
  }

  // --- reticles (hover / destination / enemy) -----------------------------

  function makeReticle(mode, size, color) {
    const geo = new THREE.PlaneGeometry(size, size)
    if (mode !== 2) geo.rotateX(-Math.PI / 2)
    const mat = decalFlags(
      new THREE.ShaderMaterial({
        vertexShader: RETICLE_VERT,
        fragmentShader: RETICLE_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uMode: { value: mode },
          uColor: { value: color.clone() },
        },
      })
    )
    if (mode === 2) {
      mat.depthTest = false
      mat.polygonOffset = false
    }
    const m = new THREE.Mesh(geo, mat)
    m.frustumCulled = false
    m.renderOrder = 24
    m.userData.noOcclude = true
    m.visible = false
    return m
  }

  const hoverMesh = makeReticle(0, TILE * 1.02, COL.hover)
  const destMesh = makeReticle(1, TILE * 1.5, COL.dest)
  root.add(hoverMesh, destMesh)

  const hoverState = { opacity: 0, want: 0 }
  const destState = { opacity: 0, want: 0 }

  function setHover(x, z) {
    if (x == null) {
      hoverState.want = 0
      return
    }
    grid.toWorld(x, z, 0, _v)
    hoverMesh.position.set(_v.x, tileTop(x, z) + 0.045, _v.z)
    hoverMesh.visible = true
    hoverState.want = 1
  }
  function clearHover() {
    hoverState.want = 0
  }

  function setDestination(wx, wy, wz, tier) {
    destMesh.position.set(wx, wy, wz)
    destMesh.material.uniforms.uColor.value.copy(tier === 'dash' ? COL.dash : COL.dest)
    destMesh.visible = true
    destState.want = 1
  }

  // --- cover pips ---------------------------------------------------------

  const coverGroup = new THREE.Group()
  coverGroup.userData.noOcclude = true
  coverGroup.visible = false
  root.add(coverGroup)

  const texFull = shieldTexture('full')
  const texHalf = shieldTexture('half')
  const coverSprites = []
  for (let i = 0; i < 4; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texFull,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    mat.__isHighlight = true
    const s = new THREE.Sprite(mat)
    s.scale.setScalar(0.85)
    s.renderOrder = 30
    s.visible = false
    coverGroup.add(s)
    coverSprites.push(s)
  }

  /** cover: `{n,e,s,w}` with 0/1/2, drawn as pips around the destination tile. */
  function setCover(cover, wx, wy, wz) {
    if (!cover) {
      coverGroup.visible = false
      return
    }
    const dirs = [
      ['n', 0, -1],
      ['e', 1, 0],
      ['s', 0, 1],
      ['w', -1, 0],
    ]
    let shown = 0
    for (let i = 0; i < 4; i++) {
      const [k, dx, dz] = dirs[i]
      const v = cover[k] | 0
      const s = coverSprites[i]
      if (!v) {
        s.visible = false
        continue
      }
      s.material.map = v >= 2 ? texFull : texHalf
      s.material.color.setHex(v >= 2 ? 0x9fe8ff : 0xffd07a)
      s.material.needsUpdate = true
      s.position.set(wx + dx * TILE * 0.5, wy + 0.95, wz + dz * TILE * 0.5)
      s.visible = true
      shown++
    }
    coverGroup.visible = shown > 0
  }

  // --- enemy target reticles ---------------------------------------------

  const targetPool = []
  const targetActive = []

  function setTargets(list) {
    for (const m of targetActive) m.visible = false
    targetActive.length = 0
    if (!list?.length) return
    for (let i = 0; i < list.length; i++) {
      let m = targetPool[i]
      if (!m) {
        m = makeReticle(2, 1.8, COL.enemy)
        targetPool.push(m)
        root.add(m)
      }
      const e = list[i]
      let p = null
      if (e?.position?.isVector3) p = e.position
      else if (e?.unitId) {
        try {
          const o = ctx.units?.getObject?.(e.unitId)
          if (o) p = o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.4, 0))
        } catch {}
        if (!p) {
          const u = ctx.state?.units?.find?.((x) => x.id === e.unitId)
          if (u) p = grid.toWorld(u.x, u.z, u.elevation || 0, new THREE.Vector3()).setY(
            (u.elevation || 0) * grid.ELEV_STEP + 1.4
          )
        }
      } else if (typeof e?.x === 'number') {
        p = grid.toWorld(e.x, e.z, e.elevation || 0, new THREE.Vector3())
        p.y += 1.4
      }
      if (!p) continue
      m.position.copy(p)
      m.visible = true
      m.material.uniforms.uOpacity.value = 1
      targetActive.push(m)
    }
  }

  // --- frame update -------------------------------------------------------

  const camQuat = new THREE.Quaternion()

  function update(dt, time) {
    fieldUniforms.uTime.value = time
    pathMat.uniforms.uTime.value = time
    hoverMesh.material.uniforms.uTime.value = time
    destMesh.material.uniforms.uTime.value = time

    // range reveal + fade
    if (rangeState.want) {
      rangeState.reveal = Math.min(2.0, rangeState.reveal + dt / 0.42)
      rangeState.opacity = Math.min(1, rangeState.opacity + dt / 0.18)
    } else {
      rangeState.opacity = Math.max(0, rangeState.opacity - dt / 0.14)
      if (rangeState.opacity <= 0) field.visible = fieldEdge.visible = false
    }
    fieldUniforms.uReveal.value = rangeState.reveal
    fieldUniforms.uOpacity.value = rangeState.opacity

    const ease = (s, rate) => {
      s.opacity += (s.want - s.opacity) * Math.min(1, dt * rate)
      return s.opacity
    }
    pathMat.uniforms.uOpacity.value = ease(pathState, 16)
    if (pathState.want === 0 && pathState.opacity < 0.01) pathMesh.visible = false

    hoverMesh.material.uniforms.uOpacity.value = ease(hoverState, 20)
    if (hoverState.want === 0 && hoverState.opacity < 0.01) hoverMesh.visible = false

    destMesh.material.uniforms.uOpacity.value = ease(destState, 16)
    if (destState.want === 0 && destState.opacity < 0.01) destMesh.visible = false
    destMesh.rotation.y = time * 0.25

    for (const m of targetActive) {
      m.material.uniforms.uTime.value = time
      ctx.camera.getWorldQuaternion(camQuat)
      m.quaternion.copy(camQuat)
    }
  }

  function clearAll() {
    clearRange()
    clearPath()
    clearHover()
    setTargets(null)
  }

  function dispose() {
    ctx.scene.remove(root)
    root.traverse((o) => {
      o.geometry?.dispose?.()
      const m = o.material
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.())
      else m?.dispose?.()
    })
    texFull.dispose()
    texHalf.dispose()
  }

  return {
    root,
    update,
    setRange,
    clearRange,
    setPath,
    clearPath,
    setHover,
    clearHover,
    setCover,
    setTargets,
    clearAll,
    dispose,
    _colors: COL,
  }
}
