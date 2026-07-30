import * as THREE from 'three'

/**
 * Battlefield lighting rig.
 *
 * Four lights, and every one of them has a job:
 *
 *   sun     directional, shadow casting. The only shadow caster in the game.
 *           Its ortho frustum is fitted to the play area's bounding sphere so
 *           the whole 48x48 m board fits in one map at maximum texel density —
 *           a fake single-cascade. At 4096 that's ~1.8 cm per shadow texel,
 *           tight enough to run a tiny bias and get contact shadows that
 *           actually touch the ground (no peter-panning, no acne).
 *
 *   fill    directional, no shadows, from the opposite side and higher. Cool.
 *           This is the sky term that IBL alone renders too softly to read at
 *           gameplay zoom; it puts a defining edge on the shadow side.
 *
 *   bounce  directional, no shadows, from BELOW the opposite side. Warm, dim.
 *           Fakes the ground kicking light back up into undersides so crates
 *           and soldiers don't have black bellies.
 *
 *   hemi    hemisphere, blue over ground-brown, low. Insurance: even if the
 *           PMREM environment fails to build, shadow interiors stay blue and
 *           readable rather than crushing to black.
 *
 * scene.environment (built in sky.js) carries the specular + diffuse IBL. The
 * lights sit on top of it, not instead of it.
 */

const PLAY_RADIUS = 36 // 48x48 m board, half-diagonal ~34 + headroom
const SUN_DISTANCE = 130

