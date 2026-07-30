import * as THREE from 'three'

/**
 * Screen -> battlefield picking.
 *
 * The grid is a heightfield: every tile is a slab whose top sits at
 * `elevation * ELEV_STEP`. Naively intersecting the y=0 plane picks the tile
 * *behind* a rooftop, which is exactly the "clicked one tile, game took the
 * neighbour" bug that makes a tactics game unshippable.
 *
 * So we run an Amanatides–Woo 2D DDA across the grid in XZ and, per cell,
 * compare the ray's height against that cell's slab top. First cell where the
 * ray is at-or-below the slab top wins — which also gets *side faces* right
 * (walking the ray into the side of a raised block hits that block, not the
 * ground behind it).
 *
 * Falls back to a flat 24x24 plane at y=0 when `ctx.world` isn't up yet.
 */
export function createPicking(ctx) {
  const grid = ctx.grid
  const camera = ctx.camera
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const ray = { o: new THREE.Vector3(), d: new THREE.Vector3() }

  const state = {
    screen: { x: -1, y: -1 },
    inside: false,
    dirty: false,
    tile: null, // { x, z, elevation, point:Vector3 }
    unitId: null,
    lastTileKey: null,
    lastUnitId: null,
    enabled: true,
  }

  // ---------------------------------------------------------------- terrain

  function tileAt(x, z) {
    if (!grid.inBounds(x, z)) return null
    const w = ctx.world
    if (!w || typeof w.getTile !== 'function') return { x, z, elevation: 0, walkable: true, __fake: true }
    try {
      return w.getTile(x, z) || null
    } catch {
      return null
    }
  }

  function topY(x, z) {
    const t = tileAt(x, z)
    if (!t) return null
    return (t.elevation || 0) * grid.ELEV_STEP
  }

  /**
   * @returns {null | {x:number, z:number, elevation:number, point:THREE.Vector3, t:number}}
   */
  function raycastHeightfield(o, d) {
    const TILE = grid.TILE
    const W = grid.W
    const H = grid.H

    // continuous grid space (cell centres at integer + 0.5)
    let gx = o.x / TILE + W / 2
    let gz = o.z / TILE + H / 2
    const dxg = d.x / TILE
    const dzg = d.z / TILE

    let ix = Math.floor(gx)
    let iz = Math.floor(gz)

    const stepX = dxg > 0 ? 1 : dxg < 0 ? -1 : 0
    const stepZ = dzg > 0 ? 1 : dzg < 0 ? -1 : 0

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dxg) : Infinity
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dzg) : Infinity

    let tMaxX =
      stepX > 0 ? (ix + 1 - gx) / dxg : stepX < 0 ? (ix - gx) / dxg : Infinity
    let tMaxZ =
      stepZ > 0 ? (iz + 1 - gz) / dzg : stepZ < 0 ? (iz - gz) / dzg : Infinity

    // If the camera starts outside the grid, skip forward to the slab entry.
    let t0 = 0
    if (ix < 0 || ix >= W || iz < 0 || iz >= H) {
      const enter = enterT(gx, gz, dxg, dzg, W, H)
      if (enter === null) return null
      t0 = Math.max(0, enter + 1e-4)
      gx = o.x / TILE + W / 2 + dxg * t0
      gz = o.z / TILE + H / 2 + dzg * t0
      ix = Math.floor(gx)
      iz = Math.floor(gz)
      tMaxX = stepX > 0 ? t0 + (ix + 1 - gx) / dxg : stepX < 0 ? t0 + (ix - gx) / dxg : Infinity
      tMaxZ = stepZ > 0 ? t0 + (iz + 1 - gz) / dzg : stepZ < 0 ? t0 + (iz - gz) / dzg : Infinity
      if (ix < 0 || ix >= W || iz < 0 || iz >= H) return null
    }

    const maxSteps = (W + H) * 2 + 8
    let tEnter = t0

    for (let n = 0; n < maxSteps; n++) {
      const tExit = Math.min(tMaxX, tMaxZ)

      if (ix >= 0 && ix < W && iz >= 0 && iz < H) {
        const top = topY(ix, iz)
        if (top !== null) {
          const yIn = o.y + d.y * tEnter
          const yOut = o.y + d.y * tExit
          if (yIn <= top + 1e-4) {
            // ray entered this cell already inside the slab (side face)
            return hit(ix, iz, o, d, tEnter, top)
          }
          if (yOut <= top) {
            const th = (top - o.y) / d.y
            return hit(ix, iz, o, d, Math.max(th, tEnter), top)
          }
        }
      }

      // step
      if (tMaxX < tMaxZ) {
        tEnter = tMaxX
        ix += stepX
        tMaxX += tDeltaX
      } else {
        tEnter = tMaxZ
        iz += stepZ
        tMaxZ += tDeltaZ
      }
      if (ix < 0 || ix >= W || iz < 0 || iz >= H) break
      if (!Number.isFinite(tEnter)) break
    }
    return null
  }

  function hit(x, z, o, d, t, top) {
    const p = new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)
    // snap to the slab top so downstream users get a clean decal height
    p.y = top
    const tile = tileAt(x, z)
    return { x, z, elevation: tile?.elevation || 0, walkable: tile?.walkable !== false, point: p, t }
  }

  /** Parametric distance at which the ray enters the [0,W]x[0,H] footprint. */
  function enterT(gx, gz, dx, dz, W, H) {
    let tmin = -Infinity
    let tmax = Infinity
    for (const [p, dd, lo, hi] of [
      [gx, dx, 0, W],
      [gz, dz, 0, H],
    ]) {
      if (Math.abs(dd) < 1e-9) {
        if (p < lo || p > hi) return null
      } else {
        let ta = (lo - p) / dd
        let tb = (hi - p) / dd
        if (ta > tb) [ta, tb] = [tb, ta]
        tmin = Math.max(tmin, ta)
        tmax = Math.min(tmax, tb)
        if (tmin > tmax) return null
      }
    }
    return tmax < 0 ? null : Math.max(tmin, 0)
  }

  // ------------------------------------------------------------------ units

  function unitObjects() {
    const out = []
    const units = ctx.units
    const list = ctx.state?.units
    if (!units || typeof units.getObject !== 'function' || !Array.isArray(list)) return out
    for (const u of list) {
      if (!u || u.alive === false) continue
      let o = null
      try {
        o = units.getObject(u.id)
      } catch {
        o = null
      }
      if (o && o.visible !== false) {
        o.userData.__unitId = u.id
        out.push(o)
      }
    }
    return out
  }

  function findUnitId(obj) {
    let o = obj
    while (o) {
      if (o.userData?.__unitId) return o.userData.__unitId
      if (o.userData?.unitId) return o.userData.unitId
      o = o.parent
    }
    return null
  }

  // ------------------------------------------------------------------ solve

  function solve() {
    const el = ctx.renderer.domElement
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    ndc.x = ((state.screen.x - rect.left) / rect.width) * 2 - 1
    ndc.y = -((state.screen.y - rect.top) / rect.height) * 2 + 1

    raycaster.setFromCamera(ndc, camera)
    ray.o.copy(raycaster.ray.origin)
    ray.d.copy(raycaster.ray.direction)

    const tileHit = raycastHeightfield(ray.o, ray.d)

    let unitId = null
    const objs = unitObjects()
    if (objs.length) {
      let hits = []
      try {
        raycaster.near = 0.01
        raycaster.far = 1000
        hits = raycaster.intersectObjects(objs, true)
      } catch {
        hits = []
      }
      for (const h of hits) {
        const id = findUnitId(h.object)
        if (!id) continue
        // a unit behind a hill shouldn't be hoverable
        if (tileHit && h.distance > tileHit.t + 1.5) break
        unitId = id
        break
      }
    }

    state.tile = tileHit
    state.unitId = unitId
  }

  function emitHover() {
    const key = state.tile ? grid.key(state.tile.x, state.tile.z) + ':' + state.tile.elevation : null
    if (key !== state.lastTileKey) {
      state.lastTileKey = key
      ctx.bus.emit(
        'tile:hover',
        state.tile ? { x: state.tile.x, z: state.tile.z, elevation: state.tile.elevation } : null
      )
    }
    if (state.unitId !== state.lastUnitId) {
      state.lastUnitId = state.unitId
      ctx.bus.emit('unit:hover', state.unitId ? { unitId: state.unitId } : null)
    }
  }

  // ------------------------------------------------------------------- API

  return {
    /** Called by controls on pointermove; the actual raycast is deferred to the frame. */
    setScreen(x, y) {
      state.screen.x = x
      state.screen.y = y
      state.inside = true
      state.dirty = true
    },

    setEnabled(v) {
      state.enabled = !!v
      if (!v) this.clear()
    },

    /** Run once per frame — raycasts only when the pointer or camera moved. */
    poll(force = false) {
      if (!state.enabled) return
      if (!state.inside) return
      if (!state.dirty && !force) return
      state.dirty = false
      try {
        solve()
      } catch (err) {
        console.warn('[input] pick failed', err)
        state.tile = null
        state.unitId = null
      }
      emitHover()
    },

    /** Camera moved — the tile under a stationary cursor may have changed. */
    invalidate() {
      state.dirty = true
    },

    clear() {
      state.inside = false
      state.tile = null
      state.unitId = null
      if (state.lastTileKey !== null) {
        state.lastTileKey = null
        ctx.bus.emit('tile:hover', null)
      }
      if (state.lastUnitId !== null) {
        state.lastUnitId = null
        ctx.bus.emit('unit:hover', null)
      }
    },

    /** Emit a click for whatever is currently under the cursor. */
    click(button) {
      if (!state.enabled) return
      this.poll(true)
      if (state.unitId) {
        ctx.bus.emit('unit:click', { unitId: state.unitId, button })
        return
      }
      if (state.tile) {
        ctx.bus.emit('tile:click', {
          x: state.tile.x,
          z: state.tile.z,
          elevation: state.tile.elevation,
          button,
        })
      }
    },

    current() {
      return { tile: state.tile, unitId: state.unitId }
    },

    /** Exposed for tests / other systems that need a world ray hit. */
    raycastTile(originV3, dirV3) {
      return raycastHeightfield(originV3, dirV3)
    },

    dispose() {},
  }
}
