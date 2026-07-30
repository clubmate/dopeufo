/**
 * Procedural VFX texture bakery.
 *
 * Everything the particle system draws is generated here on a 2D canvas at boot.
 * The rule that drives every generator: **no radial gradients as silhouettes.**
 * A soft circle is the amateur tell. Every sprite here gets its shape from an
 * accumulated metaball field, eroded by tileable fractal noise, then fake-lit
 * from a fixed key direction so it has volume instead of just falloff.
 *
 * Cost is ~120-200 ms of one-off canvas work at boot, chunked with yields so the
 * loading bar keeps painting. Nothing here runs after init.
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Tileable fractal value noise in [0,1]. `period` = lattice cells across the tile. */
function bakeNoise(N, period, octaves, seed, gain = 0.5) {
  const out = new Float32Array(N * N)
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) { total += amp; amp *= gain }
  amp = 1
  for (let o = 0; o < octaves; o++) {
    const p = period << o
    const cell = N / p
    for (let y = 0; y < N; y++) {
      const fy = y / cell
      const iy = Math.floor(fy)
      let ty = fy - iy
      ty = ty * ty * ty * (ty * (ty * 6 - 15) + 10)
      const y0 = ((iy % p) + p) % p
      const y1 = (y0 + 1) % p
      const row = y * N
      for (let x = 0; x < N; x++) {
        const fx = x / cell
        const ix = Math.floor(fx)
        let tx = fx - ix
        tx = tx * tx * tx * (tx * (tx * 6 - 15) + 10)
        const x0 = ((ix % p) + p) % p
        const x1 = (x0 + 1) % p
        const a = hash2i(x0, y0, seed + o * 91)
        const b = hash2i(x1, y0, seed + o * 91)
        const c = hash2i(x0, y1, seed + o * 91)
        const d = hash2i(x1, y1, seed + o * 91)
        const v = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty
        out[row + x] += v * amp
      }
    }
    amp *= gain
  }
  const inv = 1 / total
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return out
}

