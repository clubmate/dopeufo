/**
 * Test scaffolding: build tiny, hand-authored battlefields so every rule can be
 * asserted in isolation. No renderer, no bus, no three.js.
 */
import { makeTile, DIRS, DIR_VEC, DIR_OPPOSITE, COVER_HEIGHT, TILE, ELEV_STEP } from '../src/game/state.js'
import { createSimulation } from '../src/game/index.js'
import { EventBus } from '../src/core/bus.js'

/**
 * A blank flat world of the given size with helpers to sculpt it.
 * Implements the same surface as ctx.world.
 */
export function makeWorld(W = 12, H = 12) {
  const tiles = []
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) tiles.push(makeTile(x, z))
  const at = (x, z) => (x >= 0 && z >= 0 && x < W && z < H ? tiles[x + z * W] : null)

  const world = {
    W, H, TILE, ELEV_STEP, tiles,
    getTile: at,
    isWalkable: (x, z) => !!at(x, z)?.walkable,
    coverAt: (x, z, d) => at(x, z)?.cover?.[d] ?? 0,
    isRamp: (x, z) => !!at(x, z)?.ramp,
    getDeployZone: (team) => {
      const out = []
      const z = team === 0 ? 0 : H - 1
      for (let x = 0; x < W; x++) if (at(x, z)?.walkable) out.push({ x, z, elevation: at(x, z).elevation })
      return out
    },
    blockersForLOS() {
      const out = []
      for (const t of tiles) {
        if (t.propHeight > 0) {
          const base = t.elevation * ELEV_STEP
          out.push({ x: t.x, z: t.z, minY: base, maxY: base + t.propHeight, half: TILE * 0.45, destructible: t.destructible })
        }
      }
      return out
    },
    destroyCover(x, z, dir) {
      const t = at(x, z)
      if (!t) return false
      t.cover[dir] = 0
      const nb = at(x + DIR_VEC[dir].x, z + DIR_VEC[dir].z)
      if (nb) {
        nb.cover[DIR_OPPOSITE[dir]] = 0
        if (nb.solid && nb.destructible) {
          nb.solid = false; nb.walkable = true; nb.propHeight = 0
          for (const d of DIRS) {
            const a = at(nb.x + DIR_VEC[d].x, nb.z + DIR_VEC[d].z)
            if (a) a.cover[DIR_OPPOSITE[d]] = 0
          }
        }
      }
      return true
    },

    // --- sculpting helpers (test-only) ---
    block(x, z) { const t = at(x, z); if (t) { t.walkable = false; t.solid = true } return world },
    elevate(x, z, e) { const t = at(x, z); if (t) t.elevation = e; return world },
    ramp(x, z, e) { const t = at(x, z); if (t) { t.elevation = e; t.ramp = true } return world },
    /** Place a solid cover prop on (x,z) and give the neighbours edge cover. */
    prop(x, z, value = 2, { destructible = true } = {}) {
      const t = at(x, z)
      if (!t) return world
      t.walkable = false
      t.solid = true
      t.destructible = destructible
      t.propHeight = COVER_HEIGHT[value]
      for (const d of DIRS) {
        const nb = at(x + DIR_VEC[d].x, z + DIR_VEC[d].z)
        if (nb) nb.cover[DIR_OPPOSITE[d]] = value
      }
      return world
    },
    /** Cover on a tile edge with no prop tile behind it (a low wall). */
    edgeCover(x, z, dir, value = 2) {
      const t = at(x, z)
      if (t) t.cover[dir] = value
      const nb = at(x + DIR_VEC[dir].x, z + DIR_VEC[dir].z)
      if (nb) nb.cover[DIR_OPPOSITE[dir]] = value
      return world
    },
  }
  return world
}

/** A simulation with a hand-built world and no units deployed. */
export function makeSim(world, { seed = 'test', bus = null } = {}) {
  return createSimulation({ world, bus, units: null, grid: { W: world.W, H: world.H }, seed, squads: false })
}

/** Drop a unit into a sim at a specific tile. */
export function place(sim, unit, x, z) {
  unit.x = x
  unit.z = z
  unit.elevation = sim.world.getTile(x, z)?.elevation || 0
  sim.state.units.push(unit)
  sim.rules.syncOccupancy()
  return unit
}

/** Record every bus event in order — used to assert action sequencing. */
export function recorder(bus) {
  const events = []
  const orig = bus.emit.bind(bus)
  bus.emit = (name, payload) => { events.push({ name, payload }); return orig(name, payload) }
  return {
    events,
    names: () => events.map((e) => e.name),
    of: (name) => events.filter((e) => e.name === name),
    clear: () => { events.length = 0 },
  }
}

export { EventBus }
