/**
 * Cover & flanking geometry.
 *
 * Cover is directional. A crate on your north side does nothing about a shooter
 * standing due east of you — that shooter is FLANKING, which in XCOM terms means
 * your cover value is 0 against them and they get a large crit bonus.
 *
 * The test: cover on side `d` protects against an attacker iff the attacker lies
 * in the outward half-plane of that side, i.e. dot(normal_d, dirToAttacker) > 0.
 * Exactly perpendicular (dot === 0) does NOT protect — that is the flank line,
 * and it is why "move one tile to the side" is the core tactical verb.
 *
 * A target with no applicable cover is FLANKED (this matches XCOM 2: standing in
 * the open makes you flankable, not merely uncovered).
 */

import { DIRS, DIR_VEC } from './state.js'

export const COVER_PENALTY = { 0: 0, 1: 20, 2: 40 }

export function createCover({ world, state, los }) {
  /**
   * Cover the tile (x,z) grants against an attacker at (ax,az).
   * @returns {{ value:0|1|2, flanked:boolean, coverDir:string|null, sides:object, applicable:string[] }}
   */
  function coverAtTileFrom(x, z, ax, az) {
    const tile = world.getTile(x, z)
    const sides = tile?.cover ? { ...tile.cover } : { n: 0, e: 0, s: 0, w: 0 }
    const dx = ax - x
    const dz = az - z
    const len = Math.hypot(dx, dz)

    if (len === 0) {
      return { value: 0, flanked: false, coverDir: null, sides, applicable: [] }
    }
    const ux = dx / len
    const uz = dz / len

    let best = 0
    let bestDir = null
    const applicable = []
    for (const d of DIRS) {
      const v = sides[d] | 0
      if (v <= 0) continue
      const n = DIR_VEC[d]
      const dot = n.x * ux + n.z * uz
      if (dot > 1e-9) {
        applicable.push(d)
        if (v > best) { best = v; bestDir = d }
      }
    }

    return {
      value: best,
      flanked: best === 0,
      coverDir: bestDir,
      sides,
      applicable,
    }
  }

  /**
   * Cover the target has against this attacker.
   * @returns {{ value:0|1|2, flanked:boolean, coverDir:string|null, penalty:number, hunkered:boolean }}
   */
  function coverBetween(attacker, target) {
    if (!attacker || !target) {
      return { value: 0, flanked: true, coverDir: null, penalty: 0, hunkered: false, sides: { n: 0, e: 0, s: 0, w: 0 }, applicable: [] }
    }
    const r = coverAtTileFrom(target.x, target.z, attacker.x, attacker.z)
    const hunkered = !!target.hunkered && r.value > 0
    const penalty = COVER_PENALTY[r.value] * (hunkered ? 2 : 1)
    return { ...r, penalty, hunkered }
  }

  /** Best cover value the tile offers in any direction (for the move overlay). */
  function bestCoverAt(x, z) {
    const t = world.getTile(x, z)
    if (!t?.cover) return { value: 0, dir: null }
    let best = 0
    let dir = null
    for (const d of DIRS) {
      const v = t.cover[d] | 0
      if (v > best) { best = v; dir = d }
    }
    return { value: best, dir }
  }

  /**
   * What cover would `unit` get if it moved to (x,z)? Per known enemy, plus a
   * summary the UI can render as the little shield pips on a hovered tile.
   */
  function previewCoverAt(unit, x, z) {
    const tile = world.getTile(x, z)
    const sides = tile?.cover ? { ...tile.cover } : { n: 0, e: 0, s: 0, w: 0 }
    const best = bestCoverAt(x, z)
    const vsEnemies = []
    let worst = 3
    let exposedTo = 0

    for (const e of state.units) {
      if (!e.alive || e.team === unit.team) continue
      const visible = los ? los.hasLOS({ x, z }, e) : true
      const r = coverAtTileFrom(x, z, e.x, e.z)
      if (visible) {
        worst = Math.min(worst, r.value)
        if (r.value === 0) exposedTo++
      }
      vsEnemies.push({
        unitId: e.id,
        value: r.value,
        flanked: r.flanked,
        coverDir: r.coverDir,
        exposed: visible && r.value === 0,
        visible,
      })
    }

    return {
      x, z,
      elevation: tile?.elevation || 0,
      sides,
      best: best.value,
      bestDir: best.dir,
      /** the cover value that actually matters: the worst against any enemy that can see you */
      effective: worst === 3 ? best.value : worst,
      exposedTo,
      vsEnemies,
    }
  }

  /** True if `attacker` flanks `target` right now. */
  function isFlanking(attacker, target) {
    return coverBetween(attacker, target).flanked
  }

  /**
   * Height advantage: attacker's tile elevation strictly greater than target's.
   */
  function hasHeightAdvantage(attacker, target) {
    return (attacker?.elevation | 0) > (target?.elevation | 0)
  }

  /** Which tile edge of (x,z) faces (ax,az) most directly — for destroy-cover. */
  function facingDir(x, z, ax, az) {
    const dx = ax - x
    const dz = az - z
    if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'e' : 'w'
    return dz >= 0 ? 's' : 'n'
  }

  return {
    coverBetween, coverAtTileFrom, previewCoverAt, bestCoverAt,
    isFlanking, hasHeightAdvantage, facingDir,
    COVER_PENALTY,
    dispose() {},
  }
}
