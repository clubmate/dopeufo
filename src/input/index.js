import * as THREE from 'three'
import { createCameraRig } from './camera.js'
import { createPicking } from './picking.js'
import { createHighlights } from './highlight.js'
import { createControls } from './controls.js'

/**
 * input/ — isometric camera rig, picking, tactical ground overlay.
 *
 * Everything here degrades: with no world we pick a flat plane, with no rules
 * module we show a hover reticle only, with no units we simply never fire unit
 * events. Nothing in this module may throw during another module's absence.
 */
export async function init(ctx) {
  const params = new URLSearchParams(location.search)
  const camtest = params.get('camtest') === '1' || params.get('camtest') === 'true'

  const rig = createCameraRig(ctx)
  const picking = createPicking(ctx)
  const highlights = createHighlights(ctx)
  const controls = createControls(ctx, rig, picking)

  const off = []
  // camtest is a deterministic visual harness: the demo owns the overlay and the
  // pose, so game-driven selection / focus events must not hijack the capture.
  const on = (ev, fn) =>
    off.push(
      ctx.bus.on(ev, (p) => {
        if (camtest && ev !== 'engine:resize') return
        fn(p)
      })
    )

  // ------------------------------------------------------------ rules bridge

  function rules() {
    const c = ctx
    for (const src of [c.game, c.rules, c.state]) {
      if (src && typeof src.getReachable === 'function') return src
    }
    for (const src of [c.game, c.rules]) if (src) return src
    return null
  }

  function unitById(id) {
    if (!id) return null
    return ctx.state?.units?.find?.((u) => u.id === id) || null
  }

  function unitWorld(id) {
    try {
      const o = ctx.units?.getObject?.(id)
      if (o) return o.getWorldPosition(new THREE.Vector3())
    } catch {}
    const u = unitById(id)
    if (u) return ctx.grid.toWorld(u.x, u.z, u.elevation || 0, new THREE.Vector3())
    return null
  }

  // ------------------------------------------------------------ range/path

  let selectedId = null
  let reach = null // { blue:Set, dash:Set }
  let hoverTile = null

  function inSet(set, x, z) {
    if (!set) return false
    const k = ctx.grid.key(x, z)
    if (set.has?.(k)) return true
    if (set.has?.(`${x},${z}`)) return true
    if (Array.isArray(set)) return set.some((t) => t?.x === x && t?.z === z)
    return false
  }

  function refreshRange() {
    const u = unitById(selectedId)
    if (!u) {
      reach = null
      highlights.clearRange()
      return
    }
    const api = rules()
    if (!api?.getReachable) {
      reach = null
      highlights.clearRange()
      return
    }
    try {
      reach = api.getReachable(u) || null
    } catch (err) {
      reach = null
    }
    if (!reach) {
      highlights.clearRange()
      return
    }
    let danger = null
    try {
      danger = api.getThreatTiles?.(u) || api.getOverwatchTiles?.(u) || null
    } catch {}
    highlights.setRange({ blue: reach.blue, dash: reach.dash, danger, origin: { x: u.x, z: u.z } })
  }

  function updatePathPreview() {
    const u = unitById(selectedId)
    if (!u || !hoverTile) {
      highlights.clearPath()
      return
    }
    const api = rules()
    if (!api?.findPath) {
      highlights.clearPath()
      return
    }
    const inBlue = inSet(reach?.blue, hoverTile.x, hoverTile.z)
    const inDash = inSet(reach?.dash, hoverTile.x, hoverTile.z)
    if (reach && !inBlue && !inDash) {
      highlights.clearPath()
      return
    }
    let path = null
    try {
      path = api.findPath(u, hoverTile.x, hoverTile.z)
    } catch {
      path = null
    }
    if (!path || path.length < 2) {
      highlights.clearPath()
      return
    }
    highlights.setPath(path, inBlue ? 'blue' : 'dash')

    let cover = null
    try {
      cover = api.previewCoverAt?.(u, hoverTile.x, hoverTile.z) || null
    } catch {}
    if (cover && typeof cover === 'object' && cover.cover) cover = cover.cover
    if (cover) {
      const p = ctx.grid.toWorld(hoverTile.x, hoverTile.z, hoverTile.elevation || 0, new THREE.Vector3())
      highlights.setCover(cover, p.x, p.y, p.z)
    } else {
      highlights.setCover(null)
    }
  }

  // ---------------------------------------------------------------- events

  on('tile:hover', (p) => {
    hoverTile = p
    if (!p) {
      highlights.clearHover()
      highlights.clearPath()
      return
    }
    highlights.setHover(p.x, p.z)
    updatePathPreview()
  })

  on('unit:selected', (p) => {
    selectedId = p?.unitId || null
    rig.setFocusUnit(selectedId)
    const w = unitWorld(selectedId)
    if (w) rig.focus(w.clone().setY(w.y + 0.6), false) // gentle drift, never a yank
    refreshRange()
  })

  on('unit:deselected', () => {
    selectedId = null
    reach = null
    rig.setFocusUnit(null)
    highlights.clearRange()
    highlights.clearPath()
    highlights.setTargets(null)
  })

  on('unit:moveStart', () => {
    highlights.clearRange()
    highlights.clearPath()
  })
  on('unit:moveEnd', () => {
    const w = unitWorld(selectedId)
    if (w) rig.focus(w, false)
    refreshRange()
  })

  on('unit:shoot', (p) => {
    rig.shotBeat(p?.shooterId, p?.targetId, p?.from, p?.to)
    rig.shake(0.55 + (p?.crit ? 0.35 : 0), 0.28)
  })
  on('unit:aim', (p) => {
    highlights.clearPath()
    if (p?.targetId) highlights.setTargets([{ unitId: p.targetId }])
  })
  on('unit:damaged', (p) => rig.shake(0.3 + Math.min(0.5, (p?.dmg || 0) * 0.04), 0.22))
  on('unit:died', (p) => rig.deathPunch(p?.unitId))
  on('explosion', (p) => rig.shake(1.5, 0.55))
  on('grenade:thrown', () => rig.shake(0.15, 0.15))

  on('turn:start', (p) => {
    selectedId = null
    highlights.clearAll()
    const team = p?.team
    const list = (ctx.state?.units || []).filter((u) => u.team === team && u.alive !== false)
    const pts = list.map((u) => unitWorld(u.id)).filter(Boolean)
    if (pts.length) rig.establishingSweep(pts)
  })

  on('ui:ability', (p) => {
    if (p?.ability === 'fire' || p?.ability === 'grenade') {
      const u = unitById(selectedId)
      const foes = (ctx.state?.units || []).filter(
        (x) => x.alive !== false && (!u || x.team !== u.team)
      )
      highlights.setTargets(foes.map((f) => ({ unitId: f.id })))
      highlights.clearRange()
    } else if (p?.ability === 'move') {
      highlights.setTargets(null)
      refreshRange()
    }
  })
  on('ui:cancel', () => {
    highlights.setTargets(null)
    refreshRange()
  })

  on('camera:focus', (p) => rig.focus(p?.position, !!p?.immediate))
  on('camera:shake', (p) => rig.shake(p?.intensity ?? 1, p?.duration ?? 0.35))
  on('camera:cinematic', (p) => rig.cinematicMove(p?.from, p?.to, p?.duration ?? 1.5))

  on('engine:resize', () => picking.invalidate())

  // ------------------------------------------------------------ frame hook

  const lastCam = { x: 1e9, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

  const removeUpdate = ctx.onUpdate((dt, time) => {
    controls.update(dt)
    rig.update(dt)

    // a moving camera changes what's under a stationary cursor
    const c = ctx.camera
    if (
      Math.abs(c.position.x - lastCam.x) > 1e-4 ||
      Math.abs(c.position.y - lastCam.y) > 1e-4 ||
      Math.abs(c.position.z - lastCam.z) > 1e-4 ||
      Math.abs(c.quaternion.x - lastCam.qx) > 1e-5 ||
      Math.abs(c.quaternion.y - lastCam.qy) > 1e-5 ||
      Math.abs(c.quaternion.z - lastCam.qz) > 1e-5
    ) {
      lastCam.x = c.position.x
      lastCam.y = c.position.y
      lastCam.z = c.position.z
      lastCam.qx = c.quaternion.x
      lastCam.qy = c.quaternion.y
      lastCam.qz = c.quaternion.z
      picking.invalidate()
    }

    picking.poll()
    highlights.update(dt, time)
  })

  // --------------------------------------------------------------- camtest

  let camtestHandle = null
  if (camtest) {
    try {
      camtestHandle = buildCamTest(ctx, rig, highlights)
    } catch (err) {
      console.warn('[input] camtest scene failed', err)
    }
  } else {
    // frame the battlefield on boot
    rig.setPose({ azimuth: Math.PI / 4, distance: 46, target: new THREE.Vector3(0, 0, 0) })
  }

  // ------------------------------------------------------------------- api

  const api = {
    // required contract
    focus: (position, immediate) => rig.focus(position, immediate),
    shake: (intensity, duration) => rig.shake(intensity, duration),
    setTarget: (v3, immediate) => rig.setTarget(v3, immediate),
    getAzimuth: () => rig.getAzimuth(),
    setAzimuth: (a, immediate) => rig.setAzimuth(a, immediate),
    zoom: (delta) => rig.zoomBy(delta),
    setCinematicsEnabled: (b) => rig.setCinematicsEnabled(b),
    setPose: (p) => rig.setPose(p),

    // extras used by the rest of the game / harness
    focusTile: (x, z, e, immediate) => rig.focusTile(x, z, e, immediate),
    getPose: () => rig.getGoal(),
    getElevation: () => rig.getElevation(),
    getDistance: () => rig.getDistance(),
    getTarget: () => rig.getTarget(),
    rotateSnap: (d) => rig.rotateSnap(d),
    isCinematic: () => rig.isCinematic(),
    skipCinematic: () => rig.skipCinematic(),
    setOcclusionFade: (b) => rig.setOcclusionFade(b),
    setEdgeScroll: (b) => controls.setEdgeScroll(b),
    setPickingEnabled: (b) => picking.setEnabled(b),
    pickAt: (x, y) => {
      picking.setScreen(x, y)
      picking.poll(true)
      return picking.current()
    },
    highlights,
    rig,

    dispose() {
      removeUpdate?.()
      for (const d of off) d()
      off.length = 0
      controls.dispose()
      picking.dispose()
      highlights.dispose()
      rig.dispose()
      camtestHandle?.dispose?.()
    },
  }

  ctx.register('cameraRig', api)
  ctx.register('input', api)
  return api
}

// ---------------------------------------------------------------------------
// `?camtest=1` — a self-contained rig for judging the overlay in isolation.
// Builds a heightfield battlefield (only if world/ hasn't produced one), a
// fake two-tier move range with an obstacle-carved silhouette, a path over a
// rooftop, cover pips and an enemy reticle.
// ---------------------------------------------------------------------------

function buildCamTest(ctx, rig, highlights) {
  const grid = ctx.grid
  const W = grid.W
  const H = grid.H
  const group = new THREE.Group()
  group.name = 'input:camtest'
  group.userData.noOcclude = true

  // --- fake world (heightfield + blockers) ---------------------------------
  const elev = new Int8Array(W * H)
  const blocked = new Uint8Array(W * H)
  const plateau = (x0, z0, x1, z1, e) => {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) elev[x + z * W] = e
  }
  plateau(14, 7, 19, 12, 1)
  plateau(16, 8, 18, 10, 2)
  plateau(4, 15, 8, 18, 1)
  for (const [x, z] of [
    [11, 9], [11, 10], [11, 11], [11, 12], [10, 12],
    [13, 14], [14, 14], [15, 14], [15, 15],
    [7, 8], [7, 9], [8, 9],
  ]) blocked[x + z * W] = 1

  const fakeWorld = {
    getTile(x, z) {
      if (x < 0 || z < 0 || x >= W || z >= H) return null
      const k = x + z * W
      return {
        x, z,
        elevation: elev[k],
        walkable: !blocked[k],
        cost: 1,
        occupantId: null,
        cover: { n: 0, e: 0, s: 0, w: 0 },
        destructible: false,
        hazard: null,
      }
    },
    isWalkable: (x, z) => !!fakeWorld.getTile(x, z)?.walkable,
  }

  const usingFakeWorld = !ctx.world
  if (usingFakeWorld) ctx.world = fakeWorld
  const world = ctx.world

  // --- debug geometry: only when nobody else drew a battlefield ------------
  if (usingFakeWorld) {
    const box = new THREE.BoxGeometry(grid.TILE, 1, grid.TILE)
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.95, metalness: 0.02 })
    const inst = new THREE.InstancedMesh(box, mat, W * H)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    const col = new THREE.Color()
    let i = 0
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const e = elev[x + z * W]
        const top = e * grid.ELEV_STEP
        const h = top + 6
        grid.toWorld(x, z, 0, p)
        p.y = top - h / 2
        s.set(1, h, 1)
        m.compose(p, q, s)
        inst.setMatrixAt(i, m)
        const t = 0.82 + ((x * 7 + z * 13) % 11) * 0.03
        col.setHSL(0.58, 0.04, 0.15 * t + (e ? 0.035 : 0))
        inst.setColorAt(i, col)
        i++
      }
    }
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    inst.receiveShadow = true
    group.add(inst)

    const blockMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.9 })
    const bGeo = new THREE.BoxGeometry(grid.TILE * 0.86, 2.2, grid.TILE * 0.86)
    const bInst = new THREE.InstancedMesh(bGeo, blockMat, 64)
    let bi = 0
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        if (!blocked[x + z * W]) continue
        grid.toWorld(x, z, elev[x + z * W], p)
        p.y += 1.1
        m.compose(p, q, s.set(1, 1, 1))
        bInst.setMatrixAt(bi++, m)
      }
    }
    bInst.count = bi
    bInst.instanceMatrix.needsUpdate = true
    group.add(bInst)

    let hasLight = false
    ctx.scene.traverse((o) => {
      if (o.isLight) hasLight = true
    })
    if (!hasLight) {
      const hemi = new THREE.HemisphereLight(0x9fb6d4, 0x2a2118, 1.1)
      const key = new THREE.DirectionalLight(0xffe7c4, 2.0)
      key.position.set(24, 34, 14)
      group.add(hemi, key)
    }
  }

  ctx.scene.add(group)

  // --- fake reachability (BFS honouring blockers + 1-step climbs) ----------
  const origin = { x: 10, z: 13 }
  const BLUE_AP = 7.5
  const DASH_AP = 13
  const cost = new Map()
  const parent = new Map()
  const key = (x, z) => grid.key(x, z)
  const q0 = [[origin.x, origin.z, 0]]
  cost.set(key(origin.x, origin.z), 0)
  while (q0.length) {
    const [x, z, c] = q0.shift()
    if (c >= DASH_AP) continue
    const here = world.getTile(x, z)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const nx = x + dx
        const nz = z + dz
        const t = world.getTile(nx, nz)
        if (!t || t.walkable === false) continue
        if (Math.abs((t.elevation || 0) - (here?.elevation || 0)) > 1) continue
        const nc = c + (dx && dz ? 1.42 : 1)
        if (nc > DASH_AP) continue
        const k = key(nx, nz)
        if (cost.has(k) && cost.get(k) <= nc) continue
        cost.set(k, nc)
        parent.set(k, [x, z])
        q0.push([nx, nz, nc])
      }
    }
  }
  const blue = new Set()
  const dash = new Set()
  for (const [k, c] of cost) {
    if (k === key(origin.x, origin.z)) continue
    if (c <= BLUE_AP) blue.add(k)
    else dash.add(k)
  }

  // enemy overwatch / threat patch, deliberately outside the move range
  const danger = new Set()
  for (let z = 2; z <= 6; z++)
    for (let x = 12; x <= 18; x++)
      if (!blue.has(key(x, z)) && !dash.has(key(x, z))) danger.add(key(x, z))

  highlights.setRange({ blue, dash, danger, origin })

  // --- path: pick the longest 1-AP route so the ribbon is properly exercised
  let destX = 15
  let destZ = 11
  let bestC = -1
  for (const k of blue) {
    const c = cost.get(k)
    if (c > bestC) {
      bestC = c
      destX = k % W
      destZ = Math.floor(k / W)
    }
  }
  const path = []
  let cx = destX
  let cz = destZ
  for (let n = 0; n < 200; n++) {
    const t = world.getTile(cx, cz)
    path.push({ x: cx, z: cz, elevation: t?.elevation || 0 })
    const pr = parent.get(key(cx, cz))
    if (!pr) break
    cx = pr[0]
    cz = pr[1]
  }
  path.reverse()
  if (path.length > 1) highlights.setPath(path, blue.has(key(destX, destZ)) ? 'blue' : 'dash')
  highlights.setHover(destX, destZ)

  const dp = grid.toWorld(destX, destZ, world.getTile(destX, destZ)?.elevation || 0, new THREE.Vector3())
  highlights.setCover({ n: 2, e: 1, s: 0, w: 0 }, dp.x, dp.y, dp.z)
  highlights.__demoDest = dp.clone()
  highlights.__demoOrigin = grid.toWorld(origin.x, origin.z, 0, new THREE.Vector3())
  highlights.setTargets([
    { x: 15, z: 4, elevation: 0 },
    { x: 6, z: 17, elevation: 1 },
  ])

  rig.setPose({
    azimuth: Math.PI / 4,
    elevation: 0.88,
    distance: 48,
    target: new THREE.Vector3(0, 1, 0),
  })

  return {
    dispose() {
      ctx.scene.remove(group)
      group.traverse((o) => {
        o.geometry?.dispose?.()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.())
        else m?.dispose?.()
      })
      if (usingFakeWorld && ctx.world === fakeWorld) ctx.world = null
    },
  }
}