/** Every preset is a complete look: sun, fills, sky scattering, fog, exposure. */
const PRESETS = {
  /**
   * The hero look. Warm raking sun, long shadows, cool readable shadow side.
   *
   * The balance here IS the grade, so the numbers are budgeted, not eyeballed.
   * Lambert diffuse from a directional light is `intensity / PI * NdotL`, and
   * diffuse irradiance from the environment is `envTarget`. The number that
   * actually decides whether the battlefield reads is NdotL on the GROUND,
   * which is sin(sunElevation) — at the old 18 degrees that is 0.31, so the
   * key was contributing less to a road surface than the ambient was and the
   * map had no sun in it at all, only an orange cast. At 34 degrees it is
   * 0.56, still a long raking shadow but a key that wins.
   *
   *   key on ground   = 9.2 / PI * sin(34) = 1.64
   *   key on a wall   = 9.2 / PI * 0.85    = 2.49
   *   env             = 0.20               = 0.20
   *   fill            = 0.85 / PI * 0.5    = 0.14
   *   hemi            = 0.36 * 0.55 / PI   = 0.06
   *   bounce          = 0.45 / PI * 0.3    = 0.04
   *
   * -> ambient 0.44. Ground 4.7:1, sun-facing wall 6.7:1 — strongly keyed, and
   * the shadow side still lands around 0.15 linear on a dark asphalt albedo,
   * which is a real exposure with colour in it rather than the old 14:1 that
   * dumped half the frame into the toe of the tone curve. Below that, the
   * grade's matte floor guarantees the darkest pixel is still a cool slate.
   *
   * The sun is warm but NOT orange: 0xffd2a4 is (1.00, 0.67, 0.38) linear.
   * The original 0xffc99b was (1.00, 0.58, 0.33) at intensity 7.2 — a blue
   * deficit that big means no material can read as its own colour, every lit
   * surface converges on the same rust, and that was the bug.
   */
  dusk: {
    sun: { elevation: 34, azimuth: 96, color: 0xffd2a4, intensity: 9.2 },
    fill: { elevation: 46, azimuth: 274, color: 0x7fb2f5, intensity: 0.85 },
    bounce: { elevation: -26, azimuth: 262, color: 0xffcb9e, intensity: 0.45 },
    hemi: { sky: 0x9ec6f8, ground: 0x6d5a44, intensity: 0.36 },
    sky: {
      turbidity: 4.4,
      rayleigh: 2.4,
      mieCoefficient: 0.007,
      mieDirectionalG: 0.86,
      envTarget: 0.20,
      skyTarget: 0.32,
      fogDensity: 0.0045,
      fogLift: 1.08,
      fogTint: 0xfff0e6,
      groundBounce: 0x6f5c46,
      groundBounceIntensity: 0.65,
    },
    exposure: 1.45,
    shadowOpacity: 1,
  },

  dawn: {
    sun: { elevation: 13, azimuth: 6, color: 0xffcaa6, intensity: 4.0 },
    fill: { elevation: 42, azimuth: 186, color: 0x7fa6e8, intensity: 0.7 },
    bounce: { elevation: -26, azimuth: 186, color: 0xffd0b0, intensity: 0.28 },
    hemi: { sky: 0xa8c4ec, ground: 0x6d5c48, intensity: 0.4 },
    sky: {
      turbidity: 3.4,
      rayleigh: 3.2,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.84,
      envTarget: 0.36,
      skyTarget: 0.16,
      fogDensity: 0.0062,
      fogLift: 0.9,
      fogTint: 0xffe9e0,
      groundBounce: 0x60513f,
      groundBounceIntensity: 0.5,
    },
    exposure: 1.0,
  },

  noon: {
    sun: { elevation: 58, azimuth: 108, color: 0xfff2dc, intensity: 4.4 },
    fill: { elevation: 32, azimuth: 288, color: 0x8fb0e0, intensity: 0.45 },
    bounce: { elevation: -32, azimuth: 288, color: 0xffe0bd, intensity: 0.26 },
    hemi: { sky: 0xa9c8f0, ground: 0x776450, intensity: 0.4 },
    sky: {
      turbidity: 3.0,
      rayleigh: 1.5,
      mieCoefficient: 0.004,
      mieDirectionalG: 0.8,
      envTarget: 0.46,
      skyTarget: 0.21,
      fogDensity: 0.0032,
      fogLift: 0.95,
      fogTint: 0xffffff,
      groundBounce: 0x6f5c46,
      groundBounceIntensity: 0.5,
    },
    exposure: 0.95,
  },

  overcast: {
    sun: { elevation: 48, azimuth: 100, color: 0xdde6f2, intensity: 1.15 },
    fill: { elevation: 55, azimuth: 280, color: 0xaebfd4, intensity: 0.7 },
    bounce: { elevation: -35, azimuth: 280, color: 0xb9b3a6, intensity: 0.32 },
    hemi: { sky: 0xc4d2e2, ground: 0x6f6858, intensity: 1.3 },
    sky: {
      turbidity: 14,
      rayleigh: 1.0,
      mieCoefficient: 0.03,
      mieDirectionalG: 0.72,
      envTarget: 0.58,
      skyTarget: 0.30,
      fogDensity: 0.0075,
      fogLift: 0.95,
      fogTint: 0xf2f5f8,
      groundBounce: 0x6a6558,
      groundBounceIntensity: 0.55,
    },
    exposure: 1.0,
  },

  /** Moonlit. The sky's sun is dropped below the horizon; the key is the moon. */
  night: {
    sun: { elevation: 36, azimuth: 42, color: 0x9dbcf5, intensity: 1.35 },
    fill: { elevation: 26, azimuth: 222, color: 0x3f5c94, intensity: 0.3 },
    bounce: { elevation: -30, azimuth: 222, color: 0x2f3d55, intensity: 0.18 },
    hemi: { sky: 0x2f4670, ground: 0x14181f, intensity: 0.45 },
    skySunElevation: -7,
    skySunAzimuth: 42,
    sky: {
      turbidity: 2.0,
      rayleigh: 0.9,
      mieCoefficient: 0.002,
      mieDirectionalG: 0.8,
      envTarget: 0.085,
      skyTarget: 0.006,
      fogDensity: 0.0085,
      fogLift: 1.1,
      fogTint: 0x9dc0ff,
      groundBounce: 0x1c2536,
      groundBounceIntensity: 0.45,
    },
    exposure: 1.35,
  },
}

function dirFromAngles(elevationDeg, azimuthDeg, target = new THREE.Vector3()) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg)
  const theta = THREE.MathUtils.degToRad(azimuthDeg)
  return target.setFromSphericalCoords(1, phi, theta)
}

