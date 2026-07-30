import * as THREE from 'three'
import { createTextureFactory } from './textures.js'

/**
 * Shared PBR material library.
 *
 * Two sources, in priority order:
 *   1. Real scanned PBR sets in /textures/render/ (Poly Haven, CC0) using the
 *      glTF-standard packing: colour + ARM (AO=r, Rough=g, Metal=b) + OpenGL
 *      normal. Three maps per material, three GPU textures, no duplication.
 *   2. Procedural bakes from textures.js — the guaranteed offline fallback.
 *      If the fetch fails, or the manifest is missing, the game still ships a
 *      fully textured world.
 *
 * Everything is cached by (name + variant key), so 400 crates in the world cost
 * one material and one shader program, not 400.
 *
 * Nothing in here is ever Basic or Lambert. Standard/Physical only.
 *
 * ALBEDO TINTS ARE WHITE, DELIBERATELY. `material.color` multiplies the diffuse
 * map. The scans already carry correct, measured albedo, so any tint here is a
 * second, unphysical multiplication: the old warm off-whites were pulling every
 * surface to 0.70-0.88 linear and dragging blue down to 0.41-0.72, which under
 * an already-orange dusk key stacked into a rust-coloured world with no shadow
 * detail left to read. If a surface needs recolouring, do it per-usage with
 * get(name, { color }) — never in the shared library.
 *
 * aoMapIntensity is 0.7, not 1. The ARM AO channel is baked cavity occlusion;
 * at full strength it multiplies the *entire* indirect term, and stacked on top
 * of screen-space GTAO it is what turns shadow interiors into mush.
 */

const MANIFEST_URL = '/textures/render/manifest.json'
const SCAN_TIMEOUT_MS = 9000

/**
 * tileMeters = the real-world size one UV tile of this texture covers. Lets
 * callers ask for a surface by physical size and get a correct texel density
 * instead of guessing repeat counts.
 */
