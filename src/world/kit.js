/**
 * world/kit.js — shared toolbox for the world module.
 *
 * Everything here is deterministic given a seed: procedural PBR texture
 * generation, tileable noise, bevelled/worn geometry helpers and the local
 * material fallback library used when `ctx.materials` (owned by render/) is not
 * available or does not carry the name we asked for.
 *
 * Owned by: world.  Imported only by src/world/*.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

export function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Small convenience wrapper so call sites read like intent, not arithmetic. */
export function makeRng(seed = 1337) {
  const r = mulberry32(seed)
  return {
    raw: r,
    next: () => r(),
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => Math.floor(a + (b - a + 1) * r()),
    chance: (p) => r() < p,
    pick: (arr) => arr[Math.floor(r() * arr.length) % arr.length],
    sign: () => (r() < 0.5 ? -1 : 1),
    /** Gaussian-ish, clamped to [-1,1] — nicer than uniform for jitter. */
    jitter: () => (r() + r() + r()) / 1.5 - 1,
  }
}

// ---------------------------------------------------------------------------
// Tileable value noise
// ---------------------------------------------------------------------------

function hash2i(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const smooth = (t) => t * t * (3 - 2 * t)

/** Value noise that wraps exactly on `period` — required for seamless tiles. */
export function vnoise(x, y, period, seed) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const p = period | 0
  const wrap = (v) => ((v % p) + p) % p
  const x0 = wrap(xi)
  const y0 = wrap(yi)
  const x1 = wrap(xi + 1)
  const y1 = wrap(yi + 1)
  const u = smooth(xf)
  const v = smooth(yf)
  const a = hash2i(x0, y0, seed)
  const b = hash2i(x1, y0, seed)
  const c = hash2i(x0, y1, seed)
  const d = hash2i(x1, y1, seed)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** Non-tiling value noise, for world-space macro variation. */
export function wnoise(x, y, seed = 0) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = smooth(x - xi)
  const v = smooth(y - yi)
  const a = hash2i(xi, yi, seed)
  const b = hash2i(xi + 1, yi, seed)
  const c = hash2i(xi, yi + 1, seed)
  const d = hash2i(xi + 1, yi + 1, seed)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

export function wfbm(x, y, oct = 4, seed = 0, lac = 2, gain = 0.5) {
  let f = 1
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < oct; i++) {
    sum += amp * wnoise(x * f, y * f, seed + i * 977)
    norm += amp
    f *= lac
    amp *= gain
  }
  return sum / norm
}

/** Tileable fbm over a unit square sampled at `base` cells. */
export function tfbm(u, v, base, oct = 4, seed = 0, gain = 0.5) {
  let f = base
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u * f, v * f, f, seed + i * 7919)
    norm += amp
    f *= 2
    amp *= gain
  }
  return sum / norm
}

/** Ridged variant — good for cracks and rust veins. */
export function tridge(u, v, base, oct = 3, seed = 0) {
  let f = base
  let amp = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < oct; i++) {
    const n = vnoise(u * f, v * f, f, seed + i * 4093)
    sum += amp * (1 - Math.abs(n * 2 - 1))
    norm += amp
    f *= 2
    amp *= 0.55
  }
  return sum / norm
}

/** Tileable jittered-grid F1 cellular noise — stones, gravel, aggregate. */
export function tcell(u, v, cells, seed = 0) {
  const x = u * cells
  const y = v * cells
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  let best = 4
  let id = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx
      const cy = yi + dy
      const wx = ((cx % cells) + cells) % cells
      const wy = ((cy % cells) + cells) % cells
      const jx = hash2i(wx, wy, seed)
      const jy = hash2i(wx, wy, seed + 101)
      const px = cx + jx
      const py = cy + jy
      const d = (px - x) * (px - x) + (py - y) * (py - y)
      if (d < best) {
        best = d
        id = hash2i(wx, wy, seed + 202)
      }
    }
  }
  return { d: Math.sqrt(best), id }
}

