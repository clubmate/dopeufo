/**
 * Muzzle flash + shell ejection + barrel smoke.
 *
 * A muzzle flash is not one sprite. It is: a 4-frame flash crown that plays out
 * in ~60 ms, a hot glow halo, a burst of unburnt-powder sparks in a forward
 * cone, a wisp of propellant smoke, a point light that genuinely lights the
 * shooter, and a brass casing that arcs out and bounces.
 *
 * The entire multi-second tail (barrel smoke) is scheduled at spawn time via the
 * particle system's `delay` field, so it costs zero CPU after the trigger pull.
 */
import * as THREE from 'three'

const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export const WEAPONS = {
  rifle:    { flash: 0.62, light: 34, sparks: 12, smoke: 3, shell: true,  shellSize: 1.0, life: 0.070, hue: [2.6, 1.55, 0.55] },
  smg:      { flash: 0.48, light: 24, sparks: 8,  smoke: 2, shell: true,  shellSize: 0.85, life: 0.055, hue: [2.5, 1.45, 0.50] },
  pistol:   { flash: 0.44, light: 20, sparks: 7,  smoke: 2, shell: true,  shellSize: 0.8, life: 0.055, hue: [2.6, 1.50, 0.55] },
  shotgun:  { flash: 0.95, light: 52, sparks: 22, smoke: 6, shell: true,  shellSize: 1.5, life: 0.085, hue: [2.8, 1.35, 0.40] },
  sniper:   { flash: 0.88, light: 46, sparks: 16, smoke: 5, shell: true,  shellSize: 1.2, life: 0.080, hue: [2.7, 1.60, 0.62] },
  cannon:   { flash: 1.25, light: 70, sparks: 26, smoke: 8, shell: false, shellSize: 1.0, life: 0.100, hue: [2.9, 1.30, 0.35] },
  plasma:   { flash: 0.75, light: 44, sparks: 14, smoke: 2, shell: false, shellSize: 1.0, life: 0.075, hue: [0.55, 1.85, 2.9] },
}

