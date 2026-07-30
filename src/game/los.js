/**
 * True 3D line of sight.
 *
 * A ray is cast from the shooter's eye (1.6 m over their tile's floor) to the
 * target's centre of mass (0.9 m). Three things can stop it:
 *
 *   1. Terrain — the top surface of an intervening tile is above the ray.
 *   2. Full-cover geometry — AABB blockers from `world.blockersForLOS()`.
 *   3. Full-cover tile edges (`tile.cover[dir] === 2`) that the ray crosses.
 *
 * PEEKING (the classic bug this file exists to not have):
 * a unit's own cover must never block its own shot, and a target's cover must
 * never make it unshootable — cover is a to-hit penalty, not an LOS wall. So
 * both endpoints contribute an *exemption set*: their own tile, plus every
 * neighbouring tile that is the source of cover for them. Geometry inside the
 * exemption set is ignored. That is the model of a soldier stepping out from
 * behind their crate to fire, and stepping back.
 *
 * SYMMETRY: hasLOS(a,b) === hasLOS(b,a) by construction — the eye->COM ray is
 * directional, so we accept LOS if either direction is clear. "I can shoot you
 * but you can't shoot me" is never acceptable in a PvP tactics game.
 */

import { DIRS, DIR_VEC, DIR_OPPOSITE, ELEV_STEP, TILE, COVER_HEIGHT } from './state.js'

const EPS = 1e-6
const H_EPS = 0.02

