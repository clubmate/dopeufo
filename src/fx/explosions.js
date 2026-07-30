/**
 * Explosions and thrown grenades — the loudest thing on screen.
 *
 * An explosion is built as a timeline, not a single burst, because the eye reads
 * an event by its ORDER:
 *
 *   t+0ms    white-hot core flash + point light spike + camera shake
 *   t+0ms    fireball shell expanding outward, white -> yellow -> orange
 *   t+0ms    razor-thin ground shockwave ring racing ahead of everything
 *   t+20ms   sparks and burning ember debris thrown ballistically
 *   t+40ms   ground dust wave rolling outward, hugging the floor
 *   t+250ms  the fire turns over into black smoke and lifts
 *   t+400ms  chunks land and settle, scorch decal is on the ground
 *   t+1s..8s a smoke column drifts and erodes
 *
 * Heat distortion is REAL refraction: the mesh grabs the framebuffer with
 * copyFramebufferToTexture the instant it is drawn and resamples it with a
 * turbulent offset. One texture copy, no extra scene pass.
 */
import * as THREE from 'three'
import SHOCK_VERT from './shaders/shockwave.vert.glsl?raw'
import SHOCK_FRAG from './shaders/shockwave.frag.glsl?raw'
import HEAT_VERT from './shaders/heat.vert.glsl?raw'
import HEAT_FRAG from './shaders/heat.frag.glsl?raw'

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector2()
const _dir = new THREE.Vector3()