export function createMuzzle(fx) {
  const { ptc, lights, debris } = fx
  const _v3 = new THREE.Vector3()

  /**
   * @param {THREE.Vector3} position  muzzle tip in world space
   * @param {THREE.Vector3} direction unit vector the barrel points along
   * @param {string} weaponType       key into WEAPONS
   */
  function muzzleFlash(position, direction, weaponType = 'rifle') {
    const w = WEAPONS[weaponType] || WEAPONS.rifle
    _f.copy(direction)
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1)
    _f.normalize()
    _r.crossVectors(_f, UP)
    if (_r.lengthSq() < 1e-5) _r.set(1, 0, 0)
    _r.normalize()
    _u.crossVectors(_r, _f).normalize()

    const px = position.x + _f.x * 0.06
    const py = position.y + _f.y * 0.06
    const pz = position.z + _f.z * 0.06
    const scl = fx.scale

    // --- flash crown: plays its 4 frames exactly once, then it's gone --------
    const p = ptc.begin()
    p.x = px; p.y = py; p.z = pz
    p.life = w.life
    p.size0 = w.flash * 1.05 * scl
    p.size1 = w.flash * 1.55 * scl
    p.sizeCurve = 0.55
    p.rot = Math.random() * Math.PI * 2
    p.rotVel = (Math.random() - 0.5) * 4
    p.frame = 0
    p.frameRate = 4 / w.life
    p.fadeIn = 0.001
    p.tint2(w.hue[0], w.hue[1], w.hue[2], 1, w.hue[0] * 0.5, w.hue[1] * 0.35, w.hue[2] * 0.2, 0.25)
    ptc.emit('flash')

    // second, smaller, brighter crown offset forward — depth in the flash
    p.x = px + _f.x * 0.10; p.y = py + _f.y * 0.10; p.z = pz + _f.z * 0.10
    p.life = w.life * 0.62
    p.size0 = w.flash * 0.42 * scl
    p.size1 = w.flash * 0.72 * scl
    p.rot = Math.random() * Math.PI * 2
    p.frameRate = 4 / (w.life * 0.62)
    p.tint2(3.4, 2.6, 1.9, 1, 2.2, 1.1, 0.4, 0.3)
    ptc.emit('flash')

    // --- hot glow halo -------------------------------------------------------
    p.reset()
    p.x = px; p.y = py; p.z = pz
    p.life = w.life * 1.5
    p.size0 = w.flash * 1.9 * scl
    p.size1 = w.flash * 2.6 * scl
    p.sizeCurve = 0.6
    p.fadeIn = 0.001
    p.tint2(w.hue[0] * 0.7, w.hue[1] * 0.55, w.hue[2] * 0.35, 0.9, 0, 0, 0, 0)
    ptc.emit('glow')

    // --- unburnt powder sparks ----------------------------------------------
    const nsp = Math.round(w.sparks * fx.density)
    for (let i = 0; i < nsp; i++) {
      p.reset()
      const spread = 0.30 + Math.random() * 0.34
      const a = Math.random() * Math.PI * 2
      const sp = 5 + Math.random() * 16
      p.x = px; p.y = py; p.z = pz
      p.vx = (_f.x + (_r.x * Math.cos(a) + _u.x * Math.sin(a)) * spread) * sp
      p.vy = (_f.y + (_r.y * Math.cos(a) + _u.y * Math.sin(a)) * spread) * sp
      p.vz = (_f.z + (_r.z * Math.cos(a) + _u.z * Math.sin(a)) * spread) * sp
      p.drag = 5.5 + Math.random() * 5
      p.gravity = -7
      p.life = 0.10 + Math.random() * 0.26
      p.size0 = (0.030 + Math.random() * 0.030) * scl
      p.size1 = p.size0 * 0.25
      p.stretch = 0.016
      p.frame = 0
      p.fadeIn = 0.001
      const heat = 0.7 + Math.random() * 0.5
      p.tint2(3.6 * heat, 1.9 * heat, 0.55 * heat, 1, 1.6, 0.35, 0.05, 0)
      ptc.emit('spark')
    }

    // --- propellant smoke: a puff now, wisps for the next second -------------
    const nsm = Math.round(w.smoke * fx.density)
    for (let i = 0; i < nsm; i++) {
      p.reset()
      const t = i / Math.max(1, nsm - 1)
      p.x = px + _f.x * t * 0.45 + (Math.random() - 0.5) * 0.1
      p.y = py + _f.y * t * 0.45 + (Math.random() - 0.5) * 0.1
      p.z = pz + _f.z * t * 0.45 + (Math.random() - 0.5) * 0.1
      const sp = 1.4 + Math.random() * 2.6
      p.vx = _f.x * sp + (Math.random() - 0.5) * 0.7
      p.vy = _f.y * sp + 0.35 + Math.random() * 0.5
      p.vz = _f.z * sp + (Math.random() - 0.5) * 0.7
      p.drag = 3.4
      p.gravity = 0.55
      p.life = 0.55 + Math.random() * 0.7
      p.size0 = 0.16 * scl
      p.size1 = (0.85 + Math.random() * 0.6) * scl
      p.sizeCurve = 0.6
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 1.4
      p.frame = Math.random() * 16
      p.frameRate = 6
      p.turb = 0.12
      p.fadeIn = 0.06
      p.delay = t * 0.03
      const g = 0.55 + Math.random() * 0.25
      p.tint2(g * 1.15, g * 1.12, g * 1.08, 0.42, g * 0.55, g * 0.55, g * 0.55, 0)
      ptc.emit('smoke')
    }

    // lingering barrel smoke, entirely GPU-scheduled
    if (fx.quality !== 'low') {
      for (let i = 0; i < 4; i++) {
        p.reset()
        p.x = px; p.y = py; p.z = pz
        p.vx = _f.x * 0.35 + (Math.random() - 0.5) * 0.18
        p.vy = 0.30 + Math.random() * 0.25
        p.vz = _f.z * 0.35 + (Math.random() - 0.5) * 0.18
        p.drag = 1.2
        p.gravity = 0.25
        p.life = 1.5 + Math.random() * 1.1
        p.size0 = 0.10 * scl
        p.size1 = (0.7 + Math.random() * 0.4) * scl
        p.sizeCurve = 0.55
        p.rot = Math.random() * 6.283
        p.rotVel = (Math.random() - 0.5) * 0.7
        p.frame = Math.random() * 16
        p.frameRate = 3.5
        p.turb = 0.22
        p.fadeIn = 0.25
        p.delay = 0.10 + i * 0.22
        p.tint2(0.62, 0.62, 0.64, 0.16, 0.55, 0.55, 0.58, 0)
        ptc.emit('smoke')
      }
    }

    // --- light ---------------------------------------------------------------
    _v3.set(px + _f.x * 0.3, py + _f.y * 0.3, pz + _f.z * 0.3)
    lights.flash(_v3, [1.0, 0.72, 0.34], w.light * fx.lightScale, 11, w.life * 2.4, 2.6, 1)

    if (w.shell) shellEject(position, _r, w.shellSize)
  }

  /**
   * Brass out of the ejection port: right + up + slightly back, tumbling.
   * @param {THREE.Vector3} position ejection port (muzzle is close enough)
   * @param {THREE.Vector3} right    unit vector to the shooter's right
   */
  function shellEject(position, right, size = 1) {
    if (!debris) return
    _r.copy(right)
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0)
    _r.normalize()
    const g = fx.groundY(position.x, position.z)
    debris.shells.spawn(
      position.x - _r.x * 0.05, position.y + 0.02, position.z - _r.z * 0.05,
      _r.x * (2.6 + Math.random() * 1.6) + (Math.random() - 0.5) * 0.6,
      2.4 + Math.random() * 1.4,
      _r.z * (2.6 + Math.random() * 1.6) + (Math.random() - 0.5) * 0.6,
      size, g, [1, 1, 1]
    )
    // tiny ejection puff so the brass doesn't appear from nothing
    const p = ptc.begin()
    p.x = position.x; p.y = position.y; p.z = position.z
    p.vx = _r.x * 0.6; p.vy = 0.5; p.vz = _r.z * 0.6
    p.drag = 4
    p.life = 0.35
    p.size0 = 0.05 * fx.scale
    p.size1 = 0.22 * fx.scale
    p.frame = Math.random() * 16
    p.frameRate = 8
    p.fadeIn = 0.1
    p.tint2(0.7, 0.7, 0.7, 0.16, 0.6, 0.6, 0.6, 0)
    ptc.emit('smoke')
  }

  return { muzzleFlash, shellEject }
}
