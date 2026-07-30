/**
 * GameState + the world adapter.
 *
 * Two jobs:
 *
 *  1. `createGameState()` — the live `GameState` record from ARCHITECTURE.md.
 *  2. `adaptWorld()` — normalise whatever `ctx.world` gives us into the exact
 *     surface the rules need, and synthesise a complete fallback battlefield if
 *     the world module is missing or half-built. The simulation must run and be
 *     testable with no renderer and no world module at all.
 *
 * Direction convention (fixed here, used everywhere in game/):
 *   n = -Z,  s = +Z,  e = +X,  w = -X
 * which matches `facing = 0` looking down +Z from ARCHITECTURE.md.
 */

import { createRNG } from './rng.js'

export const DIRS = ['n', 'e', 's', 'w']
export const DIR_VEC = { n: { x: 0, z: -1 }, e: { x: 1, z: 0 }, s: { x: 0, z: 1 }, w: { x: -1, z: 0 } }
export const DIR_OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' }

export const TILE = 2.0
export const ELEV_STEP = 2.0

/** Height (metres) of a cover object by cover value. Used for 3D LOS. */
export const COVER_HEIGHT = { 0: 0, 1: 1.0, 2: 2.4 }

// ---------------------------------------------------------------------------
// GameState
// ---------------------------------------------------------------------------

export function createGameState({ seed = 'dopeufo' } = {}) {
  return {
    turn: 1,
    activeTeam: 0,
    phase: 'select', // 'select' | 'moving' | 'targeting' | 'animating' | 'over'
    units: [],
    selectedUnitId: null,
    targetUnitId: null,
    pendingAction: null,
    winner: null,

    // additive bookkeeping
    seed,
    started: false,
    log: [],
  }
}

export function unitById(state, id) {
  if (!id) return null
  for (const u of state.units) if (u.id === id) return u
  return null
}

export function unitAt(state, x, z) {
  for (const u of state.units) if (u.alive && u.x === x && u.z === z) return u
  return null
}

