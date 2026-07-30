/**
 * Audio subsystem entry point.
 *
 * Owns the mixer, the sound catalogue, ambience and the procedural score, and
 * subscribes to the event bus so that gameplay produces audio without any other
 * module having to know audio exists.
 *
 * Autoplay policy (important): no AudioContext is constructed until a genuine
 * user gesture. Before that, `init` completes normally, the API is registered
 * and every call is accepted and silently discarded. That is what lets the
 * headless screenshot harness — which never clicks anything — boot with audio
 * fully "working" and completely silent, with nothing logged.
 */

import { createAudioEngine } from './engine.js'
import { playSfx, CATALOGUE, SFX_IDS } from './sfx.js'
import { createAmbience } from './ambience.js'
import { createMusic } from './music.js'

const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'keydown']

export async function init(ctx) {
  const E = createAudioEngine()
  const ambience = createAmbience(E)
  const music = createMusic(E)

  const disposers = []
  const on = (event, fn) => disposers.push(ctx.bus.on(event, fn))

  // --- helpers --------------------------------------------------------------

  // ctx.grid.toWorld writes into a THREE.Vector3 target — a plain object throws.
  // Every helper below copies out of this scratch vector immediately, so it is
  // safe to share and costs no per-event allocation.
  const tmp = new ctx.THREE.Vector3()

  /** Accepts a Vector3, a world {x,y,z}, a tile {x,z,elevation} or a grid coord. */
  function worldPos(p, lift = 1.1) {
    if (!p) return null
    if (typeof p.y === 'number' && typeof p.elevation !== 'number') {
      return { x: p.x, y: p.y, z: p.z }
    }
    if (typeof p.x === 'number' && typeof p.z === 'number') {
      const v = ctx.grid.toWorld(p.x, p.z, p.elevation ?? 0, tmp)
      return { x: v.x, y: v.y + lift, z: v.z }
    }
    return null
  }

  function unit(id) {
    const units = ctx.state?.units
    if (!units || !id) return null
    for (const u of units) if (u.id === id) return u
    return null
  }

  function unitPos(id, lift = 1.2) {
    const u = unit(id)
    if (!u) return null
    const v = ctx.grid.toWorld(u.x, u.z, u.elevation ?? 0, tmp)
    return { x: v.x, y: v.y + lift, z: v.z }
  }

  function tileAt(x, z) {
    const w = ctx.world
    if (!w) return null
    try {
      return w.getTile?.(x, z) ?? w.tileAt?.(x, z) ?? w.tiles?.[z * ctx.grid.W + x] ?? null
    } catch {
      return null
    }
  }

  const SURFACE_ALIAS = {
    asphalt: 'concrete', road: 'concrete', stone: 'concrete', rubble: 'gravel',
    grass: 'dirt', sand: 'dirt', mud: 'dirt', earth: 'dirt', soil: 'dirt',
    steel: 'metal', grate: 'metal', catwalk: 'metal', plank: 'wood', crate: 'wood',
  }

  function surfaceAt(x, z) {
    const t = tileAt(x, z)
    const raw = String(t?.surface || t?.material || t?.ground || '').toLowerCase()
    if (!raw) return 'concrete'
    if (SURFACE_ALIAS[raw]) return SURFACE_ALIAS[raw]
    if (['concrete', 'dirt', 'gravel', 'metal', 'wood'].includes(raw)) return raw
    return 'concrete'
  }

  /**
   * Reverb space. Anything walled in on three or more sides, or explicitly
   * flagged by world/, gets the long dark IR — alleys and interiors sound
   * completely different from a street and it is free to detect.
   */
  function spaceAt(x, z) {
    const t = tileAt(x, z)
    if (!t) return 'outdoor'
    if (t.indoor || t.interior) return 'indoor'
    const c = t.cover
    if (c) {
      let full = 0
      for (const k of ['n', 'e', 's', 'w']) if ((c[k] | 0) >= 2) full++
      if (full >= 3) return 'indoor'
    }
    return 'outdoor'
  }

  const WEAPON_PATTERNS = [
    [/sniper|marksman|dmr|railgun|beam rifle|longrange/, 'gun.sniper'],
    [/smg|submachine|machine ?pistol|vector|uzi/, 'gun.smg'],
    [/shotgun|scatter|breach/, 'gun.shotgun'],
    [/launcher|grenade|rocket|mortar|cannon/, 'gun.launcher'],
    [/pistol|sidearm|revolver|magnum/, 'gun.pistol'],
    [/rifle|carbine|assault|lmg|gun/, 'gun.rifle'],
  ]
  const CLASS_WEAPON = {
    sharpshooter: 'gun.sniper', sniper: 'gun.sniper',
    ranger: 'gun.shotgun', scout: 'gun.smg',
    grenadier: 'gun.launcher', heavy: 'gun.rifle',
    specialist: 'gun.rifle', support: 'gun.rifle',
  }

  function weaponSound(id) {
    const u = unit(id)
    const name = String(u?.weapon?.name || '').toLowerCase()
    for (const [re, sound] of WEAPON_PATTERNS) if (re.test(name)) return sound
    const cls = String(u?.className || u?.class || '').toLowerCase()
    if (CLASS_WEAPON[cls]) return CLASS_WEAPON[cls]
    return 'gun.rifle'
  }

  const BURST_GAP = { 'gun.smg': 0.068, 'gun.rifle': 0.098, 'gun.shotgun': 0.5, 'gun.sniper': 0.9, 'gun.pistol': 0.16, 'gun.launcher': 0.7 }

  // --- api ------------------------------------------------------------------

  function play(id, opts = {}) {
    if (!E.live()) return null
    return playSfx(E, id, opts)
  }

  function play3D(id, position, opts = {}) {
    const p = worldPos(position)
    if (!p) return play(id, opts)
    return play(id, { ...opts, position: p, space: opts.space || 'outdoor' })
  }

  // --- unlocking ------------------------------------------------------------

  let unlocking = false
  let unlocked = false

  async function resume() {
    if (unlocked || unlocking) return unlocked
    unlocking = true
    let ok = false
    try {
      ok = await E.unlock()
    } catch {
      ok = false
    }
    unlocking = false
    if (!ok) return false
    unlocked = true
    detachGestures()
    E.updateListener(ctx.camera)
    E.onReady(() => {
      // give the IRs a moment to land before the beds fade in
      ambience.start()
      music.setIntensity(0.2, 0.1)
      music.start()
    })
    return true
  }

  const onGesture = () => { resume() }
  function attachGestures() {
    for (const g of GESTURES) window.addEventListener(g, onGesture, { passive: true, capture: true })
  }
  function detachGestures() {
    for (const g of GESTURES) window.removeEventListener(g, onGesture, { capture: true })
  }
  attachGestures()
  disposers.push(detachGestures)

  // Pause the world when the tab is hidden — background audio from a game you
  // aren't looking at is the fastest way to get muted forever.
  function onVisibility() {
    if (!E.ready || !E.ctx || E.offline) return
    try {
      if (document.hidden) E.ctx.suspend?.()
      else if (unlocked) E.ctx.resume?.()
    } catch { /* transient state, ignore */ }
  }
  document.addEventListener('visibilitychange', onVisibility)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

  // --- gameplay wiring ------------------------------------------------------

  const lastStep = new Map()
  let lastHover = null
  let lastHoverAt = 0

  on('unit:shoot', (p) => {
    if (!E.live()) return
    const sound = weaponSound(p.shooterId)
    const from = worldPos(p.from, 1.4) || unitPos(p.shooterId, 1.4)
    const to = worldPos(p.to, 1.0) || unitPos(p.targetId, 1.0)
    const shots = Math.max(1, p.shots | 0 || 1)
    const gap = BURST_GAP[sound] ?? 0.1
    const shooter = unit(p.shooterId)
    const space = shooter ? spaceAt(shooter.x, shooter.z) : 'outdoor'

    for (let i = 0; i < shots; i++) {
      // uneven spacing + level variation: the difference between "a burst" and
      // "the same sample four times"
      const d = i * gap * (0.92 + Math.random() * 0.16)
      play(sound, {
        position: from,
        delay: d,
        volume: 0.92 + Math.random() * 0.16,
        space,
        reverb: space === 'indoor' ? 0.5 : undefined,
      })
      if (sound !== 'gun.launcher' && sound !== 'gun.shotgun') {
        play('weapon.shell', { position: from, delay: d, volume: 0.9 })
      }

      if (!to) continue
      const flight = 0.035 + Math.random() * 0.03
      if (p.hit) {
        play('impact.flesh', { position: to, delay: d + flight, volume: p.crit ? 1.15 : 0.95 })
        if (p.crit) play('impact.concrete', { position: to, delay: d + flight, volume: 0.35 })
      } else {
        play('impact.whizby', { position: to, delay: d + flight * 0.6, volume: 0.7 })
        const t = unit(p.targetId)
        const surf = t ? surfaceAt(t.x, t.z) : 'concrete'
        if (Math.random() < 0.45) {
          play('impact.ricochet', { position: to, delay: d + flight, volume: 0.55 })
        } else {
          play(`impact.${surf === 'gravel' ? 'dirt' : surf}`, { position: to, delay: d + flight, volume: 0.7 })
        }
      }
    }
    music.bump(0.3, 5)
  })

  on('unit:damaged', (p) => {
    if (!E.live()) return
    const pos = unitPos(p.unitId, 1.1)
    if (!pos) return
    // armour / kit taking the hit, under whatever the projectile did
    play('impact.metal', { position: pos, volume: p.crit ? 0.28 : 0.16, reverb: 0.1 })
    play('gear.rattle', { position: pos, volume: 0.8 })
    music.bump(0.2, 4)
  })

  on('unit:died', (p) => {
    if (!E.live()) return
    const pos = unitPos(p.unitId, 0.5)
    const u = unit(p.unitId)
    const friendly = u ? u.team === (ctx.state?.activeTeam ?? 0) : false
    play(friendly ? 'stinger.down' : 'stinger.kill', { volume: 1 })
    if (pos) {
      play('impact.dirt', { position: pos, delay: 0.22, volume: 1.0 })
      play('gear.rattle', { position: pos, delay: 0.24, volume: 1.4 })
      play('impact.metal', { position: pos, delay: 0.3, volume: 0.2 })
    }
    music.bump(0.35, 8)
  })

  on('unit:moveStep', (p) => {
    if (!E.live()) return
    const now = E.ctx.currentTime
    const prev = lastStep.get(p.unitId) || 0
    if (now - prev < 0.17) return
    lastStep.set(p.unitId, now)
    const tile = p.tile || {}
    const pos = worldPos(tile, 0.15) || unitPos(p.unitId, 0.15)
    if (!pos) return
    const surf = surfaceAt(tile.x, tile.z)
    play(`step.${surf}`, { position: pos, volume: 0.85 + Math.random() * 0.3 })
    if (Math.random() < 0.6) play('gear.rattle', { position: pos, delay: 0.02, volume: 0.7 })
  })

  on('unit:moveStart', (p) => {
    const pos = unitPos(p.unitId)
    if (pos) play('weapon.lower', { position: pos, volume: 0.7 })
    music.bump(0.12, 3)
  })

  on('unit:moveEnd', (p) => {
    const pos = unitPos(p.unitId)
    if (pos) play('weapon.raise', { position: pos, volume: 0.6 })
  })

  on('unit:aim', (p) => {
    const pos = unitPos(p.shooterId, 1.4)
    if (pos) play('weapon.raise', { position: pos, volume: 0.9 })
    music.setIntensity(0.68, 1.2)
  })

  on('unit:reload', (p) => {
    const pos = unitPos(p.unitId, 1.3)
    if (!pos) return
    play('weapon.magOut', { position: pos, volume: 1 })
    play('weapon.magIn', { position: pos, delay: 0.34 + Math.random() * 0.08, volume: 1 })
    play('weapon.bolt', { position: pos, delay: 0.62 + Math.random() * 0.1, volume: 0.9 })
  })

  on('unit:overwatch', (p) => {
    const pos = unitPos(p.unitId, 1.4)
    play('stinger.overwatch', { volume: 1 })
    if (pos) {
      play('weapon.raise', { position: pos, volume: 0.9 })
      play('weapon.bolt', { position: pos, delay: 0.12, volume: 0.6 })
    }
    music.bump(0.18, 6)
  })

  on('unit:hunker', (p) => {
    const pos = unitPos(p.unitId, 0.8)
    if (pos) {
      play('gear.rattle', { position: pos, volume: 1.6 })
      play('step.dirt', { position: pos, delay: 0.09, volume: 0.6 })
    }
  })

  on('unit:selected', (p) => {
    play('ui.select')
    const pos = unitPos(p.unitId)
    if (pos) play('gear.rattle', { position: pos, volume: 0.8 })
  })
  on('unit:deselected', () => play('ui.tick', { volume: 0.7 }))

  on('grenade:thrown', (p) => {
    const from = worldPos(p.from, 1.4)
    if (from) {
      play('grenade.pin', { position: from, volume: 1 })
      play('grenade.throw', { position: from, delay: 0.14, volume: 1 })
    }
    music.bump(0.25, 4)
  })

  on('explosion', (p) => {
    if (!E.live()) return
    const pos = worldPos(p.position, 0.6)
    const big = (p.radius ?? 4) >= 3.5
    play(big ? 'explosion.large' : 'explosion.small', {
      position: pos,
      volume: 1,
      reverb: 0.55,
    })
    music.bump(0.4, 7)
  })

  on('turn:start', (p) => {
    const enemy = (p.team ?? 0) !== 0
    play('stinger.turn', { enemy, volume: 1 })
    music.setIntensity(enemy ? 0.42 : 0.24, 3)
    ambience.setIntensity(0.4 + Math.random() * 0.3)
  })

  on('game:over', (p) => {
    const won = p.winner === 0
    play(won ? 'stinger.victory' : 'stinger.defeat', { volume: 1 })
    music.setIntensity(0, 3)
    setTimeout(() => music.stop(6), 900)
    ambience.setIntensity(0.15)
  })

  // --- ui events ------------------------------------------------------------

  on('ui:ability', (p) => {
    const a = String(p?.ability || '')
    if (a === 'endturn') play('ui.confirm')
    else play('ui.ability')
  })
  on('ui:cancel', () => play('ui.cancel'))
  on('ui:endTurn', () => play('ui.confirm'))
  on('ui:hover', () => hoverTick('ui'))
  on('ui:click', () => play('ui.select'))
  on('ui:error', () => play('ui.error'))
  on('ui:denied', () => play('ui.error'))

  function hoverTick(key) {
    if (!E.live()) return
    const now = E.ctx.currentTime
    if (key === lastHover && now - lastHoverAt < 0.4) return
    if (now - lastHoverAt < 0.045) return
    lastHover = key
    lastHoverAt = now
    play('ui.hover')
  }

  on('tile:hover', (p) => {
    if (!p) return
    hoverTick(`t${p.x},${p.z}`)
  })
  on('unit:hover', (p) => {
    if (!p) return
    hoverTick(`u${p.unitId}`)
  })
  on('tile:click', (p) => {
    if (p?.button === 2) play('ui.cancel')
    else play('ui.tick', { volume: 1.2 })
  })
  on('unit:click', (p) => {
    if (p?.button === 2) play('ui.cancel')
  })

  // --- per-frame ------------------------------------------------------------

  let intensityTimer = 0

  const stopUpdate = ctx.onUpdate((dt) => {
    if (!E.live()) return
    E.updateListener(ctx.camera)
    music.update(dt)
    ambience.update(dt)

    intensityTimer += dt
    if (intensityTimer >= 0.5) {
      intensityTimer = 0
      autoIntensity()
    }
  })
  disposers.push(stopUpdate)

  /** Derive a standing tension level from game state. */
  function autoIntensity() {
    const s = ctx.state
    if (!s || !music.running) return
    let base = 0.22
    switch (s.phase) {
      case 'targeting': base = 0.7; break
      case 'moving': base = 0.42; break
      case 'animating': base = 0.5; break
      case 'over': base = 0; break
      default: base = 0.22
    }
    const units = s.units || []
    if (units.length) {
      let hurt = 0
      let alive = 0
      for (const u of units) {
        if (!u.alive) continue
        alive++
        if (u.hp < u.hpMax * 0.5) hurt++
        if (u.flanked) hurt += 0.6
      }
      if (alive) base += Math.min(0.25, (hurt / alive) * 0.35)
    }
    music.setIntensity(Math.min(1, base), 5)
  }

  // --- public api -----------------------------------------------------------

  const api = {
    play,
    play3D,
    resume,
    get ready() { return E.live() },
    get unlocked() { return unlocked },
    ids: SFX_IDS,

    setBusVolume(bus, v) { E.setBusVolume(bus, v) },
    getBusVolume(bus) { return E.getBusVolume(bus) },
    mute(on = true) { E.setMute(on) },
    get muted() { return E.muted },

    setMusicIntensity(v) { music.setIntensity(v, 3) },
    get musicIntensity() { return music.intensity },
    music,
    ambience,

    /** Escape hatches for debug/tools. */
    engine: E,
    catalogue: CATALOGUE,

    stopAll() {
      for (const v of [...E.voices]) E.release(v, 0.03)
    },

    dispose() {
      for (const d of disposers) {
        try { d() } catch { /* already gone */ }
      }
      disposers.length = 0
      try { music.dispose() } catch { /* not built */ }
      try { ambience.dispose() } catch { /* not built */ }
      E.dispose()
    },
  }

  ctx.register('audio', api)
  return api
}
