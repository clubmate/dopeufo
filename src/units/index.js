/**
 * src/units — soldier rendering, rigging and animation.
 *
 * Owns everything visible about a unit: the skinned mesh, its weapon, the
 * animation state machine, upper-body aim tracking and terrain-aware foot
 * placement. The game layer drives it through the imperative API below; the
 * event-bus subscriptions are a convenience mirror so a module that only emits
 * events still gets correct animation.
 *
 *   const units = await init(ctx)
 *   const h = units.spawn({ id:'u_0', team:0, className:'Ranger', x:3, z:4 })
 *   await units.moveAlongPath('u_0', [{x:4,z:4,elevation:0}, ...])
 *   await units.playAction('u_0', 'fire')
 */
import * as THREE from 'three'
import {
  loadClips, loadCharacter, loadWeapon, instantiate, attachWeapon,
  styleWeapon, teamMaterials, preload, disposeAssets,
} from './soldier.js'
import { AnimatorSet, POSE_CLIP } from './animation.js'
import {
  collectBones, createAimLayer, createFootLayer, aimAt, clearAim,
  updateAim, applyAim, groundFeet, worldFromLocal, forwardOf, BONE,
} from './rig.js'
import { CLASSES, WEAPONS, DEFAULT_CLASS, TEAMS } from './loadout.js'

// metres covered by one full cycle of each locomotion clip, so playback rate
// can be matched to real ground speed instead of guessing
const LOCO_CYCLE = { walk: 1.36, run: 2.04, crouch_move: 0.76 }
const WALK_SPEED = 2.0
const RUN_SPEED = 3.6
const TURN_RATE = 7.5          // rad/s
const DASH_TILES = 4

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _tmpTarget = new THREE.Vector3()

