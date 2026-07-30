import * as THREE from 'three'
import { createMaterials } from './materials.js'
import { createSky } from './sky.js'
import { createLighting } from './lighting.js'
import { createPostFX } from './postfx.js'

/**
 * render/ — lighting, atmosphere, post stack and the shared material library.
 *
 * Boot order inside this module matters:
 *   materials -> registered first, because world/ and units/ init right after us
 *                and build meshes synchronously against ctx.materials.
 *   sky       -> owns scene.environment (PMREM IBL) and scene.fog.
 *   lighting  -> drives the sky's sun angle, so it must come after sky.
 *   postfx    -> assigned to ctx.composer; engine renders through it.
 *
 * Everything is wrapped so a failure in one stage still leaves the others up:
 * losing bloom must never cost us the material library.
 */

const DEFAULT_PRESET = 'dusk'

export async function init(ctx) {
  const params = new URLSearchParams(location.search)
  const t0 = performance.now()

  // --- 1. material library -------------------------------------------------
  let materials = null
  try {
    materials = await createMaterials(ctx)
  } catch (err) {
    console.error('[render] material library failed', err)
  }
  if (materials) ctx.register('materials', materials)

  // --- 2. sky + IBL --------------------------------------------------------
  let sky = null
  try {
    sky = createSky(ctx)
  } catch (err) {
    console.error('[render] sky failed', err)
  }

  // --- 3. lighting rig -----------------------------------------------------
  let lighting = null
  try {
    lighting = createLighting(ctx, sky)
    const preset = params.get('preset')
    lighting.setPreset(lighting.presetData[preset] ? preset : DEFAULT_PRESET)
  } catch (err) {
    console.error('[render] lighting failed', err)
  }

  // --- 4. post stack -------------------------------------------------------
  let post = null
  try {
    post = createPostFX(ctx)
    ctx.composer = post.composer
  } catch (err) {
    console.error('[render] post stack failed — rendering direct', err)
    ctx.composer = null
  }

  // --- 5. optional self-test scene ----------------------------------------
  let testScene = null
  if (params.get('rendertest')) {
    try {
      testScene = buildRenderTest(ctx, materials)
    } catch (err) {
      console.error('[render] rendertest scene failed', err)
    }
  }

  const api = {
    materials,
    sky,
    lighting,
    post,
    testScene,

    /** Swap the whole look: 'dusk' | 'dawn' | 'noon' | 'overcast' | 'night'. */
    setPreset(name) {
      lighting?.setPreset(name)
      return api
    },
    get preset() {
      return lighting?.preset ?? null
    },
    get presets() {
      return lighting?.presets ?? []
    },

    /** Live tuning handles for the art-direction loop. */
    get params() {
      return {
        post: post?.params,
        sky: sky?.params,
        light: lighting?.state,
      }
    },
    setEnabled(pass, on) {
      return post?.setEnabled(pass, on) ?? false
    },
    setExposure(v) {
      ctx.renderer.toneMappingExposure = v
      return api
    },

    dispose() {
      testScene?.dispose()
      post?.dispose()
      lighting?.dispose()
      sky?.dispose()
      materials?.dispose()
      ctx.composer = null
    },
  }

  ctx.register('render', api)
  if (typeof window !== 'undefined') window.__RENDER = api

  console.info(
    `[render] ready in ${(performance.now() - t0) | 0}ms — quality=${ctx.quality} preset=${api.preset} ` +
      `scans=${materials?.stats.scanned ?? 0} composer=${ctx.composer ? 'on' : 'off'}`
  )
  return api
}

// ---------------------------------------------------------------------------
// Render self-test. Only ever built behind ?rendertest=1 — the real game never
// sees any of this. It exists so lighting/material work can be judged before
// world/ and units/ land, and so regressions in the post stack are visible.
// ---------------------------------------------------------------------------

const TEST_CAMS = {
  iso: { pos: [20, 17.5, 20], look: [0, 1.2, 0] },
  hero: { pos: [26, 13, 26], look: [0, 1.4, 0] },
  low: { pos: [17, 5.2, 17], look: [-2, 2.6, -2] },
  close: { pos: [9, 6.2, 9], look: [-0.6, 1.2, -0.6] },
}

