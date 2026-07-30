/**
 * Per-team palettes, per-class kit, weapon definitions and the shared texture
 * factory.
 *
 * All soldier geometry ships with a single UV0 that points at one cell of a 4x4
 * palette atlas, so one material covers fabric, kevlar, painted metal, rubber,
 * glass-adjacent optics and skin without a texture per soldier. UV1 is a
 * smart-projected layout used only for the tiling detail normal, which keeps
 * every surface from reading as flat vinyl at gameplay zoom.
 */
import * as THREE from 'three'

export const PAL_N = 4

// palette slot ids — must match src/units/blender/lib.py
export const SLOT = {
  CLOTH: 0, KEVLAR: 1, HELMET: 2, RUBBER: 3,
  METAL: 4, WEB: 5, SKIN: 6, ACCENT: 7,
  POLY: 8, BOOT: 9, OPTIC: 10, BRASS: 11,
  CAMO: 12, GLOVE: 13, DARK: 14, LENS: 15,
}

/**
 * Team 0 VANGUARD reads cool + dark; team 1 SCAVENGER reads warm + light.
 * The luminance gap is deliberate: the two forces stay separable in greyscale,
 * so deuteranopia / protanopia players lose nothing. Shape differs too — see
 * body.py — because colour alone is never enough.
 */
export const TEAMS = [
  {
    id: 0,
    name: 'Vanguard',
    colors: {
      [SLOT.CLOTH]:  '#2c3948', [SLOT.KEVLAR]: '#20252b', [SLOT.HELMET]: '#39485a',
      [SLOT.RUBBER]: '#191a1d', [SLOT.METAL]:  '#6d7178', [SLOT.WEB]:    '#41473f',
      [SLOT.SKIN]:   '#ab7a5d', [SLOT.ACCENT]: '#3aa8e2', [SLOT.POLY]:   '#25282c',
      [SLOT.BOOT]:   '#272220', [SLOT.OPTIC]:  '#2e3239', [SLOT.BRASS]:  '#9c7c3d',
      [SLOT.CAMO]:   '#36453f', [SLOT.GLOVE]:  '#292a2d', [SLOT.DARK]:   '#16171a',
      [SLOT.LENS]:   '#0a1a24',
    },
    marker: '#4fbcf2',
  },
  {
    id: 1,
    name: 'Scavenger',
    colors: {
      [SLOT.CLOTH]:  '#8e6f42', [SLOT.KEVLAR]: '#4b3b2b', [SLOT.HELMET]: '#a08048',
      [SLOT.RUBBER]: '#1d1b19', [SLOT.METAL]:  '#7c766c', [SLOT.WEB]:    '#6e5f3f',
      [SLOT.SKIN]:   '#a9724f', [SLOT.ACCENT]: '#d8502a', [SLOT.POLY]:   '#2b2622',
      [SLOT.BOOT]:   '#33271d', [SLOT.OPTIC]:  '#3a332c', [SLOT.BRASS]:  '#b08a3e',
      [SLOT.CAMO]:   '#7d6238', [SLOT.GLOVE]:  '#37302a', [SLOT.DARK]:   '#1c1916',
      [SLOT.LENS]:   '#241206',
    },
    marker: '#ff7a3d',
  },
]

// roughness / metalness are team-independent — only the albedo changes.
const SURFACE = {
  [SLOT.CLOTH]:  [0.92, 0.00], [SLOT.KEVLAR]: [0.86, 0.00],
  [SLOT.HELMET]: [0.62, 0.15], [SLOT.RUBBER]: [0.78, 0.00],
  [SLOT.METAL]:  [0.40, 0.90], [SLOT.WEB]:    [0.94, 0.00],
  [SLOT.SKIN]:   [0.72, 0.00], [SLOT.ACCENT]: [0.55, 0.10],
  [SLOT.POLY]:   [0.58, 0.05], [SLOT.BOOT]:   [0.70, 0.00],
  [SLOT.OPTIC]:  [0.32, 0.80], [SLOT.BRASS]:  [0.36, 0.95],
  [SLOT.CAMO]:   [0.90, 0.00], [SLOT.GLOVE]:  [0.74, 0.00],
  [SLOT.DARK]:   [0.88, 0.00], [SLOT.LENS]:   [0.08, 0.20],
}

// ------------------------------------------------------------------ classes --
export const CLASSES = {
  Ranger: {
    file: 'ranger',
    weapon: 'smg',
    sidearm: null,
    scale: 0.985,          // wiry
    fireShots: 2,
  },
  Sharpshooter: {
    file: 'sharpshooter',
    weapon: 'sniper',
    sidearm: null,
    scale: 1.005,
    fireShots: 1,
  },
  Grenadier: {
    file: 'grenadier',
    weapon: 'launcher',
    sidearm: null,
    scale: 1.045,          // broadest
    fireShots: 1,
  },
  Specialist: {
    file: 'specialist',
    weapon: 'rifle',
    sidearm: 'gadget',
    scale: 1.0,
    fireShots: 3,
  },
}

export const DEFAULT_CLASS = 'Ranger'