/** Bilinear wrapped sample of a baked noise tile, uv in tile units (wraps at 1). */
function nsample(tile, N, u, v) {
  let fx = (u - Math.floor(u)) * N
  let fy = (v - Math.floor(v)) * N
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const tx = fx - x0, ty = fy - y0
  const xa = x0 & (N - 1), ya = y0 & (N - 1)
  const xb = (x0 + 1) & (N - 1), yb = (y0 + 1) & (N - 1)
  const a = tile[ya * N + xa], b = tile[ya * N + xb]
  const c = tile[yb * N + xa], d = tile[yb * N + xb]
  const m = a + (b - a) * tx
  return m + ((c + (d - c) * tx) - m) * ty
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** Accumulate a squared-falloff metaball into a density field. Bounded loop. */
function blob(field, S, cx, cy, r, w) {
  if (r <= 0) return
  const x0 = Math.max(0, Math.floor((cx - r) * S))
  const x1 = Math.min(S - 1, Math.ceil((cx + r) * S))
  const y0 = Math.max(0, Math.floor((cy - r) * S))
  const y1 = Math.min(S - 1, Math.ceil((cy + r) * S))
  const r2 = r * r
  const inv = 1 / r2
  for (let y = y0; y <= y1; y++) {
    const dy = y / S - cy
    const dy2 = dy * dy
    const row = y * S
    for (let x = x0; x <= x1; x++) {
      const dx = x / S - cx
      const d2 = dx * dx + dy2
      if (d2 >= r2) continue
      const f = 1 - d2 * inv
      field[row + x] += f * f * w
    }
  }
}

function frameXY(i, cols, rows, S) {
  // frame 0 lives bottom-left so tile row index matches UV.v directly
  const col = i % cols
  const row = Math.floor(i / cols)
  return [col * S, (rows - 1 - row) * S]
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
function sstep(a, b, x) {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function texFromCanvas(cv, { srgb = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = mips
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = 4
  t.needsUpdate = true
  return t
}

// ---------------------------------------------------------------------------
// billowing-puff family: smoke / dust / dirt
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 *  cols/rows/size  sheet layout
 *  lit/shadow      RGB ends of the fake-lit ramp
 *  grain           extra high-frequency break-up (dust > smoke)
 *  rise            how far the puff drifts up across the flipbook
 *  bloom           radial expansion factor across the flipbook
 */
function bakePuff(o) {
  const { cols, rows, size: S, seed } = o
  const F = cols * rows
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  g.clearRect(0, 0, cv.width, cv.height)

  const { lowN, hiN, NL, NH } = o
  const r = rng(seed)

  // Many small lobes packed over the disc — a few big ones read as a kidney
  // bean. Each lobe orbits and pulses over exactly one loop of the flipbook so
  // the sheet CHURNS rather than grows: size animation belongs on the particle,
  // and a growing flipbook would break random start frames.
  const nblob = o.blobs || 44
  const blobs = []
  for (let i = 0; i < nblob; i++) {
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * 0.275
    blobs.push({
      a, d,
      r: (0.078 + r() * 0.072) * (1 - d * 0.45),
      w: 0.55 + r() * 0.85,
      orbit: (r() - 0.5) * 1.6,       // radians travelled over the loop
      pulse: r() * 6.283,
      breathe: 0.10 + r() * 0.22,
    })
  }

  const dens = new Float32Array(S * S)
  const H = new Float32Array(S * S)
  const img = g.createImageData(S, S)
  const px = img.data

  const lit = o.lit, shadow = o.shadow
  // key from upper-left-front, matching the sun most iso levels use
  const lx = -0.46, ly = 0.56, lz = 0.69
  const K = o.shade === undefined ? 5.2 : o.shade
  const nf = o.noiseFreq || 2.0
  const gf = o.grainFreq || 1.7
  const grain = o.grain === undefined ? 0.30 : o.grain
  const A0 = o.aLo === undefined ? 0.20 : o.aLo
  const A1 = o.aHi === undefined ? 0.66 : o.aHi

  for (let f = 0; f < F; f++) {
    const prog = f / F                          // /F, not /(F-1): the loop closes
    const tau = prog * Math.PI * 2
    dens.fill(0)

    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i]
      const a = b.a + b.orbit * prog
      const dist = b.d * (1 + Math.sin(b.pulse + tau) * 0.09)
      const cx = 0.5 + Math.cos(a) * dist
      const cy = 0.5 + Math.sin(a) * dist
      const rad = b.r * (1 + Math.sin(b.pulse * 1.7 + tau) * b.breathe)
      blob(dens, S, cx, cy, rad, b.w)
    }

    // --- erode: multiplicative mid-frequency + subtractive fine grain -------
    for (let y = 0; y < S; y++) {
      const v = y / S
      const row = y * S
      for (let x = 0; x < S; x++) {
        const i = row + x
        const d = dens[i]
        if (d <= 0.0001) { H[i] = 0; continue }
        const u = x / S
        // domain warp so the break-up follows the lobes instead of stripes
        const w = nsample(lowN, NL, u * nf * 0.5, v * nf * 0.5 - prog) - 0.5
        const n1 = nsample(lowN, NL, u * nf + w * 0.22, v * nf - prog + w * 0.22)
        const n2 = nsample(hiN, NH, u * gf - prog * 0.5, v * gf - prog)
        let h = d * (0.76 + 0.48 * n1) - grain * (1 - n2) * (1 - n2)
        if (h < 0) h = 0
        H[i] = h
      }
    }

    // --- shade off the density field (real gradients -> real lobes) ---------
    for (let y = 0; y < S; y++) {
      const v = y / S
      const row = y * S
      const ym = (y > 0 ? y - 1 : 0) * S
      const yp = (y < S - 1 ? y + 1 : S - 1) * S
      for (let x = 0; x < S; x++) {
        const i = row + x
        const h = H[i]
        const o4 = i * 4
        const u = x / S
        const rr = Math.hypot(u - 0.5, v - 0.5)
        const n2f = nsample(hiN, NH, u * gf * 2.2 + prog, v * gf * 2.2 - prog * 1.3)
        // faint noisy halo outside the solid body: smoke has wisps, not a rim
        let a = sstep(A0, A1, h)
        a = Math.max(a, sstep(0.020, 0.115, h) * 0.34 * (0.35 + n2f))
        a *= 1 - sstep(0.40, 0.492, rr)
        if (a <= 0.003) { px[o4] = 0; px[o4 + 1] = 0; px[o4 + 2] = 0; px[o4 + 3] = 0; continue }

        const xm = x > 0 ? x - 1 : 0
        const xp = x < S - 1 ? x + 1 : S - 1
        const nx = (H[row + xm] - H[row + xp]) * K
        const ny = (H[yp + x] - H[ym + x]) * K   // canvas y is down: already flipped
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
        const lam = (nx * lx + ny * ly + lz) * inv

        // wrapped diffuse: smoke scatters, so the terminator is soft and the
        // shadow side is never black
        let m = clamp01(lam * 0.60 + 0.44)
        m = m * m * (3 - 2 * m)
        // a touch of thickness AO so crevices read, but nowhere near enough to
        // turn the puff into popcorn
        const thick = clamp01(h * 0.5)
        m = clamp01(m * (1 - 0.20 * thick) + 0.09 * (1 - thick) * (1 - thick))

        px[o4] = (shadow[0] + (lit[0] - shadow[0]) * m) * 255
        px[o4 + 1] = (shadow[1] + (lit[1] - shadow[1]) * m) * 255
        px[o4 + 2] = (shadow[2] + (lit[2] - shadow[2]) * m) * 255
        px[o4 + 3] = a * 255
      }
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// fire
// ---------------------------------------------------------------------------

const FIRE_RAMP = [
  [0.00, [0.30, 0.030, 0.004]],
  [0.18, [0.85, 0.110, 0.010]],
  [0.38, [1.30, 0.330, 0.040]],
  [0.58, [1.75, 0.720, 0.140]],
  [0.78, [2.00, 1.180, 0.420]],
  [1.00, [2.10, 1.750, 1.150]],
]

function rampLookup(ramp, t) {
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const a = ramp[i - 1], b = ramp[i]
      const k = (t - a[0]) / (b[0] - a[0])
      return [
        a[1][0] + (b[1][0] - a[1][0]) * k,
        a[1][1] + (b[1][1] - a[1][1]) * k,
        a[1][2] + (b[1][2] - a[1][2]) * k,
      ]
    }
  }
  return ramp[ramp.length - 1][1]
}

function bakeFire(o) {
  const { cols, rows, size: S, seed, lowN, hiN, NL, NH } = o
  const F = cols * rows
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const r = rng(seed)

  const tongues = []
  for (let i = 0; i < 14; i++) {
    tongues.push({
      x: 0.5 + (r() - 0.5) * 0.58,
      top: 0.07 + r() * 0.30,
      rad: 0.085 + r() * 0.085,
      amp: 0.040 + r() * 0.085,
      freq: 3.0 + r() * 5.0,
      phase: r() * 6.283,
      loops: 1 + Math.floor(r() * 2),
    })
  }

  const dens = new Float32Array(S * S)
  const alpha = new Float32Array(S * S)
  const img = g.createImageData(S, S)
  const px = img.data

  for (let f = 0; f < F; f++) {
    const prog = f / F // note: /F not /(F-1) so the loop closes seamlessly
    dens.fill(0)

    // hot base mass: an explosion fireball is a burning cloud, not a candle
    blob(dens, S, 0.5, 0.74, 0.34, 1.25)
    blob(dens, S, 0.5, 0.64, 0.26, 1.0)
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * 6.283 + prog * 2.4
      blob(dens, S, 0.5 + Math.cos(a) * 0.17, 0.70 + Math.sin(a) * 0.13,
        0.11 + 0.05 * Math.sin(a * 3 + prog * 6.283), 0.85)
    }

    for (let k = 0; k < tongues.length; k++) {
      const t = tongues[k]
      const ph = t.phase + prog * Math.PI * 2 * t.loops
      const steps = 16
      for (let s = 0; s < steps; s++) {
        const fy = s / (steps - 1)
        const y = 0.90 - fy * (0.90 - t.top)
        const x = t.x + Math.sin(fy * t.freq + ph) * t.amp * (0.25 + fy)
        const rad = t.rad * (1 - fy * 0.62) * (0.80 + 0.25 * Math.sin(ph * 1.7 + fy * 3.0))
        blob(dens, S, x, y, rad, 0.85 * (1 - fy * 0.35))
      }
    }

    const scroll = prog
    let maxD = 0
    for (let y = 0; y < S; y++) {
      const v = y / S
      const row = y * S
      for (let x = 0; x < S; x++) {
        const u = x / S
        let d = dens[row + x]
        if (d <= 0.0001) { alpha[row + x] = 0; continue }
        const n = nsample(lowN, NL, u * 2.1, v * 2.1 + scroll * 2.0)
        const h = nsample(hiN, NH, u * 5.0, v * 5.0 + scroll * 3.0)
        d = d * (0.28 + 1.65 * n) * (0.62 + 0.55 * h)
        // taper the flame so it thins toward the tip
        d *= 0.45 + 0.75 * sstep(0.01, 0.40, v)
        const rr = Math.hypot(u - 0.5, (v - 0.52) * 1.05)
        d *= 1 - sstep(0.42, 0.50, rr)
        alpha[row + x] = d
        if (d > maxD) maxD = d
      }
    }
    const inv = maxD > 0.001 ? 1 / maxD : 0
    for (let i = 0; i < alpha.length; i++) {
      const d = clamp01(alpha[i] * inv * 1.25)
      const o4 = i * 4
      if (d <= 0.004) { px[o4] = 0; px[o4 + 1] = 0; px[o4 + 2] = 0; px[o4 + 3] = 0; continue }
      const c = rampLookup(FIRE_RAMP, d)
      // additive: store the emissive colour, alpha carries the density
      px[o4] = Math.min(255, c[0] * 128)
      px[o4 + 1] = Math.min(255, c[1] * 128)
      px[o4 + 2] = Math.min(255, c[2] * 128)
      px[o4 + 3] = Math.min(255, sstep(0.05, 0.42, d) * 255)
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// muzzle flash — 4 frames of a real flash shape, not a star sprite
// ---------------------------------------------------------------------------

function bakeFlash(o) {
  const { size: S, seed, lowN, NL, hiN, NH } = o
  const cols = 2, rows = 2, F = 4
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const r = rng(seed)

  // A real muzzle flash is an uneven CROWN: a white-hot ball at the bore with
  // a handful of long unequal petals of burning propellant thrown forward. The
  // asymmetry is the whole read — a symmetric star looks like a sparkle sticker.
  const np = 8
  const petals = []
  for (let i = 0; i < np; i++) {
    petals.push({
      a: (i / np) * 6.283 + (r() - 0.5) * 0.55,
      len: 0.16 + Math.pow(r(), 1.6) * 0.30,
      rad: 0.055 + r() * 0.055,
      bend: (r() - 0.5) * 0.55,
      taper: 0.45 + r() * 0.35,
    })
  }
  petals[0].len = 0.46; petals[0].rad = 0.115
  petals[3].len = 0.40; petals[3].rad = 0.098
  petals[5].len = 0.34; petals[5].rad = 0.082

  const dens = new Float32Array(S * S)
  const img = g.createImageData(S, S)
  const px = img.data

  //          ignition   full crown   collapse   dissipating
  const petalK = [0.42, 1.00, 0.86, 0.55]
  const coreK  = [1.25, 1.00, 0.42, 0.10]
  const widthK = [0.85, 1.00, 0.72, 0.42]
  const gain   = [0.62, 0.55, 0.52, 0.60]

  for (let f = 0; f < F; f++) {
    dens.fill(0)
    // white-hot bore
    blob(dens, S, 0.5, 0.5, 0.105 + 0.05 * coreK[f], 1.5 * coreK[f])
    blob(dens, S, 0.5, 0.5, 0.058, 2.2 * coreK[f])
    for (let i = 0; i < petals.length; i++) {
      const p = petals[i]
      const steps = 16
      const L = p.len * petalK[f]
      for (let st = 1; st <= steps; st++) {
        const t = st / steps
        const a = p.a + p.bend * t * t
        const d = t * L
        blob(dens, S, 0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d,
          (p.rad * widthK[f]) * (1 - t * p.taper) + 0.005, 1.05 * (1 - t * 0.30))
      }
    }
    // fixed gain, NOT max-normalised: normalising lets the core crush the petals
    const K = gain[f]
    for (let y = 0; y < S; y++) {
      const v = y / S
      const row = y * S
      for (let x = 0; x < S; x++) {
        const u = x / S
        const i = row + x
        let d = dens[i] * K
        if (d > 0.0005) {
          const n = nsample(lowN, NL, u * 2.6 + f * 0.37, v * 2.6 - f * 0.19)
          const h = nsample(hiN, NH, u * 2.2 - f * 0.5, v * 2.2 + f * 0.3)
          d *= 0.55 + 0.95 * n
          d -= 0.10 * (1 - h)
        }
        d = clamp01(d)
        const rr = Math.hypot(u - 0.5, v - 0.5)
        d *= 1 - sstep(0.44, 0.50, rr)
        const o4 = i * 4
        if (d <= 0.006) { px[o4] = 0; px[o4 + 1] = 0; px[o4 + 2] = 0; px[o4 + 3] = 0; continue }
        const c = rampLookup(FIRE_RAMP, clamp01(d * 1.25))
        px[o4] = Math.min(255, c[0] * 124)
        px[o4 + 1] = Math.min(255, c[1] * 124)
        px[o4 + 2] = Math.min(255, c[2] * 124)
        px[o4 + 3] = Math.min(255, sstep(0.015, 0.26, d) * 255)
      }
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// sparks / embers atlas (2x2): comet, hot dot, thin streak, soft ember
// ---------------------------------------------------------------------------

function bakeSparks(S) {
  const cols = 2, rows = 2
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const img = g.createImageData(S, S)
  const px = img.data

  for (let f = 0; f < 4; f++) {
    for (let y = 0; y < S; y++) {
      const v = y / (S - 1)
      // canvas y is top-down; UV v=1 (the stretched leading end) is canvas top
      const vv = 1 - v
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1)
        const dx = (u - 0.5) * 2
        let a = 0, hot = 0
        if (f === 0) {
          // comet: hot head at v=1, tapering tail down to v=0
          const head = sstep(0.0, 1.0, vv)
          const w = 0.10 + 0.55 * (1 - head) * (1 - head)
          const rad = Math.abs(dx) / w
          a = Math.exp(-rad * rad * 2.4) * (0.18 + 0.95 * Math.pow(head, 1.6))
          hot = Math.pow(head, 3.0) * Math.exp(-rad * rad * 5.0)
        } else if (f === 1) {
          const r2 = dx * dx + (vv - 0.5) * (vv - 0.5) * 4
          a = Math.exp(-r2 * 5.5)
          hot = Math.exp(-r2 * 26.0)
        } else if (f === 2) {
          const w = 0.075
          const rad = Math.abs(dx) / w
          a = Math.exp(-rad * rad * 2.0) * (0.25 + 0.9 * sstep(0.0, 0.85, vv)) * (1 - sstep(0.9, 1.0, vv))
          hot = a * a
        } else {
          const r2 = dx * dx + (vv - 0.5) * (vv - 0.5) * 4
          a = Math.exp(-r2 * 3.0) * 0.75
          hot = Math.exp(-r2 * 14.0) * 0.9
        }
        const i = (y * S + x) * 4
        const c = clamp01(a)
        px[i] = Math.min(255, (0.62 * c + 0.90 * hot) * 255)
        px[i + 1] = Math.min(255, (0.42 * c + 0.88 * hot) * 255)
        px[i + 2] = Math.min(255, (0.20 * c + 0.82 * hot) * 255)
        px[i + 3] = Math.min(255, c * 255)
      }
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// soft glow (the one legitimate radial) + 4-point flare
// ---------------------------------------------------------------------------

function bakeGlow(S) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const img = g.createImageData(S, S)
  const px = img.data
  for (let y = 0; y < S; y++) {
    const v = (y / (S - 1)) * 2 - 1
    for (let x = 0; x < S; x++) {
      const u = (x / (S - 1)) * 2 - 1
      const r = Math.hypot(u, v)
      let a = Math.exp(-r * r * 7.0)
      // subtle anamorphic cross so it isn't a pure blob
      const cross = Math.exp(-(u * u) * 260) * Math.exp(-(v * v) * 5.0)
        + Math.exp(-(v * v) * 260) * Math.exp(-(u * u) * 5.0)
      a = clamp01(a + cross * 0.22)
      a *= 1 - sstep(0.86, 1.0, r)
      const i = (y * S + x) * 4
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255
      px[i + 3] = a * 255
    }
  }
  g.putImageData(img, 0, 0)
  return cv
}

// ---------------------------------------------------------------------------
// debris chips atlas — irregular flat-shaded shards
// ---------------------------------------------------------------------------

function bakeChips(S) {
  const cols = 4, rows = 4
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d')
  const r = rng(7717)
  for (let f = 0; f < 16; f++) {
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.save()
    g.translate(fx + S / 2, fy + S / 2)
    const n = 5 + Math.floor(r() * 4)
    const pts = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + (r() - 0.5) * 0.5
      const rad = S * (0.16 + r() * 0.26)
      pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
    }
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1])
    g.closePath()
    g.fillStyle = '#8d8d8d'
    g.fill()
    // lit facet: half the polygon, brighter
    g.save()
    g.clip()
    const gr = g.createLinearGradient(-S * 0.4, -S * 0.4, S * 0.35, S * 0.4)
    gr.addColorStop(0, 'rgba(255,255,255,0.85)')
    gr.addColorStop(0.45, 'rgba(190,190,190,0.25)')
    gr.addColorStop(1, 'rgba(20,20,22,0.75)')
    g.fillStyle = gr
    g.fillRect(-S / 2, -S / 2, S, S)
    // a fracture line for silhouette interest
    g.strokeStyle = 'rgba(0,0,0,0.45)'
    g.lineWidth = Math.max(1, S * 0.03)
    g.beginPath()
    g.moveTo(pts[0][0], pts[0][1])
    g.lineTo(pts[Math.floor(n / 2)][0] * 0.4, pts[Math.floor(n / 2)][1] * 0.4)
    g.lineTo(pts[n - 1][0], pts[n - 1][1])
    g.stroke()
    g.restore()
    g.restore()
  }
  return cv
}

// ---------------------------------------------------------------------------
// blood droplet atlas — blobs with tendrils and satellites
// ---------------------------------------------------------------------------

function bakeBlood(S) {
  const cols = 4, rows = 4
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const r = rng(31337)
  const dens = new Float32Array(S * S)
  const img = g.createImageData(S, S)
  const px = img.data

  for (let f = 0; f < 16; f++) {
    dens.fill(0)
    const big = f < 8
    const rad = big ? 0.18 + r() * 0.11 : 0.085 + r() * 0.06
    // main mass, deliberately off-round
    const lobes = 3 + Math.floor(r() * 4)
    for (let i = 0; i < lobes; i++) {
      const a = r() * 6.283
      const d = r() * rad * 0.55
      blob(dens, S, 0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, rad * (0.6 + r() * 0.6), 1)
    }
    // tendril in a random direction
    const ta = r() * 6.283
    const tl = rad * (1.4 + r() * 2.0)
    const steps = 10
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const d = t * tl
      blob(dens, S, 0.5 + Math.cos(ta) * d, 0.5 + Math.sin(ta) * d, rad * 0.42 * (1 - t * 0.85) + 0.004, 0.9)
    }
    // satellites
    for (let i = 0; i < 4; i++) {
      const a = r() * 6.283
      const d = rad * (1.3 + r() * 1.9)
      blob(dens, S, 0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, 0.012 + r() * 0.022, 1)
    }
    for (let y = 0; y < S; y++) {
      const row = y * S
      for (let x = 0; x < S; x++) {
        const i = row + x
        const d = dens[i]
        const a = sstep(0.22, 0.55, d)
        const o4 = i * 4
        if (a <= 0.004) { px[o4] = 0; px[o4 + 1] = 0; px[o4 + 2] = 0; px[o4 + 3] = 0; continue }
        // darker, denser core; the rim catches a little specular
        const core = sstep(0.5, 1.4, d)
        const l = 0.42 + 0.58 * (1 - core) * 0.5 + core * 0.30
        px[o4] = Math.min(255, l * 255)
        px[o4 + 1] = Math.min(255, l * 0.86 * 255)
        px[o4 + 2] = Math.min(255, l * 0.84 * 255)
        px[o4 + 3] = a * 255
      }
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// decal atlas (2x2): 0 bullet hole, 1 scorch, 2 blood pool, 3 dust scuff
// ---------------------------------------------------------------------------

function bakeDecals(o) {
  const S = o.size
  const cols = 2, rows = 2
  const cv = makeCanvas(cols * S, rows * S)
  const g = cv.getContext('2d', { willReadFrequently: true })
  const { lowN, hiN, NL, NH } = o
  const img = g.createImageData(S, S)
  const px = img.data
  const rnd = rng(9001)

  for (let f = 0; f < 4; f++) {
    // per-decal irregular radius profile
    const harm = []
    for (let i = 0; i < 6; i++) harm.push({ k: 2 + i * 2, a: rnd() * 6.283, m: (0.10 / (i + 1)) * (0.6 + rnd()) })

    for (let y = 0; y < S; y++) {
      const v = y / (S - 1) * 2 - 1
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1) * 2 - 1
        const r = Math.hypot(u, v)
        const ang = Math.atan2(v, u)
        let wob = 0
        for (const h of harm) wob += Math.sin(ang * h.k + h.a) * h.m
        const n = nsample(lowN, NL, (u * 0.5 + 0.5) * 2.4 + f, (v * 0.5 + 0.5) * 2.4 + f)
        const hn = nsample(hiN, NH, (u * 0.5 + 0.5) * 6.0 + f, (v * 0.5 + 0.5) * 6.0 + f)
        const i = (y * S + x) * 4
        let a = 0, cr = 0, cg = 0, cb = 0

        if (f === 0) {
          // bullet hole: black pit, bright pulverised rim, radial cracks
          const rr = r * (1 + wob * 0.5)
          const pit = 1 - sstep(0.16, 0.30, rr)
          const rim = (1 - sstep(0.30, 0.62, rr)) * sstep(0.14, 0.32, rr)
          let cracks = 0
          for (let c = 0; c < 7; c++) {
            const ca = (c / 7) * 6.283 + harm[c % 6].a
            let d = Math.abs(((ang - ca + Math.PI * 3) % 6.283) - Math.PI)
            cracks += Math.max(0, 1 - d * 14) * (1 - sstep(0.2, 0.75 + hn * 0.2, rr))
          }
          cracks = Math.min(1, cracks) * 0.85
          a = clamp01(pit + rim * 0.75 * (0.5 + n) + cracks * 0.6)
          const l = pit > 0.5 ? 0.03 : 0.55 + 0.35 * hn
          cr = l; cg = l * 0.98; cb = l * 0.95
        } else if (f === 1) {
          // scorch: sooty core, radial soot streaks, ashy fringe
          const rr = r * (1 + wob * 0.85)
          let streak = 0
          for (let c = 0; c < 22; c++) {
            const ca = (c / 22) * 6.283 + harm[c % 6].a * 2
            let d = Math.abs(((ang - ca + Math.PI * 3) % 6.283) - Math.PI)
            streak += Math.max(0, 1 - d * 9)
          }
          streak = Math.min(1, streak)
          const body = 1 - sstep(0.20, 0.86 + streak * 0.16, rr * (0.75 + 0.5 * n))
          a = clamp01(body * (0.55 + 0.75 * n) * (0.6 + 0.6 * hn))
          const l = 0.04 + 0.18 * (1 - body) + 0.10 * hn
          cr = l * 1.05; cg = l * 0.95; cb = l * 0.88
        } else if (f === 2) {
          // blood pool: dark viscous body, glossy centre, spatter fringe
          const rr = r * (1 + wob * 1.15)
          const body = 1 - sstep(0.40, 0.80, rr * (0.8 + 0.35 * n))
          let sat = 0
          for (let c = 0; c < 10; c++) {
            const ca = harm[c % 6].a * (c + 1)
            const cd = 0.55 + ((c * 0.137) % 0.4)
            const dx = u - Math.cos(ca) * cd, dy = v - Math.sin(ca) * cd
            sat += Math.max(0, 1 - Math.hypot(dx, dy) * (18 + (c % 5) * 9))
          }
          a = clamp01(body + Math.min(1, sat) * 0.9)
          const gloss = sstep(0.55, 0.95, body) * (0.35 + 0.5 * hn)
          const l = 0.16 + 0.55 * gloss
          cr = l; cg = l * 0.20; cb = l * 0.16
        } else {
          // dust scuff: soft dirty ring
          const rr = r * (1 + wob * 0.6)
          a = clamp01((1 - sstep(0.25, 0.9, rr)) * (0.35 + 0.85 * n) * 0.75)
          const l = 0.42 + 0.30 * hn
          cr = l; cg = l * 0.94; cb = l * 0.84
        }

        a *= 1 - sstep(0.88, 1.0, r)
        px[i] = Math.min(255, cr * 255)
        px[i + 1] = Math.min(255, cg * 255)
        px[i + 2] = Math.min(255, cb * 255)
        px[i + 3] = a * 255
      }
    }
    const [fx, fy] = frameXY(f, cols, rows, S)
    g.putImageData(img, fx, fy)
  }
  return cv
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

const yieldFrame = () =>
  new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(r) : setTimeout(r, 0)))

export async function buildTextures(quality = 'high') {
  const hi = quality === 'ultra' || quality === 'high'
  const NL = 128, NH = 128
  const lowN = bakeNoise(NL, 4, 4, 12345)
  const hiN = bakeNoise(NH, 12, 3, 777)

  const out = {}
  const t0 = performance.now()

  out.smoke = {
    tex: texFromCanvas(bakePuff({
      cols: 4, rows: 4, size: hi ? 128 : 64, seed: 11, blobs: 46,
      lit: [1.02, 1.02, 1.05], shadow: [0.10, 0.11, 0.145],
      grain: 0.09, noiseFreq: 2.1, grainFreq: 1.9, shade: 5.0, aLo: 0.11, aHi: 0.50,
      lowN, hiN, NL, NH,
    })),
    tiles: [4, 4],
  }
  await yieldFrame()

  out.dust = {
    tex: texFromCanvas(bakePuff({
      cols: 4, rows: 4, size: hi ? 128 : 64, seed: 29, blobs: 52,
      lit: [1.05, 1.00, 0.90], shadow: [0.17, 0.14, 0.11],
      grain: 0.17, noiseFreq: 2.8, grainFreq: 3.2, shade: 5.8, aLo: 0.10, aHi: 0.46,
      lowN, hiN, NL, NH,
    })),
    tiles: [4, 4],
  }
  await yieldFrame()

  out.fire = {
    tex: texFromCanvas(bakeFire({
      cols: 4, rows: 4, size: hi ? 128 : 64, seed: 53, lowN, hiN, NL, NH,
    })),
    tiles: [4, 4],
  }
  await yieldFrame()

  out.flash = { tex: texFromCanvas(bakeFlash({ size: hi ? 192 : 96, seed: 101, lowN, NL, hiN, NH })), tiles: [2, 2] }
  out.spark = { tex: texFromCanvas(bakeSparks(hi ? 96 : 48)), tiles: [2, 2] }
  out.glow = { tex: texFromCanvas(bakeGlow(hi ? 128 : 64)), tiles: [1, 1] }
  await yieldFrame()

  out.chips = { tex: texFromCanvas(bakeChips(hi ? 48 : 32)), tiles: [4, 4] }
  out.blood = { tex: texFromCanvas(bakeBlood(hi ? 64 : 32)), tiles: [4, 4] }
  await yieldFrame()

  out.decals = { tex: texFromCanvas(bakeDecals({ size: hi ? 256 : 128, lowN, hiN, NL, NH })), tiles: [2, 2] }

  out.bakeMs = Math.round(performance.now() - t0)

  // Dev escape hatch: dump every sheet as a PNG download so they can be
  // inspected (or committed to public/textures/fx/) without a build step.
  out.dump = () => {
    for (const k of Object.keys(out)) {
      const e = out[k]
      if (!e || !e.tex || !e.tex.image) continue
      const a = document.createElement('a')
      a.download = `fx_${k}.png`
      a.href = e.tex.image.toDataURL('image/png')
      a.click()
    }
  }

  return out
}
