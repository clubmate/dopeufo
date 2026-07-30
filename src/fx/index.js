/**
 * VFX subsystem entry point.
 *
 * Registers `ctx.fx` and — crucially — subscribes to the gameplay bus itself, so
 * combat produces effects without the rules module knowing this module exists.
 * Every dependency on `units` / `world` is optional: positions fall back to the
 * event's own `from`/`to`, decals fall back to a local pool, surfaces fall back
 * to material-name inference and then to concrete.
 *
 *   ?fxtest=1   runs a looping demo reel on a self-contained stage
 *   ?fxstats=1  prints live particle/draw stats to an overlay
 */
import * as THREE from 'three'
import { buildTextures } from './textures.js'
import { createParticleSystem } from './particles.js'
import { createLightPool, createDebrisPools, createDecalPool } from './props.js'
import { createMuzzle, WEAPONS } from './muzzle.js'
import { createTracers } from './tracers.js'
import { createImpacts, inferSurface, SURFACES } from './impacts.js'
import { createExplosions } from './explosions.js'
import { createBlood } from './blood.js'
import { createSmoke } from './smoke.js'

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _n = new THREE.Vector3()
const _mat3 = new THREE.Matrix3()
const UP = new THREE.Vector3(0, 1, 0)

const QUALITY = {
  ultra:  { density: 1.0,  scale: 1.0, lightScale: 1.0 },
  high:   { density: 1.0,  scale: 1.0, lightScale: 1.0 },
  medium: { density: 0.62, scale: 1.0, lightScale: 0.85 },
  low:    { density: 0.38, scale: 1.0, lightScale: 0.7 },
}

