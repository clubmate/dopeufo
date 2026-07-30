/**
 * Surface-aware bullet impacts.
 *
 * Every impact is four things layered in the same frame:
 *   1. a sub-frame flash at the point of contact
 *   2. a particle burst biased along the surface normal (never a sphere)
 *   3. a persistent decal
 *   4. debris that actually falls and settles
 *
 * The surface type comes from `ctx.world.getSurfaceType()` if the world module
 * offers one; otherwise it is inferred from the struck object's material/mesh
 * name, and failing that defaults to concrete.
 */
import * as THREE from 'three'

const _n = new THREE.Vector3()
const _t = new THREE.Vector3()
const _b = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export const SURFACES = {
  concrete: {
    decal: 'hole', decalScale: 0.30,
    dust: 14, dustTint: [0.78, 0.76, 0.71], dustSize: [0.10, 0.62], dustSpeed: [1.6, 4.5],
    chips: 9, chipTint: [0.55, 0.53, 0.50], chipSize: 0.055,
    sparks: 0, chunks: 2, chunkTint: [0.55, 0.54, 0.51], chunkSize: 0.11,
    flash: [1.4, 1.25, 1.0], flashSize: 0.30,
  },
  brick: {
    decal: 'hole', decalScale: 0.30,
    dust: 14, dustTint: [0.72, 0.45, 0.34], dustSize: [0.10, 0.60], dustSpeed: [1.6, 4.4],
    chips: 10, chipTint: [0.62, 0.34, 0.26], chipSize: 0.055,
    sparks: 0, chunks: 2, chunkTint: [0.60, 0.33, 0.25], chunkSize: 0.10,
    flash: [1.4, 1.1, 0.85], flashSize: 0.28,
  },
  metal: {
    decal: 'scuff', decalScale: 0.20,
    dust: 3, dustTint: [0.55, 0.55, 0.58], dustSize: [0.05, 0.26], dustSpeed: [1.0, 2.4],
    chips: 3, chipTint: [0.75, 0.75, 0.80], chipSize: 0.04,
    sparks: 26, chunks: 0, chunkTint: [0.7, 0.7, 0.75], chunkSize: 0.07,
    flash: [3.2, 2.6, 1.7], flashSize: 0.42, ring: true,
  },
  wood: {
    decal: 'hole', decalScale: 0.24,
    dust: 8, dustTint: [0.62, 0.48, 0.31], dustSize: [0.07, 0.42], dustSpeed: [1.2, 3.4],
    chips: 14, chipTint: [0.52, 0.36, 0.20], chipSize: 0.075, chipLong: true,
    sparks: 0, chunks: 2, chunkTint: [0.48, 0.33, 0.19], chunkSize: 0.09,
    flash: [1.1, 0.85, 0.5], flashSize: 0.22,
  },
  dirt: {
    decal: 'scuff', decalScale: 0.42,
    dust: 20, dustTint: [0.60, 0.48, 0.35], dustSize: [0.14, 0.85], dustSpeed: [1.4, 3.8],
    chips: 8, chipTint: [0.36, 0.28, 0.19], chipSize: 0.055,
    sparks: 0, chunks: 3, chunkTint: [0.34, 0.27, 0.18], chunkSize: 0.12,
    flash: [0.8, 0.65, 0.45], flashSize: 0.18,
  },
  sand: {
    decal: 'scuff', decalScale: 0.45,
    dust: 26, dustTint: [0.84, 0.74, 0.52], dustSize: [0.14, 0.95], dustSpeed: [1.6, 4.2],
    chips: 4, chipTint: [0.66, 0.57, 0.40], chipSize: 0.04,
    sparks: 0, chunks: 0, chunkTint: [0.6, 0.5, 0.35], chunkSize: 0.08,
    flash: [0.9, 0.78, 0.55], flashSize: 0.18,
  },
  glass: {
    decal: 'scuff', decalScale: 0.22,
    dust: 4, dustTint: [0.80, 0.88, 0.92], dustSize: [0.05, 0.30], dustSpeed: [1.4, 3.2],
    chips: 22, chipTint: [0.80, 0.92, 0.98], chipSize: 0.05, chipShiny: true,
    sparks: 6, chunks: 0, chunkTint: [0.8, 0.9, 1.0], chunkSize: 0.06,
    flash: [2.4, 2.8, 3.2], flashSize: 0.34,
  },
  water: {
    decal: null, decalScale: 0.3,
    dust: 18, dustTint: [0.72, 0.82, 0.88], dustSize: [0.08, 0.55], dustSpeed: [2.4, 6.0],
    chips: 0, chipTint: [1, 1, 1], chipSize: 0.03,
    sparks: 0, chunks: 0, chunkTint: [1, 1, 1], chunkSize: 0.05,
    flash: [1.0, 1.2, 1.3], flashSize: 0.2,
  },
}