export function teamUnits(state, team, aliveOnly = true) {
  return state.units.filter((u) => u.team === team && (!aliveOnly || u.alive))
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export function makeTile(x, z) {
  return {
    x, z,
    elevation: 0,
    walkable: true,
    cost: 1,
    occupantId: null,
    cover: { n: 0, e: 0, s: 0, w: 0 },
    destructible: false,
    hazard: null,
    // additive
    ramp: false,
    solid: false,      // a full-height blocker occupies this tile
    propHeight: 0,     // metres of blocking geometry standing on this tile
  }
}

// ---------------------------------------------------------------------------
// Fallback battlefield — used when ctx.world is missing, and by every headless
// test. Deterministic for a given seed.
// ---------------------------------------------------------------------------

export function createFallbackWorld({ W = 24, H = 24, seed = 'fallback-world' } = {}) {
  const rng = createRNG(seed)
  const tiles = []
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) tiles.push(makeTile(x, z))

  const at = (x, z) => (x >= 0 && z >= 0 && x < W && z < H ? tiles[x + z * W] : null)

  // --- central plateau, 2 levels up, reachable only via the ramp shelf -------
  const px0 = 9, px1 = 14, pz0 = 9, pz1 = 14
  for (let z = pz0; z <= pz1; z++) {
    for (let x = px0; x <= px1; x++) {
      const t = at(x, z)
      if (t) t.elevation = 2
    }
  }
  // ramp shelf on the north face: elevation 1, flagged as a ramp
  for (let x = px0 + 1; x <= px1 - 1; x++) {
    const t = at(x, pz0 - 1)
    if (t) { t.elevation = 1; t.ramp = true }
  }

  // --- scattered cover -------------------------------------------------------
  // Solid props occupy their own tile; adjacent tiles inherit edge cover facing
  // the prop. That is how the real world module builds cover too, so the rules
  // never care which of the two produced the map.
  const propCount = 46
  let placed = 0
  let guard = 0
  while (placed < propCount && guard++ < 4000) {
    const x = rng.int(W)
    const z = rng.int(H)
    const t = at(x, z)
    if (!t || t.solid) continue
    if (z < 4 || z > H - 5) continue                     // keep deploy zones clear
    if (x >= px0 - 1 && x <= px1 + 1 && z >= pz0 - 2 && z <= pz1 + 1) continue
    // don't wall off a corridor: never place next to 3+ existing props
    let n = 0
    for (const d of DIRS) {
      const nb = at(x + DIR_VEC[d].x, z + DIR_VEC[d].z)
      if (nb && nb.solid) n++
    }
    if (n >= 2) continue

    const full = rng.next() < 0.4
    t.solid = true
    t.walkable = false
    t.propHeight = full ? COVER_HEIGHT[2] : COVER_HEIGHT[1]
    t.destructible = !full || rng.next() < 0.5
    t.coverValue = full ? 2 : 1
    placed++
  }

  // --- derive edge cover for walkable tiles ---------------------------------
  for (const t of tiles) {
    if (!t.walkable) continue
    for (const d of DIRS) {
      const nb = at(t.x + DIR_VEC[d].x, t.z + DIR_VEC[d].z)
      if (nb && nb.solid) t.cover[d] = nb.coverValue
      // a drop of 2+ levels behind you is also cover (a ledge)
      else if (nb && nb.elevation - t.elevation >= 1) t.cover[d] = Math.max(t.cover[d], nb.elevation - t.elevation >= 2 ? 2 : 1)
    }
    t.destructible = DIRS.some((d) => {
      const nb = at(t.x + DIR_VEC[d].x, t.z + DIR_VEC[d].z)
      return nb && nb.solid && nb.destructible
    })
  }

  const deploy = {
    0: [],
    1: [],
  }
  for (let z = 1; z <= 3; z++) for (let x = 4; x < W - 4; x++) if (at(x, z)?.walkable) deploy[0].push({ x, z, elevation: at(x, z).elevation })
  for (let z = H - 4; z <= H - 2; z++) for (let x = 4; x < W - 4; x++) if (at(x, z)?.walkable) deploy[1].push({ x, z, elevation: at(x, z).elevation })

  const world = {
    W, H, TILE, ELEV_STEP,
    tiles,
    isFallback: true,

    getTile: (x, z) => at(x, z),
    isWalkable: (x, z) => !!at(x, z)?.walkable,
    coverAt: (x, z, dir) => at(x, z)?.cover?.[dir] ?? 0,
    isRamp: (x, z) => !!at(x, z)?.ramp,
    getDeployZone: (team) => deploy[team] || [],

    blockersForLOS() {
      const out = []
      for (const t of tiles) {
        const base = t.elevation * ELEV_STEP
        if (t.propHeight > 0) {
          out.push({
            x: t.x, z: t.z,
            minY: base, maxY: base + t.propHeight,
            half: TILE * 0.45,
            destructible: t.destructible,
          })
        }
      }
      return out
    },

    destroyCover(x, z, dir) {
      const t = at(x, z)
      if (!t) return false
      const behind = at(x + DIR_VEC[dir].x, z + DIR_VEC[dir].z)
      // only cover backed by a destructible prop can be blown away
      if (!behind?.solid || !behind.destructible) return false
      let changed = false
      if (t.cover?.[dir]) { t.cover[dir] = 0; changed = true }
      const nb = behind
      if (nb && nb.solid && nb.destructible) {
        nb.solid = false
        nb.walkable = true
        nb.propHeight = 0
        nb.coverValue = 0
        // strip the mirrored cover every neighbour was getting from this prop
        for (const d of DIRS) {
          const around = at(nb.x + DIR_VEC[d].x, nb.z + DIR_VEC[d].z)
          if (around) around.cover[DIR_OPPOSITE[d]] = 0
        }
        changed = true
      }
      return changed
    },
  }

  return world
}

// ---------------------------------------------------------------------------
// World adapter — never trust the other agent's module to be complete.
// ---------------------------------------------------------------------------

/**
 * Wrap `ctx.world` (which may be null, partial or still under construction) in a
 * total, defensive API. Any method the world module doesn't provide is served by
 * the fallback battlefield instead, per-method, so a half-finished world module
 * degrades gracefully rather than exploding.
 */