export async function init(ctx) {
  const params = new URLSearchParams(location.search)
  const quality = ctx.quality || 'high'
  const qcfg = QUALITY[quality] || QUALITY.high

  const textures = await buildTextures(quality)
  const ptc = createParticleSystem(ctx, textures)
  const lights = createLightPool(ctx, quality === 'low' ? 2 : 4)
  const debris = createDebrisPools(ctx, quality === 'low' || quality === 'medium')
  const decals = createDecalPool(ctx, textures.decals.tex, quality === 'low' ? 16 : 40)

  // Everything we add to the scene must be invisible to our own raycasts.
  const tagIgnore = (o) => { o.traverse((c) => { c.userData.fxIgnore = true }) }
  tagIgnore(ptc.group)
  tagIgnore(debris.chunks.mesh)
  tagIgnore(debris.shells.mesh)

  // --- scheduler -------------------------------------------------------------
  /** @type {{t:number, fn:Function}[]} */
  const timers = []
  let now = 0

  // --- ground height ---------------------------------------------------------
  const ray = new THREE.Raycaster()
  ray.far = 200
  ray.camera = ctx.camera        // sprites in the scene raycast against this
  ray.layers.set(0)
  const DOWN = new THREE.Vector3(0, -1, 0)
  const hCache = new Map()

  function groundY(x, z) {
    const w = ctx.world
    try {
      if (w?.getHeightAt) return w.getHeightAt(x, z) || 0
      if (w?.heightAt) return w.heightAt(x, z) || 0
    } catch { /* world still booting */ }
    const key = `${Math.round(x * 2)},${Math.round(z * 2)}`
    const c = hCache.get(key)
    if (c !== undefined) return c
    let y = 0
    try {
      ray.set(_a.set(x, 60, z), DOWN)
      const hits = ray.intersectObjects(ctx.scene.children, true)
      for (const h of hits) {
        if (isIgnored(h.object)) continue
        y = h.point.y
        break
      }
    } catch { /* ignore */ }
    if (hCache.size > 512) hCache.clear()
    hCache.set(key, y)
    return y
  }

  function isIgnored(o) {
    let p = o
    while (p) {
      if (p.userData?.fxIgnore) return true
      if (p.isPoints || p.isLine || p.isSprite) return true
      p = p.parent
    }
    return false
  }

  // --- decals ----------------------------------------------------------------
  let worldDecals = null   // null = unknown, true = use world's, false = use ours
  function addDecal(type, position, normal, scale) {
    if (worldDecals !== false && ctx.world?.addDecal) {
      try {
        ctx.world.addDecal(type, position, normal || UP, scale)
        worldDecals = true
        return
      } catch (err) {
        if (worldDecals === null) console.warn('[fx] world.addDecal rejected us, using local decals', err)
        worldDecals = false
      }
    }
    decals.add(type, position, normal || UP, scale)
  }

  // --- shared internal context ----------------------------------------------
  const fx = {
    ctx, ptc, lights, debris, decals, textures,
    quality,
    density: qcfg.density,
    scale: qcfg.scale,
    lightScale: qcfg.lightScale,
    now: () => now,
    schedule(t, fn) { timers.push({ t: now + t, fn }) },
    addDecal,
    groundY,
  }

  const muzzle = createMuzzle(fx)
  const tracers = createTracers(fx)
  const impacts = createImpacts(fx)
  const explosions = createExplosions(fx)
  const blood = createBlood(fx)
  const smoke = createSmoke(fx)
  fx.smokeCloud = smoke.smokeCloud

  // ---------------------------------------------------------------------------
  // position resolution — every one of these tolerates a missing units module
  // ---------------------------------------------------------------------------

  /** Accepts Vector3, {x,y,z}, or grid {x,z,elevation}. */
  function toWorld(v, target = new THREE.Vector3(), lift = 0) {
    if (!v) return null
    if (v.isVector3) return target.copy(v).setY(v.y + lift)
    if (typeof v.y === 'number' && typeof v.x === 'number' && typeof v.z === 'number') {
      return target.set(v.x, v.y + lift, v.z)
    }
    if (typeof v.x === 'number' && typeof v.z === 'number' && ctx.grid) {
      ctx.grid.toWorld(v.x, v.z, v.elevation || 0, target)
      target.y += lift
      return target
    }
    return null
  }

  function unitObject(id) {
    try { return ctx.units?.getObject?.(id) || null } catch { return null }
  }

  function muzzlePos(unitId, fallback, target) {
    try {
      const m = ctx.units?.getMuzzlePosition?.(unitId)
      if (m && m.isVector3) return target.copy(m)
      if (m && typeof m.x === 'number') return target.set(m.x, m.y, m.z)
    } catch { /* units may not be up */ }
    const o = unitObject(unitId)
    if (o) return o.getWorldPosition(target).setY(o.getWorldPosition(_c).y + 1.35)
    return toWorld(fallback, target, 1.35)
  }

  function unitCenter(unitId, fallback, target) {
    const o = unitObject(unitId)
    if (o) { o.getWorldPosition(target); target.y += 1.05; return target }
    return toWorld(fallback, target, 1.05)
  }

  function unitFacing(unitId, target) {
    try {
      const u = ctx.state?.units?.find?.((x) => x.id === unitId)
      if (u && typeof u.facing === 'number') return target.set(Math.sin(u.facing), 0, Math.cos(u.facing))
    } catch { /* ignore */ }
    return null
  }

  function weaponOf(unitId) {
    try {
      const u = ctx.state?.units?.find?.((x) => x.id === unitId)
      const n = (u?.weapon?.name || u?.className || '').toLowerCase()
      if (/shot|scatter/.test(n)) return 'shotgun'
      if (/snip|marks|dmr|rail/.test(n)) return 'sniper'
      if (/pistol|sidearm/.test(n)) return 'pistol'
      if (/smg|sub/.test(n)) return 'smg'
      if (/cannon|launch|grenad/.test(n)) return 'cannon'
      if (/plasma|beam|laser/.test(n)) return 'plasma'
    } catch { /* ignore */ }
    return 'rifle'
  }

  /** Raycast the real world (never our own props) and describe what was struck. */
  const _hitInfo = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'concrete', object: null, hit: false }
  function probe(origin, dir, maxDist) {
    _hitInfo.hit = false
    _hitInfo.object = null
    try {
      ray.set(origin, dir)
      ray.far = maxDist
      const hits = ray.intersectObjects(ctx.scene.children, true)
      for (const h of hits) {
        if (!h.object?.visible || isIgnored(h.object)) continue
        if (h.object.isInstancedMesh && h.object.name?.startsWith('fx.')) continue
        _hitInfo.point.copy(h.point)
        if (h.face) {
          _mat3.getNormalMatrix(h.object.matrixWorld)
          _hitInfo.normal.copy(h.face.normal).applyMatrix3(_mat3).normalize()
          if (_hitInfo.normal.dot(dir) > 0) _hitInfo.normal.negate()
        } else {
          _hitInfo.normal.copy(dir).negate()
        }
        _hitInfo.surface = inferSurface(ctx, h.object, h.point)
        _hitInfo.object = h.object
        _hitInfo.hit = true
        return _hitInfo
      }
    } catch { /* scene may be mid-mutation */ }
    return _hitInfo
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------

  const api = {
    /** @param {THREE.Vector3} position @param {THREE.Vector3} direction */
    muzzleFlash(position, direction, weaponType = 'rifle') {
      muzzle.muzzleFlash(position, direction, weaponType)
    },

    /** @returns {Promise<void>} resolves on arrival */
    tracer(from, to, opts) { return tracers.tracer(from, to, opts) },

    impact(position, normal, surfaceType, opts) {
      impacts.impact(position, normal || UP, surfaceType || 'concrete', opts)
    },

    explosion(position, radius, opts) { explosions.explosion(position, radius || 3.5, opts) },

    grenade(from, to, opts) { return explosions.grenade(from, to, opts) },

    blood(position, direction, amount) { blood.blood(position, direction || UP, amount ?? 1) },

    spall(position, direction, amount) { blood.spall(position, direction || UP, amount ?? 1) },

    smoke(position, radius, duration) { return smoke.smokeCloud(position, radius || 3.5, duration || 12) },

    shellEject(position, direction) { muzzle.shellEject(position, direction || new THREE.Vector3(1, 0, 0), 1) },

    /** One complete shot: flash, travelling round, and whatever it hits. */
    fireShot(fromPos, toPos, opts = {}) { return fireShot(fromPos, toPos, opts) },

    decal(type, position, normal, scale) { addDecal(type, position, normal, scale) },

    setAmbient(on) { smoke.setAmbient(on) },
    setAmbientBase(y) { smoke.setAmbientBase(y) },
    setDensity(v) { fx.density = Math.max(0.05, Math.min(2, v)) },

    surfaces: SURFACES,
    weapons: WEAPONS,

    get stats() {
      const s = ptc.stats
      s.lights = lights.active
      s.chunks = debris.chunks.active
      s.shells = debris.shells.active
      s.clouds = smoke.clouds
      s.timers = timers.length
      s.tracers = tracers.pending
      s.rings = explosions.activeRings
      return s
    },

    dispose() {
      for (const u of unsubs) u()
      ptc.dispose(); lights.dispose(); debris.dispose(); decals.dispose(); explosions.dispose()
      demoStop?.()
      overlay?.remove()
      for (const k in textures) textures[k]?.tex?.dispose?.()
      ctx.onUpdate && offUpdate?.()
    },
  }

  // ---------------------------------------------------------------------------
  // one complete shot
  // ---------------------------------------------------------------------------

  /**
   * @param {THREE.Vector3} from muzzle
   * @param {THREE.Vector3} to   aim point
   * @param {object} opts { weapon, hit, targetId, crit, killed, dmg, armorAbsorb, index }
   */
  function fireShot(from, to, opts = {}) {
    const weapon = opts.weapon || 'rifle'
    _a.copy(from)
    _b.copy(to)
    _n.subVectors(_b, _a)
    const dist = _n.length() || 1
    _n.divideScalar(dist)

    muzzle.muzzleFlash(_a, _n, weapon)

    const hit = opts.hit !== false
    const end = new THREE.Vector3()
    let surface = null
    let normal = new THREE.Vector3()

    if (hit) {
      // land near the aim point with a touch of scatter so bursts aren't stacked
      end.copy(_b).add(_c.set(
        (Math.random() - 0.5) * 0.22, (Math.random() - 0.5) * 0.26, (Math.random() - 0.5) * 0.22))
      normal.copy(_n).negate()
    } else {
      // A miss must be READABLE: deviate a few degrees, sail past the target,
      // and strike whatever is genuinely behind it.
      const ax = Math.random() * Math.PI * 2
      const dev = 0.045 + Math.random() * 0.055
      _c.set(Math.cos(ax), 0, Math.sin(ax)).cross(_n).normalize()
      const missDir = _n.clone().addScaledVector(_c, dev).normalize()
      missDir.y += (Math.random() - 0.35) * 0.05
      missDir.normalize()
      const info = probe(_a, missDir, dist * 3 + 12)
      if (info.hit) {
        end.copy(info.point)
        normal.copy(info.normal)
        surface = info.surface
      } else {
        // nothing behind: skip off the deck, or fly off into the distance
        const over = dist * 1.35 + 4
        end.copy(_a).addScaledVector(missDir, over)
        const g = groundY(end.x, end.z)
        if (end.y <= g + 0.05) { end.y = g + 0.02; normal.set(0, 1, 0); surface = 'dirt' }
        else { surface = null }
      }
    }

    const p = tracers.tracer(_a, end, { weapon, delay: opts.delay || 0 })
    p.then(() => {
      if (hit) {
        if (opts.armorAbsorb) {
          blood.spall(end, _n, 1)
        } else if (opts.targetId !== undefined && opts.targetId !== null) {
          blood.blood(end, _n, opts.crit ? 1.7 : 1)
          impacts.impact(end, normal, 'dirt', { power: 0.35 })
        } else {
          impacts.impact(end, normal, surface || 'concrete', { power: 1 })
        }
      } else if (surface) {
        impacts.impact(end, normal, surface, { power: 0.9 })
      }
    })
    return p
  }

  // ---------------------------------------------------------------------------
  // bus wiring — effects happen without gameplay asking for them
  // ---------------------------------------------------------------------------

  const unsubs = []
  const on = (ev, fn) => unsubs.push(ctx.bus.on(ev, fn))

  on('unit:shoot', (e) => {
    if (!e) return
    const weapon = weaponOf(e.shooterId)
    const shots = Math.max(1, Math.min(8, e.shots || 1))
    const from = muzzlePos(e.shooterId, e.from, new THREE.Vector3())
    const to = unitCenter(e.targetId, e.to, new THREE.Vector3())
    if (!from || !to) return
    // a burst is staggered, not simultaneous — that's what makes it read as full-auto
    const gap = weapon === 'shotgun' ? 0 : 0.085
    for (let i = 0; i < shots; i++) {
      const idx = i
      fx.schedule(idx * gap, () => {
        fireShot(from, to, {
          weapon,
          hit: e.hit !== false,
          targetId: e.targetId,
          crit: e.crit,
          armorAbsorb: e.hit !== false && (e.dmg === 0 || e.armorAbsorb === true),
          index: idx,
        })
      })
    }
    if (shots > 1 || weapon === 'shotgun') {
      ctx.bus.emit('camera:shake', { intensity: 0.09, duration: 0.16 })
    }
  })

  on('unit:damaged', (e) => {
    if (!e || e.dmg === undefined) return
    // only fire independently if no shot produced it this frame (grenades, fire)
    if (lastShotFrame === (ctx.getFrame?.() ?? 0)) return
    const p = unitCenter(e.unitId, null, new THREE.Vector3())
    if (!p) return
    _n.set(Math.random() - 0.5, 0.15, Math.random() - 0.5).normalize()
    blood.blood(p, _n, Math.min(2, 0.6 + (e.dmg || 3) / 8))
  })

  let lastShotFrame = -1
  on('unit:shoot', () => { lastShotFrame = ctx.getFrame?.() ?? 0 })

  on('unit:died', (e) => {
    const p = unitCenter(e?.unitId, null, new THREE.Vector3())
    if (!p) return
    _n.set(Math.random() - 0.5, 0.2, Math.random() - 0.5).normalize()
    blood.death(p, _n)
    ctx.bus.emit('camera:shake', { intensity: 0.14, duration: 0.3 })
  })

  on('grenade:thrown', (e) => {
    if (!e) return
    const from = muzzlePos(e.unitId, e.from, new THREE.Vector3()) || toWorld(e.from, new THREE.Vector3(), 1.4)
    const to = toWorld(e.to, new THREE.Vector3(), 0.1)
    if (!from || !to) return
    to.y = groundY(to.x, to.z) + 0.15
    const kind = (e.kind || e.type || '').toLowerCase()
    if (/smoke/.test(kind)) explosions.grenade(from, to, { smoke: true, radius: e.radius || 3.6 })
    else explosions.grenade(from, to, { radius: e.radius || 3.6, kind: /plasma|acid/.test(kind) ? 'plasma' : 'frag' })
  })

  on('explosion', (e) => {
    if (!e) return
    const p = toWorld(e.position, new THREE.Vector3())
    if (!p) return
    explosions.explosion(p, e.radius || 3.5, { kind: e.kind })
  })

  on('unit:overwatch', (e) => {
    // a small readable puff so overwatch has a physical tell
    const p = muzzlePos(e?.unitId, null, new THREE.Vector3())
    if (!p) return
    const d = unitFacing(e.unitId, new THREE.Vector3()) || new THREE.Vector3(0, 0, 1)
    muzzle.shellEject(p, d.clone().cross(UP).normalize(), 0.6)
  })

  on('unit:reload', (e) => {
    const p = muzzlePos(e?.unitId, null, new THREE.Vector3())
    if (!p) return
    const d = unitFacing(e.unitId, new THREE.Vector3()) || new THREE.Vector3(0, 0, 1)
    for (let i = 0; i < 2; i++) {
      fx.schedule(i * 0.12, () => muzzle.shellEject(p, d.clone().cross(UP).normalize(), 0.9))
    }
  })

  on('engine:resize', () => { hCache.clear() })
  on('game:ready', () => { smoke.reconfigure(); hCache.clear() })

  // ---------------------------------------------------------------------------
  // frame
  // ---------------------------------------------------------------------------

  function update(dt, time) {
    now = time
    // timers first: an effect scheduled for this instant should run this frame
    if (timers.length) {
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].t <= now) {
          const fn = timers[i].fn
          timers.splice(i, 1)
          try { fn() } catch (err) { console.error('[fx] scheduled callback failed', err) }
        }
      }
    }
    tracers.update()
    smoke.update(dt)
    explosions.update(dt, time)
    lights.update(dt)
    debris.update(dt)
    decals.update(dt)
    ptc.update(dt, time)
    if (overlay) tickOverlay(dt)
  }

  const offUpdate = ctx.onUpdate(update)

  // ---------------------------------------------------------------------------
  // stats overlay + demo
  // ---------------------------------------------------------------------------

  let overlay = null
  let ovAcc = 0
  if (params.get('fxstats') === '1' || params.get('fxtest') === '1') {
    overlay = document.createElement('div')
    overlay.id = 'fx-stats'
    overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:500;font:11px/1.45 ui-monospace,monospace;' +
      'color:#9fe8ff;background:rgba(4,8,14,.72);padding:7px 10px;border:1px solid rgba(80,160,200,.35);' +
      'white-space:pre;pointer-events:none;border-radius:3px'
    document.body.appendChild(overlay)
  }
  function tickOverlay(dt) {
    ovAcc += dt
    if (ovAcc < 0.25) return
    ovAcc = 0
    const s = api.stats
    const L = []
    L.push(`fps ${Math.round(ctx.fps || 0)}   draws ${ctx.renderer.info.render.calls}   tris ${ctx.renderer.info.render.triangles}`)
    L.push(`particles ${s.live}/${s.capacity}   spawn ${s.spawnRate}/s   depth ${s.depthPass ? s.depthPasses : 'off'}`)
    const parts = []
    for (const k in s.layers) parts.push(`${k} ${s.layers[k]}`)
    L.push(parts.join('  '))
    L.push(`lights ${s.lights}  chunks ${s.chunks}  shells ${s.shells}  clouds ${s.clouds}  rings ${s.rings}  bake ${s.bakeMs}ms`)
    overlay.textContent = L.join('\n')
  }

  // Texture-sheet inspector: ?fxsheet=smoke|fire|dust|flash|spark|glow|chips|blood|decals
  const sheet = params.get('fxsheet')
  if (sheet) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:fixed;inset:0;z-index:900;background:#101418;display:grid;' +
      'grid-auto-flow:column;place-content:center;gap:12px;padding:12px'
    for (const name of sheet.split(',')) {
      const e = textures[name]
      if (!e?.tex?.image) continue
      const col = document.createElement('div')
      const img = document.createElement('img')
      img.src = e.tex.image.toDataURL('image/png')
      img.style.cssText = 'image-rendering:pixelated;max-height:82vh;background:' +
        (params.get('fxbg') || 'repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 50%/24px 24px')
      const cap = document.createElement('div')
      cap.textContent = `${name} ${e.tiles[0]}x${e.tiles[1]}`
      cap.style.cssText = 'color:#8fd;font:12px ui-monospace,monospace;text-align:center;padding:4px'
      col.appendChild(img); col.appendChild(cap)
      wrap.appendChild(col)
    }
    document.body.appendChild(wrap)
  }

  let demoStop = null
  if (params.get('fxtest') === '1') {
    try {
      const { createDemo } = await import('./demo.js')
      demoStop = createDemo(ctx, api, fx, params)
    } catch (err) {
      console.error('[fx] demo failed to start', err)
    }
  }

  window.__FX = api
  ctx.register('fx', api)
  return api
}
