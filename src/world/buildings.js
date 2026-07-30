/**
 * world/buildings.js — structures with real depth.
 *
 *  - Parking garages (the two elevated decks): expressed column grid, recessed
 *    louvre bands, overhanging deck slab with a drip edge, roller shutter, and
 *    the stair flight that is the only Δ1 route onto the deck.
 *  - Ruin shells: raised floor slab, a collapsed upper floor with exposed
 *    joists and rebar, interior debris.
 *  - Backdrop city outside the play space: silhouette blocks with genuinely
 *    recessed windows so they read at iso distance instead of looking painted.
 */
import * as THREE from 'three'
import { bevelBox, plainBox, worldUV, paintGrime, mergeGeos, place, rough, makeRng } from './kit.js'

const box = (w, h, d, r = 0.03, s = 1) => bevelBox(w, h, d, r, s)
const at = (g, x, y, z, ry = 0, rx = 0, rz = 0) => place(g, x, y, z, ry, 1, 1, 1, rx, rz)

export function buildBuildings(level, kit, quality = 'high') {
  const spec = level.spec
  const { TILE } = level
  const group = new THREE.Group()
  group.name = 'world:buildings'

  const bins = new Map()
  const push = (k, g) => {
    if (!g) return
    let a = bins.get(k)
    if (!a) {
      a = []
      bins.set(k, a)
    }
    a.push(g.index ? g.toNonIndexed() : g)
  }

  const wx = spec.wx
  const wz = spec.wz

  for (const b of spec.buildings) {
    if (b.kind === 'garage') buildGarage(b, push, level, spec)
    else if (b.kind === 'ruin') buildRuin(b, push, level, spec)
  }
  buildBackdrop(spec, push)

  const UVS = { concrete: 1.6, brick: 1.2, rust: 0.9, paint: 1.6, dark: 1, glass: 1, wood: 1 }
  const MATOPTS = {
    concrete: ['concrete', { density: 2.2, uvRepeat: 1, roughness: 0.93 }],
    brick: ['brick', { density: 1.7, uvRepeat: 1, roughness: 0.95 }],
    rust: ['rust', { density: 2.0, uvRepeat: 1.3, roughness: 0.8, metalness: 0.7 }],
    paint: ['paint', { density: 2.0, uvRepeat: 1.2, roughness: 0.6, metalness: 0.4 }],
    wood: ['wood', { density: 1.8, uvRepeat: 1, roughness: 0.88 }],
  }

  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x14161a,
    roughness: 0.85,
    metalness: 0.05,
    vertexColors: true,
  })
  darkMat.name = 'world:interiorVoid'

  const meshes = []
  for (const [key, geos] of bins) {
    const merged = mergeGeos(geos, 'bld:' + key)
    if (!merged) continue
    const mat = key === 'dark' ? darkMat : kit.get(...(MATOPTS[key] || MATOPTS.concrete))
    const m = new THREE.Mesh(merged, mat)
    m.name = 'world:buildings:' + key
    m.castShadow = true
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    group.add(m)
    meshes.push(m)
  }

  return {
    group,
    meshes,
    dispose() {
      darkMat.dispose()
    },
  }
}

// ---------------------------------------------------------------------------

function finish(g, matKey, opts) {
  const uv = { concrete: 1.7, brick: 1.15, rust: 0.9, paint: 1.6, dark: 2, wood: 1 }[matKey] || 1.5
  worldUV(g, uv)
  paintGrime(g, {
    tint: opts.tint ?? 0xffffff,
    groundY: opts.groundY ?? 0,
    grimeHeight: opts.grimeHeight ?? 1.6,
    grimeStrength: opts.grimeStrength ?? 0.45,
    wear: opts.wear ?? 0.18,
    wearRadius: opts.wearRadius ?? 0.1,
    mottle: opts.mottle ?? 0.2,
    cavity: opts.cavity ?? 0.35,
    topFade: opts.topFade ?? 0.05,
    seed: opts.seed ?? 1,
  })
  return g
}

// ---------------------------------------------------------------------------
// Parking garage: solid ground level, walkable deck at elevation 2
// ---------------------------------------------------------------------------

