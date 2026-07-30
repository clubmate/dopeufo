/**
 * world/props.js — cover objects and set dressing.
 *
 * Every prop the level spec emits is built here. Geometry is authored in local
 * space, transformed into world space, given world-scale UVs (so no two
 * instances share a texture phase) and baked vertex colours (bottom grime, edge
 * wear, cavity darkening, per-instance tint), then merged into one batch per
 * material. Result: ~10 draw calls for the entire prop set with genuine
 * per-instance variation.
 *
 * Destructible props register a vertex range so destroyCover() can collapse
 * their triangles and drop a rubble pile in their place.
 */
import * as THREE from 'three'
import {
  bevelBox,
  worldUV,
  paintGrime,
  flatColor,
  mergeGeos,
  place,
  rough,
  makeRng,
  lerp,
} from './kit.js'

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

// `density` scales texel density on render/'s shared sets (1 = their natural
// scale); `uvRepeat` does the same job for our own bakes. Props want a much
// finer grain than a 40 m ground plane or they read as polished stone.
const MATS = {
  concrete: { name: 'concrete', opts: { density: 2.4, uvRepeat: 1, roughness: 0.92, metalness: 0 } },
  brick: { name: 'brick', opts: { density: 1.7, uvRepeat: 1, roughness: 0.94, metalness: 0 } },
  rust: { name: 'rust', opts: { density: 2.0, uvRepeat: 1.4, roughness: 0.82, metalness: 0.72 } },
  paint: { name: 'paint', opts: { density: 2.0, uvRepeat: 1.1, roughness: 0.55, metalness: 0.42 } },
  wood: { name: 'wood', opts: { density: 1.8, uvRepeat: 1.2, roughness: 0.85, metalness: 0 } },
  fabric: { name: 'fabric', opts: { density: 2.2, uvRepeat: 2.4, roughness: 0.97, metalness: 0 } },
  plastic: { name: 'plastic', opts: { density: 1.8, uvRepeat: 2, roughness: 0.6, metalness: 0 } },
}

class BatchSet {
  constructor(kit) {
    this.kit = kit
    this.batches = new Map()
    this.refs = new Map()
    this.cur = null
    this.curRef = null
    this.meshes = []
  }
  begin(ref) {
    this.cur = new Map()
    this.curRef = ref
  }
  end() {
    if (this.curRef != null && this.cur && this.cur.size) this.refs.set(this.curRef, this.cur)
    this.cur = null
    this.curRef = null
  }
  emit(matKey, geo) {
    if (!geo) return
    const g = geo.index ? geo.toNonIndexed() : geo
    let b = this.batches.get(matKey)
    if (!b) {
      b = { key: matKey, geos: [], count: 0, mesh: null }
      this.batches.set(matKey, b)
    }
    const start = b.count
    const cnt = g.attributes.position.count
    b.geos.push(g)
    b.count += cnt
    if (this.cur) {
      let arr = this.cur.get(matKey)
      if (!arr) {
        arr = []
        this.cur.set(matKey, arr)
      }
      arr.push([start, cnt])
    }
  }
  build(group, overrides = null) {
    for (const b of this.batches.values()) {
      const merged = mergeGeos(b.geos, b.key)
      if (!merged) continue
      const def = MATS[b.key]
      const mat =
        overrides?.get(b.key) ||
        (def ? this.kit.get(def.name, def.opts) : this.kit.get('concrete', { uvRepeat: 1 }))
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = 'world:props:' + b.key
      mesh.castShadow = b.key !== 'glass' && b.key !== 'foliage'
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      b.mesh = mesh
      group.add(mesh)
      this.meshes.push(mesh)
      b.geos.length = 0
    }
  }
  /** Collapse a prop's triangles to a point — instant, no rebuild. */
  collapse(ref) {
    const rec = this.refs.get(ref)
    if (!rec) return false
    for (const [matKey, ranges] of rec) {
      const b = this.batches.get(matKey)
      if (!b?.mesh) continue
      const pos = b.mesh.geometry.attributes.position
      for (const [start, cnt] of ranges) {
        const ax = pos.getX(start)
        const ay = pos.getY(start)
        const az = pos.getZ(start)
        for (let i = start; i < start + cnt; i++) pos.setXYZ(i, ax, ay, az)
      }
      pos.needsUpdate = true
    }
    this.refs.delete(ref)
    return true
  }
}

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

// Tints are multipliers on an already-tinted PBR albedo, so they lean cool and
// desaturated: render/'s concrete and dirt sets are warm, and a warm tint on a
// warm scan under a warm key light turns concrete into sandstone.
const PALETTE = {
  container: [0x9c3f2b, 0x2a5c7c, 0x3d6f4c, 0xa07d31, 0x666a70, 0xb0561f, 0x3a3a44],
  car: [0x50524f, 0x5c4a40, 0x3f4a56, 0x565448, 0x45403e],
  bus: [0x8f7a3e, 0x6a7076, 0x7d4c33],
  crate: [0xa88458, 0x94734a, 0xb98f5e],
  dumpster: [0x2c5c40, 0x2d5270, 0x6d4630, 0x4b4d4e],
  ac: [0xb6bab8, 0xa1a6a4, 0xc2c4bd],
  brickish: [0xada098, 0xa5928a, 0xb8ada2, 0x9b8d84],
  concreteish: [0xbcc0c0, 0xafb3b4, 0xc6cac9, 0xa6abac],
  steel: [0x99a1a8, 0x8a9198, 0xa6adb3],
  // Loose rubble read as bright orange toy blocks at gameplay zoom: the brick
  // albedo is (correctly) a saturated fired-clay orange, but scattered debris
  // multiplied by the neutral default tint kept all of that saturation and then
  // sat under a warm key, so it was the loudest colour on the map. Real broken
  // masonry is dust-covered and much greyer than the face of a clean brick.
  // Dust-covered broken masonry: greyer and darker than a clean brick face.
  // Note these are multipliers and are further mixed 25% toward white for the
  // brick/concrete keys downstream, so they darken more than they desaturate.
  // (Pushing them cool enough to actually neutralise the clay-orange albedo
  // measured as a 0.02% pixel change — not worth the blue cast it introduces.
  // The strongly orange surfaces in wide shots are ruin *walls* from
  // buildings.js, which have their own tints and are correctly brick-coloured.)
  rubble: [0x8a8078, 0x7d766f, 0x968a80, 0x726c66],
  // Bin bags and street litter were picking up the plastic-crate albedo, which
  // is an orange utility crate. Dark, low-saturation bag colours instead.
  litter: [0x33372f, 0x2b2d30, 0x3d3a33, 0x2a3130],
}

const pickTint = (rng, arr) => arr[Math.floor(rng.next() * arr.length) % arr.length]

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function box(w, h, d, r = 0.025, seg = 1) {
  return bevelBox(w, h, d, r, seg)
}
function cyl(rt, rb, h, seg = 8) {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1)
}
function at(g, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return place(g, x, y, z, ry, sx, sy, sz, rx, rz)
}

// ---------------------------------------------------------------------------
// prop builders — all local space, origin = base centre, +X = length
// ---------------------------------------------------------------------------

