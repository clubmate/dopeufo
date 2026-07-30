/**
 * Tracer rounds.
 *
 * A tracer is a stretched additive billboard whose quad is pinned to its own
 * screen-space velocity vector, so it self-elongates without any CPU work. The
 * trail is not an emitter: it is N extra particles spawned in the SAME batch
 * with staggered `delay` values. A particle with delay τ sits exactly
 * `velocity * τ` behind the head for its whole flight, so the comet tail is
 * free — the CPU touches a tracer twice in its life (spawn and arrival).
 *
 * Speed matters: real rifle rounds are ~800 m/s, which at tactical scale is a
 * single frame and reads as an instant hitscan. XCOM cheats to ~90-140 m/s so
 * the eye can follow the round to the target — and, critically, so a MISS can
 * be seen sailing past and striking something behind.
 */
import * as THREE from 'three'

const _dir = new THREE.Vector3()

export function createTracers(fx) {
  const { ptc } = fx
  /** @type {{t:number, fn:Function}[]} pending arrivals, sorted-ish by time */
  const pending = []

  const PROFILES = {
    rifle:   { speed: 125, size: 0.075, stretch: 0.055, trail: 7, color: [3.4, 1.55, 0.42] },
    smg:     { speed: 105, size: 0.062, stretch: 0.050, trail: 5, color: [3.2, 1.45, 0.40] },
    pistol:  { speed: 95,  size: 0.060, stretch: 0.048, trail: 5, color: [3.2, 1.40, 0.40] },
    sniper:  { speed: 190, size: 0.090, stretch: 0.070, trail: 9, color: [3.6, 2.10, 0.85] },
    shotgun: { speed: 90,  size: 0.048, stretch: 0.038, trail: 3, color: [3.0, 1.25, 0.35] },
    cannon:  { speed: 70,  size: 0.130, stretch: 0.060, trail: 8, color: [3.5, 1.10, 0.25] },
    plasma:  { speed: 85,  size: 0.130, stretch: 0.065, trail: 8, color: [0.55, 2.2, 3.6] },
  }

  /**
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {object} opts { weapon, speed, delay, color, scale, smokeTrail }
   * @returns {Promise<void>} resolves the instant the round reaches `to`
   */
  function tracer(from, to, opts = {}) {
    const prof = PROFILES[opts.weapon] || PROFILES.rifle
    const speed = opts.speed || prof.speed
    const color = opts.color || prof.color
    const sizeK = (opts.scale || 1) * fx.scale

    _dir.set(to.x - from.x, to.y - from.y, to.z - from.z)
    const dist = _dir.length()
    if (dist < 1e-4) return Promise.resolve()
    _dir.divideScalar(dist)

    // Clamped so point-blank shots are still readable and cross-map shots
    // don't stall the turn.
    const travel = Math.min(0.62, Math.max(0.055, dist / speed))
    const vx = _dir.x * (dist / travel)
    const vy = _dir.y * (dist / travel)
    const vz = _dir.z * (dist / travel)
    const delay = opts.delay || 0

    const p = ptc.begin()

    // --- head ---------------------------------------------------------------
    p.x = from.x; p.y = from.y; p.z = from.z
    p.vx = vx; p.vy = vy; p.vz = vz
    p.life = travel
    p.size0 = prof.size * sizeK
    p.size1 = prof.size * sizeK * 0.9
    p.stretch = prof.stretch
    p.frame = 0                    // comet sprite: hot head, tapered tail
    p.fadeIn = 0.0005
    p.delay = delay
    p.tint2(color[0], color[1], color[2], 1, color[0] * 0.8, color[1] * 0.7, color[2] * 0.6, 1)
    ptc.emit('spark')

    // --- soft halo so the round has presence against dark geometry ----------
    p.reset()
    p.x = from.x; p.y = from.y; p.z = from.z
    p.vx = vx; p.vy = vy; p.vz = vz
    p.life = travel
    p.size0 = prof.size * sizeK * 4.2
    p.size1 = prof.size * sizeK * 4.2
    p.fadeIn = 0.0005
    p.delay = delay
    p.tint2(color[0] * 0.20, color[1] * 0.16, color[2] * 0.13, 0.55,
            color[0] * 0.16, color[1] * 0.12, color[2] * 0.10, 0.55)
    ptc.emit('glow')

    // --- comet tail ---------------------------------------------------------
    const nTrail = fx.quality === 'low' ? Math.ceil(prof.trail * 0.5) : prof.trail
    const step = Math.min(0.010, travel / (nTrail + 2))
    for (let i = 1; i <= nTrail; i++) {
      const k = i / nTrail
      p.reset()
      p.x = from.x; p.y = from.y; p.z = from.z
      p.vx = vx; p.vy = vy; p.vz = vz
      p.delay = delay + i * step
      p.life = Math.max(0.02, travel - i * step)
      p.size0 = prof.size * sizeK * (1 - k * 0.72)
      p.size1 = prof.size * sizeK * (1 - k * 0.85)
      p.stretch = prof.stretch * (1 - k * 0.35)
      p.frame = 2                  // thin streak
      p.fadeIn = 0.0005
      const f = (1 - k) * (1 - k)
      p.tint2(color[0] * f, color[1] * f, color[2] * f, 0.9 * f,
              color[0] * f * 0.3, color[1] * f * 0.2, color[2] * f * 0.15, 0)
      ptc.emit('spark')
    }

    // --- faint powder haze marking the flight line ---------------------------
    if (opts.smokeTrail !== false && fx.quality !== 'low' && dist > 4) {
      const n = Math.min(7, Math.round(dist * 0.5))
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n
        p.reset()
        p.x = from.x + _dir.x * dist * t
        p.y = from.y + _dir.y * dist * t
        p.z = from.z + _dir.z * dist * t
        p.vx = (Math.random() - 0.5) * 0.25
        p.vy = 0.15 + Math.random() * 0.2
        p.vz = (Math.random() - 0.5) * 0.25
        p.drag = 1.5
        p.life = 0.5 + Math.random() * 0.5
        p.size0 = 0.06 * fx.scale
        p.size1 = (0.30 + Math.random() * 0.2) * fx.scale
        p.rot = Math.random() * 6.283
        p.frame = Math.random() * 16
        p.frameRate = 5
        p.turb = 0.1
        p.fadeIn = 0.2
        p.delay = delay + travel * t
        p.tint2(0.7, 0.7, 0.72, 0.09, 0.6, 0.6, 0.62, 0)
        ptc.emit('smoke')
      }
    }

    return new Promise((resolve) => {
      pending.push({ t: fx.now() + delay + travel, fn: resolve })
    })
  }

  function update() {
    if (!pending.length) return
    const now = fx.now()
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].t <= now) {
        const fn = pending[i].fn
        pending.splice(i, 1)
        try { fn() } catch (e) { console.error('[fx] tracer callback', e) }
      }
    }
  }

  return { tracer, update, PROFILES, get pending() { return pending.length } }
}
