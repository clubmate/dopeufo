/**
 * `?fxtest=1` demo reel. Never loads in the real game — index.js only imports
 * this module when the URL param is present.
 *
 * By default it stands up a dedicated, properly lit showcase stage 40 m above
 * the battlefield and parks the camera on it, so effects can be judged against
 * known surfaces (concrete / brick / metal / wood / a body) without the
 * generated level's composition getting in the way. `?fxstage=0` runs the same
 * reel down in the live level instead.
 *
 * Automation hooks:
 *   __FXDEMO.play('explosion')   fire one scene immediately
 *   __FXDEMO.loop(false)         freeze the reel
 *   ?fxscene=explosion           run one scene on a short loop
 *   ?fxperiod=2.5                that loop's period
 *   ?fxview=close|wide           camera framing
 */
import * as THREE from 'three'

// --- tiny procedural surface textures for the stage -------------------------

function noiseCanvas(size, fn) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const img = g.createImageData(size, size)
  const d = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) fn(x / size, y / size, d, (y * size + x) * 4)
  }
  g.putImageData(img, 0, 0)
  return c
}
function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let fx = x - ix, fy = y - iy
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s)
  const m = a + (b - a) * fx
  return m + ((c + (d - c) * fx) - m) * fy
}
function fbm(x, y, s, o = 5) {
  let v = 0, a = 0.5, f = 1, t = 0
  for (let i = 0; i < o; i++) { v += vnoise(x * f, y * f, s + i * 13) * a; t += a; a *= 0.5; f *= 2 }
  return v / t
}
function surfaceTex(kind, repeat) {
  const cv = noiseCanvas(256, (u, v, d, i) => {
    let r, g, b
    if (kind === 'ground') {
      const big = fbm(u * 5, v * 5, 3, 5)
      const grit = fbm(u * 70, v * 70, 9, 2)
      const crack = Math.abs(fbm(u * 8, v * 8, 21, 4) - 0.5)
      const c = 0.30 + big * 0.22 + grit * 0.10 - (crack < 0.03 ? 0.17 : 0)
      const stain = fbm(u * 3 + 5, v * 3, 41, 4)
      r = c * (0.99 + stain * 0.10); g = c * (0.97 + stain * 0.05); b = c * (0.93 + stain * 0.01)
    } else if (kind === 'concrete') {
      const n = fbm(u * 7, v * 7, 77, 5), g2 = fbm(u * 55, v * 55, 33, 2)
      const c = 0.46 + n * 0.36 + g2 * 0.13
      r = c * 0.80; g = c * 0.79; b = c * 0.75
    } else if (kind === 'brick') {
      const row = Math.floor(v * 12)
      const off = (row % 2) * 0.5
      const bx = (u * 6 + off) % 1, by = (v * 12) % 1
      const mortar = (bx < 0.045 || bx > 0.955 || by < 0.09 || by > 0.91) ? 1 : 0
      const n = fbm(u * 30, v * 30, 15, 3)
      const c = mortar ? 0.42 + n * 0.16 : 0.42 + n * 0.42
      r = mortar ? c * 0.72 : c * 0.86; g = mortar ? c * 0.70 : c * 0.42; b = mortar ? c * 0.66 : c * 0.31
    } else if (kind === 'wood') {
      const grain = fbm(u * 3, v * 42, 61, 4)
      const plank = Math.abs(((v * 5) % 1) - 0.5) > 0.46 ? 0.55 : 1
      const c = (0.36 + grain * 0.5) * plank
      r = c * 0.85; g = c * 0.60; b = c * 0.34
    } else {
      const scratch = fbm(u * 4, v * 90, 91, 3)
      const patch = fbm(u * 6, v * 6, 12, 4)
      const c = 0.45 + patch * 0.30 + scratch * 0.22
      r = c * 0.72; g = c * 0.77; b = c * 0.80
    }
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = 255
  })
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeat, repeat)
  t.anisotropy = 8
  return t
}