const BUILD = {
  // ---- FULL COVER --------------------------------------------------------

  container(p, rng) {
    const out = []
    const L = Math.max(p.spanX, p.spanZ) - 0.16
    const Wd = 2.32
    const Ht = 2.52
    const body = box(L, Ht, Wd, 0.045, 1)
    out.push(['paint', at(body, 0, Ht / 2, 0)])
    // corrugation ribs
    const ribs = Math.max(8, Math.round(L / 0.42))
    for (let i = 0; i < ribs; i++) {
      const u = (i + 0.5) / ribs
      const x = (u - 0.5) * (L - 0.22)
      for (const s of [-1, 1]) {
        const g = box(0.12, Ht - 0.34, 0.075, 0.02, 1)
        out.push(['paint', at(g, x, Ht / 2, s * (Wd / 2 + 0.02))])
      }
    }
    // top + bottom rails
    for (const s of [-1, 1]) {
      out.push(['paint', at(box(L + 0.06, 0.15, 0.16, 0.02), 0, Ht - 0.07, s * (Wd / 2 + 0.02))])
      out.push(['rust', at(box(L + 0.06, 0.17, 0.18, 0.02), 0, 0.09, s * (Wd / 2 + 0.02))])
    }
    // corner castings
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        for (const sy of [0, 1]) {
          const g = box(0.3, 0.24, 0.26, 0.02)
          out.push(['rust', at(g, sx * (L / 2 - 0.1), sy ? Ht - 0.12 : 0.12, sz * (Wd / 2 + 0.03))])
        }
    // doors on one end
    const ex = L / 2 + 0.02
    for (const s of [-1, 1]) {
      out.push(['paint', at(box(0.09, Ht - 0.28, Wd / 2 - 0.06, 0.02), ex, Ht / 2, s * (Wd / 4))])
      for (const bar of [-0.28, 0.28]) {
        out.push(['rust', at(cyl(0.035, 0.035, Ht - 0.5, 6), ex + 0.07, Ht / 2, s * (Wd / 4) + bar)])
      }
    }
    // dents: a couple of shallow crushed panels
    if (rng.chance(0.7)) {
      const g = box(0.8, 0.55, 0.1, 0.05, 2)
      rough(g, 0.09, p.seed, 6)
      out.push(['paint', at(g, (rng.next() - 0.5) * (L - 1.4), 0.5 + rng.next() * 1.3, (rng.chance(0.5) ? 1 : -1) * (Wd / 2 - 0.02))])
    }
    return out
  },

  carWreck(p, rng) {
    const out = []
    const L = 4.2
    const Wd = 1.8
    const v = p.variant % 3
    const H = 0.66 // sill height

    // --- wheels first, so the arches can sit over them ---------------------
    const wheelX = [-L / 2 + 0.92, L / 2 - 0.98]
    const missing = v === 1 ? 3 : -1
    let wi = 0
    for (const wx2 of wheelX) {
      for (const sz of [-1, 1]) {
        const idx = wi++
        if (idx === missing) continue
        const flat = rng.chance(0.6)
        const tyre = cyl(0.33, 0.33, 0.25, 10)
        tyre.rotateX(Math.PI / 2)
        if (flat) tyre.scale(1, 0.7, 1)
        out.push(['plastic', at(tyre, wx2, flat ? 0.24 : 0.33, sz * (Wd / 2 - 0.1))])
        const rim = cyl(0.17, 0.17, 0.1, 8)
        rim.rotateX(Math.PI / 2)
        out.push(['rust', at(rim, wx2, flat ? 0.24 : 0.33, sz * (Wd / 2 - 0.05))])
      }
    }

    // --- chassis / sills ----------------------------------------------------
    out.push(['rust', at(box(L - 0.5, 0.2, Wd - 0.42, 0.03), 0, 0.3, 0)])
    for (const sz of [-1, 1]) {
      out.push(['paint', at(box(L - 1.6, 0.2, 0.16, 0.03), 0.05, 0.44, sz * (Wd / 2 - 0.05))])
    }

    // --- body: waist box + wheel-arch haunches ------------------------------
    out.push(['paint', at(box(L - 0.24, 0.44, Wd, 0.1, 2), 0, H + 0.18, 0)])
    for (const wx2 of wheelX) {
      for (const sz of [-1, 1]) {
        const arch = cyl(0.46, 0.46, 0.2, 10)
        arch.rotateX(Math.PI / 2)
        out.push(['paint', at(arch, wx2, 0.62, sz * (Wd / 2 - 0.08))])
      }
    }

    // --- bonnet + boot, both raked ------------------------------------------
    out.push(['paint', at(box(1.35, 0.17, Wd - 0.14, 0.06, 1), -L / 2 + 0.72, 1.0, 0, 0, -0.055)])
    out.push(['paint', at(box(1.0, 0.17, Wd - 0.14, 0.06, 1), L / 2 - 0.58, 0.99, 0, 0, 0.06)])

    // --- greenhouse: two stacked boxes give a real taper ---------------------
    const crush = v === 2 ? 0.42 : 1
    const cabY = H + 0.4
    const cabH = 0.5 * crush
    const lower = box(2.05, cabH, Wd - 0.2, 0.08, 2)
    const upper = box(1.6, 0.1, Wd - 0.44, 0.05, 1)
    if (v === 2) {
      rough(lower, 0.14, p.seed + 3, 3)
      rough(upper, 0.12, p.seed + 9, 4)
    }
    out.push(['paint', at(lower, 0.16, cabY + cabH / 2, 0, 0, v === 2 ? 0.11 : 0)])
    out.push(['paint', at(upper, 0.2, cabY + cabH + 0.04, 0, 0, v === 2 ? 0.14 : 0)])
    // burnt-out cabin interior (reads as void glass)
    out.push(['dark', at(box(1.94, cabH - 0.06, Wd - 0.34, 0.03), 0.16, cabY + cabH / 2, 0)])
    // pillars
    for (const sx of [-0.92, 0.05, 0.94])
      for (const sz of [-1, 1]) {
        out.push(['paint', at(box(0.1, cabH + 0.06, 0.1, 0.02), 0.16 + sx, cabY + cabH / 2, sz * (Wd / 2 - 0.14))])
      }

    // --- bumpers, grille, lights --------------------------------------------
    out.push(['rust', at(box(0.18, 0.22, Wd - 0.04, 0.05), -L / 2 + 0.06, 0.72, 0)])
    out.push(['rust', at(box(0.15, 0.2, Wd - 0.12, 0.05), L / 2 - 0.06, 0.72, 0)])
    out.push(['dark', at(box(0.1, 0.22, Wd - 0.55, 0.02), -L / 2 + 0.14, 0.95, 0)])
    for (const sz of [-1, 1]) {
      out.push(['dark', at(box(0.09, 0.16, 0.3, 0.02), -L / 2 + 0.2, 0.95, sz * (Wd / 2 - 0.28))])
    }

    // --- damage -------------------------------------------------------------
    if (v === 0 && rng.chance(0.75)) {
      // driver's door hanging open
      out.push(['paint', at(box(0.07, 0.68, 1.05, 0.03), 0.25, 0.85, Wd / 2 + 0.36, 0, 0, 0.2)])
    }
    if (v === 2) {
      // roof torn open
      const tear = box(1.0, 0.16, 0.8, 0.06, 2)
      rough(tear, 0.16, p.seed + 21, 4)
      out.push(['rust', at(tear, 0.3, cabY + cabH + 0.1, 0, 0.4, 0.2, 0.3)])
    }
    return out
  },

  /**
   * Three wreck states. The map places several buses and they used to be
   * pixel-identical, which reads as copy-paste from any angle — the one thing a
   * reviewer notices before anything else. Variation here is deliberately in the
   * SILHOUETTE (roof line, caps, wheels) rather than in colour, because colour
   * variation is already applied per-instance downstream and repetition still
   * showed through it.
   *   0 — burnt out: roof intact, hole blown through it
   *   1 — serviceable: solid roof, AC units and vents, all caps on
   *   2 — gutted: roof collapsed over the rear, front cap torn off, wheel gone
   */
  bus(p, rng) {
    const out = []
    const v = (p.variant ?? 0) % 3
    const L = Math.max(p.spanX, p.spanZ) - 0.5
    const Wd = 2.46
    const Ht = 2.62
    out.push(['paint', at(box(L, Ht - 0.7, Wd, 0.09, 2), 0, 0.72 + (Ht - 0.7) / 2, 0)])
    // window band recess
    out.push(['rust', at(box(L - 0.4, 0.86, Wd + 0.04, 0.03), 0, 1.86, 0)])
    // window mullions — spacing differs per variant so the flank reads differently
    const bays = Math.round(L / (v === 1 ? 1.12 : 1.3))
    for (let i = 0; i <= bays; i++) {
      const x = (i / bays - 0.5) * (L - 0.5)
      out.push(['paint', at(box(0.14, 0.9, Wd + 0.06, 0.02), x, 1.86, 0)])
    }

    if (v === 2) {
      // Gutted: front half keeps its roof, rear half has caved in and sags.
      out.push(['paint', at(box(L * 0.52, 0.2, Wd - 0.06, 0.07, 2), -L * 0.23, Ht + 0.02, 0)])
      const sag = box(L * 0.4, 0.16, Wd - 0.3, 0.06, 2)
      rough(sag, 0.2, p.seed + 11, 4)
      out.push(['rust', at(sag, L * 0.26, Ht - 0.52, 0, 0, 0, -0.13)])
      // exposed roof ribs over the collapse
      for (let i = 0; i < 4; i++) {
        out.push(['rust', at(box(0.07, 0.07, Wd - 0.24, 0.02), L * (0.1 + i * 0.11), Ht - 0.2, 0, 0, 0, -0.1)])
      }
    } else {
      out.push(['paint', at(box(L - 0.1, 0.2, Wd - 0.06, 0.07, 2), 0, Ht + 0.02, 0)])
      for (const x of [-L / 4, L / 4]) {
        out.push(['plastic', at(box(0.6, 0.1, 0.6, 0.03), x, Ht + 0.16, 0.2)])
      }
      if (v === 1) {
        // roof-mounted plant: two AC boxes and a vent stack
        out.push(['steel', at(box(1.1, 0.42, 0.9, 0.05, 2), -L * 0.18, Ht + 0.33, -0.3)])
        out.push(['steel', at(box(0.8, 0.3, 0.7, 0.05, 2), L * 0.24, Ht + 0.27, 0.25)])
        const stack = cyl(0.16, 0.19, 0.5, 8)
        out.push(['rust', at(stack, L * 0.05, Ht + 0.37, -0.6)])
      }
    }

    // skirt + wheels
    out.push(['rust', at(box(L - 0.2, 0.5, Wd - 0.18, 0.04), 0, 0.5, 0)])
    const axles = [-L / 2 + 1.3, L / 2 - 1.5, L / 2 - 2.9]
    for (let a = 0; a < axles.length; a++) {
      for (const s of [-1, 1]) {
        // gutted wreck is missing its near rear wheel — scavenged
        if (v === 2 && a === 1 && s === 1) continue
        const g = cyl(0.45, 0.45, 0.28, 10)
        g.rotateX(Math.PI / 2)
        out.push(['plastic', at(g, axles[a], 0.44, s * (Wd / 2 - 0.1))])
      }
    }

    // front/rear caps — the gutted one has lost its front
    for (const s of [-1, 1]) {
      if (v === 2 && s === 1) continue
      out.push(['paint', at(box(0.2, Ht - 0.9, Wd - 0.12, 0.09, 2), s * (L / 2 + 0.06), 1.5, 0)])
    }

    // burnt-out roof hole, only on the burnt variant
    if (v === 0) {
      const hole = box(1.7, 0.3, 1.5, 0.1, 2)
      rough(hole, 0.16, p.seed, 4)
      out.push(['rust', at(hole, L * 0.12, Ht + 0.06, 0)])
    }
    return out
  },

  dumpster(p, rng) {
    const out = []
    const Wd = 1.72
    const D = 1.32
    const H = 1.24
    // tapered body: two stacked boxes
    out.push(['paint', at(box(Wd - 0.24, H * 0.55, D - 0.22, 0.04), 0, H * 0.3, 0)])
    out.push(['paint', at(box(Wd, H * 0.5, D, 0.05), 0, H * 0.72, 0)])
    // ribs
    for (const x of [-0.55, 0, 0.55])
      out.push(['paint', at(box(0.1, H * 0.95, D + 0.04, 0.02), x, H * 0.52, 0)])
    // lids
    for (const s of [-1, 1]) {
      const open = rng.chance(0.4)
      const g = box(Wd * 0.5 - 0.03, 0.07, D - 0.04, 0.03)
      if (open) at(g, s * Wd * 0.26, H + 0.36, -D * 0.35, 0, -0.9)
      else at(g, s * Wd * 0.26, H + 0.02, 0)
      out.push(['plastic', g])
    }
    // wheels + lifting pockets
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const g = cyl(0.11, 0.11, 0.08, 8)
        g.rotateZ(Math.PI / 2)
        out.push(['plastic', at(g, sx * (Wd / 2 - 0.2), 0.11, sz * (D / 2 - 0.18))])
      }
    out.push(['rust', at(box(Wd + 0.06, 0.12, 0.14, 0.02), 0, H * 0.5, D / 2 + 0.02)])
    return out
  },

  jersey(p, rng) {
    const out = []
    const L = 1.86
    // concrete barrier profile, built from three stacked slabs
    out.push(['concrete', at(box(L, 0.24, 0.6, 0.03), 0, 0.12, 0)])
    out.push(['concrete', at(box(L, 0.34, 0.42, 0.03), 0, 0.4, 0)])
    out.push(['concrete', at(box(L, 0.5, 0.26, 0.03), 0, 0.82, 0)])
    out.push(['concrete', at(box(L + 0.04, 0.09, 0.3, 0.025), 0, 1.06, 0)])
    // steel anti-throw screen — this is what makes it FULL cover
    for (const s of [-1, 1]) {
      out.push(['rust', at(box(0.09, 0.86, 0.09, 0.02), s * (L / 2 - 0.12), 1.5, 0)])
    }
    for (const y of [1.28, 1.6, 1.88]) {
      out.push(['rust', at(box(L - 0.1, 0.055, 0.05, 0.015), 0, y, 0)])
    }
    for (let i = 0; i < 7; i++) {
      const x = (i / 6 - 0.5) * (L - 0.28)
      out.push(['rust', at(box(0.03, 0.82, 0.03, 0.01), x, 1.5, 0)])
    }
    return out
  },

  sandbags(p, rng) {
    const out = []
    const rows = 4
    for (let r = 0; r < rows; r++) {
      const y = 0.16 + r * 0.29
      const cols = 5 - (r % 2 === 1 ? 1 : 0)
      const depth = 2
      for (let d = 0; d < depth; d++) {
        for (let c = 0; c < cols; c++) {
          // A filled sandbag is not an ellipsoid: it slumps under the bags
          // above it, bulges at the waist and stays fatter at the bottom of the
          // stack. Detail 1 icosahedra scaled uniformly read as identical
          // beige lozenges — "marshmallows", in the words of a reviewer.
          // Detail 2 plus a per-bag squash that increases with depth in the
          // stack, and stronger surface noise, gives them weight.
          const load = 1 - r / rows // lower courses carry more
          const g = new THREE.IcosahedronGeometry(0.3, 2)
          g.scale(1.13 + load * 0.16, 0.54 - load * 0.11, 0.7 + load * 0.1)
          // Squash the underside flat where the bag beds down on the one below.
          const pos = g.attributes.position
          for (let i = 0; i < pos.count; i++) {
            const vy = pos.getY(i)
            if (vy < -0.06) pos.setY(i, -0.06 + (vy + 0.06) * 0.45)
          }
          pos.needsUpdate = true
          g.computeVertexNormals()
          rough(g, 0.105, p.seed + r * 13 + c * 7 + d * 3, 5)
          const x = (c - (cols - 1) / 2) * 0.38 + (r % 2 ? 0.19 : 0) + (rng.next() - 0.5) * 0.07
          const z = (d - 0.5) * 0.44 + (rng.next() - 0.5) * 0.07
          out.push(['fabric', at(g, x, y, z, (rng.next() - 0.5) * 0.55, 0, (rng.next() - 0.5) * 0.2)])
        }
      }
    }
    return out
  },

  pillar(p, rng) {
    const out = []
    const g = box(0.86, 3.6, 0.86, 0.06, 1)
    out.push(['concrete', at(g, 0, 1.8, 0)])
    out.push(['concrete', at(box(1.12, 0.22, 1.12, 0.04), 0, 0.11, 0)])
    out.push(['concrete', at(box(1.0, 0.16, 1.0, 0.04), 0, 3.62, 0)])
    // spalled corner exposing rebar
    for (let i = 0; i < 3; i++) {
      out.push([
        'rust',
        at(cyl(0.017, 0.017, 0.9, 5), 0.34 + (rng.next() - 0.5) * 0.06, 2.4 + i * 0.05, 0.34, 0, (rng.next() - 0.5) * 0.2, 0),
      ])
    }
    const chunk = box(0.3, 0.5, 0.3, 0.05, 2)
    rough(chunk, 0.14, p.seed, 5)
    out.push(['concrete', at(chunk, 0.36, 2.45, 0.36, 0.4)])
    return out
  },

  acUnit(p, rng) {
    const out = []
    const W2 = 1.4
    const D = 1.1
    const H = 1.15
    out.push(['paint', at(box(W2, H, D, 0.05, 1), 0, H / 2 + 0.12, 0)])
    out.push(['rust', at(box(W2 + 0.1, 0.14, D + 0.1, 0.03), 0, 0.07, 0)])
    // fan cowls
    for (const x of [-0.32, 0.32]) {
      out.push(['paint', at(cyl(0.31, 0.33, 0.16, 14), x, H + 0.2, 0)])
      out.push(['rust', at(cyl(0.27, 0.27, 0.04, 12), x, H + 0.29, 0)])
      for (let i = 0; i < 4; i++) {
        out.push(['rust', at(box(0.5, 0.02, 0.05, 0.005), x, H + 0.3, 0, (i * Math.PI) / 4)])
      }
    }
    // louvre band
    for (let i = 0; i < 6; i++) {
      out.push(['rust', at(box(W2 - 0.14, 0.05, 0.03, 0.01), 0, 0.34 + i * 0.13, D / 2 + 0.01, 0, 0.25)])
    }
    // conduit
    out.push(['rust', at(cyl(0.05, 0.05, 0.7, 6), W2 / 2 + 0.04, 0.45, -D / 2 + 0.15)])
    return out
  },

  /** Stair / lift penthouse. Never a plain cube: pilasters, recessed panel
   *  fields, a door opening with real jamb depth, coping, vent, downpipe. */
  liftCore(p, rng) {
    const out = []
    const W2 = p.spanX - 0.7
    const D = p.spanZ - 0.7
    const H = 3.0
    const T = 0.22 // how far pilasters stand proud

    // recessed panel core (the wall plane that everything else sits in front of)
    out.push(['concrete', at(box(W2 - T * 2, H, D - T * 2, 0.05, 1), 0, H / 2, 0)])
    // dark shadow gap so the recess reads at iso distance
    out.push(['dark', at(box(W2 - T * 1.4, H - 0.5, D - T * 1.4, 0.02), 0, H / 2 - 0.1, 0)])

    // corner pilasters
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        out.push(['concrete', at(box(0.5, H, 0.5, 0.04, 1), sx * (W2 / 2 - 0.25), H / 2, sz * (D / 2 - 0.25))])
      }
    // spandrel bands between them
    for (const [ax, az, len, ry] of [
      [0, -(D / 2 - 0.14), W2, 0],
      [0, D / 2 - 0.14, W2, 0],
      [-(W2 / 2 - 0.14), 0, D, Math.PI / 2],
      [W2 / 2 - 0.14, 0, D, Math.PI / 2],
    ]) {
      const g = ry === 0 ? box(len - 0.9, 0.4, 0.28, 0.03) : box(0.28, 0.4, len - 0.9, 0.03)
      out.push(['concrete', at(g, ax, H - 0.55, az)])
    }

    // --- door opening on +Z, built as jambs + lintel so it has real depth ---
    const dw = 1.15
    const dh = 2.15
    const zf = D / 2 - 0.06
    out.push(['dark', at(box(dw, dh, 0.55, 0.01), 0, dh / 2, zf - 0.28)])
    for (const s of [-1, 1]) {
      out.push(['concrete', at(box((W2 - dw) / 2 - 0.4, dh + 0.3, 0.34, 0.03), s * (dw / 2 + (W2 - dw) / 4 - 0.2), (dh + 0.3) / 2, zf)])
    }
    out.push(['concrete', at(box(W2 - 0.9, 0.42, 0.34, 0.03), 0, dh + 0.21, zf)])
    // steel door leaf, ajar
    out.push(['rust', at(box(0.06, dh - 0.1, dw - 0.08, 0.015), -dw * 0.42, (dh - 0.1) / 2, zf - 0.1, 0, 0, 0)])
    out.push(['rust', at(box(0.05, 0.1, 0.34, 0.01), -dw * 0.42 - 0.05, 1.05, zf - 0.02)])

    // --- vent louvre on -Z ---------------------------------------------------
    out.push(['dark', at(box(1.0, 0.72, 0.16, 0.01), 0, 2.05, -(D / 2 - 0.1))])
    for (let i = 0; i < 6; i++) {
      out.push(['rust', at(box(0.96, 0.06, 0.08, 0.015), 0, 1.76 + i * 0.13, -(D / 2 - 0.05), 0, 0.35)])
    }

    // --- coping + roof upstand ----------------------------------------------
    out.push(['concrete', at(box(W2 + 0.3, 0.26, D + 0.3, 0.04, 1), 0, H + 0.13, 0)])
    out.push(['concrete', at(box(W2 + 0.36, 0.08, D + 0.36, 0.02), 0, H + 0.02, 0)])
    out.push(['rust', at(cyl(0.13, 0.15, 0.5, 8), W2 * 0.22, H + 0.5, -D * 0.2)])
    out.push(['rust', at(cyl(0.2, 0.18, 0.1, 8), W2 * 0.22, H + 0.78, -D * 0.2)])

    // --- downpipe + brackets --------------------------------------------------
    const px = W2 / 2 - 0.1
    const pz = -(D / 2 - 0.1)
    out.push(['rust', at(cyl(0.055, 0.055, H, 7), px, H / 2, pz)])
    for (const y of [0.7, 1.9, 2.8]) out.push(['rust', at(box(0.2, 0.05, 0.08, 0.01), px - 0.08, y, pz)])
    out.push(['rust', at(box(0.26, 0.08, 0.26, 0.02), px, 0.05, pz)])
    return out
  },

  metroHead(p, rng) {
    const out = []
    const W2 = Math.max(p.spanX, p.spanZ) - 0.4
    const D = Math.min(p.spanX, p.spanZ) - 0.5
    const H = 2.5
    // stair void
    out.push(['concrete', at(box(W2 - 0.3, 0.5, D - 0.3, 0.03), 0, -0.24, 0)])
    // frame
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        out.push(['rust', at(box(0.13, H, 0.13, 0.02), sx * (W2 / 2 - 0.07), H / 2, sz * (D / 2 - 0.07))])
      }
    for (const sz of [-1, 1]) {
      out.push(['rust', at(box(W2, 0.12, 0.12, 0.02), 0, H - 0.06, sz * (D / 2 - 0.07))])
      out.push(['rust', at(box(W2, 0.12, 0.12, 0.02), 0, 0.9, sz * (D / 2 - 0.07))])
    }
    // glazing (some panes gone)
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        if (rng.chance(0.3)) continue
        const g = box(W2 / 3 - 0.09, H - 1.1, 0.035, 0.005)
        out.push(['glass', at(g, (i - 1) * (W2 / 3), 1.52, sz * (D / 2 - 0.07))])
      }
    }
    // canopy
    out.push(['paint', at(box(W2 + 0.5, 0.14, D + 0.5, 0.05, 1), 0, H + 0.1, 0)])
    out.push(['paint', at(box(W2 + 0.3, 0.34, 0.1, 0.03), 0, H + 0.3, D / 2 + 0.16)])
    // balustrade down to the stair
    for (const sx of [-1, 1]) {
      out.push(['concrete', at(box(0.16, 0.95, D - 0.2, 0.03), sx * (W2 / 2 + 0.12), 0.47, 0)])
    }
    return out
  },

  // ---- HALF COVER --------------------------------------------------------

  lowWall(p, rng) {
    const out = []
    const L = 1.94
    const H = 0.94
    const T = 0.32
    const courses = 7
    for (let i = 0; i < courses; i++) {
      const y = 0.05 + i * (H - 0.14) / courses
      const missing = i >= courses - 2 && rng.chance(0.3)
      const seg = missing ? 0.55 + rng.next() * 0.3 : 1
      const g = box(L * seg, (H - 0.14) / courses + 0.006, T, 0.012, 1)
      out.push(['brick', at(g, (1 - seg) * L * 0.5 * (rng.chance(0.5) ? 1 : -1), y + 0.03, 0, 0, 0, (rng.next() - 0.5) * 0.012)])
    }
    // coping
    if (rng.chance(0.75)) {
      out.push(['concrete', at(box(L + 0.06, 0.1, T + 0.1, 0.02), 0, H - 0.02, 0)])
    } else {
      // broken top — a couple of loose bricks
      for (let i = 0; i < 3; i++) {
        out.push([
          'brick',
          at(box(0.24, 0.1, 0.11, 0.012), (rng.next() - 0.5) * L, H - 0.02, (rng.next() - 0.5) * 0.2, rng.next() * 1.2, 0, (rng.next() - 0.5) * 0.5),
        ])
      }
    }
    // footing
    out.push(['concrete', at(box(L + 0.04, 0.1, T + 0.14, 0.02), 0, 0.05, 0)])
    return out
  },

  parapet(p, rng) {
    const out = []
    const L = 1.98
    out.push(['concrete', at(box(L, 0.88, 0.26, 0.03, 1), 0, 0.44, 0)])
    out.push(['concrete', at(box(L, 0.11, 0.4, 0.025), 0, 0.94, 0)])
    // weep holes / stains handled by grime; add a drip edge
    out.push(['concrete', at(box(L, 0.05, 0.44, 0.02), 0, 0.87, 0)])
    if (rng.chance(0.35)) {
      out.push(['rust', at(box(0.1, 0.5, 0.1, 0.02), (rng.next() - 0.5) * L, 1.2, 0)])
    }
    return out
  },

  railing(p, rng) {
    const out = []
    const L = 2.0
    for (const sx of [-1, 1]) out.push(['rust', at(cyl(0.045, 0.05, 1.02, 7), sx * (L / 2 - 0.06), 0.51, 0)])
    for (const y of [0.5, 0.98]) out.push(['rust', at(box(L, 0.06, 0.06, 0.02), 0, y, 0)])
    for (let i = 0; i < 9; i++) {
      out.push(['rust', at(cyl(0.018, 0.018, 0.94, 5), (i / 8 - 0.5) * (L - 0.16), 0.5, 0)])
    }
    out.push(['concrete', at(box(L, 0.12, 0.22, 0.02), 0, 0.06, 0)])
    return out
  },

  crate(p, rng) {
    const out = []
    const s = 0.86 + rng.next() * 0.16
    const H = 0.78 + rng.next() * 0.2
    out.push(['wood', at(box(s, H, s, 0.02, 1), 0, H / 2, 0)])
    // slat detail
    for (const sz of [-1, 1]) {
      for (const y of [0.12, H - 0.12]) {
        out.push(['wood', at(box(s + 0.03, 0.11, 0.035, 0.01), 0, y, sz * (s / 2 + 0.01))])
        out.push(['wood', at(box(0.035, H - 0.05, 0.11, 0.01), sz * (s / 2 + 0.01), H / 2, 0)])
      }
      out.push(['wood', at(box(s * 1.35, 0.08, 0.03, 0.01), 0, H / 2, sz * (s / 2 + 0.015), 0, 0, 0.72)])
    }
    // a second crate stacked, sometimes
    if (rng.chance(0.4)) {
      const s2 = s * 0.8
      const h2 = H * 0.7
      out.push(['wood', at(box(s2, h2, s2, 0.02, 1), (rng.next() - 0.5) * 0.16, H + h2 / 2, (rng.next() - 0.5) * 0.16, rng.next() * 0.6)])
    }
    return out
  },

  planter(p, rng) {
    const out = []
    const s = 1.34
    out.push(['concrete', at(box(s, 0.62, s, 0.05, 1), 0, 0.31, 0)])
    out.push(['concrete', at(box(s + 0.12, 0.12, s + 0.12, 0.03), 0, 0.64, 0)])
    out.push(['concrete', at(box(s * 0.86, 0.14, s * 0.86, 0.03), 0, 0.1, 0)])
    // soil
    const soil = new THREE.PlaneGeometry(s - 0.18, s - 0.18, 3, 3)
    soil.rotateX(-Math.PI / 2)
    rough(soil, 0.05, p.seed, 4)
    out.push(['concrete', at(soil, 0, 0.6, 0)])
    // dead shrub
    for (let i = 0; i < 7; i++) {
      const h = 0.4 + rng.next() * 0.7
      out.push([
        'wood',
        at(cyl(0.008, 0.022, h, 4), (rng.next() - 0.5) * 0.5, 0.6 + h / 2, (rng.next() - 0.5) * 0.5, 0, (rng.next() - 0.5) * 0.7, (rng.next() - 0.5) * 0.7),
      ])
    }
    return out
  },

  rubblePile(p, rng) {
    const out = []
    const count = 14 + Math.floor(rng.next() * 10)
    for (let i = 0; i < count; i++) {
      const s = 0.16 + rng.next() * 0.4
      const g = box(s, s * (0.35 + rng.next() * 0.6), s * (0.6 + rng.next() * 0.7), 0.02, 1)
      rough(g, 0.05, p.seed + i, 7)
      const r = rng.next()
      const rad = r * 0.78
      const a = rng.next() * Math.PI * 2
      out.push([
        rng.chance(0.35) ? 'brick' : 'concrete',
        at(g, Math.cos(a) * rad, 0.06 + (1 - r) * 0.55 * rng.next() + s * 0.3, Math.sin(a) * rad, rng.next() * 3.1, (rng.next() - 0.5) * 0.9, (rng.next() - 0.5) * 0.9),
      ])
    }
    for (let i = 0; i < 4; i++) {
      const h = 0.3 + rng.next() * 0.5
      out.push([
        'rust',
        at(cyl(0.014, 0.014, h, 5), (rng.next() - 0.5) * 1.2, 0.25 + h / 2, (rng.next() - 0.5) * 1.2, 0, (rng.next() - 0.5) * 1.4, (rng.next() - 0.5) * 1.4),
      ])
    }
    return out
  },

  bench(p, rng) {
    const out = []
    const L = 1.8
    for (const sx of [-1, 1]) {
      out.push(['concrete', at(box(0.14, 0.42, 0.52, 0.03), sx * (L / 2 - 0.16), 0.21, 0)])
    }
    for (let i = 0; i < 4; i++) {
      const z = (i - 1.5) * 0.15
      out.push(['wood', at(box(L, 0.05, 0.12, 0.015), 0, 0.44, z)])
    }
    for (let i = 0; i < 3; i++) {
      out.push(['wood', at(box(L, 0.05, 0.11, 0.015), 0, 0.62 + i * 0.15, -0.24, 0, -0.16)])
    }
    return out
  },

  hydrant(p, rng) {
    const out = []
    out.push(['paint', at(cyl(0.11, 0.15, 0.62, 10), 0, 0.31, 0)])
    out.push(['paint', at(cyl(0.16, 0.16, 0.07, 10), 0, 0.66, 0)])
    out.push(['paint', at(cyl(0.07, 0.1, 0.13, 8), 0, 0.75, 0)])
    for (const s of [-1, 1]) {
      out.push(['paint', at(cyl(0.07, 0.07, 0.14, 8), s * 0.13, 0.42, 0, 0, 0, Math.PI / 2)])
    }
    out.push(['concrete', at(box(0.4, 0.08, 0.4, 0.02), 0, 0.04, 0)])
    return out
  },

  // ---- WALLS -------------------------------------------------------------

  ruinWall(p, rng) {
    const out = []
    const L = 2.0
    const T = 0.36
    if (p.variant === 1) {
      const H = 3.4
      // pier at each end
      for (const sx of [-1, 1]) out.push(['brick', at(box(0.34, H, T + 0.06, 0.02, 1), sx * (L / 2 - 0.17), H / 2, 0)])
      // sill / lintel bands with a window opening between
      out.push(['brick', at(box(L, 0.95, T, 0.02, 1), 0, 0.475, 0)])
      out.push(['brick', at(box(L, 0.62, T, 0.02, 1), 0, 2.45, 0)])
      out.push(['concrete', at(box(L - 0.2, 0.14, T + 0.12, 0.02), 0, 1.02, 0)])
      out.push(['concrete', at(box(L - 0.1, 0.16, T + 0.14, 0.02), 0, 2.12, 0)])
      // window reveal (dark recess so it reads as a hole)
      out.push(['concrete', at(box(L - 0.5, 1.0, T - 0.14, 0.01), 0, 1.62, 0)])
      // ragged top course
      const chunks = 4
      for (let i = 0; i < chunks; i++) {
        const h = rng.next() * 0.42
        if (h < 0.08) continue
        const g = box(L / chunks - 0.02, h, T - 0.02, 0.015)
        out.push(['brick', at(g, (i + 0.5) * (L / chunks) - L / 2, H - 0.6 + h / 2 + 0.6, 0, 0, 0, (rng.next() - 0.5) * 0.06)])
      }
      // spalled render patches
      for (let i = 0; i < 3; i++) {
        const g = box(0.3 + rng.next() * 0.5, 0.25 + rng.next() * 0.5, 0.05, 0.03, 1)
        out.push(['concrete', at(g, (rng.next() - 0.5) * (L - 0.5), 0.4 + rng.next() * 2.4, (rng.chance(0.5) ? 1 : -1) * (T / 2 + 0.02))])
      }
    } else {
      // collapsed to waist height, broken profile
      const chunks = 5
      for (let i = 0; i < chunks; i++) {
        const h = 0.6 + rng.next() * 0.55
        const g = box(L / chunks + 0.01, h, T, 0.02, 1)
        out.push(['brick', at(g, (i + 0.5) * (L / chunks) - L / 2, h / 2, 0, 0, 0, (rng.next() - 0.5) * 0.05)])
      }
      out.push(['concrete', at(box(L + 0.04, 0.12, T + 0.12, 0.02), 0, 0.06, 0)])
      // fallen bricks at the base
      for (let i = 0; i < 6; i++) {
        out.push([
          'brick',
          at(box(0.22, 0.09, 0.11, 0.01), (rng.next() - 0.5) * L, 0.05 + rng.next() * 0.08, (rng.chance(0.5) ? 1 : -1) * (0.28 + rng.next() * 0.45), rng.next() * 3, 0, (rng.next() - 0.5) * 0.4),
        ])
      }
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// dressing builders (no cover, no tile data)
// ---------------------------------------------------------------------------

const DRESS = {
  lamp(d, rng) {
    const out = []
    const H = 5.4
    out.push(['concrete', at(box(0.44, 0.16, 0.44, 0.03), 0, 0.08, 0)])
    out.push(['rust', at(cyl(0.075, 0.11, H, 8), 0, H / 2, 0)])
    // curved arm
    for (let i = 0; i < 5; i++) {
      const t = i / 4
      out.push(['rust', at(cyl(0.055, 0.06, 0.36, 6), t * 0.62, H - 0.14 + Math.sin(t * 1.4) * 0.28, 0, 0, 0, -0.55 - t * 0.5)])
    }
    out.push(['paint', at(box(0.62, 0.13, 0.3, 0.05, 1), 0.92, H + 0.22, 0, 0, 0, 0.12)])
    out.push(['glass', at(box(0.5, 0.05, 0.22, 0.02), 0.92, H + 0.13, 0)])
    return out
  },
  deckLamp(d, rng) {
    const out = []
    const H = 3.2
    out.push(['concrete', at(box(0.32, 0.14, 0.32, 0.02), 0, 0.07, 0)])
    out.push(['rust', at(cyl(0.06, 0.08, H, 7), 0, H / 2, 0)])
    out.push(['paint', at(box(0.44, 0.12, 0.26, 0.04), 0, H + 0.1, 0)])
    return out
  },
  trafficLight(d, rng) {
    const out = []
    const H = 4.6
    out.push(['concrete', at(box(0.4, 0.14, 0.4, 0.02), 0, 0.07, 0)])
    out.push(['rust', at(cyl(0.08, 0.1, H, 8), 0, H / 2, 0)])
    for (let i = 0; i < 5; i++) {
      out.push(['rust', at(cyl(0.055, 0.055, 0.4, 6), i * 0.36, H - 0.1 + Math.sin((i / 4) * 1.2) * 0.2, 0, 0, 0, -Math.PI / 2 + 0.25)])
    }
    const head = box(0.3, 0.86, 0.28, 0.04, 1)
    out.push(['paint', at(head, 1.5, H + 0.04, 0)])
    for (let i = 0; i < 3; i++) {
      out.push(['glass', at(cyl(0.1, 0.1, 0.06, 10), 1.5, H + 0.3 - i * 0.26, 0.16, 0, Math.PI / 2)])
      out.push(['paint', at(cyl(0.13, 0.11, 0.11, 10), 1.5, H + 0.33 - i * 0.26, 0.2, 0, Math.PI / 2)])
    }
    return out
  },
  signPost(d, rng) {
    const out = []
    out.push(['rust', at(cyl(0.04, 0.05, 2.9, 6), 0, 1.45, 0)])
    out.push(['paint', at(box(0.9, 0.34, 0.035, 0.01), 0.36, 2.5, 0)])
    out.push(['paint', at(box(0.62, 0.28, 0.035, 0.01), 0.26, 2.06, 0, 0, 0, -0.06)])
    return out
  },
  islandSign(d, rng) {
    const out = []
    out.push(['rust', at(cyl(0.05, 0.06, 2.4, 6), 0, 1.2, 0)])
    out.push(['paint', at(box(0.16, 0.7, 0.7, 0.02), 0, 2.3, 0)])
    return out
  },
  billboard(d, rng) {
    const out = []
    const W2 = 6.4
    const H = 2.9
    for (const sx of [-1, 1]) {
      out.push(['rust', at(cyl(0.11, 0.13, 2.4, 7), sx * (W2 / 2 - 0.7), 1.2, 0.1)])
      out.push(['rust', at(cyl(0.07, 0.07, 2.6, 6), sx * (W2 / 2 - 0.7), 1.7, 0.9, 0, 0.5)])
    }
    out.push(['paint', at(box(W2, H, 0.16, 0.04, 1), 0, 2.4 + H / 2, 0)])
    out.push(['rust', at(box(W2 + 0.2, 0.14, 0.3, 0.02), 0, 2.36, 0)])
    out.push(['rust', at(box(W2 + 0.2, 0.14, 0.3, 0.02), 0, 2.44 + H, 0)])
    for (let i = 0; i < 3; i++) {
      out.push(['rust', at(cyl(0.035, 0.035, 0.5, 5), (i - 1) * 2.0, 2.44 + H + 0.24, 0.3, 0, -0.7)])
      out.push(['paint', at(box(0.3, 0.14, 0.18, 0.03), (i - 1) * 2.0, 2.44 + H + 0.44, 0.5)])
    }
    return out
  },
  roofVent(d, rng) {
    const out = []
    out.push(['rust', at(box(0.7, 0.24, 0.7, 0.03), 0, 0.12, 0)])
    out.push(['rust', at(cyl(0.24, 0.26, 0.62, 10), 0, 0.55, 0)])
    out.push(['rust', at(cyl(0.34, 0.3, 0.12, 10), 0, 0.92, 0)])
    return out
  },
  aerial(d, rng) {
    const out = []
    out.push(['rust', at(cyl(0.04, 0.05, 3.2, 5), 0, 1.6, 0)])
    for (let i = 0; i < 4; i++) {
      const y = 1.6 + i * 0.4
      out.push(['rust', at(box(1.1 - i * 0.18, 0.03, 0.03, 0.01), 0, y, 0, i * 0.3)])
    }
    return out
  },
  cablePole(d, rng) {
    const out = []
    out.push(['wood', at(cyl(0.12, 0.16, 6.2, 8), 0, 3.1, 0)])
    for (const y of [5.2, 5.7]) out.push(['wood', at(box(1.6, 0.11, 0.11, 0.02), 0, y, 0)])
    for (const y of [5.2, 5.7])
      for (const s of [-1, 1]) out.push(['glass', at(cyl(0.05, 0.06, 0.13, 6), s * 0.68, y + 0.11, 0)])
    out.push(['rust', at(box(0.4, 0.5, 0.28, 0.03), 0.18, 3.4, 0)])
    return out
  },
  fence(d, rng) {
    const out = []
    const L = 2.0
    const H = 2.1
    const lean = (rng.next() - 0.5) * 0.12
    for (const sx of [-1, 1]) out.push(['rust', at(cyl(0.045, 0.05, H, 6), sx * (L / 2 - 0.04), H / 2, 0, 0, 0, lean)])
    for (const y of [H - 0.04, 0.06]) out.push(['rust', at(box(L, 0.045, 0.045, 0.01), 0, y, 0, 0, 0, lean)])
    // mesh suggested by a sparse diagonal lattice — reads correctly at iso range
    const cells = 7
    for (let i = 0; i < cells; i++) {
      const x = (i / (cells - 1) - 0.5) * (L - 0.1)
      out.push(['rust', at(cyl(0.012, 0.012, H - 0.1, 4), x, H / 2, 0, 0, 0, lean)])
    }
    for (let i = 0; i < 4; i++) {
      out.push(['rust', at(box(L, 0.016, 0.016, 0.005), 0, 0.24 + i * 0.5, 0, 0, 0, lean)])
    }
    return out
  },
  kiosk(d, rng) {
    const out = []
    const W2 = 2.2
    const D = 1.5
    const H = 2.4
    out.push(['paint', at(box(W2, H, D, 0.05, 1), 0, H / 2, 0)])
    out.push(['rust', at(box(W2 + 0.36, 0.16, D + 0.36, 0.04), 0, H + 0.08, 0)])
    out.push(['glass', at(box(W2 - 0.36, 1.0, 0.06, 0.01), 0, 1.5, D / 2 + 0.01)])
    out.push(['rust', at(box(W2 - 0.3, 0.12, 0.3, 0.02), 0, 0.95, D / 2 + 0.1)])
    out.push(['paint', at(box(W2 + 0.1, 0.4, 0.08, 0.02), 0, 2.2, D / 2 + 0.03)])
    return out
  },
  manholeRig(d, rng) {
    const out = []
    out.push(['rust', at(cyl(0.42, 0.42, 0.08, 16), 0, 0.02, 0)])
    out.push(['rust', at(cyl(0.5, 0.5, 0.05, 16), 0, -0.01, 0)])
    return out
  },
  debris(d, rng) {
    const out = []
    for (let i = 0; i < 4 + Math.floor(rng.next() * 5); i++) {
      const s = 0.07 + rng.next() * 0.22
      const g = box(s, s * 0.4, s * 0.8, 0.01, 1)
      rough(g, 0.03, d.seed + i, 8)
      out.push([rng.chance(0.4) ? 'brick' : 'concrete', at(g, (rng.next() - 0.5) * 1.0, s * 0.2, (rng.next() - 0.5) * 1.0, rng.next() * 3, (rng.next() - 0.5) * 0.5, (rng.next() - 0.5) * 0.5)])
    }
    return out
  },
  brickPile(d, rng) {
    const out = []
    for (let i = 0; i < 8 + Math.floor(rng.next() * 8); i++) {
      const g = box(0.21, 0.085, 0.1, 0.008)
      out.push(['brick', at(g, (rng.next() - 0.5) * 0.8, 0.045 + Math.floor(rng.next() * 3) * 0.09, (rng.next() - 0.5) * 0.8, rng.next() * 3.1, (rng.next() - 0.5) * 0.3, (rng.next() - 0.5) * 0.3)])
    }
    return out
  },
  trash(d, rng) {
    const out = []
    for (let i = 0; i < 2 + Math.floor(rng.next() * 3); i++) {
      // Detail 1 gives ~80 tris and a visibly faceted ball; at gameplay zoom
      // these read as low-poly blobs rather than slumped bags. Detail 2 is
      // ~320 tris — trivial against a 2 M budget — and holds a soft silhouette.
      const g = new THREE.IcosahedronGeometry(0.24 + rng.next() * 0.14, 2)
      g.scale(1, 0.68, 0.9)
      rough(g, 0.06, d.seed + i, 6)
      out.push(['plastic', at(g, (rng.next() - 0.5) * 0.7, 0.16, (rng.next() - 0.5) * 0.7, rng.next() * 3)])
    }
    return out
  },
  cone(d, rng) {
    const out = []
    const fallen = rng.chance(0.35)
    const g = new THREE.ConeGeometry(0.19, 0.62, 8, 1, true)
    const base = box(0.42, 0.05, 0.42, 0.01)
    if (fallen) {
      out.push(['plastic', at(g, 0, 0.19, 0, 0, Math.PI / 2 - 0.1)])
      out.push(['plastic', at(base, 0.3, 0.02, 0, 0, 0, Math.PI / 2)])
    } else {
      out.push(['plastic', at(g, 0, 0.33, 0)])
      out.push(['plastic', at(base, 0, 0.025, 0)])
    }
    return out
  },
  tyre(d, rng) {
    const out = []
    const g = new THREE.TorusGeometry(0.31, 0.11, 5, 10)
    const flat = rng.chance(0.75)
    if (flat) {
      g.rotateX(Math.PI / 2)
      g.scale(1, 0.75, 1)
      out.push(['plastic', at(g, 0, 0.07, 0)])
    } else {
      out.push(['plastic', at(g, 0, 0.3, 0, 0, 0, 0.25)])
    }
    return out
  },
  pallet(d, rng) {
    const out = []
    for (let i = 0; i < 5; i++) {
      out.push(['wood', at(box(1.1, 0.028, 0.13, 0.006), 0, 0.13, (i / 4 - 0.5) * 0.86)])
    }
    for (const z of [-0.4, 0, 0.4]) out.push(['wood', at(box(1.1, 0.09, 0.1, 0.006), 0, 0.06, z)])
    return out
  },
  paper(d, rng) {
    const out = []
    for (let i = 0; i < 3 + Math.floor(rng.next() * 4); i++) {
      const g = new THREE.PlaneGeometry(0.2 + rng.next() * 0.14, 0.26 + rng.next() * 0.14, 2, 2)
      g.rotateX(-Math.PI / 2)
      rough(g, 0.05, d.seed + i, 9)
      out.push(['fabric', at(g, (rng.next() - 0.5) * 1.1, 0.012, (rng.next() - 0.5) * 1.1, rng.next() * 3)])
    }
    return out
  },
  weeds(d, rng) {
    const out = []
    const clumps = 2 + Math.floor(rng.next() * 2)
    for (let c = 0; c < clumps; c++) {
      const ox = (rng.next() - 0.5) * 0.5
      const oz = (rng.next() - 0.5) * 0.5
      const blades = 8 + Math.floor(rng.next() * 7)
      for (let i = 0; i < blades; i++) {
        const h = 0.13 + rng.next() * 0.3
        const g = new THREE.CylinderGeometry(0.003, 0.016, h, 3, 1)
        const a = rng.next() * Math.PI * 2
        const r = rng.next() * 0.13
        const bend = (rng.next() - 0.5) * 1.15
        out.push([
          'foliage',
          at(g, ox + Math.cos(a) * r, h * 0.45, oz + Math.sin(a) * r, rng.next() * 3, bend, bend * 0.7),
        ])
      }
    }
    return out
  },
}

const FOLIAGE_TINT = [0x39421f, 0x454a26, 0x50492a, 0x2e3a1c, 0x5a5430]

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function buildProps(level, kit, quality = 'high') {
  const spec = level.spec
  const group = new THREE.Group()
  group.name = 'world:props'
  const batch = new BatchSet(kit)

  // glass + foliage need their own materials; the batch set takes them as overrides
  let glassMat = null
  try {
    const shared = kit.ctx?.materials?.get?.('glass')
    if (shared?.isMaterial) {
      glassMat = shared.clone()
      glassMat.vertexColors = true
    }
  } catch {
    glassMat = null
  }
  if (!glassMat) {
    glassMat = new THREE.MeshStandardMaterial({
      color: 0x8fa6b0,
      roughness: 0.14,
      metalness: 0.2,
      transparent: true,
      opacity: 0.36,
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  }

  const extraMats = new Map()
  extraMats.set('glass', glassMat)
  // Deep shadow: window voids, burnt interiors, recessed panel fields. Nothing
  // in the world is ever pure black — this still takes ambient.
  extraMats.set(
    'dark',
    new THREE.MeshStandardMaterial({
      color: 0x17191c,
      roughness: 0.88,
      metalness: 0.08,
      vertexColors: true,
    })
  )
  extraMats.set(
    'foliage',
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
    })
  )

  const propRefs = new Map() // edgeKey -> ref id
  let refId = 0

  const tintFor = (type, rng) => {
    switch (type) {
      case 'container':
        return pickTint(rng, PALETTE.container)
      case 'carWreck':
        return pickTint(rng, PALETTE.car)
      case 'bus':
        return pickTint(rng, PALETTE.bus)
      case 'crate':
        return pickTint(rng, PALETTE.crate)
      case 'dumpster':
        return pickTint(rng, PALETTE.dumpster)
      case 'acUnit':
        return pickTint(rng, PALETTE.ac)
      case 'lowWall':
      case 'ruinWall':
        return pickTint(rng, PALETTE.brickish)
      case 'railing':
      case 'fence':
        return pickTint(rng, PALETTE.steel)
      case 'weeds':
        return pickTint(rng, FOLIAGE_TINT)
      case 'debris':
      case 'brickPile':
      case 'rubblePile':
        return pickTint(rng, PALETTE.rubble)
      case 'trash':
        return pickTint(rng, PALETTE.litter)
      case 'hydrant':
        return 0xb03a2c
      case 'cone':
        return 0xc4551f
      case 'tyre':
        return 0x2a2827
      case 'paper':
        return 0x8c8880
      default:
        return pickTint(rng, PALETTE.concreteish)
    }
  }

  const UVSCALE = {
    concrete: 1.5,
    brick: 1.1,
    rust: 0.8,
    paint: 1.7,
    wood: 0.9,
    fabric: 0.55,
    plastic: 0.7,
    glass: 1,
    foliage: 1,
    dark: 1,
  }

  function emitProp(item, builders, isDressing) {
    const b = builders[item.type]
    if (!b) return
    const rng = makeRng((item.seed || 1) * 2654435761 + 17)
    let parts
    try {
      parts = b(item, rng)
    } catch (err) {
      console.warn('[world] prop build failed:', item.type, err)
      return
    }
    if (!parts || !parts.length) return

    const tint = item.tint ?? tintFor(item.type, rng)
    const sc = (item.scale ?? 1) * (isDressing ? 1 : 0.985 + rng.next() * 0.035)
    const sy = sc * (isDressing ? 1 : 0.97 + rng.next() * 0.07)
    const ry = (item.ry ?? 0) + (isDressing ? 0 : (rng.next() - 0.5) * 0.035)

    const ref = item.destructible ? 'p' + refId++ : null
    if (ref) {
      batch.begin(ref)
      for (const k of item.edgeKeys || []) propRefs.set(k, ref)
    }

    for (const [matKey, geo] of parts) {
      place(geo, item.x, item.y || 0, item.z, ry, sc, sy, sc)
      worldUV(geo, UVSCALE[matKey] ?? 1)
      if (matKey === 'foliage') {
        paintGrime(geo, {
          tint,
          groundY: item.y || 0,
          grimeHeight: 0.5,
          grimeStrength: 0.45,
          wear: 0,
          mottle: 0.4,
          cavity: 0,
          topFade: 0.3,
          seed: item.seed,
        })
      } else if (matKey === 'dark') {
        paintGrime(geo, {
          tint: 0xffffff,
          groundY: item.y || 0,
          grimeHeight: 0.4,
          grimeStrength: 0.2,
          wear: 0,
          mottle: 0.28,
          cavity: 0,
          topFade: 0,
          seed: item.seed,
        })
      } else if (matKey === 'glass') {
        paintGrime(geo, {
          tint: 0xdfe9ec,
          groundY: item.y || 0,
          grimeHeight: 2.2,
          grimeStrength: 0.35,
          wear: 0,
          mottle: 0.25,
          cavity: 0,
          seed: item.seed,
        })
      } else {
        const isMetal = matKey === 'rust' || matKey === 'paint'
        paintGrime(geo, {
          tint: matKey === 'rust' || matKey === 'concrete' || matKey === 'brick' ? mixToward(tint, 0xffffff, matKey === 'rust' ? 0.55 : 0.25) : tint,
          groundY: item.y || 0,
          grimeHeight: isDressing ? 0.3 : 0.75,
          grimeStrength: isDressing ? 0.3 : 0.46,
          wear: isMetal ? 0.3 : 0.2,
          wearRadius: isMetal ? 0.055 : 0.07,
          mottle: 0.2,
          cavity: 0.3,
          topFade: 0.08,
          seed: item.seed,
        })
      }
      batch.emit(matKey, geo)
    }
    if (ref) batch.end()
  }

  for (const p of spec.props) emitProp(p, BUILD, false)
  for (const d of spec.dressing) emitProp(d, DRESS, true)

  batch.build(group, extraMats)

  return {
    group,
    batch,
    propRefs,
    materials: extraMats,
    /** Called by level.destroyCover — collapses the prop and drops rubble. */
    destroyByEdge(edgeKey) {
      const ref = propRefs.get(edgeKey)
      if (!ref) return false
      const ok = batch.collapse(ref)
      propRefs.delete(edgeKey)
      return ok
    },
    dispose() {
      for (const m of extraMats.values()) m.dispose()
    },
  }
}

function mixToward(hex, target, t) {
  const a = new THREE.Color(hex)
  const b = new THREE.Color(target)
  return a.lerp(b, t).getHex()
}
