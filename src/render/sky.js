import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'

/**
 * Sky, image-based lighting and atmosphere.
 *
 * Three jobs:
 *  1. A physically-motivated Rayleigh/Mie sky dome (three's Sky shader) so the
 *     background is a graded atmosphere with a real sun disc and horizon haze,
 *     not a gradient someone eyeballed.
 *  2. That sky -> PMREMGenerator -> scene.environment. This is the single
 *     biggest fix for the "flat WebGL demo" look: every PBR surface then gets
 *     correct specular AND diffuse irradiance instead of a constant ambient.
 *     The env scene also contains a ground dome, so upward-facing surfaces get
 *     sky and downward-facing surfaces get warm ground bounce — which is what
 *     stops undersides going dead black.
 *  3. FogExp2 whose colour is *sampled from the rendered sky at the horizon*,
 *     so the battlefield edge dissolves into the actual sky instead of into a
 *     hand-picked grey that never quite matches.
 */

const SKY_SCALE = 420 // camera far is 500; the dome rides with the camera
const ENV_SCALE = 100

export function createSky(ctx) {
  const { scene, renderer } = ctx

  // --- visible dome --------------------------------------------------------
  const sky = new Sky()
  sky.scale.setScalar(SKY_SCALE)
  sky.frustumCulled = false
  sky.renderOrder = -1000
  sky.name = 'render:sky'
  // Sky.js emits raw scattering radiance in the tens; straight through ACES the
  // whole dome clips to a white sheet and the gradient and sun disc vanish.
  // Patch in a scalar we can solve for, so the sky sits in a sane exposure band
  // while the sun disc still overshoots enough to bloom.
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('void main() {', 'uniform float skyIntensity;\nvoid main() {')
    .replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyIntensity, 1.0 );')
  sky.material.uniforms.skyIntensity = { value: 0.35 }
  scene.add(sky)

  // --- environment capture scene ------------------------------------------
  const envScene = new THREE.Scene()
  const envSky = new Sky()
  envSky.scale.setScalar(ENV_SCALE)
  envScene.add(envSky)

  // Lower hemisphere: ground bounce for the IBL. Without this the whole lower
  // half of every object's irradiance is black and everything reads like a
  // studio render on a void.
  const groundUniforms = {
    uColor: { value: new THREE.Color(0x5a4c3a) },
    uHorizon: { value: new THREE.Color(0x8fa2b5) },
    uIntensity: { value: 0.5 },
  }
  const envGround = new THREE.Mesh(
    new THREE.SphereGeometry(ENV_SCALE * 0.98, 24, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: groundUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform vec3 uHorizon; uniform float uIntensity;
        varying vec3 vDir;
        void main() {
          float t = clamp(-vDir.y, 0.0, 1.0);
          vec3 c = mix(uHorizon, uColor, smoothstep(0.0, 0.55, t));
          gl_FragColor = vec4(c * uIntensity, 1.0);
        }`,
    })
  )
  envGround.name = 'render:envGround'
  envScene.add(envGround)

  // --- PMREM ---------------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()
  let envRT = null

  // --- fog -----------------------------------------------------------------
  const fog = new THREE.FogExp2(0x8fa2b5, 0.0065)
  scene.fog = fog

  // Tiny offscreen probe used to read the true horizon radiance back out of the
  // sky shader. FloatType where available so we get unclamped HDR values.
  let probeRT
  try {
    probeRT = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
    })
  } catch (err) {
    probeRT = new THREE.WebGLRenderTarget(16, 16, { depthBuffer: false })
  }
  const probeCam = new THREE.PerspectiveCamera(100, 1, 0.1, ENV_SCALE * 4)
  const probeBuf = probeRT.texture.type === THREE.FloatType ? new Float32Array(16 * 16 * 4) : new Uint8Array(16 * 16 * 4)

  const params = {
    turbidity: 4.2,
    rayleigh: 2.4,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.86,
    // Sky.js emits raw scattering radiance with no exposure calibration — left
    // as-is its irradiance swamps the key light and everything goes flat blue.
    // envTarget is the ambient level we actually want; scene.environmentIntensity
    // is solved for it from a measured probe, so every preset lands consistently.
    envTarget: 0.5,
    // What the visible dome should average out to after the same solve. The
    // fog colour is the measured horizon put through the SAME scale, so the
    // battlefield edge and the sky it dissolves into are the same colour by
    // construction rather than by eye.
    skyTarget: 0.42,
    fogDensity: 0.0065,
    fogLift: 0.9,
    fogTint: 0xffffff,
    groundBounce: 0x5a4c3a,
    groundBounceIntensity: 0.5,
  }
  let envIntensity = 1
  let lastProbe = null

  const sunDir = new THREE.Vector3(0, 0.2, -1).normalize()
  const _sunPos = new THREE.Vector3()
  const _c = new THREE.Color()

  function pushUniforms() {
    for (const target of [sky, envSky]) {
      const u = target.material.uniforms
      u.turbidity.value = params.turbidity
      u.rayleigh.value = params.rayleigh
      u.mieCoefficient.value = params.mieCoefficient
      u.mieDirectionalG.value = params.mieDirectionalG
      u.sunPosition.value.copy(sunDir)
    }
    groundUniforms.uColor.value.set(params.groundBounce)
    groundUniforms.uIntensity.value = params.groundBounceIntensity
  }

  const _side = new THREE.Vector3()

  /**
   * Render the dome into a 16x16 probe and average a row range. readPixels
   * returns rows bottom-up, so y=0 is the bottom of the probe frame.
   * @returns {{r,g,b}|null}
   */
  function probeBand(pitchDeg, y0, y1) {
    const prevRT = renderer.getRenderTarget()
    const prevTone = renderer.toneMapping
    renderer.toneMapping = THREE.NoToneMapping
    // Look 90 degrees off the sun: sampling toward the sun would drag the fog
    // and the whole exposure solve toward the solar disc and turn the frame to
    // soup.
    _side.set(-sunDir.z, 0, sunDir.x)
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0)
    _side.normalize().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(pitchDeg)))
    _side.y = Math.sin(THREE.MathUtils.degToRad(pitchDeg))
    probeCam.position.set(0, 0, 0)
    probeCam.lookAt(_side)
    renderer.setRenderTarget(probeRT)
    renderer.render(envScene, probeCam)
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    try {
      renderer.readRenderTargetPixels(probeRT, 0, 0, 16, 16, probeBuf)
      const s = probeBuf instanceof Float32Array ? 1 : 1 / 255
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < 16; x++) {
          const p = (y * 16 + x) * 4
          r += probeBuf[p] * s
          g += probeBuf[p + 1] * s
          b += probeBuf[p + 2] * s
          n++
        }
      }
    } catch (err) {
      n = 0
    }
    renderer.setRenderTarget(prevRT)
    renderer.toneMapping = prevTone
    if (!n) return null
    return { r: r / n, g: g / n, b: b / n }
  }

  /**
   * Two measurements, because they answer different questions:
   *  - sky:     dome only (ground dome hidden), camera pitched up. This is what
   *             fills the frame behind the battlefield, and what the visible
   *             dome's exposure must be solved against.
   *  - horizon: the bottom rows of that same frame -> the fog colour.
   *  - average: full hemisphere WITH the ground dome -> ambient irradiance,
   *             which is what environmentIntensity must be solved against.
   */
  function probeScene() {
    envGround.visible = false
    const sky5 = probeBand(28, 0, 16)
    const horizon = probeBand(6, 8, 12)
    envGround.visible = true
    const average = probeBand(0, 0, 16)
    if (!sky5 || !horizon || !average) return null
    return { sky: sky5, horizon, average }
  }

  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

  /** Rebuild the PMREM env map + fog colour. Call after any sun/params change. */
  function refresh() {
    pushUniforms()
    try {
      const next = pmrem.fromScene(envScene, 0, 0.5, ENV_SCALE * 3)
      if (envRT) envRT.dispose()
      envRT = next
      scene.environment = envRT.texture
    } catch (err) {
      console.warn('[render/sky] PMREM failed, falling back to flat ambient', err)
    }

    const probe = probeScene()
    if (probe) {
      // Solve environmentIntensity so ambient irradiance lands on envTarget
      // regardless of how hot the scattering model happens to run this preset.
      const avg = Math.max(0.02, lum(probe.average))
      envIntensity = THREE.MathUtils.clamp(params.envTarget / avg, 0.02, 6)
      if ('environmentIntensity' in scene) scene.environmentIntensity = envIntensity

      const sl = Math.max(0.002, lum(probe.sky))
      const skyScale = THREE.MathUtils.clamp(params.skyTarget / sl, 0.002, 4)
      sky.material.uniforms.skyIntensity.value = skyScale
      lastProbe = { sky: sl, horizon: lum(probe.horizon), average: avg, skyScale, envIntensity }

      // Fog = the measured horizon through the same scale, pulled a touch below
      // the sky so ground still reads as ground where the two meet.
      const k = skyScale * params.fogLift
      _c.setRGB(probe.horizon.r * k, probe.horizon.g * k, probe.horizon.b * k, THREE.LinearSRGBColorSpace)
      const tint = new THREE.Color(params.fogTint)
      _c.r *= tint.r
      _c.g *= tint.g
      _c.b *= tint.b
      fog.color.copy(_c)
    }
    fog.density = params.fogDensity
    return api
  }

  function setSunDirection(v) {
    sunDir.copy(v).normalize()
    return api
  }

  /** elevation/azimuth in degrees. elevation 0 = horizon, 90 = zenith. */
  function setSunAngles(elevationDeg, azimuthDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg)
    const theta = THREE.MathUtils.degToRad(azimuthDeg)
    _sunPos.setFromSphericalCoords(1, phi, theta)
    sunDir.copy(_sunPos)
    return api
  }

  function set(patch = {}) {
    Object.assign(params, patch)
    return api
  }

  // Ride with the camera so a 420-unit dome never clips against the 500 far
  // plane no matter where the camera rig ends up.
  const stopUpdate = ctx.onUpdate(() => {
    sky.position.copy(ctx.camera.position)
  })

  const api = {
    sky,
    envScene,
    fog,
    params,
    sunDirection: sunDir,
    setSunDirection,
    setSunAngles,
    set,
    refresh,
    get envIntensity() {
      return envIntensity
    },
    get probe() {
      return lastProbe
    },
    get environment() {
      return envRT?.texture ?? null
    },
    dispose() {
      stopUpdate()
      scene.remove(sky)
      sky.geometry.dispose()
      sky.material.dispose()
      envSky.geometry.dispose()
      envSky.material.dispose()
      envGround.geometry.dispose()
      envGround.material.dispose()
      probeRT.dispose()
      envRT?.dispose()
      pmrem.dispose()
      if (scene.environment === envRT?.texture) scene.environment = null
      scene.fog = null
    },
  }

  pushUniforms()
  return api
}
