/**
 * Character hit reactions.
 *
 * Blood is directional: the spray cone follows the bullet's travel vector out
 * the far side, not a symmetric puff. Fast droplets are velocity-stretched into
 * streaks, a low dark mist hangs for a moment, and a pool decal appears on the
 * ground a beat later — after the droplets would actually have landed.
 *
 * Armour absorption is deliberately a *different* read: no red at all, just
 * bright ricochet sparks and a metal ping, so the player can tell at a glance
 * that the shot did not bite.
 */
import * as THREE from 'three'

const _d = new THREE.Vector3()
const _t = new THREE.Vector3()
const _b = new THREE.Vector3()
const _p = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export function createBlood(fx) {
  const { ptc, debris } = fx

  /**
   * @param {THREE.Vector3} position hit point on the body
   * @param {THREE.Vector3} direction bullet travel direction (shooter -> target)
   * @param {number} amount 0..2 — 1 is a normal rifle hit, 2 a lethal crit
   */
  function blood(position, direction, amount = 1) {
    const a = Math.max(0.15, amount)
    const scl = fx.scale
    const d = fx.density
    _d.copy(direction || UP)
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1)
    _d.normalize()
    _t.set(_d.z, _d.x, _d.y).cross(_d)
    if (_t.lengthSq() < 1e-5) _t.set(1, 0, 0)
    _t.normalize()
    _b.crossVectors(_d, _t).normalize()

    const p = ptc.begin()

    // --- exit spray ----------------------------------------------------------
    const n = Math.round(16 * a * d)
    for (let i = 0; i < n; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const spread = Math.pow(Math.random(), 0.55) * 0.85
      const sp = (1.6 + Math.random() * 7) * a
      p.x = position.x + _d.x * 0.12
      p.y = position.y + _d.y * 0.12
      p.z = position.z + _d.z * 0.12
      p.vx = (_d.x + (_t.x * Math.cos(th) + _b.x * Math.sin(th)) * spread) * sp
      p.vy = (_d.y + (_t.y * Math.cos(th) + _b.y * Math.sin(th)) * spread) * sp + 1.0
      p.vz = (_d.z + (_t.z * Math.cos(th) + _b.z * Math.sin(th)) * spread) * sp
      p.drag = 1.1
      p.gravity = -15
      p.life = 0.35 + Math.random() * 0.55
      p.size0 = (0.045 + Math.random() * 0.075) * scl * (0.7 + a * 0.4)
      p.size1 = p.size0 * 0.85
      p.stretch = sp > 5 ? 0.010 : 0
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 10
      p.frame = Math.floor(Math.random() * 16)
      p.fadeIn = 0.002
      const v = 0.55 + Math.random() * 0.5
      p.tint2(0.72 * v, 0.055 * v, 0.045 * v, 1, 0.30 * v, 0.02, 0.02, 0.5)
      ptc.emit('blood')
    }

    // --- fine mist that hangs for a beat -------------------------------------
    const nm = Math.round(6 * a * d)
    for (let i = 0; i < nm; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const spread = Math.random() * 0.7
      const sp = 0.8 + Math.random() * 2.4
      p.x = position.x + _d.x * 0.15
      p.y = position.y + _d.y * 0.15
      p.z = position.z + _d.z * 0.15
      p.vx = (_d.x + (_t.x * Math.cos(th) + _b.x * Math.sin(th)) * spread) * sp
      p.vy = (_d.y + (_t.y * Math.cos(th) + _b.y * Math.sin(th)) * spread) * sp
      p.vz = (_d.z + (_t.z * Math.cos(th) + _b.z * Math.sin(th)) * spread) * sp
      p.drag = 5.5
      p.gravity = -2.4
      p.life = 0.30 + Math.random() * 0.35
      p.size0 = 0.10 * scl
      p.size1 = (0.34 + Math.random() * 0.25) * scl * a
      p.sizeCurve = 0.5
      p.rot = Math.random() * 6.283
      p.frame = Math.random() * 16
      p.frameRate = 9
      p.fadeIn = 0.05
      p.tint2(0.42, 0.035, 0.030, 0.42, 0.16, 0.01, 0.01, 0)
      ptc.emit('smoke')
    }

    // --- pool on the ground, once the droplets would have landed --------------
    const gY = fx.groundY(position.x, position.z)
    if (position.y - gY < 4) {
      fx.schedule(0.28, () => {
        _p.set(position.x + _d.x * 0.55 + (Math.random() - 0.5) * 0.4, gY,
               position.z + _d.z * 0.55 + (Math.random() - 0.5) * 0.4)
        fx.addDecal('blood', _p, UP, (0.42 + Math.random() * 0.3) * a)
      })
    }
  }

  /** Armour ate it: sparks and a scuff, no red. */
  function spall(position, direction, amount = 1) {
    const scl = fx.scale
    _d.copy(direction || UP)
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1)
    _d.normalize()
    _t.set(_d.z, _d.x, _d.y).cross(_d)
    if (_t.lengthSq() < 1e-5) _t.set(1, 0, 0)
    _t.normalize()
    _b.crossVectors(_d, _t).normalize()

    const p = ptc.begin()
    p.x = position.x; p.y = position.y; p.z = position.z
    p.life = 0.07
    p.size0 = 0.22 * scl
    p.size1 = 0.5 * scl
    p.fadeIn = 0.001
    p.tint2(3.0, 2.6, 2.0, 1, 0, 0, 0, 0)
    ptc.emit('glow')

    const n = Math.round(20 * amount * fx.density)
    for (let i = 0; i < n; i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      // ricochet: mostly BACK toward the shooter, splayed wide
      const spread = 0.6 + Math.random() * 1.6
      const sp = 3 + Math.random() * 12
      p.x = position.x; p.y = position.y; p.z = position.z
      p.vx = (-_d.x * 0.7 + (_t.x * Math.cos(th) + _b.x * Math.sin(th)) * spread) * sp
      p.vy = (-_d.y * 0.7 + (_t.y * Math.cos(th) + _b.y * Math.sin(th)) * spread) * sp + 1.5
      p.vz = (-_d.z * 0.7 + (_t.z * Math.cos(th) + _b.z * Math.sin(th)) * spread) * sp
      p.drag = 2.6
      p.gravity = -14
      p.life = 0.2 + Math.random() * 0.6
      p.size0 = (0.020 + Math.random() * 0.022) * scl
      p.size1 = p.size0 * 0.25
      p.stretch = 0.018
      p.frame = 0
      p.fadeIn = 0.001
      const h = 0.85 + Math.random() * 0.6
      p.tint2(3.6 * h, 2.4 * h, 1.0 * h, 1, 1.8, 0.4, 0.05, 0)
      ptc.emit('spark')
    }
    // a few metal flakes
    for (let i = 0; i < Math.round(5 * fx.density); i++) {
      p.reset()
      const th = Math.random() * Math.PI * 2
      const sp = 2 + Math.random() * 5
      p.x = position.x; p.y = position.y; p.z = position.z
      p.vx = (-_d.x + _t.x * Math.cos(th)) * sp
      p.vy = 2 + Math.random() * 3
      p.vz = (-_d.z + _b.z * Math.sin(th)) * sp
      p.drag = 1.4
      p.gravity = -16
      p.life = 0.5 + Math.random() * 0.5
      p.size0 = 0.035 * scl
      p.size1 = 0.03 * scl
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 24
      p.frame = Math.floor(Math.random() * 16)
      p.fadeIn = 0.002
      p.tint2(1.4, 1.3, 1.2, 1, 0.5, 0.45, 0.4, 0)
      ptc.emit('chip')
    }
  }

  /** Death: bigger spray plus the dust kicked up as the body lands. */
  function death(position, direction) {
    blood(position, direction, 1.9)
    fx.schedule(0.55, () => {
      const gY = fx.groundY(position.x, position.z)
      _p.set(position.x, gY, position.z)
      bodyFall(_p)
      fx.addDecal('blood', _p, UP, 0.95)
    })
  }

  /** Dust ring where a body (or anything heavy) hits the deck. */
  function bodyFall(position) {
    const p = ptc.begin()
    const scl = fx.scale
    const n = Math.round(14 * fx.density)
    for (let i = 0; i < n; i++) {
      p.reset()
      const th = (i / n) * Math.PI * 2 + Math.random() * 0.5
      const sp = 0.8 + Math.random() * 2.2
      p.x = position.x + Math.cos(th) * 0.3
      p.y = position.y + 0.06
      p.z = position.z + Math.sin(th) * 0.3
      p.vx = Math.cos(th) * sp
      p.vy = 0.35 + Math.random() * 0.5
      p.vz = Math.sin(th) * sp
      p.drag = 3.4
      p.gravity = -0.6
      p.life = 0.7 + Math.random() * 0.8
      p.size0 = 0.12 * scl
      p.size1 = (0.5 + Math.random() * 0.4) * scl
      p.sizeCurve = 0.5
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 1.4
      p.frame = Math.random() * 16
      p.frameRate = 6
      p.turb = 0.2
      p.fadeIn = 0.08
      p.tint2(0.58, 0.53, 0.45, 0.4, 0.44, 0.42, 0.38, 0)
      ptc.emit('dust')
    }
  }

  return { blood, spall, death, bodyFall }
}