export function adaptWorld(world, grid = { W: 24, H: 24 }) {
  const W = world?.W ?? grid?.W ?? 24
  const H = world?.H ?? grid?.H ?? 24
  const fallback = createFallbackWorld({ W, H })
  const src = world && typeof world === 'object' ? world : null

  const call = (name, args, fb) => {
    if (src && typeof src[name] === 'function') {
      try {
        const v = src[name](...args)
        if (v !== undefined && v !== null) return v
      } catch (err) {
        console.warn(`[game] world.${name} threw — using fallback`, err)
      }
    }
    return fb()
  }

  let usingFallbackTiles = true
  try {
    usingFallbackTiles = !(src && typeof src.getTile === 'function' && src.getTile(0, 0))
  } catch {
    usingFallbackTiles = true
  }

  const api = {
    W, H, TILE, ELEV_STEP,
    usingFallbackTiles,
    real: src,

    getTile(x, z) {
      if (x < 0 || z < 0 || x >= W || z >= H) return null
      const t = call('getTile', [x, z], () => fallback.getTile(x, z))
      if (!t) return null
      // normalise: guarantee every field the rules read exists
      if (!t.cover) t.cover = { n: 0, e: 0, s: 0, w: 0 }
      if (t.elevation == null) t.elevation = 0
      if (t.walkable == null) t.walkable = true
      if (t.cost == null || !(t.cost > 0)) t.cost = 1
      if (t.x == null) t.x = x
      if (t.z == null) t.z = z
      return t
    },

    isWalkable(x, z) {
      if (x < 0 || z < 0 || x >= W || z >= H) return false
      if (src && typeof src.isWalkable === 'function') {
        try { return !!src.isWalkable(x, z) } catch { /* fall through */ }
      }
      return !!api.getTile(x, z)?.walkable
    },

    coverAt(x, z, dir) {
      const t = api.getTile(x, z)
      if (t?.cover && t.cover[dir] != null) return t.cover[dir] | 0
      if (src && typeof src.coverAt === 'function') {
        try { return (src.coverAt(x, z, dir) | 0) || 0 } catch { /* ignore */ }
      }
      return 0
    },

    isRamp(x, z) {
      if (src && typeof src.isRamp === 'function') {
        try { return !!src.isRamp(x, z) } catch { /* ignore */ }
      }
      const t = api.getTile(x, z)
      return !!(t?.ramp || t?.stairs)
    },

    getDeployZone(team) {
      const z = call('getDeployZone', [team], () => fallback.getDeployZone(team))
      const list = Array.isArray(z) ? z : []
      const valid = list.filter((t) => t && api.isWalkable(t.x, t.z))
      return valid.length ? valid : fallback.getDeployZone(team).filter((t) => api.isWalkable(t.x, t.z))
    },

    /**
     * World-space AABB blockers for LOS, normalised to
     * `{ minX,minY,minZ, maxX,maxY,maxZ, cells:Set<key> }`.
     *
     * The world module returns `Mesh[]` with a `.boxes` Box3[] sidecar; the
     * fallback returns plain records. Both, plus `{position,size}` objects, are
     * accepted so a world rewrite upstream cannot silently blind the rules.
     *
     * Cover we have destroyed is pruned here: the world keeps its proxy mesh
     * list stable, so without this a blown-up crate would keep blocking sight.
     */
    blockersForLOS() {
      const raw = call('blockersForLOS', [], () => fallback.blockersForLOS())
      let list = Array.isArray(raw) ? raw : []
      if (Array.isArray(raw?.boxes) && raw.boxes.length) list = raw.boxes
      const boxes = normalizeBlockers(list, W, H)
      if (!destroyed.size) return boxes
      return boxes.filter((b) => !destroyedInside(b))
    },

    destroyCover(x, z, dir) {
      // The real world owns its tile data (`level._clearEdge` updates both
      // sides), so delegate and trust its verdict — an indestructible wall must
      // stay standing in the rules too.
      if (src && typeof src.destroyCover === 'function') {
        let ok = false
        try { ok = src.destroyCover(x, z, dir) === true } catch (err) {
          console.warn('[game] world.destroyCover threw', err)
        }
        if (ok) markDestroyed(x, z, dir)
        return ok
      }

      let changed = false
      const t = api.getTile(x, z)
      if (t?.cover?.[dir]) { t.cover[dir] = 0; changed = true }
      const nx = x + DIR_VEC[dir].x
      const nz = z + DIR_VEC[dir].z
      const nb = api.getTile(nx, nz)
      if (nb?.cover) { nb.cover[DIR_OPPOSITE[dir]] = 0 }
      if (nb && (nb.solid || nb.propHeight) && nb.destructible !== false) {
        nb.solid = false; nb.walkable = true; nb.propHeight = 0; nb.coverValue = 0
        for (const d of DIRS) {
          const around = api.getTile(nx + DIR_VEC[d].x, nz + DIR_VEC[d].z)
          if (around?.cover) around.cover[DIR_OPPOSITE[d]] = 0
        }
        changed = true
      }
      if (changed) markDestroyed(x, z, dir)
      return changed
    },
  }

  // --- destroyed-cover bookkeeping ----------------------------------------
  /** World-space midpoints of edges whose cover we have removed. */
  const destroyed = new Set()

  function markDestroyed(x, z, dir) {
    const nx = x + DIR_VEC[dir].x
    const nz = z + DIR_VEC[dir].z
    const a = toWorld(x, z, api.getTile(x, z)?.elevation || 0, W, H)
    const b = toWorld(nx, nz, api.getTile(nx, nz)?.elevation || 0, W, H)
    destroyed.add(`${(a.x + b.x) / 2},${(a.y + b.y) / 2},${(a.z + b.z) / 2}`)
  }

  function destroyedInside(box) {
    for (const k of destroyed) {
      const [px, py, pz] = k.split(',').map(Number)
      if (px >= box.minX - 0.1 && px <= box.maxX + 0.1 &&
          pz >= box.minZ - 0.1 && pz <= box.maxZ + 0.1 &&
          py >= box.minY - 0.6 && py <= box.maxY + 0.1) return true
    }
    return false
  }

  return api
}

