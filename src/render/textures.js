import * as THREE from 'three'

/**
 * Procedural PBR texture bakery.
 *
 * Everything here is generated on a canvas at load time from tileable value
 * noise / fbm / voronoi fields. One scalar height field per material drives the
 * albedo, the roughness, the sobel-derived normal and a cavity-based AO map, so
 * the four maps agree with each other instead of looking like four unrelated
 * images stacked on one surface — that agreement is most of what separates a
 * believable surface from "a colour with a bump map".
 *
 * These are also the guaranteed fallback: if the Poly Haven scans in
 * public/textures/render/ are missing or fail to decode, materials.js falls back
 * to this and the game still ships a fully textured world with no network.
 *
 * Colour space discipline (the classic washed-out giveaway):
 *   albedo               -> SRGBColorSpace
 *   normal/rough/ao/metal-> NoColorSpace (raw linear bytes)
 */

const TAU = Math.PI * 2

// --- deterministic hash -----------------------------------------------------

function hash2i(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed | 0, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

function smooth(t) {
  return t * t * (3 - 2 * t)
}

/** Tileable value noise with independent X/Y periods (so we can stretch grain). */
function noise2(u, v, fx, fy, seed) {
  const x = u * fx
  const y = v * fy
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const sx = smooth(x - xi)
  const sy = smooth(y - yi)
  const x0 = ((xi % fx) + fx) % fx
  const x1 = (x0 + 1) % fx
  const y0 = ((yi % fy) + fy) % fy
  const y1 = (y0 + 1) % fy
  const a = hash2i(x0, y0, seed)
  const b = hash2i(x1, y0, seed)
  const c = hash2i(x0, y1, seed)
  const d = hash2i(x1, y1, seed)
  const top = a + (b - a) * sx
  const bot = c + (d - c) * sx
  return top + (bot - top) * sy
}

/**
 * fbm as a full Float32 field. Building whole fields and combining them with
 * flat loops is ~3x faster in JS than calling a noise closure per pixel per
 * octave, and it keeps the material specs readable.
 */
function fbmField(size, opts = {}) {
  const {
    fx = 8,
    fy = 8,
    octaves = 5,
    gain = 0.5,
    seed = 1,
    ridged = false,
    normalize = true,
  } = opts
  const out = new Float32Array(size * size)
  let amp = 1
  let sum = 0
  for (let o = 0; o < octaves; o++) {
    const ox = fx << o
    const oy = fy << o
    if (ox > size || oy > size) break // past nyquist, only adds aliasing
    const s = seed + o * 977
    let i = 0
    for (let py = 0; py < size; py++) {
      const v = py / size
      for (let px = 0; px < size; px++, i++) {
        let n = noise2(px / size, v, ox, oy, s)
        if (ridged) n = 1 - Math.abs(n * 2 - 1)
        out[i] += n * amp
      }
    }
    sum += amp
    amp *= gain
  }
  if (sum > 0) {
    const inv = 1 / sum
    for (let i = 0; i < out.length; i++) out[i] *= inv
  }
  if (normalize) normalizeField(out)
  return out
}

function normalizeField(a) {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < a.length; i++) {
    if (a[i] < lo) lo = a[i]
    if (a[i] > hi) hi = a[i]
  }
  const d = hi - lo
  if (d < 1e-6) return a
  const inv = 1 / d
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * inv
  return a
}

/**
 * Tileable voronoi. Returns F1 distance (0..1, cell-relative), the gap between
 * F1 and F2 (crack/edge mask) and a per-cell random id — enough to build gravel,
 * aggregate speckle and cobble without three separate passes.
 */