export async function init(ctx) {
  const THREE_NS = ctx.THREE || THREE
  const group = new THREE_NS.Group()
  group.name = 'units'
  ctx.scene.add(group)

  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const isTest = params.get('unittest') === '1'

  /** @type {Map<string, Unit>} */
  const units = new Map()
  let clips = []
  let disposed = false

  try {
    clips = await loadClips()
  } catch (err) {
    console.warn('[units] clip library unavailable, units will be static', err)
  }

  // ------------------------------------------------------------- helpers ----
  function toWorld(x, z, elevation, out) {
    out = out || new THREE_NS.Vector3()
    if (ctx.grid?.toWorld) return ctx.grid.toWorld(x, z, elevation || 0, out)
    return out.set(x * 2, (elevation || 0) * 2, z * 2)
  }

  /** Terrain height probe — the world module may publish one of several names. */
  function probeGround(x, z) {
    const w = ctx.world
    if (!w) return null
    const fn = w.heightAt || w.groundHeightAt || w.sampleHeight || w.getHeight
    if (typeof fn !== 'function') return null
    try {
      const h = fn.call(w, x, z)
      return typeof h === 'number' && isFinite(h) ? h : null
    } catch {
      return null
    }
  }

  function tileAt(x, z) {
    const w = ctx.world
    const fn = w && (w.tileAt || w.getTile || w.tile)
    if (typeof fn === 'function') {
      try {
        return fn.call(w, x, z)
      } catch {
        return null
      }
    }
    return null
  }

  // ---------------------------------------------------------------- Unit ----
  class Unit {
    constructor(data) {
      this.id = data.id
      this.data = data
      this.team = data.team === 1 ? 1 : 0
      this.className = CLASSES[data.className] ? data.className : DEFAULT_CLASS
      this.x = data.x | 0
      this.z = data.z | 0
      this.elevation = data.elevation || 0
      this.facing = data.facing || 0
      this.alive = data.alive !== false

      this.root = new THREE_NS.Group()
      this.root.name = `unit:${this.id}`
      this.root.userData.unitId = this.id
      toWorld(this.x, this.z, this.elevation, this.root.position)
      this.root.rotation.y = this.facing
      group.add(this.root)

      this.model = null
      this.mesh = null
      this.bones = null
      this.animator = null
      this.aim = null
      this.feet = null
      this.weaponRoot = null
      this.weaponBone = null
      this.muzzleLocal = new THREE_NS.Vector3()
      this.ready = false

      this.pose = 'idle'
      this.desiredPose = 'idle'
      this.aimTarget = null
      this.motion = null
      this.turnTo = this.facing
      this.baseY = this.root.position.y

      this._build()
    }

    async _build() {
      const cls = CLASSES[this.className]
      let src = null
      try {
        src = await loadCharacter(this.team, this.className)
      } catch (err) {
        console.warn('[units] character load failed', err)
      }
      if (disposed || !src) return
      const built = instantiate(src, this.team, this.className, ctx)
      this.model = built.model
      this.mesh = built.mesh
      this.root.add(this.model)
      this.bones = collectBones(this.model)
      this.aim = createAimLayer(this.bones)
      this.feet = createFootLayer(this.bones)
      this.animator = new AnimatorSet(this.model, clips)
      this.animator.setPose(this.desiredPose)

      this.weaponBone = this.bones[BONE.weapon] || null
      const wid = cls.weapon
      try {
        const wsrc = await loadWeapon(wid)
        if (!disposed && wsrc && this.weaponBone) {
          this.weaponRoot = attachWeapon(this.weaponBone, wsrc)
          styleWeapon(this.weaponRoot, this.team, ctx)
          const def = WEAPONS[wid]
          this.muzzleLocal.fromArray(def?.muzzle || [0, 0.08, -0.5])
        }
      } catch (err) {
        console.warn('[units] weapon load failed', err)
      }
      this.ready = true
    }

    setPose(pose, fade) {
      this.desiredPose = pose
      if (!this.animator) return
      if (this.animator.dead && pose !== 'dead') return
      this.animator.setPose(pose, fade)
      this.pose = pose
    }

    faceTo(target) {
      let yaw = this.facing
      if (typeof target === 'number') {
        yaw = target
      } else if (target) {
        const p = target.isVector3 ? target : toWorld(target.x, target.z, target.elevation || 0, _v)
        const dx = p.x - this.root.position.x
        const dz = p.z - this.root.position.z
        if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) yaw = Math.atan2(dx, dz)
      }
      this.turnTo = yaw
      return yaw
    }

    snapFacing(yaw) {
      this.facing = yaw
      this.turnTo = yaw
      this.root.rotation.y = yaw
    }

    update(dt) {
      // --- turning -------------------------------------------------------
      let d = this.turnTo - this.facing
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      if (Math.abs(d) > 1e-4) {
        const step = Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt)
        this.facing += step
        this.root.rotation.y = this.facing
      }

      // --- path following -------------------------------------------------
      if (this.motion) this._stepMotion(dt)

      if (!this.animator) return
      this.animator.update(dt)

      // --- upper body aim layer -------------------------------------------
      if (this.aim) {
        if (this.aimTarget && this.alive) {
          _v.copy(this.root.position)
          _v.y += 1.42
          aimAt(this.aim, _v, this.aimTarget, this.facing)
        } else {
          clearAim(this.aim)
        }
        updateAim(this.aim, dt)
        this.model.updateMatrixWorld(true)
        applyAim(this.aim, this.model)
      }

      // --- foot grounding --------------------------------------------------
      if (this.feet && this.alive) {
        groundFeet(this.feet, this.model, probeGround, this.root.position.y, dt)
      }
    }

    _stepMotion(dt) {
      const m = this.motion
      const seg = m.path[m.i]
      if (!seg) return this._endMotion()
      const dist = m.segLen
      m.t += (m.speed * dt) / Math.max(dist, 1e-4)
      const t = Math.min(1, m.t)
      this.root.position.lerpVectors(m.from, m.to, t)
      // ease the vertical component so a step up does not read as an elevator
      if (Math.abs(m.to.y - m.from.y) > 1e-3) {
        const e = t * t * (3 - 2 * t)
        this.root.position.y = m.from.y + (m.to.y - m.from.y) * e
      }
      this.baseY = this.root.position.y

      if (t >= 1) {
        this.x = seg.x
        this.z = seg.z
        this.elevation = seg.elevation || 0
        ctx.bus?.emit?.('units:step', { unitId: this.id, tile: seg })
        m.i++
        if (m.i >= m.path.length) return this._endMotion()
        this._beginSegment()
      }
    }

    _beginSegment() {
      const m = this.motion
      const seg = m.path[m.i]
      m.from = this.root.position.clone()
      m.to = toWorld(seg.x, seg.z, seg.elevation || 0, new THREE_NS.Vector3())
      m.segLen = m.from.distanceTo(m.to)
      m.t = 0
      const dx = m.to.x - m.from.x
      const dz = m.to.z - m.from.z
      if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) this.turnTo = Math.atan2(dx, dz)
    }

    _endMotion() {
      const m = this.motion
      this.motion = null
      if (!m) return
      const last = m.path[m.path.length - 1]
      if (last) {
        this.x = last.x
        this.z = last.z
        this.elevation = last.elevation || 0
        toWorld(this.x, this.z, this.elevation, this.root.position)
        this.baseY = this.root.position.y
      }
      // cover entry: settle against the nearest cover face if the world knows
      const tile = tileAt(this.x, this.z)
      let pose = 'idle'
      if (tile?.cover) {
        const c = tile.cover
        const best = ['n', 'e', 's', 'w'].reduce(
          (a, k) => ((c[k] || 0) > (c[a] || 0) ? k : a), 'n'
        )
        if ((c[best] || 0) > 0) {
          pose = 'cover'
          // face away from the cover so the soldier is looking downrange
          const yaw = { n: Math.PI, e: -Math.PI / 2, s: 0, w: Math.PI / 2 }[best]
          this.turnTo = yaw
        }
      }
      this.setPose(pose)
      this.animator?.setLocomotionRate(1)
      m.resolve?.()
    }

    dispose() {
      this.animator?.dispose()
      this.root.parent?.remove(this.root)
      this.root.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) o.geometry?.dispose?.()
      })
    }
  }

  // ----------------------------------------------------------------- API ----
  const api = {
    root: group,

    spawn(data) {
      if (!data?.id) throw new Error('[units] spawn requires an id')
      if (units.has(data.id)) api.despawn(data.id)
      const u = new Unit(data)
      units.set(data.id, u)
      return api.handle(u)
    },

    handle(u) {
      return {
        id: u.id,
        object: u.root,
        unit: u,
        setPose: (p) => api.setPose(u.id, p),
        playAction: (a, o) => api.playAction(u.id, a, o),
      }
    },

    despawn(id) {
      const u = units.get(id)
      if (!u) return false
      u.dispose()
      units.delete(id)
      return true
    },

    get(id) {
      return units.get(id) || null
    },

    all() {
      return [...units.values()]
    },

    getObject(id) {
      return units.get(id)?.root || null
    },

    /** Every mesh the input module can raycast against. */
    pickables() {
      const out = []
      for (const u of units.values()) if (u.mesh) out.push(u.mesh)
      return out
    },

    setPose(id, pose) {
      const u = units.get(id)
      if (!u) return
      u.setPose(POSE_CLIP[pose] ? pose : 'idle')
    },

    playAction(id, action, opts) {
      const u = units.get(id)
      if (!u) return Promise.resolve()
      if (!u.animator) return new Promise((r) => setTimeout(r, 120))
      if (action === 'death' || action === 'die') {
        u.alive = false
        u.aimTarget = null
        const variant = Math.random() < 0.5 ? 'death_a' : 'death_b'
        return u.animator.playAction(variant, opts)
      }
      return u.animator.playAction(action, opts)
    },

    faceTo(id, target) {
      const u = units.get(id)
      if (!u) return
      u.faceTo(target)
    },

    snapFacing(id, yaw) {
      units.get(id)?.snapFacing(yaw)
    },

    /**
     * Walk a unit tile-to-tile. Resolves when it arrives and settles.
     * @param {string} id
     * @param {Array<{x:number,z:number,elevation?:number}>} path
     */
    moveAlongPath(id, path, opts = {}) {
      const u = units.get(id)
      if (!u || !Array.isArray(path) || path.length === 0) return Promise.resolve()
      if (u.motion) u.motion.resolve?.()
      const dash = opts.run ?? path.length > DASH_TILES
      const crouched = !!opts.crouch
      const speed = opts.speed ?? (crouched ? 1.2 : dash ? RUN_SPEED : WALK_SPEED)
      const clip = crouched ? 'crouch_move' : dash ? 'run' : 'walk'
      u.setPose(clip)
      const dur = u.animator?.actions?.[POSE_CLIP[clip]]?.getClip?.().duration || 1
      const natural = (LOCO_CYCLE[clip] || 1.4) / dur
      u.animator?.setLocomotionRate(THREE.MathUtils.clamp(speed / natural, 0.55, 2.2))
      return new Promise((resolve) => {
        u.motion = { path: path.slice(), i: 0, t: 0, speed, resolve }
        u._beginSegment()
      })
    },

    /** Point the upper body at a world position (or another unit, or null). */
    setAimTarget(id, target) {
      const u = units.get(id)
      if (!u) return
      if (target == null) {
        u.aimTarget = null
        return
      }
      if (typeof target === 'string') {
        const t = units.get(target)
        if (!t) {
          u.aimTarget = null
          return
        }
        u.aimTarget = t.root.position.clone().setY(t.root.position.y + 1.35)
        return
      }
      if (target.isVector3) u.aimTarget = target.clone()
      else if (typeof target.x === 'number' && typeof target.z === 'number') {
        u.aimTarget = toWorld(target.x, target.z, target.elevation || 0, new THREE_NS.Vector3())
        u.aimTarget.y += 1.35
      }
    },

    /**
     * World position of the barrel tip — the VFX module hangs muzzle flashes,
     * tracer origins and shell ejection off this.
     */
    getMuzzlePosition(id, out) {
      out = out || new THREE_NS.Vector3()
      const u = units.get(id)
      if (!u) return out.set(0, 1.4, 0)
      if (u.weaponRoot) return worldFromLocal(u.weaponRoot, u.muzzleLocal, out)
      const b = u.bones?.[BONE.muzzle]
      if (b) return b.getWorldPosition(out)
      return out.copy(u.root.position).add(_v2.set(0, 1.4, 0))
    },

    getMuzzleDirection(id, out) {
      out = out || new THREE_NS.Vector3()
      const u = units.get(id)
      if (!u) return out.set(0, 0, 1)
      if (u.weaponRoot) return forwardOf(u.weaponRoot, out)
      return out.set(Math.sin(u.facing), 0, Math.cos(u.facing))
    },

    /** Eye height point, for LOS debug and camera framing. */
    getEyePosition(id, out) {
      out = out || new THREE_NS.Vector3()
      const u = units.get(id)
      if (!u) return out.set(0, 1.6, 0)
      const h = u.bones?.[BONE.head]
      if (h) return h.getWorldPosition(out)
      return out.copy(u.root.position).add(_v2.set(0, 1.6, 0))
    },

    setAlive(id, alive) {
      const u = units.get(id)
      if (!u) return
      u.alive = !!alive
      if (alive && u.animator?.dead) {
        u.animator.revive()
        u.setPose('idle')
      }
    },

    count() {
      return units.size
    },

    dispose() {
      disposed = true
      for (const off of offs) off()
      for (const u of units.values()) u.dispose()
      units.clear()
      group.parent?.remove(group)
      disposeAssets()
      showcase?.dispose?.()
    },
  }

  // ----------------------------------------------------------- bus wiring ---
  const offs = []
  function on(evt, fn) {
    if (!ctx.bus?.on) return
    ctx.bus.on(evt, fn)
    offs.push(() => ctx.bus.off?.(evt, fn))
  }

  on('unit:moveStart', ({ unitId, path }) => {
    const u = units.get(unitId)
    if (!u || u.motion) return
    api.moveAlongPath(unitId, path)
  })
  on('unit:aim', ({ shooterId, targetId }) => {
    api.setAimTarget(shooterId, targetId)
    const u = units.get(shooterId)
    if (u && !u.motion && u.pose !== 'aim') u.setPose('aim')
  })
  on('unit:shoot', ({ shooterId, targetId }) => {
    api.setAimTarget(shooterId, targetId)
    api.playAction(shooterId, 'fire')
  })
  on('unit:damaged', ({ unitId }) => {
    const u = units.get(unitId)
    if (u?.alive) api.playAction(unitId, 'hit')
  })
  on('unit:died', ({ unitId }) => api.playAction(unitId, 'death'))
  on('unit:reload', ({ unitId }) => api.playAction(unitId, 'reload'))
  on('grenade:thrown', ({ unitId, to }) => {
    if (to) api.faceTo(unitId, to)
    api.playAction(unitId, 'throw')
  })
  on('unit:overwatch', ({ unitId }) => api.setPose(unitId, 'overwatch'))
  on('unit:hunker', ({ unitId }) => api.setPose(unitId, 'hunker'))
  on('turn:start', () => {
    for (const u of units.values()) {
      if (u.alive && !u.motion && (u.pose === 'aim')) u.setPose('idle')
    }
  })

  // ----------------------------------------------------------- frame loop ---
  ctx.onUpdate((dt) => {
    if (disposed) return
    for (const u of units.values()) {
      try {
        u.update(dt)
      } catch (err) {
        /* one bad unit must never stall the frame */
      }
    }
    showcase?.update?.(dt)
  })

  // -------------------------------------------------------------- showcase --
  let showcase = null
  if (isTest) {
    try {
      showcase = buildShowcase(ctx, api, THREE_NS)
    } catch (err) {
      console.warn('[units] showcase failed', err)
    }
  } else {
    // warm the caches in the background so the first turn never hitches
    preload().catch(() => {})
  }

  ctx.register('units', api)
  return api
}