export function normalizeBlockers(raw, W, H) {
  const out = []
  for (const b of raw) {
    if (!b) continue
    let minX, minY, minZ, maxX, maxY, maxZ
    if (b.min && b.max) {
      minX = b.min.x; minY = b.min.y ?? 0; minZ = b.min.z
      maxX = b.max.x; maxY = b.max.y ?? 2.4; maxZ = b.max.z
    } else if (b.userData?.losBox) {
      const L = b.userData.losBox
      minX = L.cx - L.hx; maxX = L.cx + L.hx
      minY = L.cy - L.hy; maxY = L.cy + L.hy
      minZ = L.cz - L.hz; maxZ = L.cz + L.hz
    } else if (b.isMesh && b.position && b.scale) {
      // a unit-cube proxy mesh: position + scale is the box
      minX = b.position.x - b.scale.x / 2; maxX = b.position.x + b.scale.x / 2
      minY = b.position.y - b.scale.y / 2; maxY = b.position.y + b.scale.y / 2
      minZ = b.position.z - b.scale.z / 2; maxZ = b.position.z + b.scale.z / 2
    } else if (b.position && b.size) {
      const p = b.position, s = b.size
      minX = p.x - s.x / 2; maxX = p.x + s.x / 2
      minY = (p.y ?? 0) - (s.y ?? 2.4) / 2; maxY = (p.y ?? 0) + (s.y ?? 2.4) / 2
      minZ = p.z - s.z / 2; maxZ = p.z + s.z / 2
    } else if (b.x != null && b.z != null) {
      const half = b.half ?? TILE * 0.45
      const cx = (b.x - W / 2 + 0.5) * TILE
      const cz = (b.z - H / 2 + 0.5) * TILE
      minX = cx - half; maxX = cx + half
      minZ = cz - half; maxZ = cz + half
      minY = b.minY ?? 0
      maxY = b.maxY ?? (b.height != null ? (b.minY ?? 0) + b.height : 2.4)
    } else continue

    if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) continue

    // grid footprint, for the "own cover doesn't block me" exemption
    const uMin = minX / TILE + W / 2
    const uMax = maxX / TILE + W / 2
    const vMin = minZ / TILE + H / 2
    const vMax = maxZ / TILE + H / 2
    const cells = new Set()
    for (let cx = Math.floor(uMin + 1e-6); cx <= Math.floor(uMax - 1e-6); cx++) {
      for (let cz = Math.floor(vMin + 1e-6); cz <= Math.floor(vMax - 1e-6); cz++) {
        if (cx >= 0 && cz >= 0 && cx < W && cz < H) cells.add(cx + cz * W)
      }
    }
    out.push({ minX, minY, minZ, maxX, maxY, maxZ, cells, destructible: !!b.destructible })
  }
  return out
}

/** Canonical grid -> world conversion (mirrors src/core/grid.js without three). */
export function toWorld(x, z, elevation = 0, W = 24, H = 24) {
  return {
    x: (x - W / 2 + 0.5) * TILE,
    y: elevation * ELEV_STEP,
    z: (z - H / 2 + 0.5) * TILE,
  }
}