const DEFS = {
  concrete: {
    scan: 'concrete',
    proc: 'concrete',
    tileMeters: 3.0,
    macro: 0.09,
    props: { roughness: 1, metalness: 0, envMapIntensity: 1, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  asphalt: {
    scan: 'asphalt',
    proc: 'asphalt',
    tileMeters: 4.2,
    macro: 0.12,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.9, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  rustedMetal: {
    scan: 'rustedMetal',
    proc: 'rustedMetal',
    tileMeters: 1.5,
    metal: true,
    props: { roughness: 1, metalness: 1, envMapIntensity: 3.2, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  paintedMetal: {
    scan: 'paintedMetal',
    proc: 'paintedMetal',
    tileMeters: 1.7,
    metal: true,
    props: { roughness: 1, metalness: 1, envMapIntensity: 3.2, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  weatheredWood: {
    scan: 'weatheredWood',
    proc: 'weatheredWood',
    tileMeters: 2.0,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.85, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  dirt: {
    scan: 'dirt',
    proc: 'dirt',
    tileMeters: 2.6,
    macro: 0.12,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.85, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  gravel: {
    scan: 'gravel',
    proc: 'gravel',
    tileMeters: 2.2,
    macro: 0.14,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.85, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  brick: {
    scan: 'brick',
    proc: 'brick',
    tileMeters: 2.0,
    macro: 0.10,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.9, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  fabric: {
    scan: 'fabric',
    proc: 'fabric',
    tileMeters: 0.75,
    props: { roughness: 1, metalness: 0, envMapIntensity: 0.75, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  plasticCrate: {
    proc: 'plasticCrate',
    tileMeters: 1.2,
    props: { roughness: 1, metalness: 0, envMapIntensity: 1.0, color: 0xffffff, aoMapIntensity: 0.7 },
  },
  glass: {
    proc: 'glass',
    tileMeters: 2.0,
    physical: true,
    props: {
      roughness: 1,
      metalness: 0,
      color: 0x9fb4c4,
      envMapIntensity: 1.6,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      reflectivity: 0.6,
      aoMapIntensity: 0.5,
    },
  },
}

/** Friendly aliases so callers guessing a name still get a real surface. */
const ALIASES = {
  metal: 'paintedMetal',
  steel: 'paintedMetal',
  rust: 'rustedMetal',
  wood: 'weatheredWood',
  plank: 'weatheredWood',
  stone: 'concrete',
  cement: 'concrete',
  ground: 'dirt',
  soil: 'dirt',
  road: 'asphalt',
  tarmac: 'asphalt',
  crate: 'plasticCrate',
  plastic: 'plasticCrate',
  sandbag: 'fabric',
  cloth: 'fabric',
  canvas: 'fabric',
  window: 'glass',
}

/**
 * Large surfaces are the giveaway: a 2 k texture repeated 14 times across a
 * battlefield reads as wallpaper no matter how good the scan is. This injects a
 * low-frequency world-space noise that modulates albedo and roughness, which is
 * what breaks the grid up in every shipped engine. Two octaves, both far larger
 * than the texture tile, so it never fights the surface detail.
 */
function applyMacroVariation(mat, amount = 0.22, rough = 0.12) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroAmount = { value: amount }
    shader.uniforms.uMacroRough = { value: rough }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMacroPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMacroPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMacroPos;
        uniform float uMacroAmount;
        uniform float uMacroRough;
        float mcHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
        float mcNoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(mcHash(i), mcHash(i + vec2(1.0, 0.0)), u.x),
                     mix(mcHash(i + vec2(0.0, 1.0)), mcHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        float mcMacro(vec3 wp){
          vec2 p = wp.xz + wp.y * 0.35;
          return mcNoise(p / 8.5) * 0.45 + mcNoise(p / 27.0) * 0.55;
        }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float mcM = mcMacro(vMacroPos);
        diffuseColor.rgb *= 1.0 + (mcM - 0.5) * uMacroAmount * 2.0;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (1.0 + (mcM - 0.5) * uMacroRough * 2.0), 0.02, 1.0);`
      )
  }
  mat.customProgramCacheKey = () => `macro${amount.toFixed(2)}_${rough.toFixed(2)}`
  return mat
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ])
}

export async function createMaterials(ctx) {
  const textures = createTextureFactory(ctx)
  const maxAniso = Math.min(8, ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4)
  const loader = new THREE.TextureLoader()

  const scanCache = new Map() // url -> Texture
  const matCache = new Map() // key -> Material
  const owned = new Set()
  let envIntensity = 1

  // --- scanned texture set loading ----------------------------------------
  let manifest = {}
  if (ctx.quality !== 'low') {
    try {
      const res = await withTimeout(fetch(MANIFEST_URL, { cache: 'force-cache' }), 4000, 'manifest')
      if (res.ok) manifest = await res.json()
    } catch (err) {
      console.warn('[render/materials] no scanned texture manifest, using procedural only', err.message)
    }
  }

  function loadScanTex(file, srgb) {
    const url = `/textures/render/${file}`
    if (scanCache.has(url)) return Promise.resolve(scanCache.get(url))
    return withTimeout(
      new Promise((resolve, reject) => {
        loader.load(
          url,
          (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
            t.anisotropy = maxAniso
            scanCache.set(url, t)
            owned.add(t)
            resolve(t)
          },
          undefined,
          () => reject(new Error(`failed ${url}`))
        )
      }),
      SCAN_TIMEOUT_MS,
      file
    )
  }

  /** { map, normalMap, roughnessMap, aoMap, metalnessMap } or null. */
  async function loadScanSet(key) {
    const entry = manifest[key]
    if (!entry?.maps?.diff) return null
    try {
      const [map, arm, nor] = await Promise.all([
        loadScanTex(entry.maps.diff, true),
        entry.maps.arm ? loadScanTex(entry.maps.arm, false) : Promise.resolve(null),
        entry.maps.nor ? loadScanTex(entry.maps.nor, false) : Promise.resolve(null),
      ])
      return { map, arm, normalMap: nor, source: 'scan', slug: entry.slug, res: entry.res }
    } catch (err) {
      console.warn(`[render/materials] scan set "${key}" incomplete — procedural fallback`, err.message)
      return null
    }
  }

  // Resolve every scan set up front so material creation stays synchronous for
  // callers (world/units build meshes in tight loops and must not await).
  const scanSets = new Map()
  const scanKeys = Object.values(DEFS)
    .map((d) => d.scan)
    .filter(Boolean)
  const loaded = await Promise.all(scanKeys.map((k) => loadScanSet(k)))
  scanKeys.forEach((k, i) => loaded[i] && scanSets.set(k, loaded[i]))

  const stats = {
    scanned: scanSets.size,
    procedural: 0,
    textureSize: textures.size,
  }

  // --- material construction ----------------------------------------------

  function resolveName(name) {
    if (DEFS[name]) return name
    if (ALIASES[name]) return ALIASES[name]
    return null
  }

  function cloneWithRepeat(tex, rx, ry) {
    if (!tex) return null
    if (rx === 1 && ry === 1) return tex
    // clone() shares the underlying Source, so this costs no extra VRAM.
    const t = tex.clone()
    t.repeat.set(rx, ry)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.needsUpdate = true
    owned.add(t)
    return t
  }

  function buildMaps(def, rx, ry) {
    const scan = def.scan ? scanSets.get(def.scan) : null
    if (scan) {
      const out = {
        map: cloneWithRepeat(scan.map, rx, ry),
        normalMap: cloneWithRepeat(scan.normalMap, rx, ry),
      }
      if (scan.arm) {
        const arm = cloneWithRepeat(scan.arm, rx, ry)
        out.aoMap = arm
        out.roughnessMap = arm
        if (def.metal) out.metalnessMap = arm
      }
      return out
    }
    stats.procedural++
    const p = textures.bake(def.proc)
    return {
      map: cloneWithRepeat(p.map, rx, ry),
      normalMap: cloneWithRepeat(p.normalMap, rx, ry),
      roughnessMap: cloneWithRepeat(p.roughnessMap, rx, ry),
      aoMap: cloneWithRepeat(p.aoMap, rx, ry),
      metalnessMap: def.metal && p.metalnessMap ? cloneWithRepeat(p.metalnessMap, rx, ry) : undefined,
    }
  }

  /**
   * @param {string} name  a DEFS key or alias
   * @param {object} [opts]
   * @param {number|[number,number]} [opts.repeat=1]  UV repeat
   * @param {number} [opts.color]     multiplier tint on the albedo
   * @param {number} [opts.roughness] override (multiplies the roughness map)
   * @param {number} [opts.metalness] override (multiplies the metalness map)
   * @param {number} [opts.normalScale]
   * @param {number} [opts.aoIntensity]
   * @param {number} [opts.emissive]
   * @param {number} [opts.emissiveIntensity]
   * @param {boolean} [opts.flatShading]
   * @param {THREE.Side} [opts.side]
   * @param {boolean} [opts.transparent]
   * @param {number} [opts.opacity]
   * @param {string} [opts.key] extra cache discriminator
   */
  function get(name, opts = {}) {
    const key = resolveName(name)
    if (!key) {
      console.warn(`[render/materials] unknown material "${name}" — falling back to concrete`)
      return get('concrete', opts)
    }
    const def = DEFS[key]
    const rep = opts.repeat ?? 1
    const rx = Array.isArray(rep) ? rep[0] : rep
    const ry = Array.isArray(rep) ? rep[1] : rep
    const cacheKey = [
      key,
      rx.toFixed(3),
      ry.toFixed(3),
      opts.color ?? '',
      opts.roughness ?? '',
      opts.metalness ?? '',
      opts.normalScale ?? '',
      opts.aoIntensity ?? '',
      opts.emissive ?? '',
      opts.emissiveIntensity ?? '',
      opts.side ?? '',
      opts.transparent ?? '',
      opts.opacity ?? '',
      opts.flatShading ?? '',
      opts.key ?? '',
    ].join('|')
    if (matCache.has(cacheKey)) return matCache.get(cacheKey)

    const maps = buildMaps(def, rx, ry)
    const Ctor = def.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial
    const params = { ...def.props, ...maps }
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k]

    const mat = new Ctor(params)
    mat.name = `mat:${key}`
    mat.envMapIntensity = (def.props.envMapIntensity ?? 1) * envIntensity
    if (maps.normalMap) mat.normalScale = new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1)
    if (opts.color !== undefined) mat.color = new THREE.Color(opts.color)
    if (opts.roughness !== undefined) mat.roughness = opts.roughness
    if (opts.metalness !== undefined) mat.metalness = opts.metalness
    if (opts.aoIntensity !== undefined) mat.aoMapIntensity = opts.aoIntensity
    if (opts.emissive !== undefined) mat.emissive = new THREE.Color(opts.emissive)
    if (opts.emissiveIntensity !== undefined) mat.emissiveIntensity = opts.emissiveIntensity
    if (opts.side !== undefined) mat.side = opts.side
    if (opts.transparent !== undefined) mat.transparent = opts.transparent
    if (opts.opacity !== undefined) mat.opacity = opts.opacity
    if (opts.flatShading) mat.flatShading = true
    mat.shadowSide = mat.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide

    const macro = opts.macro ?? def.macro
    if (macro) applyMacroVariation(mat, typeof macro === 'number' ? macro : 0.22)

    matCache.set(cacheKey, mat)
    owned.add(mat)
    return mat
  }

  /**
   * Same as get(), but the repeat is derived from the real-world size of the
   * surface so texel density stays consistent across the whole battlefield.
   * `get('concrete')` on a 40 m plane looks like a blurry smear; this doesn't.
   */
  function forMeters(name, widthM, heightM = widthM, opts = {}) {
    const key = resolveName(name) || 'concrete'
    const tm = DEFS[key].tileMeters || 2
    return get(key, { ...opts, repeat: [Math.max(0.25, widthM / tm), Math.max(0.25, heightM / tm)] })
  }

  function setEnvIntensity(v) {
    envIntensity = v
    for (const m of matCache.values()) {
      const def = DEFS[m.name.slice(4)]
      m.envMapIntensity = (def?.props?.envMapIntensity ?? 1) * v
      m.needsUpdate = false
    }
  }

  const api = {
    names: Object.keys(DEFS),
    aliases: ALIASES,
    defs: DEFS,
    stats,
    textures,
    get,
    forMeters,
    has: (n) => !!resolveName(n),
    tileMeters: (n) => DEFS[resolveName(n) || 'concrete'].tileMeters,
    setEnvIntensity,
    /** Bake every procedural set now (used by ?rendertest to avoid pop-in). */
    warm(names = Object.keys(DEFS)) {
      for (const n of names) {
        try {
          get(n)
        } catch (err) {
          console.warn('[render/materials] warm failed for', n, err)
        }
      }
      return api
    },
    dispose() {
      for (const o of owned) o.dispose?.()
      owned.clear()
      matCache.clear()
      scanCache.clear()
      textures.dispose()
    },
  }
  return api
}
