/**
 * Soldier asset pipeline: GLB loading, material construction, instancing.
 *
 * Geometry is authored in Blender (see src/units/blender/) and exported as one
 * skinned mesh per team+class, plus a single animation-only GLB whose clips are
 * retargeted by bone name onto every variant. Weapons are separate static GLBs
 * parented straight to the `weapon` bone — the Blender grip space and the glTF
 * +Y-up conversion line up exactly, so no fudge transform is needed.
 *
 * One material covers the whole body (palette atlas on UV0, tiling detail
 * normal on UV1, baked crevice dirt + edge wear in COLOR_0) and one more covers
 * visor glass, so a soldier costs two draw calls plus one for the weapon.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import {
  TEAMS, CLASSES, WEAPONS, DEFAULT_CLASS,
  paletteMap, ormMap, detailNormalMap,
} from './loadout.js'

const BASE = 'models/'
const loader = new GLTFLoader()

const _charCache = new Map()
const _wpnCache = new Map()
const _mats = new Map()
let _clipsPromise = null

function url(name) {
  const b = (import.meta?.env?.BASE_URL) || '/'
  return `${b}${BASE}${name}.glb`.replace(/([^:])\/\//g, '$1/')
}

function loadGLB(name) {
  return new Promise((resolve, reject) => {
    loader.load(url(name), resolve, undefined, reject)
  })
}

// ----------------------------------------------------------------- materials -
/**
 * @param {number} team
 * @param {object} ctx  engine context — ctx.materials may not exist yet, so
 *                      every read is optional and falls back to sane defaults.
 */
export function teamMaterials(team, ctx) {
  const key = `t${team}`
  if (_mats.has(key)) return _mats.get(key)

  const envInt = ctx?.materials?.envMapIntensity ?? 1.0
  const detail = detailNormalMap()
  const orm = ormMap()

  const body = new THREE.MeshStandardMaterial({
    name: `soldier_body_t${team}`,
    map: paletteMap(team),
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1.0,
    metalness: 1.0,
    normalMap: detail,
    normalScale: new THREE.Vector2(0.55, 0.55),
    vertexColors: true,
    envMapIntensity: envInt,
    dithering: true,
  })
  // the detail normal rides the smart-projected second UV set
  if ('channel' in body.normalMap) body.normalMap.channel = 1

  const glass = new THREE.MeshStandardMaterial({
    name: `soldier_glass_t${team}`,
    color: new THREE.Color(TEAMS[team]?.colors?.[15] || '#0a1a24'),
    roughness: 0.08,
    metalness: 0.55,
    transparent: true,
    opacity: 0.72,
    envMapIntensity: envInt * 1.8,
    depthWrite: false,
  })

  const pair = { body, glass }
  _mats.set(key, pair)
  return pair
}

// ------------------------------------------------------------------ loading --
export function loadClips() {
  if (!_clipsPromise) {
    _clipsPromise = loadGLB('soldier_anims')
      .then((g) => g.animations || [])
      .catch((err) => {
        console.warn('[units] animation library failed to load', err)
        return []
      })
  }
  return _clipsPromise
}

export function loadCharacter(team, className) {
  const cls = CLASSES[className] ? className : DEFAULT_CLASS
  const t = team === 1 ? 1 : 0
  const key = `${t}:${cls}`
  if (!_charCache.has(key)) {
    const p = loadGLB(`soldier_t${t}_${CLASSES[cls].file}`)
      .then((g) => {
        g.scene.updateMatrixWorld(true)
        return g.scene
      })
      .catch((err) => {
        console.warn(`[units] character ${key} failed to load`, err)
        return null
      })
    _charCache.set(key, p)
  }
  return _charCache.get(key)
}

export function loadWeapon(id) {
  const def = WEAPONS[id]
  if (!def) return Promise.resolve(null)
  if (!_wpnCache.has(id)) {
    _wpnCache.set(
      id,
      loadGLB(def.file)
        .then((g) => g.scene)
        .catch((err) => {
          console.warn(`[units] weapon ${id} failed to load`, err)
          return null
        })
    )
  }
  return _wpnCache.get(id)
}

/** Warm the caches for everything a match will need. */
export function preload(teams = [0, 1], classes = Object.keys(CLASSES)) {
  const jobs = [loadClips()]
  for (const t of teams) for (const c of classes) jobs.push(loadCharacter(t, c))
  for (const id of new Set(Object.values(CLASSES).map((c) => c.weapon))) {
    jobs.push(loadWeapon(id))
  }
  return Promise.all(jobs)
}

// ---------------------------------------------------------------- assembling -
function applyMaterials(root, mats) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return
    const src = o.material
    const list = Array.isArray(src) ? src : [src]
    const mapped = list.map((m) => (m && /glass/i.test(m.name || '') ? mats.glass : mats.body))
    o.material = Array.isArray(src) ? mapped : mapped[0]
    o.castShadow = true
    o.receiveShadow = true
    // skinned bounds are computed from the rest pose; a deep death animation
    // would otherwise pop out of frustum
    o.frustumCulled = false
    if (o.geometry && !o.geometry.attributes.uv1 && o.geometry.attributes.uv2) {
      o.geometry.setAttribute('uv1', o.geometry.attributes.uv2)
    }
  })
}

/**
 * Build one renderable soldier.
 * @returns {{root:THREE.Group, model:THREE.Object3D, mesh:THREE.SkinnedMesh}}
 */
export function instantiate(source, team, className, ctx) {
  const mats = teamMaterials(team, ctx)
  const model = skeletonClone(source)
  applyMaterials(model, mats)

  // Blender authors the soldier facing +Y, which the glTF conversion turns into
  // -Z. The wrapper spins it so facing 0 == +Z, matching the grid contract.
  model.rotation.y = Math.PI
  const s = CLASSES[className]?.scale ?? 1
  model.scale.setScalar(s)

  const root = new THREE.Group()
  root.name = 'unit'
  root.add(model)

  let mesh = null
  model.traverse((o) => {
    if (o.isSkinnedMesh && !mesh) mesh = o
  })
  return { root, model, mesh }
}

export function attachWeapon(bone, weaponScene) {
  if (!bone || !weaponScene) return null
  const w = weaponScene.clone(true)
  w.name = 'weapon_mesh'
  bone.add(w)
  return w
}

export function styleWeapon(weaponRoot, team, ctx) {
  if (!weaponRoot) return
  const mats = teamMaterials(team, ctx)
  applyMaterials(weaponRoot, mats)
}

export function disposeAssets() {
  for (const { body, glass } of _mats.values()) {
    body.dispose()
    glass.dispose()
  }
  _mats.clear()
  _charCache.clear()
  _wpnCache.clear()
  _clipsPromise = null
}