const NAME_HINTS = [
  [/glass|window|pane/i, 'glass'],
  [/metal|steel|iron|car|vehicle|barrel|container|crate_metal|pipe|fence|girder/i, 'metal'],
  [/wood|plank|crate|door|fence_wood|timber|pallet/i, 'wood'],
  [/brick|masonry/i, 'brick'],
  [/dirt|mud|soil|ground|terrain|grass|earth/i, 'dirt'],
  [/sand|bag|sandbag/i, 'sand'],
  [/water|puddle/i, 'water'],
  [/concrete|stone|rock|kerb|curb|wall|rubble|asphalt|road/i, 'concrete'],
]

export function inferSurface(ctx, object, position) {
  try {
    if (ctx.world?.getSurfaceType) {
      const s = ctx.world.getSurfaceType(position, object)
      if (s && SURFACES[s]) return s
    }
  } catch { /* world may still be booting */ }
  if (object) {
    const names = [object.name, object.material?.name, object.parent?.name, object.userData?.surface]
    for (const n of names) {
      if (!n || typeof n !== 'string') continue
      for (const [re, s] of NAME_HINTS) if (re.test(n)) return s
    }
    if (object.material) {
      const m = object.material
      if (m.metalness !== undefined && m.metalness > 0.6) return 'metal'
      if (m.transparent && m.opacity < 0.8) return 'glass'
    }
  }
  return 'concrete'
}

