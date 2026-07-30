/**
 * Smoke grenades + ambient world life.
 *
 * SMOKE CLOUDS are sustained emitters rather than one-shot bursts: a cloud keeps
 * feeding large, slow, heavily turbulent soft particles into a disc for its whole
 * duration, so it churns and re-forms instead of visibly ageing out. Because the
 * particles are soft (depth-faded) and huge relative to a tile, an overlapping
 * stack of them genuinely occludes what is behind it — it reads as cover, which
 * is the entire point of the ability.
 *
 * AMBIENT LIFE is the cheapest realism in the whole game. A completely static
 * battlefield between turns is the giveaway that you are looking at a tech demo.
 * Dust motes drifting through the light, embers, grit skittering along the
 * ground and distant smoke columns cost a few hundred particles and never stop.
 */
import * as THREE from 'three'

const _c = new THREE.Vector3()

export function createSmoke(fx) {
  const { ptc, ctx } = fx
  const clouds = []

  /**
   * @param {THREE.Vector3} position centre of the cloud, at ground level
   * @param {number} radius  metres — a smoke grenade covers ~3 tiles
   * @param {number} duration seconds the emitter keeps feeding
   */
  function smokeCloud(position, radius = 3.5, duration = 12) {
    const c = {
      p: position.clone(),
      r: radius,
      dur: duration,
      t: 0,
      acc: 0,
      rate: (fx.quality === 'low' ? 7 : 15) * fx.density,
      ground: fx.groundY(position.x, position.z),
    }
    clouds.push(c)

    // opening burst: a fast, violent bloom so deployment reads as an event
    const p = ptc.begin()
    const n = Math.round(20 * fx.density)
    for (let i = 0; i < n; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const rr = Math.random() * radius * 0.5
      p.x = c.p.x + Math.cos(th) * rr
      p.y = c.ground + 0.25 + Math.random() * 0.7
      p.z = c.p.z + Math.sin(th) * rr
      const sp = 2.4 + Math.random() * 3.4
      p.vx = Math.cos(th) * sp
      p.vy = 0.9 + Math.random() * 1.5
      p.vz = Math.sin(th) * sp
      p.drag = 2.6
      p.gravity = 0.15
      p.life = 3.0 + Math.random() * 2.5
      p.size0 = radius * 0.28 * fx.scale
      p.size1 = radius * (0.95 + Math.random() * 0.5) * fx.scale
      p.sizeCurve = 0.45
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 0.5
      p.frame = Math.random() * 16
      p.frameRate = 3
      p.turb = 0.35
      p.fadeIn = 0.05
      const g = 0.78 + Math.random() * 0.18
      p.tint2(g, g, g * 1.02, 0.55, g * 0.85, g * 0.85, g * 0.88, 0)
      ptc.emit('smoke')
    }

    // a little ground-hugging skirt so it doesn't float
    for (let i = 0; i < Math.round(10 * fx.density); i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      p.x = c.p.x + Math.cos(th) * radius * 0.2
      p.y = c.ground + 0.1
      p.z = c.p.z + Math.sin(th) * radius * 0.2
      const sp = 3.0 + Math.random() * 3.0
      p.vx = Math.cos(th) * sp
      p.vy = 0.15
      p.vz = Math.sin(th) * sp
      p.drag = 3.0
      p.life = 2.6 + Math.random() * 2
      p.size0 = radius * 0.25 * fx.scale
      p.size1 = radius * 0.9 * fx.scale
      p.rot = Math.random() * 6.283
      p.frame = Math.random() * 16
      p.frameRate = 3
      p.turb = 0.25
      p.fadeIn = 0.06
      p.tint2(0.82, 0.82, 0.84, 0.5, 0.7, 0.7, 0.72, 0)
      ptc.emit('smoke')
    }
    return c
  }

  function updateClouds(dt) {
    for (let i = clouds.length - 1; i >= 0; i--) {
      const c = clouds[i]
      c.t += dt
      if (c.t > c.dur) { clouds.splice(i, 1); continue }
      // taper the feed in the last 20% so the cloud thins rather than snapping off
      const taper = c.t > c.dur * 0.8 ? 1 - (c.t - c.dur * 0.8) / (c.dur * 0.2) : 1
      c.acc += c.rate * taper * dt
      const p = ptc.begin()
      while (c.acc >= 1) {
        c.acc -= 1
        p.reset()
        const th = Math.random() * Math.PI * 2
        const rr = Math.sqrt(Math.random()) * c.r * 0.85
        p.x = c.p.x + Math.cos(th) * rr
        p.y = c.ground + 0.15 + Math.random() * c.r * 0.75
        p.z = c.p.z + Math.sin(th) * rr
        p.vx = Math.cos(th) * (0.20 + Math.random() * 0.45) + 0.10
        p.vy = 0.08 + Math.random() * 0.28
        p.vz = Math.sin(th) * (0.20 + Math.random() * 0.45)
        p.drag = 0.55
        p.gravity = 0.02
        p.life = 4.5 + Math.random() * 3.5
        p.size0 = c.r * (0.45 + Math.random() * 0.3) * fx.scale
        p.size1 = c.r * (1.0 + Math.random() * 0.55) * fx.scale
        p.sizeCurve = 0.6
        p.rot = Math.random() * 6.283
        p.rotVel = (Math.random() - 0.5) * 0.28
        p.frame = Math.random() * 16
        p.frameRate = 1.6
        p.turb = 0.30
        p.fadeIn = 0.16
        const g = 0.74 + Math.random() * 0.22
        p.tint2(g, g, g * 1.03, 0.40, g * 0.8, g * 0.8, g * 0.84, 0)
        ptc.emit('smoke')
      }
    }
  }

  // -------------------------------------------------------------------------
  // ambient world life
  // -------------------------------------------------------------------------

  const amb = {
    on: true,
    motes: 0, embers: 0, grit: 0, column: 0,
    extentX: 24, extentZ: 24, baseY: 0,
    columns: [],
  }

  function configureAmbient() {
    const g = ctx.grid
    amb.extentX = (g?.W || 24) * (g?.TILE || 2) * 0.5
    amb.extentZ = (g?.H || 24) * (g?.TILE || 2) * 0.5
    // a couple of distant burning wrecks on the horizon
    amb.columns = []
    const n = fx.quality === 'low' ? 0 : 2
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const d = Math.max(amb.extentX, amb.extentZ) * (1.35 + Math.random() * 0.7)
      amb.columns.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, acc: 0 })
    }
  }

  const RATE_MOTE = 26
  const RATE_EMBER = 2.2
  const RATE_GRIT = 3.5

  function updateAmbient(dt) {
    if (!amb.on) return
    const p = ptc.begin()
    const ex = amb.extentX, ez = amb.extentZ

    // --- dust motes hanging in the light -------------------------------------
    amb.motes += RATE_MOTE * fx.density * dt
    while (amb.motes >= 1) {
      amb.motes -= 1
      p.reset()
      p.x = (Math.random() * 2 - 1) * ex
      p.y = amb.baseY + Math.random() * 7
      p.z = (Math.random() * 2 - 1) * ez
      p.vx = 0.14 + Math.random() * 0.22
      p.vy = (Math.random() - 0.35) * 0.10
      p.vz = (Math.random() - 0.5) * 0.14
      p.drag = 0.05
      p.life = 9 + Math.random() * 9
      p.size0 = 0.016 + Math.random() * 0.026
      p.size1 = p.size0
      p.turb = 0.09
      p.fadeIn = 0.22
      const b = 0.5 + Math.random() * 0.9
      p.tint2(b, b * 0.95, b * 0.82, 0.30, b, b * 0.95, b * 0.82, 0)
      ptc.emit('glow')
    }

    // --- rising embers -------------------------------------------------------
    amb.embers += RATE_EMBER * fx.density * dt
    while (amb.embers >= 1) {
      amb.embers -= 1
      p.reset()
      p.x = (Math.random() * 2 - 1) * ex
      p.y = amb.baseY + Math.random() * 1.6
      p.z = (Math.random() * 2 - 1) * ez
      p.vx = 0.35 + Math.random() * 0.5
      p.vy = 0.55 + Math.random() * 0.8
      p.vz = (Math.random() - 0.5) * 0.4
      p.drag = 0.3
      p.gravity = 0.12
      p.life = 3.5 + Math.random() * 3.5
      p.size0 = 0.020 + Math.random() * 0.022
      p.size1 = p.size0 * 0.5
      p.frame = 3
      p.turb = 0.5
      p.fadeIn = 0.15
      const h = 0.6 + Math.random() * 0.7
      p.tint2(2.2 * h, 0.75 * h, 0.16 * h, 0.9, 1.1 * h, 0.16 * h, 0.02, 0)
      ptc.emit('spark')
    }

    // --- grit skittering along the deck --------------------------------------
    amb.grit += RATE_GRIT * fx.density * dt
    while (amb.grit >= 1) {
      amb.grit -= 1
      p.reset()
      p.x = -ex * 1.05
      p.y = amb.baseY + 0.06 + Math.random() * 0.5
      p.z = (Math.random() * 2 - 1) * ez
      p.vx = 3.5 + Math.random() * 4.5
      p.vy = 0.25 + Math.random() * 0.5
      p.vz = (Math.random() - 0.5) * 0.8
      p.drag = 0.55
      p.gravity = -1.2
      p.life = 2.5 + Math.random() * 2.5
      p.size0 = 0.022 + Math.random() * 0.03
      p.size1 = p.size0
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 16
      p.frame = Math.floor(Math.random() * 16)
      p.fadeIn = 0.15
      p.tint2(0.5, 0.46, 0.38, 0.6, 0.4, 0.37, 0.32, 0)
      ptc.emit('chip')
    }

    // --- distant smoke columns ------------------------------------------------
    for (const c of amb.columns) {
      c.acc += 2.4 * fx.density * dt
      while (c.acc >= 1) {
        c.acc -= 1
        p.reset()
        p.x = c.x + (Math.random() - 0.5) * 2.5
        p.y = amb.baseY + Math.random() * 2
        p.z = c.z + (Math.random() - 0.5) * 2.5
        p.vx = 0.9 + Math.random() * 0.8
        p.vy = 1.6 + Math.random() * 1.4
        p.vz = (Math.random() - 0.5) * 0.6
        p.drag = 0.18
        p.gravity = 0.35
        p.life = 9 + Math.random() * 7
        p.size0 = 2.2
        p.size1 = 11 + Math.random() * 6
        p.sizeCurve = 0.7
        p.rot = Math.random() * 6.283
        p.rotVel = (Math.random() - 0.5) * 0.16
        p.frame = Math.random() * 16
        p.frameRate = 0.9
        p.turb = 0.7
        p.fadeIn = 0.12
        const g = 0.22 + Math.random() * 0.2
        p.tint2(g, g * 0.97, g * 0.95, 0.44, g * 0.7, g * 0.7, g * 0.72, 0)
        ptc.emit('smoke')
      }
    }
  }

  configureAmbient()

  function update(dt) {
    updateClouds(dt)
    updateAmbient(dt)
  }

  return {
    smokeCloud,
    update,
    setAmbient(v) { amb.on = !!v },
    setAmbientBase(y) { amb.baseY = y },
    reconfigure: configureAmbient,
    get clouds() { return clouds.length },
  }
}