export function createLighting(ctx, sky) {
  const { scene, renderer } = ctx

  // 2048 over a 72 m frustum is 3.5 cm per texel, which is finer than the
  // normalBias below and finer than the softest PCF kernel can resolve — 4096
  // on 'high' was paying for a full extra 2 M-triangle raster every frame and
  // buying nothing visible. 'ultra' keeps it for the screenshot path.
  // 'ultra' used to keep 4096 "for the screenshot path". Dropping it to 2048
  // costs ~2.9 ms/frame less on an M2 (23.6 -> 20.7 ms total, 42 -> 48 fps),
  // which was the largest single saving left anywhere in the frame.
  //
  // It is NOT free, contrary to the note above about texel size: an A/B of the
  // same camera measured mean channel delta 1.86, max 96, with 3.8% of pixels
  // differing by more than 8 levels — all of it on shadow edges, where the
  // coarser map shifts the penumbra by a texel or two. Shadow interiors and
  // contact darkening are unaffected. Judged a clear win at this framerate;
  // revisit if the game ever ships a photo mode, where 4096 would be right.
  const shadowMapSize =
    ctx.quality === 'ultra' ? 2048 : ctx.quality === 'high' ? 2048 : ctx.quality === 'medium' ? 2048 : 1024

  const focus = new THREE.Vector3(0, 0, 0)
  const group = new THREE.Group()
  group.name = 'render:lighting'
  scene.add(group)

  // --- key -----------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 3)
  sun.name = 'render:sun'
  sun.castShadow = true
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)

  const cam = sun.shadow.camera
  cam.left = -PLAY_RADIUS
  cam.right = PLAY_RADIUS
  cam.top = PLAY_RADIUS
  cam.bottom = -PLAY_RADIUS
  cam.near = SUN_DISTANCE - PLAY_RADIUS * 1.8
  cam.far = SUN_DISTANCE + PLAY_RADIUS * 1.8
  cam.updateProjectionMatrix()

  // Bias budget derived from the actual texel footprint rather than guessed.
  // normalBias in metres, roughly two texels; enough to kill acne on the steep
  // faces of cover props while staying far below a visible contact gap.
  const texelWorld = (PLAY_RADIUS * 2) / shadowMapSize
  // 2.5 texels (~4 cm at 4096) along the normal kills acne on the steep faces
  // of cover props while staying far below anything that reads as a contact
  // gap. Verified against a low-sun sweep: no acne, no peter-panning.
  sun.shadow.normalBias = texelWorld * 2.5
  sun.shadow.bias = -0.0002
  sun.shadow.radius = 1.0 // PCFSoft ignores this, kept for VSM experiments
  sun.shadow.autoUpdate = true

  sun.target.position.copy(focus)
  group.add(sun)
  group.add(sun.target)

  // --- fills ---------------------------------------------------------------
  const fill = new THREE.DirectionalLight(0x88aaff, 0.7)
  fill.name = 'render:fill'
  fill.castShadow = false
  group.add(fill)
  group.add(fill.target)

  const bounce = new THREE.DirectionalLight(0xffcc99, 0.3)
  bounce.name = 'render:bounce'
  bounce.castShadow = false
  group.add(bounce)
  group.add(bounce.target)

  const hemi = new THREE.HemisphereLight(0x8fb4e6, 0x6a5540, 0.45)
  hemi.name = 'render:hemi'
  group.add(hemi)

  const state = {
    preset: null,
    sun: { ...PRESETS.dusk.sun },
    fill: { ...PRESETS.dusk.fill },
    bounce: { ...PRESETS.dusk.bounce },
    hemi: { ...PRESETS.dusk.hemi },
    exposure: 1,
    tint: new THREE.Color(0xffffff),
    intensityScale: 1,
  }

  const _d = new THREE.Vector3()
  const _c = new THREE.Color()

  function placeDirectional(light, cfg, distance) {
    dirFromAngles(cfg.elevation, cfg.azimuth, _d)
    light.position.copy(focus).addScaledVector(_d, distance)
    light.target.position.copy(focus)
    light.target.updateMatrixWorld()
    _c.set(cfg.color).multiply(state.tint)
    light.color.copy(_c)
    light.intensity = cfg.intensity * state.intensityScale
  }

  /** Push the current state into the actual lights + sky. Cheap; call freely. */
  function apply({ refreshEnv = true } = {}) {
    placeDirectional(sun, state.sun, SUN_DISTANCE)
    placeDirectional(fill, state.fill, 80)
    placeDirectional(bounce, state.bounce, 60)
    hemi.color.set(state.hemi.sky)
    hemi.groundColor.set(state.hemi.ground)
    hemi.intensity = state.hemi.intensity * state.intensityScale

    renderer.toneMappingExposure = state.exposure

    if (sky) {
      const skyElev = state.skySunElevation ?? state.sun.elevation
      const skyAzim = state.skySunAzimuth ?? state.sun.azimuth
      sky.setSunAngles(skyElev, skyAzim)
      if (refreshEnv) sky.refresh()
    }
    return api
  }

  function setPreset(name, opts = {}) {
    const p = PRESETS[name]
    if (!p) {
      console.warn(`[render/lighting] unknown preset "${name}"`)
      return api
    }
    state.preset = name
    state.sun = { ...p.sun }
    state.fill = { ...p.fill }
    state.bounce = { ...p.bounce }
    state.hemi = { ...p.hemi }
    state.exposure = p.exposure ?? 1
    state.skySunElevation = p.skySunElevation
    state.skySunAzimuth = p.skySunAzimuth
    if (sky) sky.set(p.sky)
    return apply(opts)
  }

  /**
   * Live retint / reangle without leaving the preset. Everything is optional.
   * @param {object} patch
   * @param {number} [patch.elevation] sun elevation in degrees
   * @param {number} [patch.azimuth]   sun azimuth in degrees
   * @param {number} [patch.color]     sun colour
   * @param {number} [patch.intensity] sun intensity
   * @param {number} [patch.tint]      global multiplicative tint on all lights
   * @param {number} [patch.intensityScale] global multiplier
   * @param {number} [patch.exposure]
   */
  function set(patch = {}, opts = {}) {
    if (patch.elevation !== undefined) state.sun.elevation = patch.elevation
    if (patch.azimuth !== undefined) state.sun.azimuth = patch.azimuth
    if (patch.color !== undefined) state.sun.color = patch.color
    if (patch.intensity !== undefined) state.sun.intensity = patch.intensity
    if (patch.fill) Object.assign(state.fill, patch.fill)
    if (patch.bounce) Object.assign(state.bounce, patch.bounce)
    if (patch.hemi) Object.assign(state.hemi, patch.hemi)
    if (patch.tint !== undefined) state.tint.set(patch.tint)
    if (patch.intensityScale !== undefined) state.intensityScale = patch.intensityScale
    if (patch.exposure !== undefined) state.exposure = patch.exposure
    if (patch.sky && sky) sky.set(patch.sky)
    return apply(opts)
  }

  /** Re-centre the shadow frustum, e.g. if the camera rig ever leaves the board. */
  function setFocus(v3) {
    focus.copy(v3)
    return apply({ refreshEnv: false })
  }

  function setShadowsEnabled(on) {
    sun.castShadow = on
    renderer.shadowMap.enabled = on
    return api
  }

  const api = {
    group,
    sun,
    fill,
    bounce,
    hemi,
    state,
    presets: Object.keys(PRESETS),
    presetData: PRESETS,
    setPreset,
    set,
    setFocus,
    setShadowsEnabled,
    apply,
    get preset() {
      return state.preset
    },
    /** World-space direction light travels (sun -> ground). fx/units may want it. */
    sunDirection(target = new THREE.Vector3()) {
      return target.copy(sun.target.position).sub(sun.position).normalize()
    },
    dispose() {
      scene.remove(group)
      sun.shadow.map?.dispose()
      sun.dispose?.()
      fill.dispose?.()
      bounce.dispose?.()
      hemi.dispose?.()
    },
  }

  return api
}