export function createImpacts(fx) {
  const { ptc, lights, debris } = fx

  /**
   * @param {THREE.Vector3} position contact point
   * @param {THREE.Vector3} normal   surface normal (points back toward shooter)
   * @param {string} surfaceType     key into SURFACES
   * @param {object} opts            { power: 0..2 }
   */
  function impact(position, normal, surfaceType = 'concrete', opts = {}) {
    const S = SURFACES[surfaceType] || SURFACES.concrete
    const power = opts.power ?? 1
    const scl = fx.scale
    const d = fx.density

    _n.copy(normal || UP)
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0)
    _n.normalize()
    // tangent basis for cone sampling
    _t.set(_n.z, _n.x, _n.y).cross(_n)
    if (_t.lengthSq() < 1e-5) _t.set(1, 0, 0)
    _t.normalize()
    _b.crossVectors(_n, _t).normalize()

    const px = position.x + _n.x * 0.02
    const py = position.y + _n.y * 0.02
    const pz = position.z + _n.z * 0.02

    const p = ptc.begin()

    // --- 1. contact flash ----------------------------------------------------
    p.x = px; p.y = py; p.z = pz
    p.life = 0.055
    p.size0 = S.flashSize * scl * power
    p.size1 = S.flashSize * 1.9 * scl * power
    p.sizeCurve = 0.5
    p.fadeIn = 0.001
    p.tint2(S.flash[0], S.flash[1], S.flash[2], 1, 0, 0, 0, 0)
    ptc.emit('glow')

    if (S.ring) {
      // metal gets a flat impact star as well as the glow
      p.reset()
      p.x = px; p.y = py; p.z = pz
      p.life = 0.07
      p.size0 = 0.16 * scl
      p.size1 = 0.42 * scl
      p.rot = Math.random() * 6.283
      p.frame = 0
      p.frameRate = 4 / 0.07
      p.fadeIn = 0.001
      p.tint2(2.8, 2.4, 1.8, 1, 1.2, 0.6, 0.2, 0)
      ptc.emit('flash')
    }

    // --- 2a. dust cone along the normal -------------------------------------
    const nd = Math.round(S.dust * d * power)
    for (let i = 0; i < nd; i++) {
      p.reset()
      const a = Math.random() * Math.PI * 2
      const spread = Math.pow(Math.random(), 0.6) * 0.95
      const sp = S.dustSpeed[0] + Math.random() * (S.dustSpeed[1] - S.dustSpeed[0])
      const dx = _n.x + (_t.x * Math.cos(a) + _b.x * Math.sin(a)) * spread
      const dy = _n.y + (_t.y * Math.cos(a) + _b.y * Math.sin(a)) * spread
      const dz = _n.z + (_t.z * Math.cos(a) + _b.z * Math.sin(a)) * spread
      p.x = px; p.y = py; p.z = pz
      p.vx = dx * sp; p.vy = dy * sp + 0.3; p.vz = dz * sp
      p.drag = 3.6 + Math.random() * 2.5
      p.gravity = -1.1
      p.life = 0.45 + Math.random() * 0.75
      p.size0 = S.dustSize[0] * scl
      p.size1 = S.dustSize[1] * scl * (0.7 + Math.random() * 0.7) * power
      p.sizeCurve = 0.55
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 2.2
      p.frame = Math.random() * 16
      p.frameRate = 7
      p.turb = 0.16
      p.fadeIn = 0.05
      const v = 0.85 + Math.random() * 0.3
      p.tint2(S.dustTint[0] * v, S.dustTint[1] * v, S.dustTint[2] * v, 0.55,
              S.dustTint[0] * 0.6, S.dustTint[1] * 0.6, S.dustTint[2] * 0.6, 0)
      ptc.emit('dust')
    }

    // --- 2b. chips / splinters / shards -------------------------------------
    const nc = Math.round(S.chips * d * power)
    for (let i = 0; i < nc; i++) {
      p.reset()
      const a = Math.random() * Math.PI * 2
      const spread = 0.25 + Math.random() * 0.85
      const sp = 2.5 + Math.random() * 7.5 * power
      p.x = px; p.y = py; p.z = pz
      p.vx = (_n.x + (_t.x * Math.cos(a) + _b.x * Math.sin(a)) * spread) * sp
      p.vy = (_n.y + (_t.y * Math.cos(a) + _b.y * Math.sin(a)) * spread) * sp + 1.5
      p.vz = (_n.z + (_t.z * Math.cos(a) + _b.z * Math.sin(a)) * spread) * sp
      p.drag = 1.2
      p.gravity = -16
      p.life = 0.5 + Math.random() * 0.7
      p.size0 = S.chipSize * scl * (0.6 + Math.random() * 0.9)
      p.size1 = p.size0 * (S.chipLong ? 1.0 : 0.9)
      p.rot = Math.random() * 6.283
      p.rotVel = (Math.random() - 0.5) * 22
      p.frame = Math.floor(Math.random() * 16)
      p.fadeIn = 0.002
      const v = 0.75 + Math.random() * 0.5
      const shine = S.chipShiny ? 1.9 : 1
      p.tint2(S.chipTint[0] * v * shine, S.chipTint[1] * v * shine, S.chipTint[2] * v * shine, 1,
              S.chipTint[0] * v * 0.5, S.chipTint[1] * v * 0.5, S.chipTint[2] * v * 0.5, 0)
      ptc.emit('chip')
    }

    // --- 2c. sparks (metal / glass) -----------------------------------------
    const ns = Math.round(S.sparks * d * power)
    for (let i = 0; i < ns; i++) {
      p.reset()
      const a = Math.random() * Math.PI * 2
      // metal sparks hug the surface: wide cone around the normal, not a ball
      const spread = 0.7 + Math.random() * 1.5
      const sp = 4 + Math.random() * 13 * power
      p.x = px; p.y = py; p.z = pz
      p.vx = (_n.x * 0.6 + (_t.x * Math.cos(a) + _b.x * Math.sin(a)) * spread) * sp
      p.vy = (_n.y * 0.6 + (_t.y * Math.cos(a) + _b.y * Math.sin(a)) * spread) * sp
      p.vz = (_n.z * 0.6 + (_t.z * Math.cos(a) + _b.z * Math.sin(a)) * spread) * sp
      p.drag = 2.2 + Math.random() * 2.5
      p.gravity = -13
      p.life = 0.22 + Math.random() * 0.75
      p.size0 = (0.022 + Math.random() * 0.022) * scl
      p.size1 = p.size0 * 0.3
      p.stretch = 0.020
      p.frame = 0
      p.fadeIn = 0.001
      const heat = 0.8 + Math.random() * 0.6
      p.tint2(3.8 * heat, 2.3 * heat, 0.75 * heat, 1, 2.2, 0.45, 0.06, 0)
      ptc.emit('spark')
    }

    // --- 3. decal ------------------------------------------------------------
    if (S.decal) fx.addDecal(S.decal, position, _n, S.decalScale * (0.75 + Math.random() * 0.6) * power)

    // --- 4. settling debris --------------------------------------------------
    const nk = Math.round((S.chunks || 0) * d * power)
    if (nk > 0 && debris) {
      const g = fx.groundY(position.x, position.z)
      for (let i = 0; i < nk; i++) {
        const a = Math.random() * Math.PI * 2
        const spread = 0.4 + Math.random()
        const sp = 2.5 + Math.random() * 4.5
        debris.chunks.spawn(
          px, py, pz,
          (_n.x + (_t.x * Math.cos(a) + _b.x * Math.sin(a)) * spread) * sp,
          (_n.y + (_t.y * Math.cos(a) + _b.y * Math.sin(a)) * spread) * sp + 2.5,
          (_n.z + (_t.z * Math.cos(a) + _b.z * Math.sin(a)) * spread) * sp,
          S.chunkSize * (0.6 + Math.random() * 0.9), g, S.chunkTint
        )
      }
    }

    // metal impacts throw enough light to register
    if (S.sparks > 10 && fx.quality !== 'low') {
      lights.flash(position, [1.0, 0.78, 0.42], 7 * fx.lightScale, 4, 0.10, 2.4, 0)
    }
  }

  return { impact, inferSurface: (o, p) => inferSurface(fx.ctx, o, p) }
}