export function createDemo(ctx, api, fx, params) {
  const THREE_ = ctx.THREE || THREE
  const disposables = []
  const stage = new THREE_.Group()
  stage.name = 'fx.demoStage'

  const useStage = params.get('fxstage') !== '0'
  const BASE = useStage ? parseFloat(params.get('fxstagey') || '40') : fx.groundY(0, -2)
  stage.position.y = useStage ? BASE : 0

  let hasLight = false
  ctx.scene.traverse((o) => { if (o.isLight && o.intensity > 0.01) hasLight = true })

  if (!hasLight) {
    ctx.scene.background = new THREE_.Color(0x0d1420)
    if (!ctx.scene.fog) ctx.scene.fog = new THREE_.Fog(0x18222f, 30, 120)
    const hemi = new THREE_.HemisphereLight(0x8fb8ff, 0x2b2418, 0.9)
    stage.add(hemi)
    const sun = new THREE_.DirectionalLight(0xffe2bc, 2.6)
    sun.position.set(-16, 22, 12)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 80
    sun.shadow.camera.left = -24
    sun.shadow.camera.right = 24
    sun.shadow.camera.top = 24
    sun.shadow.camera.bottom = -24
    sun.shadow.bias = -0.0009
    stage.add(sun, sun.target)
    const fill = new THREE_.DirectionalLight(0x5f86c0, 0.45)
    fill.position.set(14, 9, -12)
    stage.add(fill)
  }

  if (useStage) {
    const tG = surfaceTex('ground', 12)
    const tC = surfaceTex('concrete', 2)
    const tB = surfaceTex('brick', 2)
    const tW = surfaceTex('wood', 1)
    const tM = surfaceTex('metal', 2)
    disposables.push(tG, tC, tB, tW, tM)

    const ground = new THREE_.Mesh(
      new THREE_.PlaneGeometry(70, 70),
      new THREE_.MeshStandardMaterial({ map: tG, roughness: 0.96, metalness: 0 })
    )
    ground.name = 'demo_concrete_ground'
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    stage.add(ground)

    const mats = {
      concrete: new THREE_.MeshStandardMaterial({ map: tC, roughness: 0.94, metalness: 0 }),
      brick: new THREE_.MeshStandardMaterial({ map: tB, roughness: 0.95, metalness: 0 }),
      wood: new THREE_.MeshStandardMaterial({ map: tW, roughness: 0.8, metalness: 0 }),
      metal: new THREE_.MeshStandardMaterial({ map: tM, roughness: 0.30, metalness: 0.92 }),
    }
    for (const k in mats) { mats[k].name = k; disposables.push(mats[k]) }

    const box = (w, h, d, x, y, z, mat, name) => {
      const m = new THREE_.Mesh(new THREE_.BoxGeometry(w, h, d), mats[mat])
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      m.name = name
      stage.add(m)
      return m
    }
    box(16, 3.6, 0.8, -1.0, 1.8, -8.6, 'concrete', 'demo_concrete_wall')
    box(5.0, 2.4, 0.7, -9.8, 1.2, -5.0, 'brick', 'demo_brick_wall')
    box(2.8, 2.6, 6.4, 8.2, 1.3, -3.2, 'metal', 'demo_metal_container')
    box(1.4, 1.4, 1.4, -4.4, 0.7, -2.2, 'wood', 'demo_wood_crate')
    box(1.15, 1.15, 1.15, -3.3, 0.575, -3.5, 'wood', 'demo_wood_crate2')
    box(1.4, 1.4, 1.4, -4.5, 2.1, -2.3, 'wood', 'demo_wood_crate3')
    box(4.4, 1.05, 0.7, 2.2, 0.525, -0.6, 'concrete', 'demo_concrete_cover')
    box(0.5, 0.5, 6.0, -7.2, 0.25, -1.0, 'concrete', 'demo_concrete_kerb')

    for (let i = 0; i < 3; i++) {
      const b = new THREE_.Mesh(
        new THREE_.CylinderGeometry(0.36, 0.36, 0.96, 18),
        new THREE_.MeshStandardMaterial({ color: [0x7d4326, 0x3a5b46, 0x6a5228][i], roughness: 0.5, metalness: 0.65 })
      )
      b.position.set(5.2 + i * 0.92, 0.48, 1.8 - i * 0.55)
      b.castShadow = true; b.receiveShadow = true
      b.name = 'demo_metal_barrel'
      stage.add(b)
      disposables.push(b.material)
    }
    const dummy = new THREE_.Mesh(
      new THREE_.CapsuleGeometry(0.33, 1.10, 6, 14),
      new THREE_.MeshStandardMaterial({ color: 0x3b444e, roughness: 0.72, metalness: 0.12 })
    )
    dummy.position.set(1.2, 1.0, -4.4)
    dummy.castShadow = true
    dummy.name = 'demo_target_dummy'
    stage.add(dummy)
    disposables.push(dummy.material)
  }

  ctx.scene.add(stage)

  // The HUD is not what we are judging here — hide it unless asked for.
  if (params.get('fxhud') !== '1') {
    const st = document.createElement('style')
    st.id = 'fx-demo-hide-hud'
    st.textContent = 'body > *:not(#app):not(#fx-stats), #app > *:not(#view) { display:none !important }'
    document.head.appendChild(st)
    disposables.push({ dispose: () => st.remove() })
  }
  fx.ctx.fx?.setAmbientBase?.(BASE)
  api.setAmbientBase?.(BASE)

  // --- shake receiver (the input module owns this in the real game) ---------
  const shake = { i: 0, t: 0, d: 0.3 }
  const shakeOff = new THREE_.Vector3()
  const offShake = ctx.bus.on('camera:shake', (e) => {
    shake.i = Math.max(shake.i, e.intensity || 0)
    shake.d = Math.max(shake.d, e.duration || 0.3)
    shake.t = 0
  })

  // --- camera ---------------------------------------------------------------
  // The input module owns the camera, so the override is re-registered on
  // `game:ready`: by then every other updater is in the list and ours lands last.
  const LOOK = new THREE_.Vector3(-0.3, BASE + 1.4, -2.6)
  const camPos = new THREE_.Vector3(12.0, BASE + 17.0, 14.0)
  if (params.get('fxview') === 'wide') camPos.set(19, BASE + 27, 22)
  if (params.get('fxview') === 'close') camPos.set(7.5, BASE + 10.5, 8.5)
  const camOn = params.get('fxcam') !== '0'

  function poseCamera() {
    ctx.camera.position.copy(camPos).add(shakeOff)
    ctx.camera.lookAt(LOOK)
  }
  let camOff = null
  if (camOn) {
    poseCamera()
    ctx.bus.once('game:ready', () => { camOff = ctx.onUpdate(poseCamera) })
  }

  // --- anchors --------------------------------------------------------------
  const V = (x, y, z) => new THREE_.Vector3(x, BASE + y, z)
  const dray = new THREE_.Raycaster()
  dray.camera = ctx.camera
  const _d = new THREE_.Vector3()
  function snap(from, to) {
    _d.subVectors(to, from)
    const len = _d.length() || 1
    _d.divideScalar(len)
    dray.set(from, _d)
    dray.far = len * 1.8 + 6
    let hits = []
    try { hits = dray.intersectObjects(ctx.scene.children, true) } catch { return to.clone() }
    for (const h of hits) {
      if (!h.object.visible || h.object.isSprite) continue
      let p = h.object, skip = false
      while (p) { if (p.userData?.fxIgnore) { skip = true; break } p = p.parent }
      if (skip) continue
      return h.point.clone().addScaledVector(_d, -0.05)
    }
    return to.clone()
  }

  const SHOOTER = V(-5.8, 1.42, 6.0)
  const SHOOTER2 = V(6.4, 1.42, 5.2)
  const WALL = snap(SHOOTER, V(-1.0, 1.9, -8.2))
  const CONTAINER = snap(SHOOTER2, V(6.8, 1.6, -1.0))
  const CRATE = snap(SHOOTER, V(-4.4, 1.1, -1.5))
  const BRICK = snap(SHOOTER, V(-9.8, 1.5, -4.7))
  const DUMMY = V(1.2, 1.25, -4.4)
  const BOOM = V(-0.8, 0.35, -3.2)
  const BOOM2 = V(2.4, 0.5, -3.4)
  const BOOM3 = V(-3.6, 0.6, -5.4)
  const SMOKE = V(3.4, 0.0, -0.2)

  function shootAt(from, to, weapon, hit, shots = 1, targetId = null) {
    for (let i = 0; i < shots; i++) {
      fx.schedule(i * 0.085, () => api.fireShot(from, to, { weapon, hit, targetId }))
    }
  }

  const scenes = {
    burst() { shootAt(SHOOTER, WALL, 'rifle', true, 3) },
    miss() { shootAt(SHOOTER, DUMMY, 'rifle', false, 3, 'dummy') },
    sniper() { shootAt(SHOOTER2, CONTAINER, 'sniper', true, 1) },
    shotgun() { shootAt(SHOOTER, CRATE, 'shotgun', true, 1) },
    smgburst() { shootAt(SHOOTER2, WALL, 'smg', true, 5) },
    blood() { shootAt(SHOOTER, DUMMY, 'rifle', true, 2, 'dummy') },
    spall() {
      const d = new THREE_.Vector3().subVectors(DUMMY, SHOOTER2).normalize()
      api.muzzleFlash(SHOOTER2, d, 'rifle')
      fx.schedule(0.14, () => api.spall(DUMMY, d, 1))
    },
    death() {
      api.blood(DUMMY, new THREE_.Vector3(0.3, 0.2, -1).normalize(), 1.9)
      fx.schedule(0.5, () => api.blood(V(1.2, 0.3, -4.4), new THREE_.Vector3(0.4, 0.1, -0.8).normalize(), 1.2))
    },
    grenade() { api.grenade(V(SHOOTER.x, 1.5, SHOOTER.z), BOOM, { radius: 3.4 }) },
    explosion() { api.explosion(BOOM, 3.6) },
    bigexplosion() { api.explosion(BOOM2, 6.2) },
    plasma() { api.explosion(BOOM3, 4.2, { kind: 'plasma' }) },
    smoke() { api.smoke(SMOKE, 3.4, 11) },
    impacts() {
      const pts = [
        [WALL, new THREE_.Vector3(0, 0, 1), 'concrete'],
        [CONTAINER, new THREE_.Vector3(1, 0, 0), 'metal'],
        [CRATE, new THREE_.Vector3(0, 0, 1), 'wood'],
        [BRICK, new THREE_.Vector3(1, 0, 0.3).normalize(), 'brick'],
        [V(-1.0, 0.02, 1.4), new THREE_.Vector3(0, 1, 0), 'dirt'],
        [V(1.2, 0.02, 2.4), new THREE_.Vector3(0, 1, 0), 'sand'],
        [V(-3.2, 0.02, 2.2), new THREE_.Vector3(0, 1, 0), 'glass'],
      ]
      pts.forEach((p, i) => fx.schedule(i * 0.09, () => api.impact(p[0], p[1], p[2])))
    },
  }

  const REEL = [
    [0.15, 'burst'],
    [1.10, 'sniper'],
    [1.75, 'shotgun'],
    [2.50, 'blood'],
    [3.35, 'impacts'],
    [4.55, 'grenade'],
    [6.40, 'smgburst'],
    [7.30, 'miss'],
    [8.20, 'smoke'],
    [9.40, 'bigexplosion'],
    [10.90, 'spall'],
    [11.60, 'burst'],
    [12.60, 'plasma'],
    [13.60, 'death'],
    [14.40, 'sniper'],
  ]
  const PERIOD = 16

  const single = params.get('fxscene')
  let clock = 0
  let cursor = 0
  let looping = params.get('fxloop') !== '0'
  const singlePeriod = parseFloat(params.get('fxperiod') || '3.0')

  if (single && scenes[single]) scenes[single]()

  const off = ctx.onUpdate((dt) => {
    if (looping) {
      const prev = clock
      clock += dt
      if (single) {
        if (scenes[single] && Math.floor(clock / singlePeriod) !== Math.floor(prev / singlePeriod)) scenes[single]()
      } else {
        while (cursor < REEL.length && REEL[cursor][0] <= clock) {
          const name = REEL[cursor][1]
          cursor++
          try { scenes[name]?.() } catch (err) { console.error('[fx demo]', name, err) }
        }
        if (clock >= PERIOD) { clock = 0; cursor = 0 }
      }
    }
    if (shake.i > 0) {
      shake.t += dt
      const k = shake.t / shake.d
      if (k >= 1) { shake.i = 0; shakeOff.set(0, 0, 0) } else {
        const a = shake.i * (1 - k) * (1 - k) * 0.7
        shakeOff.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a)
      }
    }
  })

  window.__FXDEMO = {
    scenes, anchors: { SHOOTER, SHOOTER2, WALL, CONTAINER, CRATE, DUMMY, BOOM, BOOM2, SMOKE },
    play(n) { scenes[n]?.() },
    loop(v) { looping = !!v },
    seek(t) { clock = t; cursor = 0 },
    list: Object.keys(scenes),
  }

  return function stop() {
    off()
    offShake()
    camOff?.()
    ctx.scene.remove(stage)
    stage.traverse((o) => { o.geometry?.dispose?.() })
    for (const d of disposables) d.dispose?.()
    delete window.__FXDEMO
  }
}