function buildRenderTest(ctx, materials) {
  const { scene, grid } = ctx
  const root = new THREE.Group()
  root.name = 'render:test'
  scene.add(root)

  // The test must be reproducible frame to frame, but world/ and input/ boot
  // after us and will both add geometry and seize the camera. Once everything
  // is up, hide anything that isn't ours and pin the camera. Registering the
  // updater last means it runs after the camera rig's and therefore wins.
  const camName = new URLSearchParams(location.search).get('cam') || 'iso'
  const camCfg = TEST_CAMS[camName] || TEST_CAMS.iso
  let stopCam = null
  const hideForeign = () => {
    for (const child of scene.children) {
      if (!child.name?.startsWith('render:')) child.visible = false
    }
  }
  const onReady = () => {
    hideForeign()
    // Hide the HUD too — this shot is about the render, not the interface.
    const style = document.createElement('style')
    style.id = 'render-test-hide-ui'
    style.textContent = 'body > *:not(#app){display:none!important}#app > *:not(#view){display:none!important}'
    document.head.appendChild(style)
    stopCam = ctx.onUpdate(() => {
      hideForeign() // other modules keep adding decals after boot
      ctx.camera.position.set(...camCfg.pos)
      ctx.camera.lookAt(...camCfg.look)
      ctx.camera.updateMatrixWorld()
    })
  }
  ctx.bus.on('game:ready', onReady)

  const disposables = []
  const geo = (g) => (disposables.push(g), g)
  const mat = (name, opts) =>
    materials ? materials.get(name, opts) : new THREE.MeshStandardMaterial({ color: 0x808080 })
  const matM = (name, w, h, opts) =>
    materials ? materials.forMeters(name, w, h, opts) : new THREE.MeshStandardMaterial({ color: 0x808080 })

  const W = grid.W * grid.TILE
  const H = grid.H * grid.TILE

  function add(mesh, x, y, z, { cast = true, receive = true } = {}) {
    mesh.position.set(x, y, z)
    mesh.castShadow = cast
    mesh.receiveShadow = receive
    root.add(mesh)
    return mesh
  }

  // --- ground: asphalt apron with a concrete pad ---------------------------
  const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(W * 1.9, H * 1.9, 1, 1)), matM('asphalt', W * 1.9, H * 1.9))
  ground.rotation.x = -Math.PI / 2
  add(ground, 0, -0.02, 0, { cast: false })

  const pad = new THREE.Mesh(geo(new THREE.BoxGeometry(W * 0.62, 0.35, H * 0.62)), matM('concrete', W * 0.62, H * 0.62))
  add(pad, 0, 0.155, 0)

  const dirtPatch = new THREE.Mesh(geo(new THREE.CircleGeometry(9, 48)), matM('dirt', 18, 18))
  dirtPatch.rotation.x = -Math.PI / 2
  add(dirtPatch, -16, 0.005, 12, { cast: false })

  const gravelPatch = new THREE.Mesh(geo(new THREE.CircleGeometry(7, 48)), matM('gravel', 14, 14))
  gravelPatch.rotation.x = -Math.PI / 2
  add(gravelPatch, 16, 0.005, -13, { cast: false })

  // --- material spheres: the honest PBR read -------------------------------
  const sphereGeo = geo(new THREE.SphereGeometry(0.9, 48, 32))
  // Laid out ALONG the sun azimuth, not across it: at an 18 degree sun each
  // sphere throws a ~5.5 m shadow, and a row spaced across the light just
  // shadows itself into a row of crescents.
  const showcase = materials ? materials.names : []
  showcase.forEach((name, i) => {
    const m = new THREE.Mesh(sphereGeo, mat(name, { repeat: 1.4 }))
    add(m, 7.5, 1.25, -15.5 + i * 3.1)
  })

  // --- cover props: what the game will actually be made of -----------------
  const crateGeo = geo(new THREE.BoxGeometry(1.7, 1.7, 1.7))
  const crateGeoLow = geo(new THREE.BoxGeometry(1.9, 1.05, 1.9))
  const crates = [
    ['plasticCrate', -6, 0.85, 2, 0.3],
    ['plasticCrate', -6, 2.55, 2, 0.9],
    ['weatheredWood', -3.4, 0.85, 3.6, -0.4],
    ['paintedMetal', 5.5, 0.85, 1.2, 0.15],
    ['rustedMetal', 7.6, 0.85, 3.4, -0.7],
  ]
  for (const [m, x, y, z, rot] of crates) {
    const mesh = new THREE.Mesh(crateGeo, mat(m, { repeat: 1 }))
    mesh.rotation.y = rot
    add(mesh, x, y + 0.33, z)
  }
  for (const [x, z, rot] of [
    [1.2, 6.4, 0.2],
    [-9.5, -3.2, -0.5],
  ]) {
    const mesh = new THREE.Mesh(crateGeoLow, mat('weatheredWood', { repeat: 1 }))
    mesh.rotation.y = rot
    add(mesh, x, 0.86, z)
  }

  // half-height sandbag wall — cover geometry, fabric material
  const bagGeo = geo(new THREE.CapsuleGeometry(0.34, 0.62, 6, 12))
  for (let i = 0; i < 14; i++) {
    const layer = (i / 7) | 0
    const k = i % 7
    const bag = new THREE.Mesh(bagGeo, mat('fabric', { repeat: [1.6, 0.55] }))
    bag.rotation.z = Math.PI / 2
    bag.rotation.y = 0.06 * Math.sin(i * 2.3)
    add(bag, -1.2 + k * 0.78 + layer * 0.36, 0.66 + layer * 0.62, -6.6 + layer * 0.05)
  }

  // brick wall with a glass pane — vertical surfaces catch the raking sun
  const wall = new THREE.Mesh(geo(new THREE.BoxGeometry(9, 4.2, 0.5)), matM('brick', 9, 4.2))
  wall.rotation.y = -0.22
  add(wall, 11, 2.43, 9)

  const pane = new THREE.Mesh(geo(new THREE.BoxGeometry(2.6, 1.9, 0.06)), mat('glass'))
  pane.rotation.y = -0.22
  add(pane, 10.2, 2.7, 8.72, { cast: false })

  const frame = new THREE.Mesh(geo(new THREE.BoxGeometry(2.9, 2.2, 0.12)), mat('rustedMetal', { repeat: 0.8 }))
  frame.rotation.y = -0.22
  add(frame, 10.2, 2.7, 8.66)

  // barrels
  const barrelGeo = geo(new THREE.CylinderGeometry(0.58, 0.58, 1.5, 24, 1))
  for (const [x, z, m, rot] of [
    [-13, -6, 'rustedMetal', 0.4],
    [-11.6, -7.4, 'paintedMetal', -0.9],
    [14, 4, 'rustedMetal', 1.2],
  ]) {
    const b = new THREE.Mesh(barrelGeo, mat(m, { repeat: [2, 1] }))
    b.rotation.y = rot
    add(b, x, 0.75 + 0.33, z)
  }

  // --- scale reference: a 1.8 m soldier proxy ------------------------------
  const soldier = new THREE.Group()
  const torso = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.26, 0.62, 8, 16)), mat('fabric', { repeat: 1.1 }))
  torso.position.y = 1.22
  const legs = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.22, 0.6, 8, 16)), mat('fabric', { repeat: 1.1, color: 0x6d6a58 }))
  legs.position.y = 0.5
  const head = new THREE.Mesh(geo(new THREE.SphereGeometry(0.19, 24, 16)), mat('paintedMetal', { repeat: 3 }))
  head.position.y = 1.72
  for (const p of [torso, legs, head]) {
    p.castShadow = true
    p.receiveShadow = true
    soldier.add(p)
  }
  soldier.position.set(2.6, 0.33, -1.5)
  root.add(soldier)

  const soldier2 = soldier.clone()
  soldier2.position.set(-4.6, 0.33, -3.2)
  soldier2.rotation.y = 1.1
  root.add(soldier2)

  return {
    root,
    camera: camCfg,
    dispose() {
      stopCam?.()
      ctx.bus.off('game:ready', onReady)
      document.getElementById('render-test-hide-ui')?.remove()
      scene.remove(root)
      for (const g of disposables) g.dispose()
    },
  }
}