export function createLOS({ world, state }) {
  const W = world.W
  const H = world.H
  const key = (x, z) => x + z * W

  let blockerCache = null
  function blockers() {
    if (!blockerCache) blockerCache = world.blockersForLOS()
    return blockerCache
  }
  function invalidate() { blockerCache = null }

  function floorY(x, z) {
    return (world.getTile(x, z)?.elevation || 0) * ELEV_STEP
  }

  function eyePoint(u) {
    return { x: u.x, z: u.z, y: floorY(u.x, u.z) + (u.eyeHeight ?? 1.6) }
  }
  function comPoint(u) {
    return { x: u.x, z: u.z, y: floorY(u.x, u.z) + (u.comHeight ?? 0.9) }
  }

  /**
   * Tiles whose geometry does not block this endpoint: its own tile plus every
   * neighbour that is the source of its cover.
   */
  function exemptCells(x, z) {
    const s = new Set([key(x, z)])
    const t = world.getTile(x, z)
    if (t?.cover) {
      for (const d of DIRS) {
        if ((t.cover[d] | 0) > 0) {
          const nx = x + DIR_VEC[d].x
          const nz = z + DIR_VEC[d].z
          if (nx >= 0 && nz >= 0 && nx < W && nz < H) s.add(key(nx, nz))
        }
      }
    }
    return s
  }

  /**
   * Walk the grid along the 2D projection of the segment (Amanatides & Woo).
   * Yields one record per tile boundary crossed:
   *   { t, from:{x,z}, to:{x,z}, dirOut, dirIn }
   */
  function traverse(x0, z0, x1, z1) {
    const out = []
    const u0 = x0 + 0.5, v0 = z0 + 0.5
    const u1 = x1 + 0.5, v1 = z1 + 0.5
    const du = u1 - u0
    const dv = v1 - v0

    let x = x0, z = z0
    const stepX = du > 0 ? 1 : du < 0 ? -1 : 0
    const stepZ = dv > 0 ? 1 : dv < 0 ? -1 : 0
    const invDu = du !== 0 ? 1 / Math.abs(du) : Infinity
    const invDv = dv !== 0 ? 1 / Math.abs(dv) : Infinity
    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? x + 1 - u0 : u0 - x) * invDu
    let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? z + 1 - v0 : v0 - z) * invDv

    let guard = 0
    while (guard++ < (W + H) * 4) {
      if (tMaxX > 1 + EPS && tMaxZ > 1 + EPS) break
      let dirOut, t
      if (tMaxX <= tMaxZ) {
        t = tMaxX
        dirOut = stepX > 0 ? 'e' : 'w'
        const from = { x, z }
        x += stepX
        tMaxX += invDu
        out.push({ t, from, to: { x, z }, dirOut, dirIn: DIR_OPPOSITE[dirOut] })
      } else {
        t = tMaxZ
        dirOut = stepZ > 0 ? 's' : 'n'
        const from = { x, z }
        z += stepZ
        tMaxZ += invDv
        out.push({ t, from, to: { x, z }, dirOut, dirIn: DIR_OPPOSITE[dirOut] })
      }
      if (x === x1 && z === z1) break
      if (x < 0 || z < 0 || x >= W || z >= H) break
    }
    return out
  }

  /** Segment vs world-space AABB (slab method), segment param in [0,1]. */
  function segmentHitsBox(a, b, box) {
    let tmin = 0
    let tmax = 1
    const axes = [
      [a.x, b.x - a.x, box.minX, box.maxX],
      [a.y, b.y - a.y, box.minY, box.maxY],
      [a.z, b.z - a.z, box.minZ, box.maxZ],
    ]
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return false
      } else {
        let t1 = (lo - o) / d
        let t2 = (hi - o) / d
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
        if (t1 > tmin) tmin = t1
        if (t2 < tmax) tmax = t2
        if (tmin > tmax) return false
      }
    }
    return true
  }

  function gridToWorld(x, z, y) {
    return { x: (x - W / 2 + 0.5) * TILE, y, z: (z - H / 2 + 0.5) * TILE }
  }

  /**
   * One directed ray test.
   * @param {{x,z,y}} a  grid tile + world Y of the origin
   * @param {{x,z,y}} b  grid tile + world Y of the destination
   * @param {Set<number>} exempt  tile keys whose geometry is ignored
   */
  function rayClear(a, b, exempt) {
    if (a.x === b.x && a.z === b.z) return true
    const crossings = traverse(a.x, a.z, b.x, b.z)
    const dy = b.y - a.y

    for (const c of crossings) {
      const y = a.y + dy * c.t
      const fromKey = key(c.from.x, c.from.z)
      const toKey = key(c.to.x, c.to.z)
      const fromExempt = exempt.has(fromKey)
      const toExempt = exempt.has(toKey)

      const fromT = world.getTile(c.from.x, c.from.z)
      const toT = world.getTile(c.to.x, c.to.z)
      if (!toT) return false // ran off the map

      // 1. full-cover edge
      if (!(fromExempt || toExempt)) {
        const cOut = fromT?.cover ? fromT.cover[c.dirOut] | 0 : 0
        const cIn = toT.cover ? toT.cover[c.dirIn] | 0 : 0
        const cv = Math.max(cOut, cIn)
        if (cv === 2) {
          const base = Math.max((fromT?.elevation || 0), toT.elevation || 0) * ELEV_STEP
          if (y < base + COVER_HEIGHT[2] - H_EPS) return false
        }
      }

      // 2. terrain height of the tile we just entered
      if (!toExempt) {
        const top = (toT.elevation || 0) * ELEV_STEP
        if (y < top - H_EPS) return false
      }
    }

    // 3. AABB blockers
    const wa = gridToWorld(a.x, a.z, a.y)
    const wb = gridToWorld(b.x, b.z, b.y)
    for (const box of blockers()) {
      if (box.cells.size && allExempt(box.cells, exempt)) continue
      if (segmentHitsBox(wa, wb, box)) return false
    }
    return true
  }

  function allExempt(cells, exempt) {
    for (const c of cells) if (!exempt.has(c)) return false
    return true
  }

  function asPos(v) {
    if (!v) return null
    if (typeof v.x === 'number' && typeof v.z === 'number') return v
    return null
  }

  /**
   * @param {object} from unit or {x,z}
   * @param {object} to   unit or {x,z}
   */
  function hasLOS(from, to) {
    const a = asPos(from)
    const b = asPos(to)
    if (!a || !b) return false
    if (a.x === b.x && a.z === b.z) return true

    const exempt = new Set([...exemptCells(a.x, a.z), ...exemptCells(b.x, b.z)])

    const aEye = { x: a.x, z: a.z, y: floorY(a.x, a.z) + (a.eyeHeight ?? 1.6) }
    const bCom = { x: b.x, z: b.z, y: floorY(b.x, b.z) + (b.comHeight ?? 0.9) }
    if (rayClear(aEye, bCom, exempt)) return true

    // mirrored test keeps LOS symmetric
    const bEye = { x: b.x, z: b.z, y: floorY(b.x, b.z) + (b.eyeHeight ?? 1.6) }
    const aCom = { x: a.x, z: a.z, y: floorY(a.x, a.z) + (a.comHeight ?? 0.9) }
    return rayClear(bEye, aCom, exempt)
  }

  /** Would `unit` see `to` if it were standing at (x,z)? Used by move preview. */
  function hasLOSFrom(x, z, to) {
    return hasLOS({ x, z }, to)
  }

  function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))
  }

  function visibleEnemies(unit, { from = null } = {}) {
    if (!unit) return []
    const origin = from || unit
    const out = []
    for (const e of state.units) {
      if (!e.alive || e.team === unit.team) continue
      if (chebyshev(origin, e) > (unit.sightRange ?? 18)) continue
      if (!hasLOS({ x: origin.x, z: origin.z, eyeHeight: unit.eyeHeight, comHeight: unit.comHeight }, e)) continue
      out.push(e)
    }
    return out
  }

  /** Enemies that are both visible and inside weapon range. */
  function getTargets(unit, { from = null } = {}) {
    const origin = from || unit
    const range = unit?.weapon?.range ?? 20
    return visibleEnemies(unit, { from }).filter((e) => euclid(origin, e) <= range)
  }

  function euclid(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z)
  }

  /** Which of `unit`'s enemies can see it right now (for the danger overlay). */
  function seenBy(unit) {
    const out = []
    for (const e of state.units) {
      if (!e.alive || e.team === unit.team) continue
      if (chebyshev(unit, e) > (e.sightRange ?? 18)) continue
      if (hasLOS(e, unit)) out.push(e)
    }
    return out
  }

  return {
    hasLOS, hasLOSFrom, visibleEnemies, getTargets, seenBy,
    traverse, rayClear, exemptCells, segmentHitsBox, euclid, chebyshev,
    invalidate,
    dispose() { blockerCache = null },
  }
}
