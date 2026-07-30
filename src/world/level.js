/**
 * world/level.js — authoritative tile data + layout spec.
 *
 * THE CONTRACT THAT MATTERS: every cover value in `tiles` is emitted by the same
 * call that emits the visible geometry spec. There is no second list. If the art
 * shows a waist-high wall on a tile's north edge, `tile.cover.n === 1`, because
 * both came out of `addEdgeProp(..., 'n', 1)`.
 *
 * Layout is 180°-rotationally symmetric about the map centre (structural pieces
 * only) so the two corner deploy zones are exactly as good as each other. Set
 * dressing and wear are seeded-random and deliberately NOT symmetric, so the
 * fairness never reads as a mirror.
 *
 *   Directions: n = -Z, s = +Z, e = +X, w = -X.
 *   Use api.coverAgainst(x, z, fromX, fromZ) if you would rather not care.
 */
import { makeRng, wfbm } from './kit.js'

export const SURF = { ASPHALT: 0, CONCRETE: 1, DIRT: 2, GRAVEL: 3 }
export const DIRS = {
  n: { dx: 0, dz: -1 },
  e: { dx: 1, dz: 0 },
  s: { dx: 0, dz: 1 },
  w: { dx: -1, dz: 0 },
}
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' }
const DIR_LIST = ['n', 'e', 's', 'w']

// ---------------------------------------------------------------------------