function voronoiField(size, { cells = 24, seed = 3, jitter = 0.9 } = {}) {
  const f1 = new Float32Array(size * size)
  const edge = new Float32Array(size * size)
  const id = new Float32Array(size * size)
  const cs = 1 / cells
  const px = new Float32Array(cells * cells)
  const py = new Float32Array(cells * cells)
  const pid = new Float32Array(cells * cells)
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const k = cy * cells + cx
      px[k] = (cx + 0.5 + (hash2i(cx, cy, seed) - 0.5) * jitter) * cs
      py[k] = (cy + 0.5 + (hash2i(cx, cy, seed + 41) - 0.5) * jitter) * cs
      pid[k] = hash2i(cx, cy, seed + 97)
    }
  }
  let i = 0
  for (let y = 0; y < size; y++) {
    const v = y / size
    const cyBase = Math.floor(v * cells)
    for (let x = 0; x < size; x++, i++) {
      const u = x / size
      const cxBase = Math.floor(u * cells)
      let d1 = 1e9
      let d2 = 1e9
      let best = 0
      for (let oy = -1; oy <= 1; oy++) {
        const cy = (((cyBase + oy) % cells) + cells) % cells
        const wrapY = Math.floor((cyBase + oy) / cells)
        for (let ox = -1; ox <= 1; ox++) {
          const cx = (((cxBase + ox) % cells) + cells) % cells
          const wrapX = Math.floor((cxBase + ox) / cells)
          const k = cy * cells + cx
          const dx = px[k] + wrapX - u
          const dy = py[k] + wrapY - v
          const d = dx * dx + dy * dy
          if (d < d1) {
            d2 = d1
            d1 = d
            best = pid[k]
          } else if (d < d2) d2 = d
        }
      }
      const r1 = Math.sqrt(d1)
      const r2 = Math.sqrt(d2)
      f1[i] = Math.min(1, r1 / cs)
      edge[i] = Math.min(1, (r2 - r1) / cs)
      id[i] = best
    }
  }
  return { f1, edge, id }
}

/** Wrap-aware separable box blur — used for cavity AO and softening. */
function blurField(src, size, radius) {
  if (radius < 1) return Float32Array.from(src)
  const tmp = new Float32Array(size * size)
  const out = new Float32Array(size * size)
  const w = radius * 2 + 1
  const inv = 1 / w
  for (let y = 0; y < size; y++) {
    const row = y * size
    let acc = 0
    for (let k = -radius; k <= radius; k++) acc += src[row + ((k % size) + size) % size]
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc * inv
      const add = src[row + (x + radius + 1) % size]
      const sub = src[row + ((x - radius) % size + size) % size]
      acc += add - sub
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0
    for (let k = -radius; k <= radius; k++) acc += tmp[(((k % size) + size) % size) * size + x]
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc * inv
      const add = tmp[((y + radius + 1) % size) * size + x]
      const sub = tmp[(((y - radius) % size + size) % size) * size + x]
      acc += add - sub
    }
  }
  return out
}

// --- canvas / texture plumbing ---------------------------------------------

function makeCanvas(size) {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return c
}

function fieldToCanvas(field, size, fn) {
  const c = makeCanvas(size)
  const g = c.getContext('2d', { willReadFrequently: false })
  const img = g.createImageData(size, size)
  const d = img.data
  for (let i = 0, p = 0; i < field.length; i++, p += 4) {
    const rgb = fn(field[i], i)
    d[p] = rgb[0]
    d[p + 1] = rgb[1]
    d[p + 2] = rgb[2]
    d[p + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}

function rgbaToCanvas(rgba, size) {
  const c = makeCanvas(size)
  const g = c.getContext('2d')
  const img = new ImageData(rgba, size, size)
  g.putImageData(img, 0, 0)
  return c
}

function grayToCanvas(field, size) {
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let i = 0, p = 0; i < field.length; i++, p += 4) {
    const v = Math.max(0, Math.min(255, field[i] * 255)) | 0
    rgba[p] = rgba[p + 1] = rgba[p + 2] = v
    rgba[p + 3] = 255
  }
  return rgbaToCanvas(rgba, size)
}

/**
 * Sobel height -> tangent-space normal (OpenGL convention, +Y up) with wrap, so
 * the normal map tiles as cleanly as the height it came from.
 */
function normalFromHeight(height, size, strength = 2.2) {
  const rgba = new Uint8ClampedArray(size * size * 4)
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1)
      const t = at(x, y - 1)
      const tr = at(x + 1, y - 1)
      const l = at(x - 1, y)
      const r = at(x + 1, y)
      const bl = at(x - 1, y + 1)
      const b = at(x, y + 1)
      const br = at(x + 1, y + 1)
      const dx = tl + 2 * l + bl - (tr + 2 * r + br)
      const dy = tl + 2 * t + tr - (bl + 2 * b + br)
      let nx = dx * strength
      let ny = dy * strength
      const nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      const p = (y * size + x) * 4
      rgba[p] = (nx * 0.5 + 0.5) * 255
      rgba[p + 1] = (ny * 0.5 + 0.5) * 255
      rgba[p + 2] = nz * inv * 0.5 * 255 + 127.5
      rgba[p + 3] = 255
    }
  }
  return rgbaToCanvas(rgba, size)
}