export function createExplosions(fx) {
  const { ctx, ptc, lights, debris } = fx
  const lowSpec = fx.quality === 'low' || fx.quality === 'medium'

  // --- shockwave ring pool ---------------------------------------------------
  const ringGeo = new THREE.CircleGeometry(1, lowSpec ? 48 : 96)
  const rings = []
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHOCK_VERT,
      fragmentShader: SHOCK_FRAG,
      uniforms: {
        uRadius: { value: 1 },
        uT: { value: 1 },
        uColor: { value: new THREE.Color(0.62, 0.56, 0.46) },
        uHot: { value: new THREE.Color(2.4, 1.1, 0.35) },
        uSeed: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    })
    const m = new THREE.Mesh(ringGeo, mat)
    m.rotation.x = -Math.PI / 2
    m.frustumCulled = false
    m.renderOrder = 2900
    m.visible = false
    ctx.scene.add(m)
    rings.push({ mesh: m, mat, t: 0, dur: 0, max: 1, busy: false })
  }

  // --- heat distortion pool --------------------------------------------------
  let sceneTex = null
  let heatOK = fx.quality !== 'low'
  let grabFrame = -1
  const heats = []
  const heatGeo = new THREE.PlaneGeometry(1, 1)

  function ensureSceneTex() {
    const s = ctx.renderer.getDrawingBufferSize(_v2)
    const w = Math.max(2, Math.floor(s.x))
    const h = Math.max(2, Math.floor(s.y))
    if (!sceneTex || sceneTex.image.width !== w || sceneTex.image.height !== h) {
      sceneTex?.dispose()
      sceneTex = new THREE.FramebufferTexture(w, h)
      sceneTex.colorSpace = THREE.NoColorSpace
      sceneTex.minFilter = THREE.LinearFilter
      sceneTex.magFilter = THREE.LinearFilter
      for (const h2 of heats) h2.mat.uniforms.uScene.value = sceneTex
    }
    return sceneTex
  }

  if (heatOK) {
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: HEAT_VERT,
        fragmentShader: HEAT_FRAG,
        uniforms: {
          uScene: { value: null },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uStrength: { value: 26 },
          uT: { value: 0 },
          uSeed: { value: 0 },
          uRadius: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
      })
      const m = new THREE.Mesh(heatGeo, mat)
      m.frustumCulled = false
      m.renderOrder = 3070   // after the particles so it warps the fire too
      m.visible = false
      m.onBeforeRender = (renderer) => {
        const frame = ctx.getFrame ? ctx.getFrame() : -1
        if (frame === grabFrame) return
        grabFrame = frame
        try {
          const t = ensureSceneTex()
          renderer.copyFramebufferToTexture(t)
        } catch (err) {
          console.warn('[fx] framebuffer grab unavailable, heat haze off', err)
          heatOK = false
          for (const hh of heats) { hh.mesh.visible = false; hh.busy = false }
        }
      }
      ctx.scene.add(m)
      heats.push({ mesh: m, mat, t: 0, dur: 0, busy: false, radius: 1 })
    }
  }

  function takeRing() {
    let r = rings.find((x) => !x.busy)
    if (!r) r = rings.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b))
    r.busy = true
    r.t = 0
    r.mesh.visible = true
    return r
  }

  function takeHeat() {
    if (!heatOK) return null
    let h = heats.find((x) => !x.busy)
    if (!h) return null
    h.busy = true
    h.t = 0
    h.mesh.visible = true
    return h
  }

  // --- the main event --------------------------------------------------------

  /**
   * @param {THREE.Vector3} position
   * @param {number} radius  blast radius in metres (grenade ~ 3.5)
   * @param {object} opts    { kind:'frag'|'plasma'|'fuel', shake:number, ground:number }
   */
  function explosion(position, radius = 3.5, opts = {}) {
    const R = Math.max(0.8, radius)
    const d = fx.density
    const scl = fx.scale
    const kind = opts.kind || 'frag'
    const gY = opts.ground !== undefined ? opts.ground : fx.groundY(position.x, position.z)
    const p = ptc.begin()

    const hot = kind === 'plasma' ? [0.7, 2.4, 3.6] : [3.6, 2.4, 1.5]
    const warm = kind === 'plasma' ? [0.35, 1.5, 2.8] : [3.2, 1.35, 0.35]

    // --- camera shake, scaled by distance to camera --------------------------
    try {
      const camDist = ctx.camera.position.distanceTo(position)
      const falloff = 1 / (1 + camDist / 22)
      const intensity = Math.min(1.4, (opts.shake ?? 1) * (R / 3.5) * falloff * 1.25)
      if (intensity > 0.02) {
        ctx.bus.emit('camera:shake', { intensity, duration: 0.45 + R * 0.05 })
      }
    } catch { /* input module may not be up yet */ }

    // --- light: a white spike, then a lingering orange glow ------------------
    _v.set(position.x, position.y + R * 0.25, position.z)
    lights.flash(_v, kind === 'plasma' ? [0.6, 0.95, 1.0] : [1.0, 0.86, 0.62],
      420 * (R / 3.5) * fx.lightScale, R * 9, 0.10, 1.6, 3)
    fx.schedule(0.09, () => {
      lights.flash(_v, kind === 'plasma' ? [0.4, 0.8, 1.0] : [1.0, 0.52, 0.16],
        150 * (R / 3.5) * fx.lightScale, R * 7, 0.75, 2.6, 2)
    })

    // --- core flash ----------------------------------------------------------
    p.x = position.x; p.y = position.y + R * 0.15; p.z = position.z
    p.life = 0.11
    p.size0 = R * 0.9 * scl
    p.size1 = R * 2.3 * scl
    p.sizeCurve = 0.45
    p.rot = Math.random() * 6.283
    p.frame = 0
    p.frameRate = 4 / 0.11
    p.fadeIn = 0.001
    p.tint2(hot[0] * 1.6, hot[1] * 1.6, hot[2] * 1.5, 1, warm[0] * 0.5, warm[1] * 0.3, warm[2] * 0.15, 0.2)
    ptc.emit('flash')

    p.reset()
    p.x = position.x; p.y = position.y + R * 0.2; p.z = position.z
    p.life = 0.28
    p.size0 = R * 1.5 * scl
    p.size1 = R * 3.4 * scl
    p.sizeCurve = 0.4
    p.fadeIn = 0.001
    p.tint2(hot[0], hot[1] * 0.8, hot[2] * 0.5, 0.95, 0, 0, 0, 0)
    ptc.emit('glow')

    // --- fireball shell ------------------------------------------------------
    const nf = Math.round((lowSpec ? 16 : 30) * d)
    for (let i = 0; i < nf; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(1 - Math.random() * 1.55)   // biased to the upper hemisphere
      const sp = (2.0 + Math.random() * 6.5) * (R / 3.5)
      const dx = Math.sin(ph) * Math.cos(th)
      const dy = Math.cos(ph) * 0.75 + 0.30
      const dz = Math.sin(ph) * Math.sin(th)
      p.x = position.x + dx * R * 0.12
      p.y = position.y + R * 0.15 + dy * R * 0.12
      p.z = position.z + dz * R * 0.12
      p.vx = dx * sp; p.vy = dy * sp; p.vz = dz * sp
      p.drag = 3.4
      p.gravity = 1.6                       // fire is buoyant
      p.life = 0.42 + Math.random() * 0.55
      p.size0 = R * (0.16 + Math.random() * 0.12) * scl
      p.size1 = R * (0.55 + Math.random() * 0.45) * scl
      p.sizeCurve = 0.6
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 2.5
      p.frame = Math.random() * 16
      p.frameRate = 22 + Math.random() * 10
      p.turb = 0.35
      p.fadeIn = 0.02
      p.delay = Math.random() * 0.05
      const b = 1.1 + Math.random() * 0.7
      p.tint2(b, b, b, 1, warm[0] * 0.16, warm[1] * 0.10, warm[2] * 0.06, 0)
      ptc.emit('fire')
    }
    // dense core so the middle isn't hollow
    for (let i = 0; i < Math.round(6 * d); i++) {
      p.reset()
      p.x = position.x + (Math.random() - 0.5) * R * 0.3
      p.y = position.y + R * 0.2 + (Math.random() - 0.5) * R * 0.2
      p.z = position.z + (Math.random() - 0.5) * R * 0.3
      p.vy = 1.2 + Math.random() * 1.6
      p.drag = 2.4
      p.gravity = 1.0
      p.life = 0.34 + Math.random() * 0.3
      p.size0 = R * 0.5 * scl
      p.size1 = R * 1.05 * scl
      p.sizeCurve = 0.5
      p.rot = Math.random() * 6.283
      p.frame = Math.random() * 16
      p.frameRate = 26
      p.fadeIn = 0.01
      p.tint2(1.6, 1.6, 1.6, 1, 0.3, 0.16, 0.08, 0)
      ptc.emit('fire')
    }

    // --- shockwave ring on the ground ---------------------------------------
    const ring = takeRing()
    ring.dur = 0.30 + R * 0.045
    ring.max = R * 2.15
    ring.mesh.position.set(position.x, gY + 0.05, position.z)
    ring.mat.uniforms.uSeed.value = Math.random() * 100
    ring.mat.uniforms.uHot.value.setRGB(warm[0] * 0.9, warm[1] * 0.7, warm[2] * 0.4)

    // --- heat haze -----------------------------------------------------------
    const heat = takeHeat()
    if (heat) {
      heat.dur = 0.42 + R * 0.04
      heat.radius = R * 1.5
      heat.mesh.position.set(position.x, position.y + R * 0.25, position.z)
      heat.mat.uniforms.uSeed.value = Math.random() * 50
      heat.mat.uniforms.uStrength.value = 22 + R * 5
    }

    // --- ground dust wave ----------------------------------------------------
    const ndw = Math.round((lowSpec ? 14 : 26) * d)
    for (let i = 0; i < ndw; i++) {
      p.reset()
      const th = (i / ndw) * Math.PI * 2 + Math.random() * 0.4
      const sp = (4.5 + Math.random() * 7) * (R / 3.5)
      p.x = position.x + Math.cos(th) * R * 0.25
      p.y = gY + 0.12 + Math.random() * 0.25
      p.z = position.z + Math.sin(th) * R * 0.25
      p.vx = Math.cos(th) * sp
      p.vy = 0.5 + Math.random() * 1.0
      p.vz = Math.sin(th) * sp
      p.drag = 3.2
      p.gravity = -0.35
      p.life = 1.1 + Math.random() * 1.3
      p.size0 = R * 0.18 * scl
      p.size1 = R * (0.7 + Math.random() * 0.5) * scl
      p.sizeCurve = 0.5
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 1.2
      p.frame = Math.random() * 16
      p.frameRate = 7
      p.turb = 0.3
      p.fadeIn = 0.06
      p.delay = 0.02 + Math.random() * 0.06
      const v = 0.8 + Math.random() * 0.35
      p.tint2(0.60 * v, 0.54 * v, 0.44 * v, 0.62, 0.42, 0.39, 0.34, 0)
      ptc.emit('dust')
    }

    // --- sparks + burning embers --------------------------------------------
    const nsp = Math.round((lowSpec ? 26 : 55) * d)
    for (let i = 0; i < nsp; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(1 - Math.random() * 1.7)
      const sp = (5 + Math.random() * 22) * (R / 3.5)
      const dx = Math.sin(ph) * Math.cos(th)
      const dy = Math.cos(ph) * 0.85 + 0.35
      const dz = Math.sin(ph) * Math.sin(th)
      p.x = position.x; p.y = position.y + R * 0.15; p.z = position.z
      p.vx = dx * sp; p.vy = dy * sp; p.vz = dz * sp
      p.drag = 1.1 + Math.random() * 1.6
      p.gravity = -14
      p.life = 0.4 + Math.random() * 1.5
      p.size0 = (0.028 + Math.random() * 0.045) * scl
      p.size1 = p.size0 * 0.2
      p.stretch = 0.018
      p.frame = Math.random() < 0.7 ? 0 : 3
      p.fadeIn = 0.001
      const h = 0.8 + Math.random() * 0.7
      p.tint2(3.8 * h, 1.9 * h, 0.5 * h, 1, 1.5 * h, 0.22 * h, 0.03, 0)
      ptc.emit('spark')
    }

    // --- thrown debris that lands and stays -----------------------------------
    if (debris) {
      const nk = Math.round((lowSpec ? 5 : 11) * d)
      for (let i = 0; i < nk; i++) {
        const th = Math.random() * Math.PI * 2
        const sp = (3 + Math.random() * 9) * (R / 3.5)
        debris.chunks.spawn(
          position.x, position.y + 0.25, position.z,
          Math.cos(th) * sp, 4 + Math.random() * 9, Math.sin(th) * sp,
          0.10 + Math.random() * 0.20, gY,
          [0.34 + Math.random() * 0.15, 0.31 + Math.random() * 0.12, 0.28 + Math.random() * 0.1]
        )
      }
    }

    // --- fire turns over into smoke, then a drifting column -------------------
    const nsm = Math.round((lowSpec ? 12 : 24) * d)
    for (let i = 0; i < nsm; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const rr = Math.random() * R * 0.55
      p.x = position.x + Math.cos(th) * rr
      p.y = position.y + 0.2 + Math.random() * R * 0.4
      p.z = position.z + Math.sin(th) * rr
      p.vx = Math.cos(th) * (0.6 + Math.random() * 1.8)
      p.vy = 1.1 + Math.random() * 2.2
      p.vz = Math.sin(th) * (0.6 + Math.random() * 1.8)
      p.drag = 1.1
      p.gravity = 0.55
      p.life = 2.4 + Math.random() * 3.6
      p.size0 = R * 0.22 * scl
      p.size1 = R * (0.85 + Math.random() * 0.75) * scl
      p.sizeCurve = 0.5
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 0.6
      p.frame = Math.random() * 16
      p.frameRate = 3.2
      p.turb = 0.42
      p.fadeIn = 0.12
      p.delay = 0.18 + Math.random() * 0.5
      // starts lit by the fireball, cools to cold grey
      const g0 = 0.30 + Math.random() * 0.2
      p.tint2(g0 * 2.2, g0 * 1.35, g0 * 0.8, 0.72, 0.30, 0.29, 0.30, 0)
      ptc.emit('smoke')
    }

    // --- scorch -------------------------------------------------------------
    _v.set(position.x, gY, position.z)
    fx.addDecal('scorch', _v, null, R * 1.5)
    fx.schedule(0.05, () => {
      _v.set(position.x + (Math.random() - 0.5) * R * 0.5, gY, position.z + (Math.random() - 0.5) * R * 0.5)
      fx.addDecal('scuff', _v, null, R * 1.1)
    })
  }

  // --- thrown grenade --------------------------------------------------------
  const grenGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.13, 8)
  const grenMat = new THREE.MeshStandardMaterial({ color: 0x3a4230, roughness: 0.62, metalness: 0.35 })
  const projectiles = []
  const projPool = []
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(grenGeo, grenMat)
    m.visible = false
    m.frustumCulled = false
    ctx.scene.add(m)
    projPool.push(m)
  }

  /**
   * Arcing grenade with a smoke trail; detonates on arrival.
   * @returns {Promise<void>} resolves when the explosion fires
   */
  function grenade(from, to, opts = {}) {
    const mesh = projPool.find((m) => !m.visible) || projPool[0]
    mesh.visible = true
    const dist = Math.hypot(to.x - from.x, to.z - from.z)
    const dur = opts.duration || Math.min(1.5, 0.55 + dist * 0.055)
    const peak = opts.arc ?? Math.max(1.6, dist * 0.42)
    return new Promise((resolve) => {
      projectiles.push({
        mesh, from: from.clone(), to: to.clone(), t: 0, dur, peak,
        trail: 0, radius: opts.radius ?? 3.6, kind: opts.kind || 'frag',
        smoke: opts.smoke === true, resolve,
      })
    })
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const g = projectiles[i]
      g.t += dt
      const k = Math.min(1, g.t / g.dur)
      const x = g.from.x + (g.to.x - g.from.x) * k
      const z = g.from.z + (g.to.z - g.from.z) * k
      const y = g.from.y + (g.to.y - g.from.y) * k + Math.sin(k * Math.PI) * g.peak
      g.mesh.position.set(x, y, z)
      g.mesh.rotation.x += dt * 11
      g.mesh.rotation.z += dt * 7

      g.trail += dt
      if (g.trail > 0.022) {
        g.trail = 0
        const p = ptc.begin()
        p.x = x; p.y = y; p.z = z
        p.vx = (Math.random() - 0.5) * 0.3
        p.vy = 0.25 + Math.random() * 0.3
        p.vz = (Math.random() - 0.5) * 0.3
        p.drag = 1.4
        p.life = 0.6 + Math.random() * 0.6
        p.size0 = 0.07 * fx.scale
        p.size1 = (0.34 + Math.random() * 0.2) * fx.scale
        p.rot = Math.random() * 6.283
        p.rotVel = (Math.random() - 0.5) * 1.5
        p.frame = Math.random() * 16
        p.frameRate = 6
        p.turb = 0.18
        p.fadeIn = 0.1
        p.tint2(0.78, 0.78, 0.80, 0.34, 0.6, 0.6, 0.62, 0)
        ptc.emit('smoke')
        // a hot pip so the grenade is trackable at iso distance
        p.reset()
        p.x = x; p.y = y; p.z = z
        p.life = 0.10
        p.size0 = 0.17 * fx.scale
        p.size1 = 0.05 * fx.scale
        p.fadeIn = 0.001
        p.tint2(2.2, 0.85, 0.25, 0.8, 0.8, 0.2, 0.05, 0)
        ptc.emit('glow')
      }

      if (k >= 1) {
        g.mesh.visible = false
        projectiles.splice(i, 1)
        if (g.smoke) fx.smokeCloud?.(g.to, g.radius, 12)
        else explosion(g.to, g.radius, { kind: g.kind })
        try { g.resolve() } catch { /* ignore */ }
      }
    }
  }

  function update(dt, time) {
    updateProjectiles(dt)

    for (const r of rings) {
      if (!r.busy) continue
      r.t += dt
      const k = r.t / r.dur
      if (k >= 1) { r.busy = false; r.mesh.visible = false; continue }
      // fast out of the gate, decelerating — a linear ramp reads as an animation
      r.mat.uniforms.uRadius.value = r.max * Math.pow(k, 0.42)
      r.mat.uniforms.uT.value = k
    }

    if (heatOK) {
      const s = ctx.renderer.getDrawingBufferSize(_v2)
      for (const h of heats) {
        if (!h.busy) continue
        h.t += dt
        const k = h.t / h.dur
        if (k >= 1) { h.busy = false; h.mesh.visible = false; continue }
        h.mat.uniforms.uT.value = k
        h.mat.uniforms.uTime.value = time
        h.mat.uniforms.uRadius.value = h.radius * (0.55 + k * 1.4)
        h.mat.uniforms.uResolution.value.set(s.x, s.y)
      }
    }
  }

  function dispose() {
    for (const r of rings) { r.mesh.removeFromParent(); r.mat.dispose() }
    for (const h of heats) { h.mesh.removeFromParent(); h.mat.dispose() }
    for (const m of projPool) m.removeFromParent()
    ringGeo.dispose(); heatGeo.dispose(); grenGeo.dispose(); grenMat.dispose()
    sceneTex?.dispose()
  }

  return { explosion, grenade, update, dispose, get activeRings() { return rings.filter((r) => r.busy).length } }
}