/**
 * Weapons live in "grip space" (origin = right palm, +Y muzzle, +Z rail) in
 * Blender; the glTF +Y-up conversion maps that to (+Y up, -Z forward) here, so
 * the muzzle offsets below are already in three-space.
 */
export const WEAPONS = {
  rifle:    { file: 'wpn_rifle',    muzzle: [0, 0.080, -0.650], eject: [0.030, 0.090, -0.140] },
  sniper:   { file: 'wpn_sniper',   muzzle: [0, 0.082, -0.780], eject: [0.044, 0.098, -0.150] },
  launcher: { file: 'wpn_launcher', muzzle: [0, 0.096, -0.462], eject: [0.060, 0.030, -0.100] },
  smg:      { file: 'wpn_smg',      muzzle: [0, 0.074, -0.452], eject: [0.028, 0.080, -0.120] },
  gadget:   { file: 'wpn_gadget',   muzzle: [0, 0.020, -0.100], eject: [0, 0, 0] },
}

// The left-hand gadget rides on the forearm rather than the palm.
export const OFFHAND_XFORM = {
  position: [0.0, -0.02, -0.05],
  rotation: [-0.5, 0.2, 0.1],
}

// ------------------------------------------------------------------ textures -
const _cache = new Map()

function cellRect(i, size) {
  const c = size / PAL_N
  return { x: (i % PAL_N) * c, y: Math.floor(i / PAL_N) * c, c }
}

function makeCanvas(size) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  return cv
}

/** Base-colour atlas for a team. */
export function paletteMap(team) {
  const key = `pal:${team}`
  if (_cache.has(key)) return _cache.get(key)
  const size = 256
  const cv = makeCanvas(size)
  const g = cv.getContext('2d')
  const cols = TEAMS[team]?.colors || TEAMS[0].colors
  g.fillStyle = '#808080'
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 16; i++) {
    const { x, y, c } = cellRect(i, size)
    g.fillStyle = cols[i] || '#808080'
    g.fillRect(x, y, c, c)
  }
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.generateMipmaps = false
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  _cache.set(key, t)
  return t
}

/** Packed roughness (G) / metalness (B) atlas — team independent. */
export function ormMap() {
  const key = 'orm'
  if (_cache.has(key)) return _cache.get(key)
  const size = 256
  const cv = makeCanvas(size)
  const g = cv.getContext('2d')
  g.fillStyle = '#00ff00'
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 16; i++) {
    const { x, y, c } = cellRect(i, size)
    const [r, m] = SURFACE[i] || [0.8, 0]
    g.fillStyle = `rgb(0, ${Math.round(r * 255)}, ${Math.round(m * 255)})`
    g.fillRect(x, y, c, c)
  }
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.NoColorSpace
  t.generateMipmaps = false
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  _cache.set(key, t)
  return t
}

// ---- tileable procedural detail normal (cordura weave + scuffs) -------------
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const w = (a, b) => ((a % b) + b) % b
  const a = hash2(w(xi, period), w(yi, period), seed)
  const b = hash2(w(xi + 1, period), w(yi, period), seed)
  const c = hash2(w(xi, period), w(yi + 1, period), seed)
  const d = hash2(w(xi + 1, period), w(yi + 1, period), seed)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

function heightAt(u, v, S) {
  // fibre weave: two perpendicular high-frequency ripples
  const weave = (Math.sin(u * Math.PI * 2 * 96) * 0.5 + 0.5) * 0.30 +
                (Math.sin(v * Math.PI * 2 * 96) * 0.5 + 0.5) * 0.30
  // fbm grain for scuffing and pilling
  let f = 0, amp = 0.55, per = 8
  for (let o = 0; o < 5; o++) {
    f += vnoise(u * per, v * per, per, 17 + o) * amp
    amp *= 0.52
    per *= 2
  }
  // sparse deep scratches
  const scr = Math.pow(vnoise(u * 220, v * 12, 220, 91), 6.0) * 1.4
  return weave * 0.32 + f * 0.62 - scr * 0.45
}

export function detailNormalMap(size = 512) {
  const key = `detail:${size}`
  if (_cache.has(key)) return _cache.get(key)
  const cv = makeCanvas(size)
  const g = cv.getContext('2d')
  const img = g.createImageData(size, size)
  const d = img.data
  const h = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightAt(x / size, y / size, size)
  }
  const S = 2.6
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)]
      const r = h[y * size + ((x + 1) % size)]
      const u = h[((y - 1 + size) % size) * size + x]
      const dn = h[((y + 1) % size) * size + x]
      let nx = (l - r) * S, ny = (u - dn) * S, nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      const i = (y * size + x) * 4
      d[i] = (nx * inv * 0.5 + 0.5) * 255
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255
      d[i + 2] = (nz * inv * 0.5 + 0.5) * 255
      d[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.NoColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(7, 7)
  t.anisotropy = 4
  t.needsUpdate = true
  _cache.set(key, t)
  return t
}

export function disposeTextures() {
  for (const t of _cache.values()) t.dispose?.()
  _cache.clear()
}