/** Cavity occlusion: how far below the local average a texel sits. */
function aoFromHeight(height, size, radius = 10, strength = 1.1) {
  const blurred = blurField(height, size, radius)
  const ao = new Float32Array(height.length)
  for (let i = 0; i < ao.length; i++) {
    const cav = Math.max(0, blurred[i] - height[i])
    ao[i] = Math.max(0.25, 1 - cav * 2.6 * strength)
  }
  return ao
}

// --- colour helpers ---------------------------------------------------------

function hexRGB(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}

function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// --- material specs ---------------------------------------------------------
// Each returns { albedo:Uint8ClampedArray, height:Float32Array, rough:Float32Array,
//                metal?:Float32Array, normalStrength, aoRadius }

const SPECS = {
  concrete(size) {
    const base = fbmField(size, { fx: 6, fy: 6, octaves: 6, seed: 11 })
    const grain = fbmField(size, { fx: 32, fy: 32, octaves: 3, seed: 23 })
    const stain = fbmField(size, { fx: 3, fy: 3, octaves: 4, seed: 37, gain: 0.6 })
    const { f1, edge } = voronoiField(size, { cells: 40, seed: 5 })
    const cracks = fbmField(size, { fx: 5, fy: 5, octaves: 5, seed: 61, ridged: true })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cLo = hexRGB(0x6f6f6a)
    const cHi = hexRGB(0xb6b4ab)
    const cStain = hexRGB(0x4a4841)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const agg = 1 - f1[i] // aggregate stones poking through
      const crackMask = clamp01((cracks[i] - 0.86) * 12)
      const h = clamp01(base[i] * 0.55 + grain[i] * 0.2 + agg * 0.25 - crackMask * 0.5)
      height[i] = h
      const tone = clamp01(base[i] * 0.6 + grain[i] * 0.4)
      let c = mixc(cLo, cHi, tone)
      c = mixc(c, cStain, clamp01((stain[i] - 0.45) * 1.5) * 0.55)
      c = mixc(c, [30, 29, 27], crackMask * 0.8)
      // pale aggregate flecks
      c = mixc(c, [206, 203, 194], clamp01((agg - 0.7) * 3) * 0.5 * edge[i])
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.72 + grain[i] * 0.22 - tone * 0.06)
    }
    return { albedo, height, rough, normalStrength: 2.6, aoRadius: 12 }
  },

  asphalt(size) {
    const { f1, edge, id } = voronoiField(size, { cells: 72, seed: 13, jitter: 1 })
    const fine = fbmField(size, { fx: 48, fy: 48, octaves: 3, seed: 29 })
    const patch = fbmField(size, { fx: 3, fy: 3, octaves: 4, seed: 51 })
    const cracks = fbmField(size, { fx: 4, fy: 4, octaves: 5, seed: 71, ridged: true })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cDark = hexRGB(0x222224)
    const cMid = hexRGB(0x3d3d3c)
    const cStone = hexRGB(0x6d6a62)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const stone = clamp01((0.62 - f1[i]) * 3)
      const crackMask = clamp01((cracks[i] - 0.88) * 14)
      height[i] = clamp01(0.42 + stone * 0.32 + fine[i] * 0.16 - crackMask * 0.6 - (1 - edge[i]) * 0.05)
      let c = mixc(cDark, cMid, clamp01(patch[i] * 0.8 + fine[i] * 0.3))
      c = mixc(c, cStone, stone * (0.25 + id[i] * 0.55))
      c = mixc(c, [12, 12, 13], crackMask)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      // polished wear in the low patches, gritty on the stones
      rough[i] = clamp01(0.62 + stone * 0.26 + fine[i] * 0.12 - patch[i] * 0.14)
    }
    return { albedo, height, rough, normalStrength: 2.2, aoRadius: 8 }
  },

  rustedMetal(size) {
    const rustMask = fbmField(size, { fx: 4, fy: 4, octaves: 5, seed: 17, gain: 0.55 })
    const streak = fbmField(size, { fx: 26, fy: 3, octaves: 4, seed: 33 })
    const pit = fbmField(size, { fx: 40, fy: 40, octaves: 3, seed: 45 })
    const dent = fbmField(size, { fx: 6, fy: 6, octaves: 3, seed: 59 })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const metal = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cSteel = hexRGB(0x8a8f95)
    const cRustA = hexRGB(0x7a3c1d)
    const cRustB = hexRGB(0xb56a2c)
    const cScale = hexRGB(0x4a2412)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      // streaks bias the rust downward, like real weeping corrosion
      const r = clamp01((rustMask[i] * 0.75 + streak[i] * 0.35 - 0.34) * 2.4)
      const pitted = clamp01((pit[i] - 0.6) * 2.5) * r
      height[i] = clamp01(0.55 + dent[i] * 0.22 + r * 0.14 - pitted * 0.55)
      let c = mixc(cSteel, cRustA, clamp01(r * 1.4))
      c = mixc(c, cRustB, clamp01((r - 0.4) * 1.8) * streak[i])
      c = mixc(c, cScale, pitted * 0.8)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.34 + r * 0.52 + pit[i] * 0.1)
      metal[i] = clamp01(1 - r * 0.9)
    }
    return { albedo, height, rough, metal, normalStrength: 2.4, aoRadius: 9 }
  },

  paintedMetal(size) {
    const orange = fbmField(size, { fx: 40, fy: 40, octaves: 2, seed: 19 })
    const grime = fbmField(size, { fx: 5, fy: 5, octaves: 4, seed: 27 })
    const scratch = fbmField(size, { fx: 96, fy: 6, octaves: 3, seed: 39, ridged: true })
    const chip = fbmField(size, { fx: 14, fy: 14, octaves: 4, seed: 55 })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const metal = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cPaint = hexRGB(0x5c6650)
    const cPaintHi = hexRGB(0x76806a)
    const cPrimer = hexRGB(0x8d5f3d)
    const cSteel = hexRGB(0x9aa0a6)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const x = i % size
      const y = (i / size) | 0
      // stamped panel seams every quarter
      const seamX = Math.min(x % (size / 2), (size / 2) - (x % (size / 2)))
      const seamY = Math.min(y % (size / 2), (size / 2) - (y % (size / 2)))
      const seam = clamp01(1 - Math.min(seamX, seamY) / 4)
      const scr = clamp01((scratch[i] - 0.78) * 6)
      const chipped = clamp01((chip[i] - 0.74) * 6)
      height[i] = clamp01(0.6 + orange[i] * 0.08 - seam * 0.45 - chipped * 0.18)
      let c = mixc(cPaint, cPaintHi, orange[i] * 0.7)
      c = mixc(c, [26, 30, 24], clamp01((grime[i] - 0.5) * 2) * 0.45 + seam * 0.5)
      c = mixc(c, cPrimer, chipped * 0.85)
      c = mixc(c, cSteel, scr * 0.7)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.44 + grime[i] * 0.22 + chipped * 0.28 - scr * 0.25)
      metal[i] = clamp01(chipped * 0.3 + scr * 0.85)
    }
    return { albedo, height, rough, metal, normalStrength: 1.8, aoRadius: 7 }
  },

  weatheredWood(size) {
    const grain = fbmField(size, { fx: 3, fy: 64, octaves: 4, seed: 21 })
    const fibre = fbmField(size, { fx: 2, fy: 220, octaves: 2, seed: 43 })
    const knot = fbmField(size, { fx: 4, fy: 4, octaves: 3, seed: 67 })
    const weather = fbmField(size, { fx: 6, fy: 6, octaves: 4, seed: 83 })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cDark = hexRGB(0x3c2c1c)
    const cMid = hexRGB(0x74593a)
    const cGrey = hexRGB(0x8b8378)
    const PLANKS = 5
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const x = i % size
      const plankIdx = Math.floor((x / size) * PLANKS)
      const inPlank = (x / size) * PLANKS - plankIdx
      const gap = clamp01(1 - Math.min(inPlank, 1 - inPlank) * 26)
      const shade = hash2i(plankIdx, 0, 7) * 0.35 + 0.65
      const g = clamp01(grain[i] * 0.65 + fibre[i] * 0.35)
      const k = clamp01((knot[i] - 0.7) * 3)
      height[i] = clamp01(0.6 + g * 0.22 - gap * 0.8 - k * 0.15)
      let c = mixc(cDark, cMid, g * shade)
      c = mixc(c, cGrey, clamp01((weather[i] - 0.42) * 1.6) * 0.5) // silvering
      c = mixc(c, [24, 17, 11], k * 0.7 + gap * 0.85)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.72 + fibre[i] * 0.2 + gap * 0.1)
    }
    return { albedo, height, rough, normalStrength: 2.0, aoRadius: 10 }
  },

  dirt(size) {
    const clump = fbmField(size, { fx: 5, fy: 5, octaves: 6, seed: 31 })
    const fine = fbmField(size, { fx: 44, fy: 44, octaves: 3, seed: 47 })
    const { f1 } = voronoiField(size, { cells: 30, seed: 63 })
    const damp = fbmField(size, { fx: 3, fy: 3, octaves: 3, seed: 79 })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cDry = hexRGB(0x8a7350)
    const cWet = hexRGB(0x4a3a26)
    const cPebble = hexRGB(0x8f8878)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const peb = clamp01((0.4 - f1[i]) * 4)
      height[i] = clamp01(clump[i] * 0.6 + fine[i] * 0.2 + peb * 0.3)
      let c = mixc(cWet, cDry, clamp01(clump[i] * 0.7 + fine[i] * 0.4))
      c = mixc(c, cWet, clamp01((damp[i] - 0.5) * 2) * 0.55)
      c = mixc(c, cPebble, peb * 0.6)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.9 + fine[i] * 0.1 - peb * 0.15)
    }
    return { albedo, height, rough, normalStrength: 2.8, aoRadius: 12 }
  },

  gravel(size) {
    const { f1, edge, id } = voronoiField(size, { cells: 34, seed: 91, jitter: 1 })
    const grit = fbmField(size, { fx: 60, fy: 60, octaves: 3, seed: 93 })
    const dust = fbmField(size, { fx: 6, fy: 6, octaves: 4, seed: 95 })

    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cA = hexRGB(0x5b5750)
    const cB = hexRGB(0x9a9084)
    const cC = hexRGB(0x6b5a46)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const dome = Math.sqrt(Math.max(0, 1 - f1[i] * f1[i])) // stone as a hemisphere
      height[i] = clamp01(dome * 0.8 + grit[i] * 0.15)
      const stoneTint = id[i]
      let c = mixc(cA, cB, stoneTint)
      c = mixc(c, cC, clamp01((stoneTint - 0.7) * 3))
      c = mixc(c, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], (1 - dome) * 0.7)
      c = mixc(c, [122, 110, 92], clamp01((dust[i] - 0.5) * 1.8) * 0.35)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.82 + grit[i] * 0.14 - dome * 0.08 + (1 - edge[i]) * 0.05)
    }
    return { albedo, height, rough, normalStrength: 3.0, aoRadius: 10 }
  },

  glass(size) {
    const smudge = fbmField(size, { fx: 6, fy: 6, octaves: 4, seed: 101 })
    const dustF = fbmField(size, { fx: 30, fy: 30, octaves: 3, seed: 103 })
    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const s = clamp01((smudge[i] - 0.45) * 1.6)
      height[i] = 0.5 + s * 0.03
      const tint = 214 + dustF[i] * 26
      albedo[p] = tint * 0.92
      albedo[p + 1] = tint * 0.97
      albedo[p + 2] = tint
      albedo[p + 3] = 255
      rough[i] = clamp01(0.03 + s * 0.3 + dustF[i] * 0.06)
    }
    return { albedo, height, rough, normalStrength: 0.5, aoRadius: 6 }
  },

  fabric(size) {
    const fuzz = fbmField(size, { fx: 80, fy: 80, octaves: 3, seed: 107 })
    const wear = fbmField(size, { fx: 5, fy: 5, octaves: 4, seed: 109 })
    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cA = hexRGB(0x4a4f3d)
    const cB = hexRGB(0x6a6f56)
    const THREADS = 96
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const x = i % size
      const y = (i / size) | 0
      const u = (x / size) * THREADS
      const v = (y / size) * THREADS
      // plain weave: warp over weft in a checker
      const warp = Math.sin(u * TAU) * 0.5 + 0.5
      const weft = Math.sin(v * TAU) * 0.5 + 0.5
      const over = ((Math.floor(u) + Math.floor(v)) & 1) === 0
      const w = over ? warp : weft
      height[i] = clamp01(0.35 + w * 0.5 + fuzz[i] * 0.15)
      let c = mixc(cA, cB, w * 0.6 + wear[i] * 0.4)
      c = mixc(c, [30, 32, 26], (1 - w) * 0.35)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.86 + fuzz[i] * 0.12 - w * 0.05)
    }
    return { albedo, height, rough, normalStrength: 1.6, aoRadius: 6 }
  },

  plasticCrate(size) {
    const peel = fbmField(size, { fx: 56, fy: 56, octaves: 3, seed: 111 })
    const scuff = fbmField(size, { fx: 40, fy: 8, octaves: 3, seed: 113, ridged: true })
    const grime = fbmField(size, { fx: 4, fy: 4, octaves: 4, seed: 117 })
    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cA = hexRGB(0x7a4426)
    const cB = hexRGB(0x8f5b39)
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const s = clamp01((scuff[i] - 0.8) * 6)
      height[i] = clamp01(0.55 + peel[i] * 0.12 - s * 0.05)
      let c = mixc(cA, cB, peel[i] * 0.5 + 0.25)
      c = mixc(c, [188, 178, 168], s * 0.55) // stress-whitened scuffs
      c = mixc(c, [46, 38, 30], clamp01((grime[i] - 0.55) * 2) * 0.4)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.38 + peel[i] * 0.16 + s * 0.34 + grime[i] * 0.1)
    }
    return { albedo, height, rough, normalStrength: 1.2, aoRadius: 6 }
  },

  brick(size) {
    const clay = fbmField(size, { fx: 40, fy: 40, octaves: 3, seed: 121 })
    const blotch = fbmField(size, { fx: 7, fy: 7, octaves: 4, seed: 123 })
    const mortarN = fbmField(size, { fx: 50, fy: 50, octaves: 3, seed: 127 })
    const height = new Float32Array(size * size)
    const rough = new Float32Array(size * size)
    const albedo = new Uint8ClampedArray(size * size * 4)
    const cA = hexRGB(0x7a3a2c)
    const cB = hexRGB(0xa85f42)
    const cC = hexRGB(0x59322a)
    const cMortar = hexRGB(0x9c9a90)
    const ROWS = 8
    const MORTAR = 0.055
    for (let i = 0, p = 0; i < height.length; i++, p += 4) {
      const x = i % size
      const y = (i / size) | 0
      const v = y / size
      const row = Math.floor(v * ROWS)
      const inRow = v * ROWS - row
      const offset = (row & 1) * 0.5
      const u = (x / size) * (ROWS / 2) + offset
      const col = Math.floor(u)
      const inCol = u - col
      const mv = Math.min(inRow, 1 - inRow)
      const mh = Math.min(inCol, 1 - inCol)
      const mortar = clamp01(1 - Math.min(mv, mh * 0.5) / MORTAR)
      const rnd = hash2i(col, row, 13)
      const rnd2 = hash2i(col, row, 29)
      height[i] = clamp01(0.72 + clay[i] * 0.12 - mortar * 0.55 - rnd2 * 0.06)
      let c = mixc(cA, cB, rnd * 0.8 + clay[i] * 0.2)
      c = mixc(c, cC, clamp01((blotch[i] - 0.45) * 1.6) * 0.6)
      c = mixc(c, mixc(cMortar, [110, 108, 100], mortarN[i]), mortar)
      albedo[p] = c[0]
      albedo[p + 1] = c[1]
      albedo[p + 2] = c[2]
      albedo[p + 3] = 255
      rough[i] = clamp01(0.78 + clay[i] * 0.14 + mortar * 0.12)
    }
    return { albedo, height, rough, normalStrength: 2.4, aoRadius: 12 }
  },
}

