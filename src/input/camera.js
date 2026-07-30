import * as THREE from 'three'

/**
 * Isometric camera rig.
 *
 * Model: a *target point* on the battlefield plus spherical (azimuth, elevation,
 * distance). The engine camera stays a 30° FOV perspective — it reads isometric
 * but keeps the parallax that a true ortho throws away.
 *
 * Every driven value goes through a critically-damped spring (Unity-style
 * SmoothDamp). Nothing in this file ever assigns a pose directly except
 * `setPose()` (the deterministic screenshot hook) — that is the single reason
 * the camera feels expensive rather than snappy-but-cheap.
 *
 * Shake is applied as a post-transform offset so it can never corrupt rig state.
 * Cinematics work by re-targeting the *goals* (not the current values), so a
 * cinematic can be cancelled at any instant and the rig just springs home.
 */

const DEG = Math.PI / 180

/** Unity SmoothDamp — critically damped spring, implicit + stable at any dt. */
function smoothDamp(cur, goal, ref, smoothTime, dt, maxSpeed = Infinity) {
  smoothTime = Math.max(1e-4, smoothTime)
  const omega = 2 / smoothTime
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  let change = cur - goal
  const maxChange = maxSpeed * smoothTime
  change = Math.max(-maxChange, Math.min(maxChange, change))
  const clampedGoal = cur - change
  const temp = (ref.v + omega * change) * dt
  ref.v = (ref.v - omega * temp) * exp
  let out = clampedGoal + (change + temp) * exp
  // kill overshoot so the spring never rings
  if (goal - cur > 0 === out > goal) {
    out = goal
    ref.v = (out - goal) / Math.max(dt, 1e-6)
  }
  return out
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function createCameraRig(ctx) {
  const camera = ctx.camera
  const grid = ctx.grid
  const halfW = (grid.W * grid.TILE) / 2
  const halfH = (grid.H * grid.TILE) / 2

  const cfg = {
    distMin: 14, // player's manual zoom floor
    cineDistMin: 5, // authored cinematics may push closer than the player can
    distMax: 78,
    distDefault: 46,
    // pitch is driven off zoom: close = lower & more cinematic, far = more top-down
    elevNear: 0.74, // ~42°
    elevFar: 1.0, //  ~57°
    boundsMargin: 8,
    snapStep: 45 * DEG,
    // spring response times (seconds to ~63% — lower = snappier)
    smoothTarget: 0.16,
    smoothAzimuth: 0.22,
    smoothElev: 0.3,
    smoothDist: 0.2,
    smoothHeight: 0.42,
  }

  // --- rig state ----------------------------------------------------------
  const cur = {
    target: new THREE.Vector3(0, 0, 0),
    azimuth: 45 * DEG,
    elevation: 0.88,
    distance: cfg.distDefault,
  }
  const goal = {
    target: cur.target.clone(),
    azimuth: cur.azimuth,
    elevation: cur.elevation,
    distance: cur.distance,
  }
  // spring velocities
  const vel = {
    tx: { v: 0 },
    ty: { v: 0 },
    tz: { v: 0 },
    az: { v: 0 },
    el: { v: 0 },
    di: { v: 0 },
  }
  // active smooth-times (cinematics temporarily stiffen/soften these)
  const sm = {
    target: cfg.smoothTarget,
    azimuth: cfg.smoothAzimuth,
    elevation: cfg.smoothElev,
    distance: cfg.smoothDist,
  }

  let manualElevation = false // set true by setPose / explicit pitch control
  let terrainY = 0
  let targetYLocked = false // focus() pins the height until the player pans again

  // --- shake --------------------------------------------------------------
  const shake = { amp: 0, t: 0, dur: 0, seed: Math.random() * 100 }
  const shakeOffset = new THREE.Vector3()

  // --- cinematics ---------------------------------------------------------
  let cinematicsEnabled = true
  /** @type {null | {keys:Array, i:number, t:number, saved:object, lerp?:object}} */
  let cine = null

  const tmpV = new THREE.Vector3()
  const tmpV2 = new THREE.Vector3()
  const offset = new THREE.Vector3()
  const lookAt = new THREE.Vector3()

  // ---------------------------------------------------------------- helpers

  function groundHeightAt(wx, wz) {
    const w = ctx.world
    if (!w || typeof w.getTile !== 'function') return 0
    let sum = 0
    let n = 0
    const gx = Math.floor(wx / grid.TILE + grid.W / 2)
    const gz = Math.floor(wz / grid.TILE + grid.H / 2)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        let t = null
        try {
          t = w.getTile(gx + dx, gz + dz)
        } catch {
          t = null
        }
        if (t) {
          sum += (t.elevation || 0) * grid.ELEV_STEP
          n++
        }
      }
    }
    return n ? sum / n : 0
  }

  function clampTarget(v) {
    v.x = clamp(v.x, -halfW - cfg.boundsMargin, halfW + cfg.boundsMargin)
    v.z = clamp(v.z, -halfH - cfg.boundsMargin, halfH + cfg.boundsMargin)
    v.y = clamp(v.y, -4, 40)
    return v
  }

  /** Pitch follows zoom unless the caller took manual control. */
  function autoElevation(dist) {
    const t = clamp((dist - cfg.distMin) / (cfg.distMax - cfg.distMin), 0, 1)
    const s = t * t * (3 - 2 * t)
    return cfg.elevNear + (cfg.elevFar - cfg.elevNear) * s
  }

  function applyTransform() {
    const ce = Math.cos(cur.elevation)
    const se = Math.sin(cur.elevation)
    offset.set(Math.sin(cur.azimuth) * ce, se, Math.cos(cur.azimuth) * ce).multiplyScalar(cur.distance)

    camera.position.copy(cur.target).add(offset).add(shakeOffset)
    // never let the rig dip below the ground plane it's looking at
    const floor = terrainY + 1.6
    if (camera.position.y < floor) camera.position.y = floor

    lookAt.copy(cur.target)
    lookAt.x += shakeOffset.x * 0.35
    lookAt.y += shakeOffset.y * 0.35
    lookAt.z += shakeOffset.z * 0.35
    camera.lookAt(lookAt)
  }

  // ------------------------------------------------------------- occlusion

  const occl = {
    enabled: true,
    timer: 0,
    /** @type {Map<THREE.Mesh, {orig:any, clones:any[], w:number, seen:boolean}>} */
    faded: new Map(),
    ray: new THREE.Raycaster(),
    focusId: null,
  }

  function occluderCandidates() {
    const roots = []
    const w = ctx.world
    const r = w?.root || w?.group || w?.container
    if (r && r.isObject3D) roots.push(r)
    if (!roots.length) {
      for (const c of ctx.scene.children) {
        if (!c.isObject3D) continue
        if (c.isLight || c.isCamera) continue
        if (c.userData?.noOcclude) continue
        if (c.name === 'input:highlights' || c.name === 'input:camtest') continue
        roots.push(c)
      }
    }
    return roots
  }

  function fadeMesh(mesh) {
    const rec = occl.faded.get(mesh)
    if (rec) {
      rec.seen = true
      return
    }
    const orig = mesh.material
    if (!orig) return
    const arr = Array.isArray(orig) ? orig : [orig]
    const clones = arr.map((m) => {
      const c = m.clone()
      c.transparent = true
      c.depthWrite = false
      c.opacity = 1
      return c
    })
    mesh.material = Array.isArray(orig) ? clones : clones[0]
    mesh.userData.__inputFaded = true
    occl.faded.set(mesh, { orig, clones, w: 0, seen: true })
  }

  function restoreMesh(mesh, rec) {
    mesh.material = rec.orig
    delete mesh.userData.__inputFaded
    for (const c of rec.clones) c.dispose?.()
  }

  function updateOcclusion(dt) {
    // ease existing fades every frame, re-scan at 12 Hz
    for (const [mesh, rec] of occl.faded) {
      const want = rec.seen ? 1 : 0
      rec.w += (want - rec.w) * Math.min(1, dt * 9)
      const op = 1 - 0.82 * rec.w
      for (const c of rec.clones) c.opacity = op
      if (!rec.seen && rec.w < 0.02) {
        restoreMesh(mesh, rec)
        occl.faded.delete(mesh)
      }
    }

    occl.timer -= dt
    if (occl.timer > 0) return
    occl.timer = 1 / 12

    for (const rec of occl.faded.values()) rec.seen = false
    if (!occl.enabled || !occl.focusId) return

    let obj = null
    try {
      obj = ctx.units?.getObject?.(occl.focusId) || null
    } catch {
      obj = null
    }
    if (!obj) return

    obj.getWorldPosition(tmpV)
    tmpV.y += 1.0
    tmpV2.copy(tmpV).sub(camera.position)
    const len = tmpV2.length()
    if (len < 0.5) return
    tmpV2.divideScalar(len)
    occl.ray.set(camera.position, tmpV2)
    occl.ray.near = 0.1
    occl.ray.far = len - 0.8
    occl.ray.firstHitOnly = false

    let hits = []
    try {
      hits = occl.ray.intersectObjects(occluderCandidates(), true)
    } catch {
      hits = []
    }
    let n = 0
    for (const h of hits) {
      const m = h.object
      if (!m?.isMesh || m.isSkinnedMesh) continue
      if (m.userData?.noOcclude) continue
      if (!m.material || m.material.__isHighlight) continue
      fadeMesh(m)
      if (++n >= 10) break
    }
  }

  function clearOcclusion() {
    for (const [mesh, rec] of occl.faded) restoreMesh(mesh, rec)
    occl.faded.clear()
  }

  // ------------------------------------------------------------- cinematics

  function poseNow() {
    return {
      target: goal.target.clone(),
      azimuth: goal.azimuth,
      elevation: goal.elevation,
      distance: goal.distance,
      manualElevation,
    }
  }

  function applyKey(k) {
    if (k.target) goal.target.copy(clampTarget(k.target.clone()))
    if (k.azimuth != null) goal.azimuth = k.azimuth
    if (k.elevation != null) {
      goal.elevation = k.elevation
      manualElevation = true
    }
    // Cinematics may go closer than the player's manual zoom floor. cfg.distMin
    // (14) exists to stop a player driving the free camera into the geometry;
    // applying it here silently overrode every authored close-up. The shot beat
    // asks for 10 and then 8.6 to get an over-the-shoulder read, and both were
    // being floored to 14 — which is why the "camera moves into the shooter"
    // action beat never actually got near the shooter.
    if (k.distance != null) goal.distance = clamp(k.distance, cfg.cineDistMin, cfg.distMax)
    sm.target = k.smooth ?? 0.28
    sm.azimuth = k.smoothAz ?? k.smooth ?? 0.3
    sm.elevation = k.smoothEl ?? k.smooth ?? 0.3
    sm.distance = k.smoothDist ?? k.smooth ?? 0.3
  }

  function endCinematic(restore = true) {
    if (!cine) return
    if (restore && cine.saved) {
      goal.target.copy(cine.saved.target)
      goal.azimuth = cine.saved.azimuth
      goal.elevation = cine.saved.elevation
      goal.distance = cine.saved.distance
      manualElevation = cine.saved.manualElevation
    }
    sm.target = cfg.smoothTarget
    sm.azimuth = cfg.smoothAzimuth
    sm.elevation = cfg.smoothElev
    sm.distance = cfg.smoothDist
    cine = null
    ctx.bus?.emit?.('camera:cinematicEnd', {})
  }

  /**
   * keys: [{ at, target?, azimuth?, elevation?, distance?, smooth? }] sorted by
   * `at` (seconds). The final entry's `at` is the total duration.
   */
  function playCinematic(keys, { restoreOnEnd = true } = {}) {
    if (!cinematicsEnabled || !keys?.length) return false
    endCinematic(false)
    cine = { keys, i: -1, t: 0, saved: poseNow(), restoreOnEnd }
    ctx.bus?.emit?.('camera:cinematicStart', {})
    return true
  }

  function updateCinematic(dt) {
    if (!cine) return
    cine.t += dt
    // advance through keyframes
    while (cine.i + 1 < cine.keys.length && cine.t >= cine.keys[cine.i + 1].at) {
      cine.i++
      applyKey(cine.keys[cine.i])
    }
    if (cine.lerpFn) cine.lerpFn(cine.t)
    const last = cine.keys[cine.keys.length - 1]
    if (cine.t >= (last.until ?? last.at)) endCinematic(cine.restoreOnEnd)
  }

  // --------------------------------------------------------------- updating

  function update(dt) {
    if (!(dt > 0)) dt = 1 / 60
    dt = Math.min(dt, 1 / 15)

    updateCinematic(dt)

    if (!manualElevation) goal.elevation = autoElevation(goal.distance)

    // height-aware target: ride the terrain (rooftops raise the frame)
    terrainY = groundHeightAt(goal.target.x, goal.target.z)
    if (!cine && !targetYLocked) {
      goal.target.y += (terrainY - goal.target.y) * Math.min(1, dt / cfg.smoothHeight)
    }

    cur.target.x = smoothDamp(cur.target.x, goal.target.x, vel.tx, sm.target, dt)
    cur.target.y = smoothDamp(cur.target.y, goal.target.y, vel.ty, sm.target * 1.4, dt)
    cur.target.z = smoothDamp(cur.target.z, goal.target.z, vel.tz, sm.target, dt)
    cur.azimuth = smoothDamp(cur.azimuth, goal.azimuth, vel.az, sm.azimuth, dt)
    cur.elevation = smoothDamp(cur.elevation, goal.elevation, vel.el, sm.elevation, dt)
    cur.distance = smoothDamp(cur.distance, goal.distance, vel.di, sm.distance, dt)

    // --- shake (post-transform offset, never touches rig state) ---
    if (shake.t > 0) {
      shake.t -= dt
      const k = Math.max(0, shake.t / shake.dur)
      const env = k * k // quadratic decay reads as a punch, not a wobble
      const a = shake.amp * env * (0.25 + cur.distance * 0.012)
      const s = shake.seed
      const tt = ctx.time || performance.now() / 1000
      shakeOffset.set(
        (Math.sin(tt * 47.3 + s) + Math.sin(tt * 31.7 + s * 2.1)) * 0.5 * a,
        (Math.sin(tt * 53.1 + s * 1.7) + Math.sin(tt * 37.3 + s * 3.3)) * 0.5 * a * 0.7,
        (Math.sin(tt * 43.9 + s * 2.9) + Math.sin(tt * 29.1 + s * 1.3)) * 0.5 * a
      )
      if (shake.t <= 0) shakeOffset.set(0, 0, 0)
    }

    applyTransform()
    updateOcclusion(dt)
  }

  // -------------------------------------------------------------- rig verbs

  /** Pan in camera-relative screen space (metres). */
  function panBy(right, forward) {
    const s = Math.sin(cur.azimuth)
    const c = Math.cos(cur.azimuth)
    // camera forward projected on XZ is -offsetDir
    goal.target.x += -s * forward + c * right
    goal.target.z += -c * forward - s * right
    clampTarget(goal.target)
    targetYLocked = false
  }

  function rotateSnap(dir) {
    const step = cfg.snapStep
    const a = goal.azimuth
    const eps = 1e-3
    goal.azimuth = dir > 0 ? (Math.floor(a / step + eps) + 1) * step : (Math.ceil(a / step - eps) - 1) * step
  }

  function rotateFree(delta) {
    goal.azimuth += delta
  }

  function snapToNearest() {
    goal.azimuth = Math.round(goal.azimuth / cfg.snapStep) * cfg.snapStep
  }

  function zoomBy(delta) {
    // multiplicative so the zoom feel is constant across the range
    goal.distance = clamp(goal.distance * Math.pow(1.12, delta), cfg.distMin, cfg.distMax)
    manualElevation = false
  }

  function pitchBy(delta) {
    manualElevation = true
    goal.elevation = clamp(goal.elevation + delta, 0.28, 1.28)
  }

  function focus(position, immediate = false) {
    if (!position) return
    const p = position.isVector3
      ? position
      : new THREE.Vector3(position.x || 0, position.y || 0, position.z || 0)
    goal.target.copy(p)
    clampTarget(goal.target)
    targetYLocked = true
    if (immediate) {
      cur.target.copy(goal.target)
      vel.tx.v = vel.ty.v = vel.tz.v = 0
      applyTransform()
    }
  }

  /** Focus a grid tile (elevation aware). */
  function focusTile(x, z, elevation = 0, immediate = false) {
    const p = grid.toWorld(x, z, elevation, tmpV.clone())
    p.y += 0.8
    focus(p, immediate)
  }

  function doShake(intensity = 1, duration = 0.35) {
    const amp = Math.max(0, intensity)
    // a new shake never cancels a bigger one mid-decay
    const remaining = shake.t > 0 ? shake.amp * (shake.t / shake.dur) ** 2 : 0
    shake.amp = Math.max(amp, remaining)
    shake.dur = Math.max(0.08, duration)
    shake.t = shake.dur
    shake.seed = Math.random() * 100
  }

  function setPose({ azimuth, elevation, distance, target } = {}) {
    endCinematic(false)
    if (target) {
      const p = target.isVector3
        ? target.clone()
        : new THREE.Vector3(target.x || 0, target.y || 0, target.z || 0)
      goal.target.copy(clampTarget(p))
      cur.target.copy(goal.target)
      targetYLocked = true
    }
    if (azimuth != null) {
      goal.azimuth = azimuth
      cur.azimuth = azimuth
    }
    if (distance != null) {
      goal.distance = clamp(distance, cfg.distMin, cfg.distMax)
      cur.distance = goal.distance
    }
    if (elevation != null) {
      manualElevation = true
      goal.elevation = clamp(elevation, 0.12, 1.4)
      cur.elevation = goal.elevation
    } else if (distance != null && !manualElevation) {
      goal.elevation = cur.elevation = autoElevation(goal.distance)
    }
    vel.tx.v = vel.ty.v = vel.tz.v = vel.az.v = vel.el.v = vel.di.v = 0
    shake.t = 0
    shakeOffset.set(0, 0, 0)
    terrainY = groundHeightAt(cur.target.x, cur.target.z)
    applyTransform()
    camera.updateMatrixWorld(true)
  }

  function setFocusUnit(unitId) {
    occl.focusId = unitId || null
    if (!unitId) {
      for (const rec of occl.faded.values()) rec.seen = false
    }
  }

  // ------------------------------------------------------------ cinema shots

  /**
   * Accepts a world Vector3, a `{x,y,z}` world position, or a grid tile
   * `{x,z,elevation}`. Grid tiles are integers with no `y`, which is how the
   * bus payloads (`from`/`to`) are shaped.
   */
  function worldOf(p, lift = 0) {
    if (!p) return null
    if (p.isVector3) return p.clone()
    if (Array.isArray(p) && p.length >= 3) return new THREE.Vector3(p[0], p[1], p[2])
    if (typeof p.x !== 'number' || typeof p.z !== 'number') return null
    const looksLikeTile =
      p.y === undefined && Number.isInteger(p.x) && Number.isInteger(p.z) && p.x >= 0 && p.z >= 0
    if (looksLikeTile) {
      const v = grid.toWorld(p.x, p.z, p.elevation || 0, new THREE.Vector3())
      v.y += lift
      return v
    }
    return new THREE.Vector3(p.x, p.y || 0, p.z)
  }

  function unitWorld(unitId) {
    try {
      const o = ctx.units?.getObject?.(unitId)
      if (o) return o.getWorldPosition(new THREE.Vector3())
    } catch {}
    const u = ctx.state?.units?.find?.((x) => x.id === unitId)
    if (u) return grid.toWorld(u.x, u.z, u.elevation || 0, new THREE.Vector3())
    return null
  }

  /** XCOM-style action beat: swing low behind the shooter, hold, ease back. */
  function shotBeat(shooterId, targetId, fromHint, toHint) {
    if (!cinematicsEnabled) return
    const a = unitWorld(shooterId) || worldOf(fromHint)
    const b = unitWorld(targetId) || worldOf(toHint)
    if (!a || !b) return
    const dir = tmpV.copy(b).sub(a)
    dir.y = 0
    const len = dir.length()
    if (len < 0.01) return
    dir.divideScalar(len)

    // sit behind the shooter, kicked off-axis for an over-the-shoulder read
    const shoulder = (shooterId?.charCodeAt?.(shooterId.length - 1) || 0) % 2 ? 26 * DEG : -26 * DEG
    const az = Math.atan2(-dir.x, -dir.z) + shoulder

    const focusPt = new THREE.Vector3().copy(a).lerp(b, 0.42)
    focusPt.y += 1.35

    // Total beat ≈ 0.85s of hold + a ~0.4s spring home. Long unskippable
    // cameras are the single most hated thing in XCOM — this stays short.
    const dist = clamp(len * 0.5 + 7.5, 10, 19)
    playCinematic([
      { at: 0, target: focusPt, azimuth: nearestTurn(az), elevation: 0.34, distance: dist, smooth: 0.22 },
      {
        at: 0.45,
        target: focusPt,
        azimuth: nearestTurn(az) + 3 * DEG,
        elevation: 0.3,
        distance: dist - 1.4,
        // 0.9 s of smoothing inside a 0.4 s segment meant the camera was still
        // travelling when the beat ended and simply sprang home — measured, it
        // never got within 40 units of the shooter. The push-in has to resolve
        // inside its own segment to read as a deliberate move.
        smooth: 0.3,
      },
      { at: 0.95, until: 0.95 },
    ])
  }

  /** Choose the wrapped angle closest to the current azimuth (no long way round). */
  function nearestTurn(a) {
    const two = Math.PI * 2
    let d = ((a - goal.azimuth) % two + two + Math.PI) % two - Math.PI
    return goal.azimuth + d
  }

  function deathPunch(unitId) {
    if (!cinematicsEnabled) return
    const p = unitWorld(unitId)
    if (!p) return
    const f = p.clone()
    f.y += 0.9
    playCinematic([
      { at: 0, target: f, distance: Math.max(cfg.distMin, goal.distance * 0.6), elevation: 0.52, smooth: 0.16 },
      { at: 0.5, until: 0.72 },
    ])
  }

  /** Quick establishing sweep across the active team. */
  function establishingSweep(positions) {
    if (!cinematicsEnabled || !positions?.length) return
    const c = new THREE.Vector3()
    for (const p of positions) c.add(p)
    c.divideScalar(positions.length)
    c.y += 1.0
    playCinematic([
      {
        at: 0,
        target: c,
        azimuth: goal.azimuth - 26 * DEG,
        distance: clamp(goal.distance * 1.22, cfg.distMin, cfg.distMax),
        smooth: 0.45,
      },
      {
        at: 0.55,
        target: c,
        azimuth: goal.azimuth + 26 * DEG,
        distance: clamp(goal.distance * 1.02, cfg.distMin, cfg.distMax),
        smooth: 0.6,
      },
      { at: 1.15, until: 1.15 },
    ])
  }

  /** `camera:cinematic` — glide the framing from one point to another. */
  function cinematicMove(from, to, duration = 1.5) {
    const a = worldOf(from, 1)
    const b = worldOf(to, 1)
    if (!a || !b) return
    const ok = playCinematic([
      { at: 0, target: a.clone(), smooth: 0.12 },
      { at: Math.max(0.2, duration), until: Math.max(0.2, duration) },
    ])
    if (!ok) return
    const dur = Math.max(0.2, duration)
    cine.lerpFn = (t) => {
      const k = easeInOut(clamp(t / dur, 0, 1))
      goal.target.copy(a).lerp(b, k)
      clampTarget(goal.target)
    }
  }

  function skipCinematic() {
    if (cine) endCinematic(true)
  }

  // ------------------------------------------------------------------ setup
  setPose({
    azimuth: 45 * DEG,
    distance: cfg.distDefault,
    elevation: null,
    target: new THREE.Vector3(0, 0, 0),
  })
  manualElevation = false
  goal.elevation = cur.elevation = autoElevation(goal.distance)
  targetYLocked = false
  applyTransform()

  return {
    cfg,
    update,
    // verbs
    panBy,
    rotateSnap,
    rotateFree,
    snapToNearest,
    zoomBy,
    pitchBy,
    focus,
    focusTile,
    shake: doShake,
    setPose,
    setFocusUnit,
    // cinematics
    shotBeat,
    deathPunch,
    establishingSweep,
    cinematicMove,
    skipCinematic,
    isCinematic: () => !!cine,
    setCinematicsEnabled(v) {
      cinematicsEnabled = !!v
      if (!v) endCinematic(true)
    },
    getCinematicsEnabled: () => cinematicsEnabled,
    setOcclusionFade(v) {
      occl.enabled = !!v
      if (!v) clearOcclusion()
    },
    // accessors
    getAzimuth: () => cur.azimuth,
    setAzimuth(a, immediate = false) {
      goal.azimuth = a
      if (immediate) {
        cur.azimuth = a
        vel.az.v = 0
        applyTransform()
      }
    },
    getElevation: () => cur.elevation,
    getDistance: () => cur.distance,
    getTarget: () => cur.target.clone(),
    setTarget(v, immediate = false) {
      focus(v, immediate)
    },
    getGoal: () => ({
      azimuth: goal.azimuth,
      elevation: goal.elevation,
      distance: goal.distance,
      target: goal.target.clone(),
    }),
    dispose() {
      clearOcclusion()
      cine = null
    },
  }
}