export function buildLevel({ W = 24, H = 24, TILE = 2, ELEV_STEP = 2, seed = 20250729 } = {}) {
  const rng = makeRng(seed)
  const tiles = new Array(W * H)
  const surface = new Uint8Array(W * H)
  const idx = (x, z) => x + z * W
  const inB = (x, z) => x >= 0 && z >= 0 && x < W && z < H

  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      tiles[idx(x, z)] = {
        x,
        z,
        elevation: 0,
        walkable: true,
        cost: 1,
        occupantId: null,
        cover: { n: 0, e: 0, s: 0, w: 0 },
        destructible: false,
        hazard: null,
      }
    }
  }

  const spec = {
    W,
    H,
    TILE,
    ELEV_STEP,
    seed,
    tiles,
    surface,
    props: [],
    dressing: [],
    decals: [],
    buildings: [],
    backdrop: [],
    losBoxes: [],
    kerbs: [],
    deploy: { 0: [], 1: [] },
  }

  const edges = new Map() // canonical edge key -> record
  spec.edges = edges

  // --- world-space helpers -------------------------------------------------
  const wx = (x) => (x - W / 2 + 0.5) * TILE
  const wz = (z) => (z - H / 2 + 0.5) * TILE
  const wy = (e) => e * ELEV_STEP
  spec.wx = wx
  spec.wz = wz
  spec.wy = wy

  // ---------------------------------------------------------------------------
  // Cover plumbing
  // ---------------------------------------------------------------------------

  function edgeKey(x, z, dir) {
    if (dir === 'n') return `H:${x}:${z}`
    if (dir === 's') return `H:${x}:${z + 1}`
    if (dir === 'w') return `V:${x}:${z}`
    return `V:${x + 1}:${z}` // e
  }

  /**
   * The single place cover is ever written. Sets both sides of the shared edge
   * and records a destructible handle so destroyCover() can find the mesh.
   */
  function setCover(x, z, dir, value, destructible = false) {
    if (!inB(x, z) || value <= 0) return null
    const key = edgeKey(x, z, dir)
    let rec = edges.get(key)
    if (!rec) {
      rec = { key, value: 0, destructible: false, sides: [], hooks: [] }
      edges.set(key, rec)
    }
    const nx = x + DIRS[dir].dx
    const nz = z + DIRS[dir].dz
    const sides = [{ x, z, dir }]
    if (inB(nx, nz)) sides.push({ x: nx, z: nz, dir: OPP[dir] })
    for (const s of sides) {
      const t = tiles[idx(s.x, s.z)]
      if (value > t.cover[s.dir]) t.cover[s.dir] = value
      if (!rec.sides.some((q) => q.x === s.x && q.z === s.z && q.dir === s.dir)) rec.sides.push(s)
    }
    rec.value = Math.max(rec.value, value)
    rec.destructible = rec.destructible || destructible
    if (destructible) {
      for (const s of sides) tiles[idx(s.x, s.z)].destructible = true
    }
    return rec
  }

  function clearCoverEdge(rec) {
    if (!rec) return false
    for (const s of rec.sides) {
      const t = tiles[idx(s.x, s.z)]
      t.cover[s.dir] = 0
    }
    rec.value = 0
    for (const t of tiles) {
      t.destructible = DIR_LIST.some((d) => {
        const r = edges.get(edgeKey(t.x, t.z, d))
        return !!r && r.value > 0 && r.destructible
      })
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Terrain painting helpers
  // ---------------------------------------------------------------------------

  function paint(x0, z0, x1, z1, surf) {
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) if (inB(x, z)) surface[idx(x, z)] = surf
  }
  function setElev(x0, z0, x1, z1, e, opts = {}) {
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (!inB(x, z)) continue
        const t = tiles[idx(x, z)]
        t.elevation = e
        if (opts.walkable !== undefined) t.walkable = opts.walkable
        if (opts.cost !== undefined) t.cost = opts.cost
      }
  }
  function block(x0, z0, x1, z1) {
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) if (inB(x, z)) tiles[idx(x, z)].walkable = false
  }

  function addLosBox(cx, cy, cz, hx, hy, hz) {
    spec.losBoxes.push({ cx, cy, cz, hx, hy, hz })
  }

  // ---------------------------------------------------------------------------
  // Symmetry transform
  // ---------------------------------------------------------------------------
  // s = +1 identity, s = -1 rotate 180° about the map centre.
  function T(s) {
    return {
      s,
      tx: (x) => (s > 0 ? x : W - 1 - x),
      tz: (z) => (s > 0 ? z : H - 1 - z),
      rect: (x0, z0, x1, z1) =>
        s > 0 ? [x0, z0, x1, z1] : [W - 1 - x1, H - 1 - z1, W - 1 - x0, H - 1 - z0],
      dir: (d) => (s > 0 ? d : OPP[d]),
      wxz: (X, Z) => (s > 0 ? [X, Z] : [-X, -Z]),
      ry: (r) => (s > 0 ? r : r + Math.PI),
      team: s > 0 ? 0 : 1,
    }
  }

  // ---------------------------------------------------------------------------
  // Prop emission
  // ---------------------------------------------------------------------------

  let propSeed = 1

  /**
   * A prop that occupies whole tiles: blocks movement, gives `cover` on every
   * outward tile edge of its footprint.
   */
  function addBlockProp(t, type, x0, z0, x1, z1, opts = {}) {
    const [rx0, rz0, rx1, rz1] = t.rect(x0, z0, x1, z1)
    const e = opts.elevation ?? tiles[idx(rx0, rz0)].elevation
    const cover = opts.cover ?? 2
    const destructible = opts.destructible ?? false

    for (let z = rz0; z <= rz1; z++) {
      for (let x = rx0; x <= rx1; x++) {
        if (!inB(x, z)) continue
        tiles[idx(x, z)].walkable = false
        tiles[idx(x, z)].elevation = e
        for (const d of DIR_LIST) {
          const nx = x + DIRS[d].dx
          const nz = z + DIRS[d].dz
          const inside = nx >= rx0 && nx <= rx1 && nz >= rz0 && nz <= rz1
          if (!inside) setCover(x, z, d, cover, destructible)
        }
      }
    }

    const cx = (wx(rx0) + wx(rx1)) * 0.5
    const cz = (wz(rz0) + wz(rz1)) * 0.5
    const p = {
      type,
      x: cx,
      y: wy(e) + (opts.yOffset ?? 0),
      z: cz,
      ry: t.ry(opts.ry ?? 0),
      spanX: (rx1 - rx0 + 1) * TILE,
      spanZ: (rz1 - rz0 + 1) * TILE,
      tint: opts.tint ?? null,
      seed: propSeed++,
      variant: opts.variant ?? 0,
      scale: opts.scale ?? 1,
      tiles: [],
      cover,
      destructible,
      edgeKeys: [],
    }
    for (let z = rz0; z <= rz1; z++) for (let x = rx0; x <= rx1; x++) p.tiles.push({ x, z })
    for (const tl of p.tiles)
      for (const d of DIR_LIST) {
        const k = edgeKey(tl.x, tl.z, d)
        if (edges.has(k) && !p.edgeKeys.includes(k)) p.edgeKeys.push(k)
      }

    if (opts.los !== false) {
      const h = opts.losHeight ?? 2.4
      addLosBox(cx, wy(e) + h * 0.5, cz, (p.spanX * 0.5) * 0.92, h * 0.5, (p.spanZ * 0.5) * 0.92)
    }
    spec.props.push(vary(p, opts))
    return p
  }

  /**
   * A prop that sits ON a tile edge: does not block the tile, gives `cover` on
   * that edge to both adjacent tiles.
   */
  function addEdgeProp(t, type, x, z, dir, opts = {}) {
    const tx = t.tx(x)
    const tz = t.tz(z)
    const td = t.dir(dir)
    const cover = opts.cover ?? 1
    const destructible = opts.destructible ?? true
    const rec = setCover(tx, tz, td, cover, destructible)
    const e = opts.elevation ?? tiles[idx(tx, tz)].elevation
    const d = DIRS[td]
    const p = {
      type,
      x: wx(tx) + d.dx * TILE * 0.5,
      y: wy(e) + (opts.yOffset ?? 0),
      z: wz(tz) + d.dz * TILE * 0.5,
      ry: d.dx !== 0 ? Math.PI / 2 : 0,
      len: TILE,
      tint: opts.tint ?? null,
      seed: propSeed++,
      variant: opts.variant ?? 0,
      scale: opts.scale ?? 1,
      cover,
      destructible,
      edge: { x: tx, z: tz, dir: td },
      edgeKeys: rec ? [rec.key] : [],
      tiles: [{ x: tx, z: tz }],
    }
    if (opts.los) {
      const h = opts.losHeight ?? 2.4
      addLosBox(p.x, wy(e) + h * 0.5, p.z, d.dx !== 0 ? 0.2 : TILE * 0.5, h * 0.5, d.dz !== 0 ? 0.2 : TILE * 0.5)
    }
    spec.props.push(vary(p, opts))
    return p
  }

  /** Zero-cover set dressing. Never touches tile data. */
  /**
   * Assign a deterministic mesh variant per prop instance.
   *
   * props.js already varies tint, scale (±1.75%) and yaw (±1°) per instance,
   * seeded from the prop's own seed — so colour and placement were never the
   * repetition problem. What repeated was the SHAPE: `variant` defaulted to 0
   * here and nothing ever overrode it, so every builder that branches on it
   * only ever produced its first form. Three identical buses, three identical
   * awnings, which is what an art director flagged as the loudest tell on the
   * map.
   *
   * Hashed from the seed rather than drawn from a shared RNG stream so a prop's
   * shape depends only on itself: inserting a prop earlier in generation won't
   * reshuffle every prop after it, and screenshots stay comparable run to run.
   */
  function hash01(seed, salt) {
    let h = (seed * 374761393 + salt * 668265263) | 0
    h = (h ^ (h >>> 13)) * 1274126177
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }

  /**
   * Round-robin per type, offset by a hash of the type name.
   *
   * Pure hashing clumps badly at low instance counts, which is exactly where it
   * matters: with only two buses on the map, both drew variant 0 (a 1-in-9
   * coincidence) and the whole point of adding variants was lost. Several other
   * pairs collided the same way. Rotating by type guarantees consecutive
   * instances differ; the hash offset stops every type from starting at 0, so
   * the low-count types don't all show their variant-0 form together.
   */
  const typeCounts = new Map()
  function vary(p, opts, variants = 3) {
    if (opts.variant === undefined) {
      const n = typeCounts.get(p.type) ?? 0
      typeCounts.set(p.type, n + 1)
      let nameHash = 0
      for (let i = 0; i < p.type.length; i++) nameHash = (nameHash * 31 + p.type.charCodeAt(i)) | 0
      p.variant = (n + Math.abs(nameHash)) % variants
    }
    return p
  }

  function addDressing(t, type, X, Z, opts = {}) {
    const [px, pz] = t.wxz(X, Z)
    spec.dressing.push({
      type,
      x: px,
      y: opts.y ?? 0,
      z: pz,
      ry: t.ry(opts.ry ?? 0),
      scale: opts.scale ?? 1,
      tint: opts.tint ?? null,
      seed: propSeed++,
      variant: opts.variant ?? 0,
      data: opts.data ?? null,
    })
  }

  function addDecal(t, type, X, Z, opts = {}) {
    const [px, pz] = t.wxz(X, Z)
    spec.decals.push({
      type,
      x: px,
      z: pz,
      y: opts.y ?? 0,
      ry: t.ry(opts.ry ?? 0),
      size: opts.size ?? 2,
      aspect: opts.aspect ?? 1,
      opacity: opts.opacity ?? 1,
      seed: propSeed++,
    })
  }

  // ===========================================================================
  // LAYOUT
  // ===========================================================================
  //
  //        x0                     x9 x10..13 x14                    x23
  //  z0    +----------------+-----+------------+-----+----------------+
  //        |  RUIN / LOT    | sw  |            | sw  |  PARK. GARAGE  |
  //        |  (team 0 home) |     |   N-S AVE  |     |   deck @ elev2 |
  //  z9    +----------------+-----+------------+-----+----------------+
  //  z10   |            E-W AVENUE   [metro island @ elev1]           |
  //  z13   +----------------+-----+------------+-----+----------------+
  //        |  PARK. GARAGE  | sw  |            | sw  |  RUIN / LOT    |
  //        |   deck @ elev2 |     |            |     |  (team 1 home) |
  //  z23   +----------------+-----+------------+-----+----------------+

  const ROAD_Z0 = 10
  const ROAD_Z1 = 13
  const ROAD_X0 = 10
  const ROAD_X1 = 13

  // --- surfaces ------------------------------------------------------------
  paint(0, 0, W - 1, H - 1, SURF.CONCRETE)
  paint(0, ROAD_Z0, W - 1, ROAD_Z1, SURF.ASPHALT)
  paint(ROAD_X0, 0, ROAD_X1, H - 1, SURF.ASPHALT)

  // kerb lines: sidewalk/road boundaries (visual only, sub-tile height)
  for (let x = 0; x < W; x++) {
    if (x >= ROAD_X0 && x <= ROAD_X1) continue
    spec.kerbs.push({ x0: wx(x) - TILE / 2, z: wz(ROAD_Z0) - TILE / 2, x1: wx(x) + TILE / 2, axis: 'x', side: 1 })
    spec.kerbs.push({ x0: wx(x) - TILE / 2, z: wz(ROAD_Z1) + TILE / 2, x1: wx(x) + TILE / 2, axis: 'x', side: -1 })
  }
  for (let z = 0; z < H; z++) {
    if (z >= ROAD_Z0 && z <= ROAD_Z1) continue
    spec.kerbs.push({ z0: wz(z) - TILE / 2, x: wx(ROAD_X0) - TILE / 2, z1: wz(z) + TILE / 2, axis: 'z', side: 1 })
    spec.kerbs.push({ z0: wz(z) - TILE / 2, x: wx(ROAD_X1) + TILE / 2, z1: wz(z) + TILE / 2, axis: 'z', side: -1 })
  }

  const HALVES = [T(1), T(-1)]

  for (const t of HALVES) {
    // =======================================================================
    // NW QUADRANT — team home block: ruin shell + parking lot
    // =======================================================================
    const R = t.rect(5, 0, 8, 3) // ruin footprint
    paint(R[0], R[1], R[2], R[3], SURF.CONCRETE)
    const L = t.rect(0, 5, 8, 8) // parking lot
    paint(L[0], L[1], L[2], L[3], SURF.ASPHALT)
    const D = t.rect(0, 4, 8, 4)
    paint(D[0], D[1], D[2], D[3], SURF.DIRT)
    const F = t.rect(0, 0, 4, 3)
    paint(F[0], F[1], F[2], F[3], SURF.CONCRETE)

    // --- the ruin: a roofless two-storey shell ----------------------------
    // North wall (map edge side) — full height, blocks LOS
    spec.buildings.push({
      kind: 'ruin',
      rect: t.rect(5, 0, 8, 3),
      t: t.s,
      seed: 7000 + (t.s > 0 ? 0 : 1),
    })
    // wall segments are emitted as edge props so cover == what you see
    for (let x = 5; x <= 8; x++) {
      addEdgeProp(t, 'ruinWall', x, 0, 'n', { cover: 2, los: true, losHeight: 3.4, destructible: true, variant: 1 })
    }
    for (let z = 0; z <= 3; z++) {
      // west face — door opening at z = 2
      if (z !== 2)
        addEdgeProp(t, 'ruinWall', 5, z, 'w', { cover: 2, los: true, losHeight: 3.4, destructible: true, variant: 1 })
      // east face — collapsed below z = 2 (half cover, no LOS block)
      if (z <= 1)
        addEdgeProp(t, 'ruinWall', 8, z, 'e', { cover: 2, los: true, losHeight: 3.4, destructible: true, variant: 1 })
      else addEdgeProp(t, 'ruinWall', 8, z, 'e', { cover: 1, destructible: true, variant: 2 })
    }
    for (let x = 5; x <= 8; x++) {
      // south face — breach at x = 7
      if (x === 7) continue
      if (x === 6)
        addEdgeProp(t, 'ruinWall', x, 3, 's', { cover: 1, destructible: true, variant: 2 })
      else addEdgeProp(t, 'ruinWall', x, 3, 's', { cover: 2, los: true, losHeight: 3.4, destructible: true, variant: 1 })
    }
    // interior: an internal partition stub + rubble
    addEdgeProp(t, 'ruinWall', 7, 1, 'w', { cover: 2, los: true, losHeight: 3.0, destructible: true, variant: 1 })
    addBlockProp(t, 'rubblePile', 6, 0, 6, 0, { cover: 1, los: false, destructible: false })
    addBlockProp(t, 'crate', 8, 3, 8, 3, { cover: 1, los: false, ry: 0.3 })

    // --- forecourt / deploy approach --------------------------------------
    addBlockProp(t, 'sandbags', 4, 2, 4, 2, { cover: 2, losHeight: 1.3, destructible: true })
    addBlockProp(t, 'sandbags', 4, 3, 4, 3, { cover: 2, losHeight: 1.3, destructible: true })
    addBlockProp(t, 'jersey', 1, 4, 1, 4, { cover: 2, losHeight: 1.9, destructible: true, ry: 0 })
    addBlockProp(t, 'jersey', 2, 4, 2, 4, { cover: 2, losHeight: 1.9, destructible: true, ry: 0 })
    addBlockProp(t, 'jersey', 6, 4, 6, 4, { cover: 2, losHeight: 1.9, destructible: true, ry: 0 })
    addBlockProp(t, 'dumpster', 0, 3, 0, 3, { cover: 2, losHeight: 1.4, ry: Math.PI / 2 })
    addEdgeProp(t, 'lowWall', 3, 4, 'n', { cover: 1, destructible: true })

    // --- parking lot ------------------------------------------------------
    addBlockProp(t, 'carWreck', 1, 6, 2, 6, { cover: 2, losHeight: 1.5, ry: 0, variant: 0 })
    addBlockProp(t, 'carWreck', 4, 7, 5, 7, { cover: 2, losHeight: 1.5, ry: 0, variant: 1 })
    addBlockProp(t, 'carWreck', 7, 5, 8, 5, { cover: 2, losHeight: 1.5, ry: 0, variant: 2 })
    addBlockProp(t, 'container', 6, 7, 8, 7, { cover: 2, losHeight: 2.7, ry: 0, variant: 0 })
    // lot boundary wall onto the sidewalk, with two gaps
    for (let x = 0; x <= 8; x++) {
      if (x === 3 || x === 6) continue
      addEdgeProp(t, 'lowWall', x, 8, 's', { cover: 1, destructible: true })
    }
    addBlockProp(t, 'planter', 0, 6, 0, 6, { cover: 1, los: false })

    // =======================================================================
    // NE QUADRANT — parking garage, deck at elevation 2
    // =======================================================================
    const G = t.rect(17, 2, 22, 7)
    setElev(G[0], G[1], G[2], G[3], 2, { walkable: true, cost: 1 })
    paint(G[0], G[1], G[2], G[3], SURF.CONCRETE)
    const Y = t.rect(15, 0, 23, 8)
    for (let z = Y[1]; z <= Y[3]; z++)
      for (let x = Y[0]; x <= Y[2]; x++)
        if (tiles[idx(x, z)].elevation === 0) surface[idx(x, z)] = SURF.GRAVEL

    spec.buildings.push({
      kind: 'garage',
      rect: t.rect(17, 2, 22, 7),
      stair: t.rect(16, 4, 16, 5),
      t: t.s,
      seed: 8000 + (t.s > 0 ? 0 : 1),
    })
    // The garage mass blocks LOS from ground level; the deck surface does not.
    {
      const cx = (wx(G[0]) + wx(G[2])) * 0.5
      const cz = (wz(G[1]) + wz(G[3])) * 0.5
      addLosBox(cx, 2.0, cz, (G[2] - G[0] + 1) * TILE * 0.5, 2.0, (G[3] - G[1] + 1) * TILE * 0.5)
    }
    // full cover for anyone hugging the garage at ground level
    for (let z = 2; z <= 7; z++) {
      addEdgeProp(t, 'garageWall', 17, z, 'w', { cover: 2, destructible: false, elevation: 0, variant: 3 })
      addEdgeProp(t, 'garageWall', 22, z, 'e', { cover: 2, destructible: false, elevation: 0, variant: 3 })
    }
    for (let x = 17; x <= 22; x++) {
      addEdgeProp(t, 'garageWall', x, 2, 'n', { cover: 2, destructible: false, elevation: 0, variant: 3 })
      addEdgeProp(t, 'garageWall', x, 7, 's', { cover: 2, destructible: false, elevation: 0, variant: 3 })
    }

    // stair landing at elev 1 — the only Δ1 chain onto the deck
    const S = t.rect(16, 4, 16, 5)
    setElev(S[0], S[1], S[2], S[3], 1, { walkable: true, cost: 2 })
    paint(S[0], S[1], S[2], S[3], SURF.CONCRETE)

    // deck parapet: half cover on every outward deck edge
    for (let z = 2; z <= 7; z++) {
      addEdgeProp(t, 'parapet', 17, z, 'w', { cover: 1, destructible: true, elevation: 2 })
      addEdgeProp(t, 'parapet', 22, z, 'e', { cover: 1, destructible: true, elevation: 2 })
    }
    for (let x = 17; x <= 22; x++) {
      addEdgeProp(t, 'parapet', x, 2, 'n', { cover: 1, destructible: true, elevation: 2 })
      addEdgeProp(t, 'parapet', x, 7, 's', { cover: 1, destructible: true, elevation: 2 })
    }
    // the west parapet is broken open where the stair arrives
    for (const z of [4, 5]) {
      const k = edgeKey(t.tx(17), t.tz(z), t.dir('w'))
      const rec = edges.get(k)
      if (rec) {
        for (const s of rec.sides) tiles[idx(s.x, s.z)].cover[s.dir] = 0
        rec.value = 0
        rec.removed = true
      }
    }
    spec.props = spec.props.filter(
      (p) => !(p.type === 'parapet' && p.edgeKeys.some((k) => edges.get(k)?.removed))
    )

    // deck contents
    addBlockProp(t, 'liftCore', 20, 4, 21, 5, { cover: 2, losHeight: 3.0, elevation: 2 })
    addBlockProp(t, 'acUnit', 18, 3, 18, 3, { cover: 2, losHeight: 1.5, elevation: 2, ry: 0.1 })
    addBlockProp(t, 'acUnit', 19, 7, 19, 7, { cover: 2, losHeight: 1.5, elevation: 2, ry: -0.06 })
    addBlockProp(t, 'carWreck', 21, 2, 22, 2, { cover: 2, losHeight: 1.5, elevation: 2, ry: Math.PI / 2, variant: 1 })
    addBlockProp(t, 'crate', 17, 6, 17, 6, { cover: 1, los: false, elevation: 2, ry: -0.2 })
    addDressing(t, 'billboard', wx(19.5), wz(1.55), { y: 4, ry: 0, scale: 1 })
    addDressing(t, 'roofVent', wx(19), wz(5.4), { y: 4 })
    addDressing(t, 'roofVent', wx(22), wz(6.3), { y: 4, ry: 0.7 })
    addDressing(t, 'deckLamp', wx(18), wz(2.6), { y: 4 })
    addDressing(t, 'deckLamp', wx(21.6), wz(7.2), { y: 4 })
    addDressing(t, 'aerial', wx(17.4), wz(3.2), { y: 4 })

    // yard around the garage
    addBlockProp(t, 'container', 15, 0, 15, 2, { cover: 2, losHeight: 2.7, ry: Math.PI / 2, variant: 1 })
    addBlockProp(t, 'container', 19, 0, 21, 0, { cover: 2, losHeight: 2.7, ry: 0, variant: 2 })
    addBlockProp(t, 'container', 20, 8, 22, 8, { cover: 2, losHeight: 2.7, ry: 0, variant: 0 })
    addBlockProp(t, 'jersey', 15, 5, 15, 5, { cover: 2, losHeight: 1.9, destructible: true })
    addBlockProp(t, 'jersey', 15, 6, 15, 6, { cover: 2, losHeight: 1.9, destructible: true })
    addBlockProp(t, 'pillar', 23, 4, 23, 4, { cover: 2, losHeight: 3.6 })
    addBlockProp(t, 'rubblePile', 16, 8, 16, 8, { cover: 1, los: false })
    addBlockProp(t, 'crate', 17, 8, 17, 8, { cover: 1, los: false, ry: 0.5 })
    addBlockProp(t, 'crate', 23, 7, 23, 7, { cover: 1, los: false, ry: -0.3 })
    addEdgeProp(t, 'lowWall', 18, 8, 's', { cover: 1, destructible: true })
    addEdgeProp(t, 'lowWall', 19, 8, 's', { cover: 1, destructible: true })

    // chain-link fence around the yard (blocks nothing, sells the place)
    for (let x = 15; x <= 23; x += 1) addDressing(t, 'fence', wx(x), wz(9) - TILE / 2, { ry: 0 })

    // =======================================================================
    // STREETS
    // =======================================================================
    // Wrecked bus across the west avenue. Variant is left unset so the two
    // mirrored instances get different wreck states — pinning it to 0 here was
    // vestigial from before the builder had variants at all, and it was the one
    // thing still forcing the map's most conspicuous prop to appear twice
    // identically.
    addBlockProp(t, 'bus', 3, 11, 8, 11, { cover: 2, losHeight: 3.0, ry: 0 })
    // barricade line on the avenue approach
    addBlockProp(t, 'jersey', 9, 12, 9, 12, { cover: 2, losHeight: 1.9, destructible: true })
    addBlockProp(t, 'jersey', 9, 13, 9, 13, { cover: 2, losHeight: 1.9, destructible: true })
    addBlockProp(t, 'carWreck', 10, 9, 11, 9, { cover: 2, losHeight: 1.5, ry: Math.PI / 2, variant: 2 })
    addBlockProp(t, 'planter', 14, 9, 14, 9, { cover: 1, los: false })
    addBlockProp(t, 'planter', 14, 10, 14, 10, { cover: 1, los: false })
    addBlockProp(t, 'rubblePile', 13, 8, 13, 8, { cover: 1, los: false })
    addBlockProp(t, 'dumpster', 9, 5, 9, 5, { cover: 2, losHeight: 1.4 })
    addBlockProp(t, 'crate', 9, 6, 9, 6, { cover: 1, los: false, ry: 0.7 })
    addEdgeProp(t, 'bench', 9, 2, 'e', { cover: 1, destructible: true })
    addEdgeProp(t, 'bench', 14, 17, 'w', { cover: 1, destructible: true })
    addBlockProp(t, 'hydrant', 9, 15, 9, 15, { cover: 1, los: false })

    // street furniture (no cover)
    for (const z of [1, 5, 16, 20]) addDressing(t, 'lamp', wx(9) + 0.55, wz(z), { ry: -Math.PI / 2 })
    for (const x of [2, 6, 17, 21]) addDressing(t, 'lamp', wx(x), wz(9) + 0.55, { ry: 0 })
    addDressing(t, 'trafficLight', wx(9) + 0.7, wz(9) + 0.7, { ry: Math.PI * 0.25 })
    addDressing(t, 'signPost', wx(14) - 0.6, wz(9) + 0.5, { ry: -0.4 })
    addDressing(t, 'trafficLight', wx(14) - 0.7, wz(14) - 0.7, { ry: Math.PI * 1.25 })
    addDressing(t, 'kiosk', wx(9), wz(17), { ry: Math.PI / 2 })
    addDressing(t, 'cablePole', wx(14) - 0.5, wz(4), { ry: 0.2 })

    // =======================================================================
    // CENTRE — raised metro island
    // =======================================================================
    if (t.s > 0) {
      setElev(11, 10, 12, 13, 1, { walkable: true, cost: 1 })
      paint(11, 10, 12, 13, SURF.CONCRETE)
    }
    // two metro head-houses (a symmetric pair) sit at the island ends
    addBlockProp(t, 'metroHead', 11, 10, 12, 10, {
      cover: 2,
      losHeight: 2.9,
      elevation: 1,
      ry: 0,
    })
    // island flank railings -> half cover on the long edges
    addEdgeProp(t, 'railing', 11, 11, 'w', { cover: 1, destructible: true, elevation: 1 })
    addEdgeProp(t, 'railing', 11, 12, 'w', { cover: 1, destructible: true, elevation: 1 })
    addDressing(t, 'islandSign', wx(12) + 0.6, wz(11) - 0.4, { y: 2, ry: -0.3 })
  }

  // --- centre-line detail that is its own mirror ---------------------------
  const t0 = T(1)
  addDressing(t0, 'manholeRig', 0, 0, { scale: 1 })

  // ---------------------------------------------------------------------------
  // Seeded, deliberately ASYMMETRIC dressing + decals
  // ---------------------------------------------------------------------------

  const freeTiles = []
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++) {
      const t = tiles[idx(x, z)]
      if (t.walkable && t.elevation === 0) freeTiles.push(t)
    }

  // weighted: rubble and litter dominate, hero clutter (tyres, cones) is rare
  const scatterKinds = [
    'debris', 'debris', 'debris', 'debris', 'debris',
    'trash', 'trash',
    'weeds', 'weeds', 'weeds',
    'brickPile', 'brickPile',
    'paper', 'paper',
    'pallet', 'cone', 'tyre',
  ]
  for (let i = 0; i < 165; i++) {
    const t = freeTiles[Math.floor(rng.next() * freeTiles.length)]
    if (!t) break
    const kind = scatterKinds[Math.floor(rng.next() * scatterKinds.length)]
    spec.dressing.push({
      type: kind,
      x: wx(t.x) + rng.jitter() * 0.8,
      y: wy(t.elevation),
      z: wz(t.z) + rng.jitter() * 0.8,
      ry: rng.next() * Math.PI * 2,
      scale: 0.75 + rng.next() * 0.6,
      tint: null,
      seed: 20000 + i,
      variant: Math.floor(rng.next() * 3),
    })
  }
  // weeds cluster along kerbs and wall bases where nobody sweeps
  for (let i = 0; i < 110; i++) {
    const t = freeTiles[Math.floor(rng.next() * freeTiles.length)]
    if (!t) continue
    let edgy = 0
    for (const d of DIR_LIST) {
      const nx = t.x + DIRS[d].dx
      const nz = t.z + DIRS[d].dz
      if (!inB(nx, nz) || !tiles[idx(nx, nz)].walkable) edgy++
      if (inB(nx, nz) && surface[idx(nx, nz)] !== surface[idx(t.x, t.z)]) edgy++
    }
    if (edgy === 0 && rng.next() > 0.25) continue
    spec.dressing.push({
      type: 'weeds',
      x: wx(t.x) + rng.jitter() * 0.9,
      y: wy(t.elevation),
      z: wz(t.z) + rng.jitter() * 0.9,
      ry: rng.next() * Math.PI * 2,
      scale: 0.6 + rng.next() * 0.8,
      seed: 30000 + i,
      variant: Math.floor(rng.next() * 3),
    })
  }

  // --- decals --------------------------------------------------------------
  // road markings: dashed centre lines down both avenues
  for (let z = 0; z < H; z++) {
    if (z % 2 === 0) spec.decals.push({ type: 'dash', x: wx(11) + TILE / 2, z: wz(z), ry: 0, size: 2.1, aspect: 0.09, y: 0 })
  }
  for (let x = 0; x < W; x++) {
    if (x % 2 === 1) spec.decals.push({ type: 'dash', x: wx(x), z: wz(11) + TILE / 2, ry: Math.PI / 2, size: 2.1, aspect: 0.09, y: 0 })
  }
  // stop bars + crossings at the intersection
  for (const [cx, cz, r] of [
    [wx(11.5), wz(9) + 0.4, 0],
    [wx(11.5), wz(14) - 0.4, 0],
    [wx(9) + 0.4, wz(11.5), Math.PI / 2],
    [wx(14) - 0.4, wz(11.5), Math.PI / 2],
  ]) {
    for (let i = 0; i < 6; i++) {
      const off = (i - 2.5) * 0.85
      spec.decals.push({
        type: 'zebra',
        x: cx + (r === 0 ? off : 0),
        z: cz + (r === 0 ? 0 : off),
        ry: r,
        size: 2.6,
        aspect: 0.2,
        y: 0,
      })
    }
  }
  // parking bay lines in the lots
  for (const s of [1, -1]) {
    for (let i = 0; i <= 8; i++) {
      spec.decals.push({
        type: 'line',
        x: s * (wx(i) + 1),
        z: s * wz(6.5),
        ry: Math.PI / 2,
        size: 4.4,
        aspect: 0.05,
        y: 0,
      })
    }
  }
  // stains, scorches, cracks, manholes — asymmetric
  const stainKinds = ['oil', 'crack', 'scorch', 'grime', 'puddle']
  for (let i = 0; i < 120; i++) {
    const t = freeTiles[Math.floor(rng.next() * freeTiles.length)]
    if (!t) continue
    spec.decals.push({
      type: stainKinds[Math.floor(rng.next() * stainKinds.length)],
      x: wx(t.x) + rng.jitter() * 1.0,
      z: wz(t.z) + rng.jitter() * 1.0,
      ry: rng.next() * Math.PI * 2,
      size: 1.4 + rng.next() * 3.4,
      aspect: 1,
      y: wy(t.elevation),
      opacity: 0.45 + rng.next() * 0.5,
    })
  }
  for (const [mx, mz] of [
    [wx(11), wz(6)],
    [wx(12), wz(18)],
    [wx(5), wz(12)],
    [wx(19), wz(11)],
  ]) {
    spec.decals.push({ type: 'manhole', x: mx, z: mz, ry: 0.3, size: 1.5, aspect: 1, y: 0 })
  }
  // graffiti gets projected onto vertical surfaces by decals.js
  spec.graffiti = []
  for (let i = 0; i < 14; i++) {
    spec.graffiti.push({ seed: 40000 + i, variant: Math.floor(rng.next() * 4) })
  }

  // ---------------------------------------------------------------------------
  // Backdrop city (outside play space, pure silhouette)
  // ---------------------------------------------------------------------------
  {
    const half = (W * TILE) / 2
    const ring = []
    for (let i = 0; i < 40; i++) {
      const side = i % 4
      const t01 = rng.next()
      const along = (t01 - 0.5) * (W * TILE + 150)
      // far enough that an orbiting iso camera never has one in its lap
      const out = half + 40 + Math.pow(rng.next(), 0.7) * 80
      let bx, bz
      if (side === 0) [bx, bz] = [along, -out]
      else if (side === 1) [bx, bz] = [along, out]
      else if (side === 2) [bx, bz] = [-out, along]
      else [bx, bz] = [out, along]
      ring.push({
        x: bx,
        z: bz,
        w: 11 + rng.next() * 22,
        d: 11 + rng.next() * 22,
        h: 10 + Math.pow(rng.next(), 0.9) * 30,
        ry: (rng.next() - 0.5) * 0.5,
        seed: 50000 + i,
        variant: Math.floor(rng.next() * 3),
      })
    }
    spec.backdrop = ring
  }

  // ---------------------------------------------------------------------------
  // Deploy zones
  // ---------------------------------------------------------------------------
  function collectDeploy(x0, z0, x1, z1) {
    const out = []
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const t = tiles[idx(x, z)]
        if (t.walkable) out.push(t)
      }
    return out
  }
  spec.deploy[0] = collectDeploy(0, 0, 3, 3)
  spec.deploy[1] = collectDeploy(W - 4, H - 4, W - 1, H - 1)

  // ---------------------------------------------------------------------------
  // Micro-elevation for the terrain mesh (sub-tile, does not affect rules)
  // ---------------------------------------------------------------------------
  spec.groundHeight = (X, Z) => {
    // gentle settlement + camber; returns metres, |y| < 0.2
    const gx = X / TILE + W / 2 - 0.5
    const gz = Z / TILE + H / 2 - 0.5
    let y = (wfbm(X * 0.055, Z * 0.055, 3, 991) - 0.5) * 0.19
    y += (wfbm(X * 0.24, Z * 0.24, 2, 331) - 0.5) * 0.045
    const onRoadX = gx > ROAD_X0 - 0.5 && gx < ROAD_X1 + 0.5
    const onRoadZ = gz > ROAD_Z0 - 0.5 && gz < ROAD_Z1 + 0.5
    if (onRoadX || onRoadZ) {
      // camber: crown in the middle of the carriageway, gutters at the kerbs
      let c = 0
      if (onRoadX) {
        const u = (gx - (ROAD_X0 - 0.5)) / (ROAD_X1 - ROAD_X0 + 1)
        c = Math.max(c, Math.sin(u * Math.PI) * 0.085)
      }
      if (onRoadZ) {
        const u = (gz - (ROAD_Z0 - 0.5)) / (ROAD_Z1 - ROAD_Z0 + 1)
        c = Math.max(c, Math.sin(u * Math.PI) * 0.085)
      }
      y += c - 0.13
      // potholes
      const p = wfbm(X * 0.5 + 40, Z * 0.5 - 12, 2, 707)
      if (p > 0.74) y -= (p - 0.74) * 1.1
    }
    return y
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api = {
    W,
    H,
    TILE,
    ELEV_STEP,
    seed,
    DIRS,
    tiles,
    spec,

    getTile(x, z) {
      return inB(x, z) ? tiles[idx(x, z)] : null
    },
    isWalkable(x, z) {
      return inB(x, z) ? tiles[idx(x, z)].walkable : false
    },
    elevationAt(x, z) {
      return inB(x, z) ? tiles[idx(x, z)].elevation : 0
    },
    coverAt(x, z, dir) {
      if (!inB(x, z)) return 0
      const d = typeof dir === 'number' ? DIR_LIST[dir & 3] : dir
      return tiles[idx(x, z)].cover[d] || 0
    },
    /** Convention-free helper: cover the tile has against an attacker at (ax,az). */
    coverAgainst(x, z, ax, az) {
      if (!inB(x, z)) return 0
      const t = tiles[idx(x, z)]
      const dx = ax - x
      const dz = az - z
      let best = 0
      if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) best = Math.max(best, t.cover[dx > 0 ? 'e' : 'w'])
      if (Math.abs(dz) >= Math.abs(dx) && dz !== 0) best = Math.max(best, t.cover[dz > 0 ? 's' : 'n'])
      return best
    },
    getDeployZone(team) {
      return spec.deploy[team] || []
    },
    surfaceAt(x, z) {
      return inB(x, z) ? surface[idx(x, z)] : SURF.CONCRETE
    },

    /** internal — used by props.js to bind meshes to destructible edges */
    _edges: edges,
    _edgeKey: edgeKey,
    _clearEdge: clearCoverEdge,
  }

  return api
}