export const PROCEDURAL_NAMES = Object.keys(SPECS)

/**
 * @param {object} ctx engine context (used only for anisotropy)
 */
export function createTextureFactory(ctx) {
  const cache = new Map()
  const disposables = new Set()
  const maxAniso = Math.min(8, ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4)
  const SIZE = ctx?.quality === 'low' ? 256 : ctx?.quality === 'medium' ? 384 : 512

  function finish(tex, srgb) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    tex.anisotropy = maxAniso
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
    disposables.add(tex)
    return tex
  }

  /**
   * Bake one procedural material's map set.
   * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture,
   *            aoMap:THREE.Texture, metalnessMap?:THREE.Texture, normalScale:number}}
   */
  function bake(name) {
    if (cache.has(name)) return cache.get(name)
    const spec = SPECS[name]
    if (!spec) throw new Error(`[textures] unknown procedural spec "${name}"`)
    const t0 = performance.now()
    const { albedo, height, rough, metal, normalStrength, aoRadius } = spec(SIZE)

    const maps = {
      map: finish(new THREE.CanvasTexture(rgbaToCanvas(albedo, SIZE)), true),
      normalMap: finish(new THREE.CanvasTexture(normalFromHeight(height, SIZE, normalStrength)), false),
      roughnessMap: finish(new THREE.CanvasTexture(grayToCanvas(rough, SIZE)), false),
      aoMap: finish(new THREE.CanvasTexture(grayToCanvas(aoFromHeight(height, SIZE, aoRadius), SIZE)), false),
      bakeMs: performance.now() - t0,
    }
    if (metal) maps.metalnessMap = finish(new THREE.CanvasTexture(grayToCanvas(metal, SIZE)), false)
    cache.set(name, maps)
    return maps
  }

  /** Small flat helpers other render code needs (never exposed to the world). */
  function flat(hex, srgb = true) {
    const key = `flat:${hex}:${srgb}`
    if (cache.has(key)) return cache.get(key)
    const c = makeCanvas(4)
    const g = c.getContext('2d')
    g.fillStyle = `#${hex.toString(16).padStart(6, '0')}`
    g.fillRect(0, 0, 4, 4)
    const t = finish(new THREE.CanvasTexture(c), srgb)
    cache.set(key, t)
    return t
  }

  return {
    size: SIZE,
    names: PROCEDURAL_NAMES,
    bake,
    flat,
    has: (n) => !!SPECS[n],
    dispose() {
      for (const t of disposables) t.dispose()
      disposables.clear()
      cache.clear()
    },
    // exposed for anyone who wants raw fields (fx decals etc.)
    _internals: { fbmField, voronoiField, normalFromHeight, aoFromHeight },
  }
}