function buildGarage(b, push, level, spec) {
  const rng = makeRng(b.seed)
  const [x0, z0, x1, z1] = b.rect
  const [sx0, sz0, sx1, sz1] = b.stair
  const TILE = level.TILE
  const wx = spec.wx
  const wz = spec.wz

  const minX = wx(x0) - TILE / 2
  const maxX = wx(x1) + TILE / 2
  const minZ = wz(z0) - TILE / 2
  const maxZ = wz(z1) + TILE / 2
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const W = maxX - minX
  const D = maxZ - minZ

  const DECK = 4.0
  const SLAB = 0.42
  const WALL = DECK - SLAB // 3.58
  const tint = 0xc4c8c8

  const G = (k, g, extra = {}) => push(k, finish(g, k, { tint, seed: b.seed, groundY: 0, ...extra }))

  // --- ground-level mass ---------------------------------------------------
  // Solid core, inset, so the column grid can stand proud of it.
  G('concrete', at(box(W - 0.5, WALL, D - 0.5, 0.05, 1), cx, WALL / 2, cz))

  // recessed louvre band around the perimeter (reads as an open parking level)
  const bandY = 2.35
  const bandH = 0.95
  for (const [ax, az, len, ry] of [
    [cx, minZ, W, 0],
    [cx, maxZ, W, 0],
    [minX, cz, D, Math.PI / 2],
    [maxX, cz, D, Math.PI / 2],
  ]) {
    const inX = ax === minX ? 0.28 : ax === maxX ? -0.28 : 0
    const inZ = az === minZ ? 0.28 : az === maxZ ? -0.28 : 0
    G('dark', at(box(len - 0.9, bandH, 0.5, 0.02), ax + inX, bandY, az + inZ, ry), {
      grimeStrength: 0.15,
      wear: 0,
      cavity: 0,
    })
    const slats = Math.max(3, Math.round(len / 1.15))
    for (let i = 0; i < slats; i++) {
      const t = (i + 0.5) / slats - 0.5
      const px = ry === 0 ? ax + t * (len - 0.9) : ax + inX * 1.35
      const pz = ry === 0 ? az + inZ * 1.35 : az + t * (len - 0.9)
      G('rust', at(box(0.14, bandH - 0.06, 0.14, 0.02), px, bandY, pz, ry))
    }
  }

  // expressed columns on a 4 m grid
  const colsX = Math.max(2, Math.round(W / 4))
  const colsZ = Math.max(2, Math.round(D / 4))
  for (let i = 0; i <= colsX; i++) {
    const px = minX + (i / colsX) * W
    for (const pz of [minZ, maxZ]) {
      G('concrete', at(box(0.72, WALL, 0.55, 0.04, 1), px, WALL / 2, pz))
    }
  }
  for (let i = 1; i < colsZ; i++) {
    const pz = minZ + (i / colsZ) * D
    for (const px of [minX, maxX]) {
      G('concrete', at(box(0.55, WALL, 0.72, 0.04, 1), px, WALL / 2, pz))
    }
  }
  // plinth
  G('concrete', at(box(W + 0.34, 0.4, D + 0.34, 0.05, 1), cx, 0.2, cz))

  // --- deck slab with an overhang + drip edge ------------------------------
  G('concrete', at(box(W + 0.42, SLAB, D + 0.42, 0.05, 1), cx, WALL + SLAB / 2, cz), {
    grimeHeight: 0.5,
    grimeStrength: 0.55,
  })
  G('concrete', at(box(W + 0.5, 0.1, D + 0.5, 0.03), cx, WALL + 0.06, cz), { grimeStrength: 0.6 })

  // deck surface (walkable, elevation 2)
  {
    const deck = new THREE.PlaneGeometry(W - 0.06, D - 0.06, Math.round(W), Math.round(D))
    deck.rotateX(-Math.PI / 2)
    rough(deck, 0.035, b.seed, 3)
    place(deck, cx, DECK + 0.004, cz)
    G('concrete', deck, { grimeHeight: 0.02, grimeStrength: 0, wear: 0.14, mottle: 0.28, cavity: 0 })
  }

  // --- deck markings + drainage -------------------------------------------
  // The deck is a large, flat, walkable surface that units fight on, and it
  // read as a blank concrete slab from the gameplay camera. Everything added
  // here is either flush with the deck or sits outside the walkable footprint,
  // so none of it can contradict the tile cover data.
  {
    const drng = makeRng(b.seed + 907)
    const bayW = 2.5
    const nBays = Math.max(2, Math.floor((W - 1.6) / bayW))
    const span = nBays * bayW
    const x0 = cx - span / 2
    const stripe = (px, pz, sx, sz, worn) =>
      G('concrete', at(box(sx, 0.02, sz, 0.004), px, DECK + 0.02, pz), {
        // Faded line paint: bright enough to read at iso zoom, patchy enough
        // not to look freshly applied on a derelict structure.
        // Grime and wear were washing these out to invisibility at gameplay
        // zoom — the point is that the deck reads as a parking level, so the
        // lines have to survive being 15 m away. Kept patchy, not pristine.
        tint: worn ? 0xd9d2b8 : 0xf2ecd6,
        grimeStrength: 0.18,
        grimeHeight: 0.05,
        wear: 0.3,
        wearRadius: 0.11,
        mottle: 0.3,
        cavity: 0,
      })

    // two rows of bays either side of a central aisle
    for (const side of [-1, 1]) {
      const zEdge = cz + side * (D / 2 - 0.5)
      const depth = Math.min(4.6, D * 0.3)
      for (let i = 0; i <= nBays; i++) {
        const px = x0 + i * bayW
        stripe(px, zEdge - side * depth / 2, 0.11, depth, drng.chance(0.35))
      }
      // bay head line
      stripe(cx, zEdge - side * depth, span, 0.11, drng.chance(0.3))
    }

    // drainage channel down the aisle, with grated gullies
    G('concrete', at(box(span * 0.92, 0.03, 0.34, 0.01), cx, DECK + 0.008, cz), {
      tint: 0x8f8b82,
      grimeStrength: 0.85,
      grimeHeight: 0.1,
      wear: 0.2,
      cavity: 0.5,
    })
    for (let i = 0; i < 3; i++) {
      const gx = cx + (i - 1) * span * 0.3
      G('rust', at(box(0.5, 0.05, 0.32, 0.01), gx, DECK + 0.022, cz), { wear: 0.5, cavity: 0.4 })
    }
  }

  // --- roof-edge plant --------------------------------------------------
  // MUST stay outside the deck footprint. The deck tiles are walkable at
  // elevation 2 and carry no cover for anything placed here, so a solid object
  // standing on one would be geometry a unit walks straight through — exactly
  // the art/data mismatch the tile contract exists to prevent. An earlier
  // version used W/2 - 0.45, which put the water tank *inside* the deck: 6 of
  // the 8 candidate corner tiles measured walkable. Offsetting outward parks
  // it on the parapet instead, which is also where roof plant actually sits.
  {
    const rrng = makeRng(b.seed + 4451)
    const ex = W / 2 + 0.34
    const ez = D / 2 + 0.34
    // vent stacks and a water tank hugging one corner
    const cornerX = cx + (rrng.chance(0.5) ? ex : -ex)
    const cornerZ = cz + (rrng.chance(0.5) ? ez : -ez)
    const tankH = 1.1 + rrng.next() * 0.5
    G('rust', at(new THREE.CylinderGeometry(0.62, 0.62, tankH, 12), cornerX, DECK + tankH / 2, cornerZ), {
      grimeHeight: tankH, grimeStrength: 0.6, wear: 0.45,
    })
    // supporting legs
    for (const [lx, lz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
      G('rust', at(box(0.08, 0.3, 0.08, 0.01), cornerX + lx, DECK + 0.15, cornerZ + lz), { wear: 0.4 })
    }
    // a run of conduit along one parapet edge
    const side = rrng.chance(0.5) ? 1 : -1
    G('rust', at(new THREE.CylinderGeometry(0.07, 0.07, W * 0.7, 8).rotateZ(Math.PI / 2), cx, DECK + 0.42, cz + side * ez), {
      wear: 0.35,
    })
    for (let i = 0; i < 4; i++) {
      const bx = cx + (i / 3 - 0.5) * W * 0.62
      G('rust', at(box(0.1, 0.42, 0.1, 0.01), bx, DECK + 0.21, cz + side * ez), { wear: 0.35 })
    }
  }

  // --- stair: landing (elev 1) up to the deck ------------------------------
  {
    const lcx = (wx(sx0) + wx(sx1)) / 2
    const lcz = (wz(sz0) + wz(sz1)) / 2
    const dirX = Math.sign(cx - lcx)
    const dirZ = Math.sign(cz - lcz)
    const along = Math.abs(dirX) > Math.abs(dirZ) ? 'x' : 'z'
    const width = along === 'x' ? (sz1 - sz0 + 1) * TILE - 0.2 : (sx1 - sx0 + 1) * TILE - 0.2
    const steps = 5
    const rise = (DECK - 2.0) / steps
    const going = 0.42
    for (let i = 0; i < steps; i++) {
      const h = 2.0 + rise * (i + 1)
      const offset = (i + 0.5) * going
      const px = along === 'x' ? lcx + dirX * (TILE / 2 - 0.1 + offset) : lcx
      const pz = along === 'x' ? lcz : lcz + dirZ * (TILE / 2 - 0.1 + offset)
      const g =
        along === 'x' ? box(going + 0.04, h, width, 0.02, 1) : box(width, h, going + 0.04, 0.02, 1)
      G('concrete', at(g, px, h / 2, pz), { grimeHeight: 0.6, grimeStrength: 0.5, wear: 0.3 })
    }
    // side stringers
    for (const s of [-1, 1]) {
      const g =
        along === 'x'
          ? box(steps * going + 0.3, 1.4, 0.2, 0.03, 1)
          : box(0.2, 1.4, steps * going + 0.3, 0.03, 1)
      const px = along === 'x' ? lcx + dirX * (TILE / 2 + steps * going * 0.5 - 0.2) : lcx + s * (width / 2 + 0.08)
      const pz = along === 'x' ? lcz + s * (width / 2 + 0.08) : lcz + dirZ * (TILE / 2 + steps * going * 0.5 - 0.2)
      G('concrete', at(g, px, 2.6, pz))
    }
    // handrail
    for (const s of [-1, 1]) {
      const rl = steps * going + 0.5
      const g = along === 'x' ? box(rl, 0.07, 0.07, 0.02) : box(0.07, 0.07, rl, 0.02)
      const px = along === 'x' ? lcx + dirX * (TILE / 2 + rl * 0.5 - 0.3) : lcx + s * (width / 2 + 0.08)
      const pz = along === 'x' ? lcz + s * (width / 2 + 0.08) : lcz + dirZ * (TILE / 2 + rl * 0.5 - 0.3)
      G('rust', at(g, px, 3.5, pz, 0, along === 'z' ? -0.55 * Math.sign(dirZ) : 0, along === 'x' ? 0.55 * Math.sign(dirX) : 0))
      for (let i = 0; i <= 3; i++) {
        const t = i / 3 - 0.5
        const hx = along === 'x' ? px + t * rl : px
        const hz = along === 'x' ? pz : pz + t * rl
        G('rust', at(box(0.06, 1.0, 0.06, 0.02), hx, 3.0 + t * 0.6, hz))
      }
    }
  }

  // --- roller shutter on the far face --------------------------------------
  {
    const face = rng.chance(0.5) ? 1 : -1
    const px = cx
    const pz = cz + face * (D / 2 + 0.02)
    G('rust', at(box(3.2, 3.0, 0.24, 0.03, 1), px, 1.55, pz))
    for (let i = 0; i < 12; i++) {
      G('rust', at(box(3.05, 0.17, 0.1, 0.02), px, 0.2 + i * 0.24, pz + face * 0.13))
    }
    G('concrete', at(box(3.7, 0.34, 0.5, 0.03), px, 3.2, pz - face * 0.1))
  }

  // --- pipework + signage --------------------------------------------------
  for (const [px, pz] of [
    [minX + 0.25, minZ + 0.25],
    [maxX - 0.25, maxZ - 0.25],
    [minX + 0.25, maxZ - 0.25],
  ]) {
    G('rust', at(new THREE.CylinderGeometry(0.09, 0.09, WALL, 8), px, WALL / 2, pz))
    G('rust', at(box(0.26, 0.12, 0.26, 0.02), px, 0.28, pz))
  }
  {
    const px = cx - W * 0.3
    const pz = minZ - 0.05
    G('paint', at(box(1.3, 1.3, 0.12, 0.03), px, 2.4, pz), { tint: 0x2c56a0, wear: 0.35 })
    G('paint', at(box(0.34, 0.86, 0.05, 0.02), px, 2.4, pz - 0.09), { tint: 0xf0f0ea, wear: 0.4 })
  }
}

// ---------------------------------------------------------------------------
// Ruin: floor slab + collapsed upper storey
// ---------------------------------------------------------------------------

function buildRuin(b, push, level, spec) {
  const rng = makeRng(b.seed)
  const [x0, z0, x1, z1] = b.rect
  const TILE = level.TILE
  const minX = spec.wx(x0) - TILE / 2
  const maxX = spec.wx(x1) + TILE / 2
  const minZ = spec.wz(z0) - TILE / 2
  const maxZ = spec.wz(z1) + TILE / 2
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const W = maxX - minX
  const D = maxZ - minZ
  const tint = 0xc2bfb6

  const G = (k, g, extra = {}) => push(k, finish(g, k, { tint, seed: b.seed, groundY: 0, ...extra }))

  // ground slab, raised a step, broken at one corner
  G('concrete', at(box(W - 0.1, 0.22, D - 0.1, 0.03, 1), cx, 0.09, cz), {
    grimeHeight: 0.15,
    grimeStrength: 0.4,
    wear: 0.2,
  })

  // --- collapsed upper floor over ~40 % of the plan ------------------------
  const UP = 3.15
  const slabW = W * (0.42 + rng.next() * 0.16)
  const slabD = D * (0.55 + rng.next() * 0.2)
  const ox = cx - W * 0.24
  const oz = cz - D * 0.1
  const slab = box(slabW, 0.3, slabD, 0.04, 1)
  rough(slab, 0.05, b.seed + 4, 2)
  G('concrete', at(slab, ox, UP, oz), { grimeHeight: 0.5, grimeStrength: 0.5, wear: 0.3 })

  // ragged broken edge: chunks hanging off the free side
  for (let i = 0; i < 7; i++) {
    const s = 0.3 + rng.next() * 0.5
    const g = box(s, 0.26, s * (0.7 + rng.next()), 0.03, 1)
    rough(g, 0.06, b.seed + i, 5)
    G(
      'concrete',
      at(
        g,
        ox + slabW / 2 + rng.next() * 0.5,
        UP + (rng.next() - 0.5) * 0.16,
        oz + (rng.next() - 0.5) * slabD,
        rng.next() * 3,
        (rng.next() - 0.5) * 0.4,
        (rng.next() - 0.5) * 0.4
      )
    )
  }
  // exposed rebar mat at the break
  for (let i = 0; i < 9; i++) {
    const len = 0.4 + rng.next() * 0.8
    G(
      'rust',
      at(
        new THREE.CylinderGeometry(0.015, 0.014, len, 5),
        ox + slabW / 2 + len * 0.4,
        UP + 0.06 + (rng.next() - 0.5) * 0.14,
        oz + (rng.next() - 0.5) * slabD * 0.95,
        0,
        0,
        Math.PI / 2 + (rng.next() - 0.5) * 0.6
      )
    )
  }
  // steel joists still spanning
  for (let i = 0; i < 4; i++) {
    const jz = oz - slabD / 2 + ((i + 0.5) / 4) * slabD
    G('rust', at(box(W * 0.9, 0.22, 0.12, 0.02), cx + 0.2, UP - 0.2, jz, 0, 0, (rng.next() - 0.5) * 0.06))
  }
  // props holding it up
  for (let i = 0; i < 3; i++) {
    const px = ox + (rng.next() - 0.5) * slabW * 0.8
    const pz = oz + (rng.next() - 0.5) * slabD * 0.8
    G('rust', at(new THREE.CylinderGeometry(0.06, 0.07, UP - 0.15, 6), px, (UP - 0.15) / 2, pz, 0, (rng.next() - 0.5) * 0.08, (rng.next() - 0.5) * 0.08))
  }
  // --- underside of the surviving slab ------------------------------------
  // The iso camera looks straight into this cavity and it was a bare concrete
  // plane. Everything here hangs at UP (3.15 m) or below the slab but well
  // above the 1.8 m unit height, so it cannot block a shot or imply cover:
  // LOS is traced eye-to-centre-of-mass, both under 1.8 m, and no tile data is
  // touched. That height separation is what makes this safe to add freely.
  {
    const urng = makeRng(b.seed + 7717)
    const halfW = slabW / 2
    const halfD = slabD / 2

    // severed conduit runs, still clipped to the ceiling
    for (let i = 0; i < 3; i++) {
      const cz2 = oz + (i / 2 - 0.5) * slabD * 0.7
      const runL = slabW * (0.45 + urng.next() * 0.4)
      G('rust', at(new THREE.CylinderGeometry(0.045, 0.045, runL, 6).rotateZ(Math.PI / 2),
        ox + (urng.next() - 0.5) * slabW * 0.3, UP - 0.22, cz2), { wear: 0.5, cavity: 0.4 })
      // the broken end drooping down
      const droop = 0.3 + urng.next() * 0.5
      G('rust', at(new THREE.CylinderGeometry(0.04, 0.035, droop, 6),
        ox + runL * 0.5 * (urng.chance(0.5) ? 1 : -1), UP - 0.22 - droop / 2, cz2,
        0, 0, (urng.next() - 0.5) * 0.9), { wear: 0.6 })
    }

    // dangling rebar curtain along the broken edge
    for (let i = 0; i < 11; i++) {
      const len = 0.25 + urng.next() * 0.7
      G('rust', at(new THREE.CylinderGeometry(0.013, 0.012, len, 4),
        ox + halfW - urng.next() * 0.35,
        UP - 0.16 - len / 2,
        oz + (urng.next() - 0.5) * slabD * 1.9,
        0, (urng.next() - 0.5) * 0.5, (urng.next() - 0.5) * 0.55), { wear: 0.55 })
    }

    // spalled ceiling patches — concrete blown off exposing a rougher face
    for (let i = 0; i < 5; i++) {
      const s = 0.4 + urng.next() * 0.9
      const g = box(s, 0.06, s * (0.6 + urng.next() * 0.8), 0.02, 1)
      rough(g, 0.05, b.seed + 300 + i, 6)
      G('concrete', at(g,
        ox + (urng.next() - 0.5) * slabW * 0.85,
        UP - 0.17,
        oz + (urng.next() - 0.5) * slabD * 0.85,
        urng.next() * 3), { grimeStrength: 0.7, wear: 0.5, cavity: 0.55, topFade: 0 })
    }

    // a hanging cable with a dead fixture on the end
    {
      const hx = ox + (urng.next() - 0.5) * slabW * 0.5
      const hz = oz + (urng.next() - 0.5) * slabD * 0.5
      const drop = 0.55 + urng.next() * 0.45
      G('rust', at(new THREE.CylinderGeometry(0.012, 0.012, drop, 4), hx, UP - 0.18 - drop / 2, hz,
        0, 0, 0.12), { wear: 0.4 })
      G('rust', at(new THREE.ConeGeometry(0.17, 0.2, 8), hx + drop * 0.06, UP - 0.18 - drop - 0.08, hz),
        { wear: 0.6, cavity: 0.5 })
    }
  }

  // interior debris field
  for (let i = 0; i < 22; i++) {
    const s = 0.12 + rng.next() * 0.3
    const g = box(s, s * 0.4, s * 0.8, 0.02, 1)
    rough(g, 0.04, b.seed + i * 3, 7)
    G(
      rng.chance(0.45) ? 'brick' : 'concrete',
      at(g, cx + (rng.next() - 0.5) * (W - 1), 0.22 + s * 0.2, cz + (rng.next() - 0.5) * (D - 1), rng.next() * 3, (rng.next() - 0.5) * 0.7, (rng.next() - 0.5) * 0.7)
    )
  }
}

// ---------------------------------------------------------------------------
// Backdrop city — silhouette only, but with real window recesses
// ---------------------------------------------------------------------------

function buildBackdrop(spec, push) {
  for (const b of spec.backdrop) {
    const rng = makeRng(b.seed)
    const BACKDROP_TINTS = [0xb2b4b0, 0xa39f98, 0xbcbdb6, 0x979892, 0xa9a9a2]
    const tint = BACKDROP_TINTS[Math.floor(rng.next() * BACKDROP_TINTS.length) % BACKDROP_TINTS.length]
    const G = (k, g, extra = {}) =>
      push(k, finish(g, k, { tint, seed: b.seed, groundY: -1, grimeHeight: 6, grimeStrength: 0.35, wear: 0.1, ...extra }))

    const body = box(b.w, b.h, b.d, 0.08, 1)
    G(rng.chance(0.4) ? 'brick' : 'concrete', at(body, b.x, b.h / 2 - 1, b.z, b.ry))
    // parapet
    G('concrete', at(box(b.w + 0.4, 0.7, b.d + 0.4, 0.06), b.x, b.h - 1 + 0.2, b.z, b.ry))
    // roof clutter
    for (let i = 0; i < 3; i++) {
      const s = 0.8 + rng.next() * 1.8
      G('rust', at(box(s, s * 0.8, s, 0.05), b.x + (rng.next() - 0.5) * b.w * 0.6, b.h - 1 + 0.4 + s * 0.4, b.z + (rng.next() - 0.5) * b.d * 0.6, b.ry + rng.next()))
    }
    if (rng.chance(0.5)) {
      const h = 2 + rng.next() * 4
      G('rust', at(new THREE.CylinderGeometry(0.9, 1.1, h, 10), b.x + (rng.next() - 0.5) * b.w * 0.4, b.h - 1 + h / 2, b.z + (rng.next() - 0.5) * b.d * 0.4))
    }

    // windows on the two faces that look toward the play space
    const faceZ = b.z < 0 ? 1 : -1
    const faceX = b.x < 0 ? 1 : -1
    const rows = Math.max(2, Math.floor((b.h - 3) / 3.2))
    const colsW = Math.max(2, Math.floor(b.w / 2.6))
    const colsD = Math.max(2, Math.floor(b.d / 2.6))
    const cos = Math.cos(b.ry)
    const sin = Math.sin(b.ry)
    const put = (lx, ly, lz, w, h, d) => {
      const gx = b.x + lx * cos + lz * sin
      const gz = b.z - lx * sin + lz * cos
      const g = plainBox(w, h, d)
      G('dark', at(g, gx, ly, gz, b.ry), { grimeStrength: 0.1, wear: 0, cavity: 0, mottle: 0.35 })
    }
    for (let r = 0; r < rows; r++) {
      const ly = 1.4 + r * 3.2
      if (ly > b.h - 2.4) break
      for (let c = 0; c < colsW; c++) {
        if (rng.chance(0.12)) continue
        const lx = ((c + 0.5) / colsW - 0.5) * (b.w - 1.0)
        put(lx, ly, faceZ * (b.d / 2 - 0.18), 1.35, 1.9, 0.5)
      }
      for (let c = 0; c < colsD; c++) {
        if (rng.chance(0.12)) continue
        const lz = ((c + 0.5) / colsD - 0.5) * (b.d - 1.0)
        put(faceX * (b.w / 2 - 0.18), ly, lz, 0.5, 1.9, 1.35)
      }
    }
  }
}