// ---------------------------------------------------------------------------
// Procedural texture generation
// ---------------------------------------------------------------------------

function newCanvas(size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

/**
 * Runs `shade(u, v)` for every texel and returns { albedo, rough, height }
 * ImageData. `shade` returns [r, g, b, roughness, height] all in 0..1.
 */
function bake(size, shade) {
  const alb = new Uint8ClampedArray(size * size * 4)
  const rgh = new Uint8ClampedArray(size * size * 4)
  const hgt = new Float32Array(size * size)
  const inv = 1 / size
  let i = 0
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv
      const o = shade(u, v)
      alb[i] = o[0] * 255
      alb[i + 1] = o[1] * 255
      alb[i + 2] = o[2] * 255
      alb[i + 3] = 255
      const r = o[3] * 255
      rgh[i] = r
      rgh[i + 1] = r
      rgh[i + 2] = r
      rgh[i + 3] = 255
      hgt[(i / 4) | 0] = o[4]
      i += 4
    }
  }
  return { alb, rgh, hgt, size }
}

/** Sobel a height field into a tangent-space normal map. */
function heightToNormal(hgt, size, strength) {
  const out = new Uint8ClampedArray(size * size * 4)
  const at = (x, y) => hgt[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = at(x - 1, y)
      const r = at(x + 1, y)
      const d = at(x, y - 1)
      const u = at(x, y + 1)
      let nx = (l - r) * strength
      let ny = (d - u) * strength
      const nz = 1
      const len = Math.hypot(nx, ny, nz)
      const i = (y * size + x) * 4
      out[i] = ((nx / len) * 0.5 + 0.5) * 255
      out[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
      out[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
      out[i + 3] = 255
    }
  }
  return out
}

function texFromBytes(bytes, size, srgb) {
  const c = newCanvas(size)
  const ctx2d = c.getContext('2d')
  const img = ctx2d.createImageData(size, size)
  img.data.set(bytes)
  ctx2d.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

/**
 * Bakes one surface into { map, normalMap, roughnessMap }.
 * All three share the same UV space and tile seamlessly.
 */
export function makeSurface(size, shade, normalStrength = 6) {
  const b = bake(size, shade)
  return {
    map: texFromBytes(b.alb, size, true),
    roughnessMap: texFromBytes(b.rgh, size, false),
    normalMap: texFromBytes(heightToNormal(b.hgt, size, normalStrength), size, false),
  }
}

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// --- surface shaders --------------------------------------------------------

const SURFACES = {
  asphalt: (S) => (u, v) => {
    const agg = tcell(u, v, 46, 11)
    const grit = tfbm(u, v, 24, 4, 3)
    const macro = tfbm(u, v, 3, 3, 17)
    const crack = tridge(u, v, 5, 4, 91)
    const crackMask = sstep(0.82, 0.96, crack) * sstep(0.25, 0.6, macro)
    const stoneLit = sstep(0.16, 0.02, agg.d) * (0.35 + agg.id * 0.65)
    let base = 0.082 + macro * 0.055 + grit * 0.05
    base += stoneLit * 0.125
    base = lerp(base, base * 0.32, crackMask)
    // sun-bleached patches + polished wheel tracks
    base += sstep(0.6, 0.86, tfbm(u, v, 6, 3, 55)) * 0.075
    const r = base * 1.02
    const g = base * 1.0
    const bl = base * 1.03
    const rough = clamp01(0.86 + grit * 0.1 - stoneLit * 0.18 - crackMask * 0.05)
    const h = grit * 0.35 + stoneLit * 0.5 - crackMask * 1.0 + macro * 0.2
    return [r, g, bl, rough, h]
  },

  concrete: (S) => (u, v) => {
    const mottle = tfbm(u, v, 5, 5, 23)
    const fine = tfbm(u, v, 40, 3, 31)
    const pit = tcell(u, v, 30, 71)
    const pits = sstep(0.1, 0.0, pit.d)
    const crack = tridge(u, v, 4, 4, 13)
    const crackMask = sstep(0.87, 0.98, crack)
    const stain = sstep(0.55, 0.95, tfbm(u, v, 2.5, 4, 87))
    let l = 0.36 + mottle * 0.14 + fine * 0.05
    l -= pits * 0.16
    l = lerp(l, l * 0.55, crackMask)
    l = lerp(l, l * 0.72, stain * 0.8)
    const r = l * 1.02
    const g = l * 1.0
    const b = l * 0.96
    const rough = clamp01(0.78 + fine * 0.12 + pits * 0.1 - stain * 0.06)
    const h = mottle * 0.3 + fine * 0.2 - pits * 0.9 - crackMask * 0.8
    return [r, g, b, rough, h]
  },

  brick: (S) => (u, v) => {
    const rows = 16
    const cols = 8
    const ry = v * rows
    const row = Math.floor(ry)
    const off = row % 2 === 0 ? 0 : 0.5
    const rx = u * cols + off
    const col = Math.floor(rx)
    const fx = rx - col
    const fy = ry - row
    const mortarW = 0.055
    const mortar =
      1 -
      sstep(0, mortarW, fx) * sstep(1, 1 - mortarW, fx) * sstep(0, mortarW * cols / rows * 2, fy) *
        sstep(1, 1 - mortarW * cols / rows * 2, fy)
    const id = hash2i(col, row, 5)
    const id2 = hash2i(col, row, 6)
    const grain = tfbm(u, v, 60, 3, 9)
    const chip = sstep(0.62, 0.9, tfbm(u * 3 + col, v * 3 + row, 8, 3, id * 1000))
    // brick body: weathered red-brown, some darker/burnt, some sandy
    let r = lerp(0.30, 0.44, id) + grain * 0.06
    let g = lerp(0.14, 0.22, id2) + grain * 0.05
    let b = lerp(0.10, 0.16, id) + grain * 0.045
    if (id > 0.86) {
      r *= 0.62
      g *= 0.7
      b *= 0.8
    }
    const soot = sstep(0.5, 0.95, tfbm(u, v, 2, 4, 44))
    r = lerp(r, r * 0.4, soot * 0.7)
    g = lerp(g, g * 0.42, soot * 0.7)
    b = lerp(b, b * 0.45, soot * 0.7)
    // mortar
    const m = 0.36 + tfbm(u, v, 30, 3, 77) * 0.1
    r = lerp(r, m, mortar)
    g = lerp(g, m * 0.98, mortar)
    b = lerp(b, m * 0.93, mortar)
    // chipped corners show pale core
    r = lerp(r, r * 1.5, chip * (1 - mortar) * 0.35)
    g = lerp(g, g * 1.5, chip * (1 - mortar) * 0.35)
    b = lerp(b, b * 1.5, chip * (1 - mortar) * 0.35)
    const rough = clamp01(0.82 + mortar * 0.1 + grain * 0.06)
    const h = (1 - mortar) * 0.7 + grain * 0.15 - chip * 0.2
    return [r, g, b, rough, h]
  },

  rust: (S) => (u, v) => {
    const base = tfbm(u, v, 6, 5, 3)
    const veins = tridge(u, v, 10, 4, 19)
    const flake = tcell(u, v, 34, 61)
    const rustMask = clamp01(sstep(0.36, 0.72, base) + veins * 0.35 - 0.1)
    const scale = sstep(0.14, 0.02, flake.d) * flake.id
    // steel underneath
    let r = 0.20 + base * 0.05
    let g = 0.205 + base * 0.05
    let b = 0.215 + base * 0.05
    // rust colours: dark brown -> orange -> ochre
    const rr = lerp(0.24, 0.55, flake.id)
    const rg = lerp(0.10, 0.26, flake.id)
    const rb = lerp(0.05, 0.10, flake.id)
    r = lerp(r, rr, rustMask)
    g = lerp(g, rg, rustMask)
    b = lerp(b, rb, rustMask)
    r += scale * rustMask * 0.12
    g += scale * rustMask * 0.05
    const rough = clamp01(lerp(0.45, 0.95, rustMask) + scale * 0.05)
    const metal = 1 - rustMask * 0.9
    const h = rustMask * 0.6 + scale * 0.4 + veins * 0.2
    return [r, g, b, rough, h, metal]
  },

  paint: (S) => (u, v) => {
    // Neutral painted steel panel — tint comes from vertex/instance colour.
    const panelV = Math.floor(v * 4)
    const seam = 1 - sstep(0.0, 0.012, Math.abs(v * 4 - Math.round(v * 4)))
    const grime = tfbm(u, v, 4, 5, 29)
    const scratch = tridge(u, v, 26, 3, 71)
    const scratchMask = sstep(0.9, 0.99, scratch)
    const rustBleed = sstep(0.68, 0.95, tfbm(u, v, 3, 4, 5))
    let l = 0.80 + grime * 0.14 + hash2i(panelV, 0, 3) * 0.05
    let r = l
    let g = l
    let b = l
    // scratches to bare metal
    r = lerp(r, 0.30, scratchMask)
    g = lerp(g, 0.31, scratchMask)
    b = lerp(b, 0.33, scratchMask)
    // rust bleed (tints toward orange, survives the instance tint)
    r = lerp(r, 0.34, rustBleed * 0.85)
    g = lerp(g, 0.17, rustBleed * 0.85)
    b = lerp(b, 0.09, rustBleed * 0.85)
    const dark = seam * 0.55
    r *= 1 - dark
    g *= 1 - dark
    b *= 1 - dark
    const rough = clamp01(0.42 + grime * 0.2 + rustBleed * 0.35 + scratchMask * 0.2)
    const h = -seam * 0.9 + grime * 0.15 - scratchMask * 0.2 + rustBleed * 0.15
    return [r, g, b, rough, h]
  },

  wood: (S) => (u, v) => {
    const grain = tfbm(u * 0.12, v * 3.0, 16, 4, 41)
    const rings = Math.abs(Math.sin((v * 9 + grain * 2.4) * Math.PI))
    const plank = Math.floor(u * 5)
    const pj = hash2i(plank, 0, 13)
    const gap = 1 - sstep(0, 0.02, Math.abs(u * 5 - Math.round(u * 5)))
    const weather = tfbm(u, v, 4, 4, 67)
    let l = lerp(0.16, 0.30, rings * 0.55 + grain * 0.45) * lerp(0.82, 1.15, pj)
    let r = l * 1.12
    let g = l * 0.95
    let b = l * 0.76
    // silvered weathering
    const w = clamp01(weather * 1.2 - 0.15)
    r = lerp(r, l * 1.02, w * 0.6)
    g = lerp(g, l * 1.0, w * 0.6)
    b = lerp(b, l * 0.97, w * 0.6)
    r *= 1 - gap * 0.8
    g *= 1 - gap * 0.8
    b *= 1 - gap * 0.8
    const rough = clamp01(0.72 + grain * 0.18 + w * 0.1)
    const h = grain * 0.5 + rings * 0.25 - gap * 1.2
    return [r, g, b, rough, h]
  },

  dirt: (S) => (u, v) => {
    const macro = tfbm(u, v, 4, 5, 83)
    const fine = tfbm(u, v, 36, 3, 97)
    const peb = tcell(u, v, 26, 37)
    const pm = sstep(0.13, 0.03, peb.d)
    let l = 0.13 + macro * 0.09 + fine * 0.04
    let r = l * 1.30
    let g = l * 1.05
    let b = l * 0.78
    const stone = 0.20 + peb.id * 0.2
    r = lerp(r, stone, pm * 0.8)
    g = lerp(g, stone * 0.97, pm * 0.8)
    b = lerp(b, stone * 0.92, pm * 0.8)
    const rough = clamp01(0.94 - pm * 0.12 + fine * 0.05)
    const h = macro * 0.4 + fine * 0.25 + pm * 0.7
    return [r, g, b, rough, h]
  },

  gravel: (S) => (u, v) => {
    const c1 = tcell(u, v, 30, 7)
    const c2 = tcell(u * 1.7 + 0.31, v * 1.7 + 0.11, 30, 29)
    const fine = tfbm(u, v, 44, 3, 53)
    const edge = sstep(0.02, 0.16, c1.d)
    let l = lerp(0.16, 0.42, c1.id) * lerp(0.85, 1.1, c2.id)
    l = lerp(l * 1.15, l * 0.55, edge)
    l += fine * 0.04
    const warm = lerp(0.94, 1.08, c1.id)
    const r = l * warm
    const g = l * 1.0
    const b = l * lerp(1.02, 0.9, c1.id)
    const rough = clamp01(0.8 + edge * 0.15 + fine * 0.05)
    const h = (1 - edge) * 0.9 + fine * 0.2
    return [r, g, b, rough, h]
  },

  fabric: (S) => (u, v) => {
    const weave =
      Math.abs(Math.sin(u * Math.PI * 90)) * 0.5 + Math.abs(Math.sin(v * Math.PI * 90)) * 0.5
    const soil = tfbm(u, v, 5, 4, 111)
    const fuzz = tfbm(u, v, 60, 2, 121)
    let l = 0.22 + weave * 0.06 + fuzz * 0.05
    let r = l * 1.18
    let g = l * 1.06
    let b = l * 0.82
    const d = soil * 0.5
    r *= 1 - d
    g *= 1 - d
    b *= 1 - d
    const rough = clamp01(0.94 + fuzz * 0.05)
    const h = weave * 0.5 + fuzz * 0.3
    return [r, g, b, rough, h]
  },

  plastic: (S) => (u, v) => {
    const grain = tfbm(u, v, 50, 3, 131)
    const rib = 1 - sstep(0, 0.02, Math.abs(((u * 12) % 1) - 0.5) - 0.46)
    const scuff = sstep(0.72, 0.96, tfbm(u, v, 8, 4, 141))
    let l = 0.62 + grain * 0.1
    let r = l
    let g = l
    let b = l
    r = lerp(r, 0.86, scuff * 0.5)
    g = lerp(g, 0.86, scuff * 0.5)
    b = lerp(b, 0.86, scuff * 0.5)
    const rough = clamp01(0.5 + grain * 0.2 + scuff * 0.3)
    const h = grain * 0.3 + rib * 0.5 - scuff * 0.1
    return [r, g, b, rough, h]
  },
}

// ---------------------------------------------------------------------------
// Material library (local fallback for ctx.materials)
// ---------------------------------------------------------------------------

/**
 * Maps our semantic names onto the names render/ publishes, then falls back to
 * a locally-baked material. Every returned material is cloned per *usage class*
 * (not per object) so we can flip vertexColors on without mutating render's
 * shared instances.
 */
/** our semantic names -> the names render/ publishes */
const RENDER_NAME = {
  paint: 'paintedMetal',
  rust: 'rustedMetal',
  wood: 'weatheredWood',
  plastic: 'plasticCrate',
  concrete: 'concrete',
  brick: 'brick',
  asphalt: 'asphalt',
  dirt: 'dirt',
  gravel: 'gravel',
  fabric: 'fabric',
  glass: 'glass',
}

export class MaterialKit {
  constructor(ctx, quality = 'high') {
    this.ctx = ctx
    this.quality = quality
    this.size = quality === 'low' ? 128 : quality === 'medium' ? 256 : 512
    this.surfaces = new Map()
    this.locals = new Map()
    this.cache = new Map()
    this.disposables = []
  }

  /** Bake one named surface. Yields between surfaces so boot never janks. */
  async bakeAll(names) {
    for (const n of names) {
      if (this.surfaces.has(n)) continue
      const f = SURFACES[n]
      if (!f) continue
      const s = makeSurface(this.size, f(this.size), n === 'paint' || n === 'plastic' ? 3 : 6)
      this.surfaces.set(n, s)
      for (const k of ['map', 'normalMap', 'roughnessMap']) this.disposables.push(s[k])
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  surface(name) {
    return this.surfaces.get(name) || null
  }

  /** Build (and cache) a local standard material from a baked surface. */
  local(name, opts = {}) {
    const key = name + '|' + JSON.stringify(opts)
    if (this.locals.has(key)) return this.locals.get(key)
    const s = this.surfaces.get(name)
    const m = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xffffff,
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0,
      map: s?.map || null,
      normalMap: s?.normalMap || null,
      roughnessMap: s?.roughnessMap || null,
      vertexColors: opts.vertexColors !== false,
      side: opts.side ?? THREE.FrontSide,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      alphaTest: opts.alphaTest ?? 0,
      envMapIntensity: opts.envMapIntensity ?? 1,
    })
    if (s?.normalMap && opts.normalScale) {
      m.normalScale = new THREE.Vector2(opts.normalScale, opts.normalScale)
    }
    m.name = 'world:' + name
    this.locals.set(key, m)
    this.disposables.push(m)
    return m
  }

  /**
   * Resolve a material: prefer render/'s shared library, degrade to ours.
   *
   * Our geometry carries world-scale UVs (1 UV unit = 1 metre), so `uvRepeat`
   * is "texture tiles per metre". render/ authors its sets against a declared
   * `tileMeters`, so on that path we derive the repeat from their texel density
   * instead of ours — otherwise their 3 m concrete scan gets crushed into 1 m
   * and reads as sandpaper.
   */
  get(name, opts = {}) {
    const key = name + '|' + JSON.stringify(opts)
    if (this.cache.has(key)) return this.cache.get(key)

    let m = null
    const shared = this.ctx?.materials
    const remote = RENDER_NAME[name] || name
    try {
      if (shared?.get && (shared.has ? shared.has(remote) : true)) {
        const tm = shared.tileMeters?.(remote) ?? 2
        const rep = (opts.density ?? 1) * (1.35 / tm)
        const got = shared.get(remote, {
          repeat: rep,
          key: 'world',
          ...(opts.side !== undefined ? { side: opts.side } : {}),
        })
        if (got && got.isMaterial) {
          m = got.clone()
          m.vertexColors = opts.vertexColors !== false
          if (opts.transparent) {
            m.transparent = true
            m.opacity = opts.opacity ?? 1
          }
          if (opts.side !== undefined) m.side = opts.side
          m.name = 'world:shared:' + remote
          this.disposables.push(m)
          this.cache.set(key, m)
          return m
        }
      }
    } catch {
      m = null
    }

    if (!m) m = this.local(name, opts)

    // World-scale UV repeat: our geometry UVs are already in metres.
    const rep = opts.uvRepeat ?? 1
    if (rep !== 1) {
      m = m.clone()
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        if (m[k]) {
          m[k] = m[k].clone()
          m[k].needsUpdate = true
          m[k].repeat.set(rep, rep)
          m[k].wrapS = m[k].wrapT = THREE.RepeatWrapping
          this.disposables.push(m[k])
        }
      }
      this.disposables.push(m)
    }

    this.cache.set(key, m)
    return m
  }

  dispose() {
    for (const d of this.disposables) d?.dispose?.()
    this.disposables.length = 0
    this.surfaces.clear()
    this.locals.clear()
    this.cache.clear()
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Bevelled box — never ship a razor-sharp CG corner.
 * Anything small enough that the bevel would be sub-pixel at gameplay zoom
 * falls back to a plain box; the bevel budget is spent on silhouettes.
 */
const SMALL = 0.19
// A bevel only earns its triangles if it is wide enough to catch a highlight at
// gameplay zoom. Callers were passing 0.025-0.045, which on a 2.5 m container is
// a ~3 cm chamfer — geometrically present, sub-pixel on screen, and an art
// director reviewing the result reported "no prop has a chamfer" and called it
// the single clearest tell that this was greybox work. So the requested radius
// is treated as a floor and scaled against the object's own size instead of
// being taken literally: big surfaces get a proportionally bigger chamfer.
const BEVEL_FRAC = 0.055 // of the smallest dimension
const BEVEL_MAX = 0.11 // metres — beyond this it reads as a rounded pillow
export function bevelBox(w, h, d, r = 0.03, seg = 1) {
  const min = Math.min(w, h, d)
  if (min < SMALL || r <= 0.012) return new THREE.BoxGeometry(w, h, d)
  const rr = Math.min(Math.max(r, min * BEVEL_FRAC), BEVEL_MAX, min * 0.32)
  // Two segments across a wide chamfer gives a graded highlight rather than a
  // single hard facet; only worth it once the bevel is actually visible.
  const s = rr > 0.05 ? Math.max(seg, 2) : seg
  return new RoundedBoxGeometry(w, h, d, s, rr)
}
/** Explicitly cheap box — used for detail that never reads at iso distance. */
export function plainBox(w, h, d) {
  return new THREE.BoxGeometry(w, h, d)
}

/**
 * Replaces UVs with world-scale planar projection per dominant face normal.
 * `scale` = texture metres per UV unit (1 => one texture tile per metre).
 */
export function worldUV(geo, scale = 1, offset = [0, 0]) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const n = pos.count
  const uv = new Float32Array(n * 2)
  const s = 1 / scale
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i)
    const py = pos.getY(i)
    const pz = pos.getZ(i)
    const nx = Math.abs(nor.getX(i))
    const ny = Math.abs(nor.getY(i))
    const nz = Math.abs(nor.getZ(i))
    let u, v
    if (ny >= nx && ny >= nz) {
      u = px
      v = pz
    } else if (nx >= nz) {
      u = pz
      v = py
    } else {
      u = px
      v = py
    }
    uv[i * 2] = u * s + offset[0]
    uv[i * 2 + 1] = v * s + offset[1]
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return geo
}

const _c = new THREE.Color()

/**
 * Bakes grime / edge-wear / cavity darkening into vertex colours.
 *
 * opts:
 *   tint          base colour multiplier (hex or THREE.Color)
 *   groundY       world Y where dirt accumulation starts (default bbox min)
 *   grimeHeight   metres over which the bottom grime fades out
 *   grimeStrength 0..1 how dark the bottom gets
 *   wear          0..1 how much edges get lightened (paint rubbed off)
 *   wearRadius    metres from a bbox edge that counts as "an edge"
 *   mottle        0..1 large-scale colour noise
 *   seed
 *   topFade       lighten upward-facing surfaces (sun bleaching)
 */
export function paintGrime(geo, opts = {}) {
  const {
    tint = 0xffffff,
    grimeHeight = 0.55,
    grimeStrength = 0.42,
    wear = 0.22,
    wearRadius = 0.06,
    mottle = 0.16,
    seed = 1,
    topFade = 0.06,
    cavity = 0.25,
  } = opts

  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const groundY = opts.groundY ?? bb.min.y
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const n = pos.count
  const col = new Float32Array(n * 3)
  _c.set(tint)
  const tr = _c.r
  const tg = _c.g
  const tb = _c.b
  const sx = bb.max.x - bb.min.x
  const sy = bb.max.y - bb.min.y
  const sz = bb.max.z - bb.min.z

  for (let i = 0; i < n; i++) {
    const px = pos.getX(i)
    const py = pos.getY(i)
    const pz = pos.getZ(i)
    const ny = nor.getY(i)

    // --- bottom grime -----------------------------------------------------
    const hAbove = py - groundY
    const grime = grimeStrength * (1 - clamp01(hAbove / grimeHeight)) ** 1.6

    // --- edge wear: count how many bbox faces this vertex is close to -----
    let near = 0
    if (sx > 1e-4) {
      if (px - bb.min.x < wearRadius || bb.max.x - px < wearRadius) near++
    }
    if (sy > 1e-4) {
      if (py - bb.min.y < wearRadius || bb.max.y - py < wearRadius) near++
    }
    if (sz > 1e-4) {
      if (pz - bb.min.z < wearRadius || bb.max.z - pz < wearRadius) near++
    }
    const edge = near >= 2 ? (near >= 3 ? 1 : 0.65) : 0

    // --- mottle -----------------------------------------------------------
    const m = wfbm(px * 0.9 + 13.7, pz * 0.9 + py * 0.6 + 5.1, 3, seed) - 0.5

    // --- cavity: downward faces darken ------------------------------------
    const cav = ny < -0.2 ? cavity : ny > 0.6 ? -topFade : 0

    let k = 1 - grime - cav + m * mottle + edge * wear
    k = clamp01(k)
    // worn edges also desaturate slightly toward bare material
    const de = edge * wear * 0.5
    col[i * 3] = clamp01(tr * k + de)
    col[i * 3 + 1] = clamp01(tg * k + de)
    col[i * 3 + 2] = clamp01(tb * k + de)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return geo
}

/** Uniform vertex colour (for merging into a vertex-coloured batch). */
export function flatColor(geo, hex) {
  const n = geo.attributes.position.count
  const col = new Float32Array(n * 3)
  _c.set(hex)
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r
    col[i * 3 + 1] = _c.g
    col[i * 3 + 2] = _c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return geo
}

/** Randomly nudge vertices — kills the "perfect CG primitive" read. */
export function rough(geo, amount = 0.012, seed = 5, freq = 2.5) {
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const dx = (wfbm(x * freq + 3, z * freq + y * freq + 1, 2, seed) - 0.5) * amount
    const dy = (wfbm(y * freq + 11, x * freq + z * freq + 7, 2, seed + 3) - 0.5) * amount
    const dz = (wfbm(z * freq + 19, y * freq + x * freq + 5, 2, seed + 7) - 0.5) * amount
    pos.setXYZ(i, x + dx, y + dy, z + dz)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/** Merge with a friendly error instead of a silent null. */
export function mergeGeos(list, name = 'merge', extraAttrs = []) {
  let clean = list.filter(Boolean)
  if (clean.length === 0) return null
  // Uniform, non-indexed attribute sets — mergeGeometries is unforgiving.
  clean = clean.map((g) => {
    if (!g.index) return g
    const n = g.toNonIndexed()
    g.dispose()
    return n
  })
  if (clean.length === 1) return clean[0]
  const sizes = { position: 3, normal: 3, uv: 2, color: 3 }
  for (const [nm, sz] of extraAttrs) sizes[nm] = sz
  const want = Object.keys(sizes)
  for (const g of clean) {
    for (const a of want) {
      if (!g.attributes[a]) {
        const n = g.attributes.position.count
        const itemSize = sizes[a]
        const arr = new Float32Array(n * itemSize)
        if (a === 'color') arr.fill(1)
        if (a === 'normal') for (let i = 0; i < n; i++) arr[i * 3 + 1] = 1
        g.setAttribute(a, new THREE.BufferAttribute(arr, itemSize))
      }
    }
    for (const k of Object.keys(g.attributes)) {
      if (!want.includes(k)) g.deleteAttribute(k)
    }
  }
  const merged = BufferGeometryUtils.mergeGeometries(clean, false)
  if (!merged) {
    console.warn(`[world] merge failed for "${name}" — falling back to first geometry`)
    return clean[0]
  }
  for (const g of clean) g.dispose()
  return merged
}

/** Apply a Matrix4 to a geometry and return it (chainable). */
export function xform(geo, m) {
  geo.applyMatrix4(m)
  return geo
}

const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)

export function place(geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz)
  _q.setFromEuler(_e)
  _v.set(x, y, z)
  _s.set(sx, sy, sz)
  _m4.compose(_v, _q, _s)
  geo.applyMatrix4(_m4)
  return geo
}

export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    const m = o.material
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.())
    else m?.dispose?.()
  })
}

export { clamp01, lerp, sstep, hash2i }