// ============================================================== showcase =====
/**
 * `?unittest=1` only. Lines up both teams and all four classes, cycles the
 * animation set, and — if no other module has published lighting, ground or a
 * camera rig yet — supplies a minimal neutral one so the module can be judged
 * standalone. None of this exists in a normal boot.
 */
function buildShowcase(ctx, api, T) {
  const added = []
  const CLASS_LIST = ['Ranger', 'Sharpshooter', 'Grenadier', 'Specialist']

  let hasLight = false
  ctx.scene.traverse((o) => {
    if (o.isLight) hasLight = true
  })
  if (!hasLight) {
    const key = new T.DirectionalLight(0xfff0dd, 3.1)
    key.position.set(6, 11, 5)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 60
    const d = 14
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d })
    key.shadow.bias = -0.0008
    key.shadow.normalBias = 0.02
    ctx.scene.add(key)
    const rim = new T.DirectionalLight(0x9fc4ff, 1.1)
    rim.position.set(-7, 5, -8)
    ctx.scene.add(rim)
    const hemi = new T.HemisphereLight(0xbcd4ff, 0x3a3128, 1.05)
    ctx.scene.add(hemi)
    added.push(key, rim, hemi)
    if (!ctx.scene.background) ctx.scene.background = new T.Color(0x2b3138)
    if (!ctx.scene.fog) ctx.scene.fog = new T.Fog(0x2b3138, 26, 70)
  }

  if (!ctx.world) {
    const g = new T.Mesh(
      new T.PlaneGeometry(60, 60),
      new T.MeshStandardMaterial({ color: 0x4a4a44, roughness: 0.98, metalness: 0 })
    )
    g.rotation.x = -Math.PI / 2
    g.receiveShadow = true
    ctx.scene.add(g)
    added.push(g)
  }

  const ids = []
  const SPACING = 1.7
  for (let t = 0; t < 2; t++) {
    for (let c = 0; c < CLASS_LIST.length; c++) {
      const i = t * 4 + c
      const id = `demo_${i}`
      const h = api.spawn({
        id, team: t, className: CLASS_LIST[c],
        x: 0, z: 0, elevation: 0, facing: 0,
      })
      h.object.position.set((i - 3.5) * SPACING, 0, t === 0 ? 0.9 : -0.9)
      h.unit.snapFacing(t === 0 ? 0.28 : -0.28)
      h.unit.baseY = 0
      ids.push(id)
    }
  }

  // camera: pinned only in test mode so the harness always frames the row
  const cam = ctx.camera
  const camPos = new T.Vector3(0.0, 4.4, 11.6)
  const camAt = new T.Vector3(0, 1.0, 0)

  const SCRIPT = [
    { pose: 'idle', hold: 2.6 },
    { pose: 'aim', hold: 1.4, aim: true },
    { action: 'fire', hold: 1.1, aim: true },
    { pose: 'overwatch', hold: 2.4 },
    { pose: 'walk', hold: 2.4 },
    { pose: 'run', hold: 2.0 },
    { pose: 'crouch', hold: 2.0 },
    { action: 'reload', hold: 2.6 },
    { pose: 'cover', hold: 2.0 },
    { action: 'throw', hold: 2.0 },
    { pose: 'hunker', hold: 2.0 },
    { action: 'hit', hold: 1.6 },
    { action: 'death', hold: 3.0 },
  ]
  let step = 0
  let clock = 0
  let started = false

  function apply(i) {
    const s = SCRIPT[i % SCRIPT.length]
    for (const id of ids) {
      const u = api.get(id)
      if (!u) continue
      if (s.action === 'death') {
        api.playAction(id, 'death')
        continue
      }
      if (u.animator?.dead) {
        api.setAlive(id, true)
      }
      if (s.pose) api.setPose(id, s.pose)
      if (s.aim) {
        const p = u.root.position.clone()
        p.z += 9
        p.x += 2.5
        p.y += 1.3
        api.setAimTarget(id, p)
      } else {
        api.setAimTarget(id, null)
      }
      if (s.action) api.playAction(id, s.action)
    }
  }

  return {
    update(dt) {
      cam.position.lerp(camPos, started ? 0.12 : 1)
      cam.lookAt(camAt)
      if (!started) {
        started = true
        apply(0)
        return
      }
      clock += dt
      const s = SCRIPT[step % SCRIPT.length]
      if (clock >= s.hold) {
        clock = 0
        step++
        apply(step)
      }
    },
    dispose() {
      for (const o of added) {
        o.parent?.remove(o)
        o.geometry?.dispose?.()
        o.material?.dispose?.()
      }
    },
  }
}
