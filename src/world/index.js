/**
 * world/index.js — battlefield owner.
 *
 * Builds one THREE.Group containing terrain, buildings, props and decals, and
 * publishes the tile data the rules module reads. Art and data come out of the
 * same generator pass, so the cover a player can see is exactly the cover the
 * combat maths uses.
 *
 *   const world = ctx.world
 *   world.getTile(x, z)               -> Tile
 *   world.isWalkable(x, z)            -> bool
 *   world.coverAt(x, z, 'n'|'e'|'s'|'w') -> 0 | 1 | 2
 *   world.coverAgainst(x, z, ax, az)  -> cover facing an attacker at (ax, az)
 *   world.getDeployZone(team)         -> Tile[]
 *   world.blockersForLOS()            -> Mesh[]  (also .boxes: Box3[])
 *   world.destroyCover(x, z, dir)     -> removes data AND geometry
 *   world.addDecal(type, pos, rotY, scale)
 */
import * as THREE from 'three'
import { buildLevel, SURF, DIRS } from './level.js'
import { MaterialKit, disposeTree } from './kit.js'
import { buildTerrain } from './terrain.js'
import { buildBuildings } from './buildings.js'
import { buildProps } from './props.js'
import { buildDecals } from './decals.js'

const SURFACE_SET = [
  'asphalt',
  'concrete',
  'brick',
  'rust',
  'paint',
  'wood',
  'dirt',
  'gravel',
  'fabric',
  'plastic',
]

export async function init(ctx) {
  const t0 = performance.now()
  const quality = ctx.quality || 'high'
  const seed = Number(new URLSearchParams(location.search).get('worldSeed')) || 20250729

  const root = new THREE.Group()
  root.name = 'world'

  const kit = new MaterialKit(ctx, quality)
  await kit.bakeAll(SURFACE_SET)

  const level = buildLevel({
    W: ctx.grid?.W ?? 24,
    H: ctx.grid?.H ?? 24,
    TILE: ctx.grid?.TILE ?? 2,
    ELEV_STEP: ctx.grid?.ELEV_STEP ?? 2,
    seed,
  })
  const spec = level.spec

  let terrain = null
  let buildings = null
  let props = null
  let decals = null

  try {
    terrain = buildTerrain(level, kit, quality)
    root.add(terrain.group)
  } catch (err) {
    console.error('[world] terrain failed', err)
  }
  try {
    buildings = buildBuildings(level, kit, quality)
    root.add(buildings.group)
  } catch (err) {
    console.error('[world] buildings failed', err)
  }
  try {
    props = buildProps(level, kit, quality)
    root.add(props.group)
  } catch (err) {
    console.error('[world] props failed', err)
  }
  try {
    decals = buildDecals(level, kit, quality)
    root.add(decals.group)
  } catch (err) {
    console.error('[world] decals failed', err)
  }

  // -------------------------------------------------------------------------
  // LOS blockers — raycastable proxies, deliberately NOT in the scene graph
  // -------------------------------------------------------------------------
  const blockerGeo = new THREE.BoxGeometry(1, 1, 1)
  const blockerMat = new THREE.MeshBasicMaterial({ visible: false })
  const blockers = []
  const boxes = []
  for (const b of spec.losBoxes) {
    const m = new THREE.Mesh(blockerGeo, blockerMat)
    m.position.set(b.cx, b.cy, b.cz)
    m.scale.set(Math.max(b.hx * 2, 0.05), Math.max(b.hy * 2, 0.05), Math.max(b.hz * 2, 0.05))
    m.updateMatrix()
    m.updateMatrixWorld(true)
    m.userData.losBox = b
    blockers.push(m)
    boxes.push(
      new THREE.Box3(
        new THREE.Vector3(b.cx - b.hx, b.cy - b.hy, b.cz - b.hz),
        new THREE.Vector3(b.cx + b.hx, b.cy + b.hy, b.cz + b.hz)
      )
    )
  }
  blockers.boxes = boxes

  ctx.scene.add(root)

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  const buildMs = Math.round(performance.now() - t0)
  let tri = 0
  let draws = 0
  root.traverse((o) => {
    if (!o.isMesh) return
    draws++
    const g = o.geometry
    const n = g.index ? g.index.count : g.attributes.position.count
    tri += n / 3
  })
  console.log(
    `[world] built in ${buildMs} ms — ${draws} meshes, ${Math.round(tri / 1000)}k tris, seed ${seed}`
  )

  const api = {
    // --- data ---
    W: level.W,
    H: level.H,
    TILE: level.TILE,
    ELEV_STEP: level.ELEV_STEP,
    seed,
    DIRS,
    SURF,
    tiles: level.tiles,
    group: root,
    spec,
    stats: { meshes: draws, triangles: Math.round(tri), buildMs },

    getTile: level.getTile,
    isWalkable: level.isWalkable,
    elevationAt: level.elevationAt,
    coverAt: level.coverAt,
    coverAgainst: level.coverAgainst,
    getDeployZone: level.getDeployZone,
    surfaceAt: level.surfaceAt,

    /** World position of a tile's standing surface. */
    tileWorld(x, z, target = new THREE.Vector3()) {
      const t = level.getTile(x, z)
      const e = t ? t.elevation : 0
      return target.set(spec.wx(x), spec.wy(e), spec.wz(z))
    },

    /** Meshes the LOS raycaster can test against. `.boxes` gives Box3s. */
    blockersForLOS() {
      return blockers
    },

    /**
     * Destroy the cover on one tile edge. Clears the value on BOTH sides, drops
     * the geometry out of the batch and leaves a scorch where it stood.
     */
    destroyCover(x, z, dir) {
      const d = typeof dir === 'number' ? ['n', 'e', 's', 'w'][dir & 3] : dir
      const key = level._edgeKey(x, z, d)
      const rec = level._edges.get(key)
      if (!rec || rec.value <= 0) return false
      if (!rec.destructible) return false

      const nx = x + (DIRS[d]?.dx ?? 0)
      const nz = z + (DIRS[d]?.dz ?? 0)
      const px = (spec.wx(x) + spec.wx(nx)) * 0.5
      const pz = (spec.wz(z) + spec.wz(nz)) * 0.5
      const t = level.getTile(x, z)
      const py = spec.wy(t ? t.elevation : 0)

      level._clearEdge(rec)
      props?.destroyByEdge(key)

      // rubble + scorch where the cover was
      try {
        decals?.addDecal('soot', new THREE.Vector3(px, py, pz), Math.random() * 6.28, 3.0, {
          opacity: 0.75,
        })
        decals?.addDecal('grime', new THREE.Vector3(px, py, pz), Math.random() * 6.28, 4.2, {
          opacity: 0.45,
        })
      } catch {
        /* non-fatal */
      }

      ctx.bus?.emit?.('world:coverDestroyed', { x, z, dir: d, position: { x: px, y: py, z: pz } })
      return true
    },

    /** Runtime decal, used by fx/ for scorch, blood, impacts. */
    addDecal(type, position, rotation = 0, scale = 1, opts = {}) {
      return decals?.addDecal(type, position, rotation, scale, opts) ?? -1
    },

    /** Every tile edge that still carries destructible cover. */
    destructibleEdges() {
      const out = []
      for (const rec of level._edges.values()) {
        if (rec.value > 0 && rec.destructible) out.push(rec)
      }
      return out
    },

    dispose() {
      ctx.scene.remove(root)
      disposeTree(root)
      decals?.dispose()
      buildings?.dispose()
      props?.dispose()
      blockerGeo.dispose()
      blockerMat.dispose()
      kit.dispose()
    },
  }

  ctx.register('world', api)
  return api
}
