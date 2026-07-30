/* ============================================================================
   DOPE UFO — UI module entry
   ----------------------------------------------------------------------------
   Owns every pixel of the 2D interface. Builds one #ui-root layer, mounts the
   five components into it, and drives them from a single read-only *store* that
   sits between the HUD and whatever the game module happens to expose.

   The store exists because this module boots alongside game/, not after it in
   any guaranteed sense — the HUD has to render something sane when ctx.state is
   null, when previewShot() doesn't exist yet, and when ctx.units has no meshes
   to project. Every read goes through the store and every read is guarded.

   ?uitest=1 swaps the store's source for a fully-populated mock (two squads, a
   selection, a target, a complete shot breakdown) so the interface can be built
   and screenshotted before the rules land. The mock is gated on that parameter
   alone and can never appear in a normal session.

   Bus contract — emitted:  ui:ability {ability} | ui:cancel {} | ui:endTurn {}
   Unit selection and shot confirmation reuse input/'s `unit:click`, which is
   the only sanctioned channel for "the player picked this unit".
   ========================================================================== */

import { createHud } from './hud.js'
import { createAbilityBar, ABILITIES } from './abilitybar.js'
import { createShotPanel } from './shotpanel.js'
import { createWorldUI } from './worldui.js'
import { createBanners } from './banners.js'

const CALLSIGNS = ['ARCLIGHT', 'NIGHTJAR']

const EMPTY_STATE = {
  turn: 1,
  activeTeam: 0,
  phase: 'select',
  units: [],
  selectedUnitId: null,
  targetUnitId: null,
  pendingAction: null,
  winner: null,
}

/* ========================================================== mock scenario */

function buildMock() {
  const wep = (name, dmgMin, dmgMax, range, ammo, ammoMax, critBonus = 0) => ({
    name, dmgMin, dmgMax, critBonus, range, ammo, ammoMax, spread: 1, shots: 1,
  })

  const u = (id, team, name, className, rank, x, z, hp, hpMax, armor, weapon, extra = {}) => ({
    id, team, name, className, rank,
    x, z, elevation: extra.elevation || 0, facing: 0,
    hp, hpMax, armor,
    aim: 75, defense: 10, mobility: 12, crit: 12, dodge: 10, will: 50,
    ap: extra.ap ?? 2, apMax: 2,
    weapon,
    abilities: ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade'],
    statuses: [],
    alive: extra.alive !== false,
    overwatch: !!extra.overwatch,
    hunkered: !!extra.hunkered,
    flanked: !!extra.flanked,
    ...extra,
  })

  const units = [
    u('u_0', 0, 'VOSS', 'Ranger', 4, 8, 14, 7, 8, 1, wep('Shard Carbine', 4, 6, 12, 3, 4)),
    u('u_1', 0, 'KOVÁC', 'Sharpshooter', 5, 9, 16, 6, 7, 0, wep('Marksman Rifle', 5, 8, 22, 2, 4), { elevation: 1 }),
    u('u_2', 0, 'RIEGER', 'Grenadier', 3, 7, 17, 8, 9, 2, wep('Autocannon', 6, 9, 14, 5, 6), { hunkered: true, ap: 0 }),
    u('u_3', 0, 'ADEYEMI', 'Specialist', 2, 6, 15, 2, 7, 0, wep('Bullpup', 3, 5, 13, 0, 4), { overwatch: true }),

    u('u_4', 1, 'HALLOWAY', 'Ranger', 3, 15, 9, 5, 8, 0, wep('Shard Carbine', 4, 6, 12, 4, 4)),
    u('u_5', 1, 'SORENSEN', 'Grenadier', 4, 16, 11, 6, 9, 1, wep('Autocannon', 6, 9, 14, 6, 6), { flanked: true }),
    u('u_6', 1, 'MBEKI', 'Specialist', 2, 14, 12, 7, 7, 0, wep('Bullpup', 3, 5, 13, 3, 4), { overwatch: true }),
    u('u_7', 1, 'ZHAO', 'Sharpshooter', 5, 17, 8, 0, 7, 0, wep('Marksman Rifle', 5, 8, 22, 1, 4), { alive: false, ap: 0 }),
  ]

  const state = {
    turn: 4,
    activeTeam: 0,
    phase: 'targeting',
    units,
    selectedUnitId: 'u_1',
    targetUnitId: 'u_5',
    pendingAction: 'fire',
    winner: null,
  }

  const tiles = new Map()
  const setCover = (x, z, cover, elevation = 0) =>
    tiles.set(`${x},${z}`, { x, z, elevation, walkable: true, cost: 1, occupantId: null, cover, destructible: true, hazard: null })
  setCover(9, 16, { n: 0, e: 2, s: 0, w: 1 }, 1)
  setCover(8, 14, { n: 1, e: 0, s: 0, w: 0 })
  setCover(7, 17, { n: 2, e: 0, s: 0, w: 2 })
  setCover(16, 11, { n: 0, e: 0, s: 1, w: 0 })
  setCover(15, 9, { n: 2, e: 0, s: 0, w: 0 })

  const MODS = {
    u_4: [
      { label: 'Base aim', value: 78 },
      { label: 'Range (14 tiles)', value: -12 },
      { label: 'Target in full cover', value: -40 },
      { label: 'Height advantage', value: 20 },
      { label: 'Target defense', value: -10 },
    ],
    u_5: [
      { label: 'Base aim', value: 78 },
      { label: 'Range (9 tiles)', value: -4 },
      { label: 'Flanked — cover ignored', value: 0 },
      { label: 'Height advantage', value: 20 },
      { label: 'Target defense', value: -10 },
      { label: 'Steady weapon', value: 8 },
    ],
    u_6: [
      { label: 'Base aim', value: 78 },
      { label: 'Range (7 tiles)', value: 2 },
      { label: 'Target in half cover', value: -20 },
      { label: 'Height advantage', value: 20 },
      { label: 'Target defense', value: -10 },
      { label: 'Target hunkered', value: -20 },
    ],
  }

  function previewShot(a, t) {
    const modifiers = (MODS[t?.id] || MODS.u_5).map((m) => ({ ...m }))
    const raw = modifiers.reduce((s, m) => s + m.value, 0)
    const hitChance = Math.max(1, Math.min(100, raw))
    return {
      hitChance,
      critChance: t?.flanked ? 42 : 14,
      dodgeChance: t?.dodge ?? 10,
      dmgMin: a?.weapon?.dmgMin ?? 5,
      dmgMax: a?.weapon?.dmgMax ?? 8,
      modifiers,
    }
  }

  return { state, tiles, previewShot }
}

/* ================================================================== store */

function createStore(ctx, mock) {
  let localTarget = null
  let lastGameTarget = null

  let cache = { key: '', value: null, at: -1 }

  const store = {
    mock: !!mock,

    state() {
      if (mock) return mock.state
      const s = ctx.state
      if (s && Array.isArray(s.units)) return s
      return EMPTY_STATE
    },

    callsign(team) {
      const s = store.state()
      return s.teams?.[team]?.name || CALLSIGNS[team === 1 ? 1 : 0]
    },

    unit(id) {
      if (!id) return null
      return store.state().units.find((u) => u.id === id) || null
    },

    selected() {
      return store.unit(store.state().selectedUnitId)
    },

    /** Enemies this unit could legally shoot, in a stable order. */
    candidates() {
      const s = store.state()
      const a = store.selected()
      if (!a || a.alive === false) return []

      const fromGame = ctx.game?.getTargets?.(a.id)
      if (Array.isArray(fromGame) && fromGame.length) {
        return fromGame
          .map((t) => (typeof t === 'string' ? store.unit(t) : t && t.id ? store.unit(t.id) || t : null))
          .filter(Boolean)
      }

      const range = a.weapon?.range ?? 14
      return s.units
        .filter((u) => u.team !== a.team && u.alive !== false)
        .filter((u) => Math.max(Math.abs(u.x - a.x), Math.abs(u.z - a.z)) <= range)
        .sort((p, q) => (p.id < q.id ? -1 : 1))
    },

    target() {
      const s = store.state()
      // adopt the game's target whenever it changes underneath us
      if (s.targetUnitId && s.targetUnitId !== lastGameTarget) {
        lastGameTarget = s.targetUnitId
        localTarget = s.targetUnitId
      }
      const cands = store.candidates()
      if (!cands.length) return null
      const hit = cands.find((u) => u.id === localTarget)
      if (hit) return hit
      localTarget = cands[0].id
      return cands[0]
    },

    setTarget(id) {
      const cands = store.candidates()
      if (!cands.some((u) => u.id === id)) return
      localTarget = id
      if (mock) mock.state.targetUnitId = id
      ctx.game?.setTarget?.(id)
      ctx.bus.emit('unit:hover', { unitId: id })
    },

    cycleTarget(dir) {
      const cands = store.candidates()
      if (cands.length < 2) return
      const t = store.target()
      const i = Math.max(0, cands.findIndex((u) => u.id === t?.id))
      const n = (i + (dir > 0 ? 1 : -1) + cands.length) % cands.length
      store.setTarget(cands[n].id)
    },

    selectUnit(id) {
      const u = store.unit(id)
      if (!u || u.alive === false) return
      if (mock) {
        mock.state.selectedUnitId = id
        localTarget = null
      }
      ctx.bus.emit('unit:click', { unitId: id, button: 0 })
    },

    /** Cycle through this team's units that still have actions left. */
    cycleUnit(dir = 1) {
      const s = store.state()
      const own = s.units.filter((u) => u.team === s.activeTeam && u.alive !== false)
      if (!own.length) return
      const ready = own.filter((u) => (u.ap | 0) > 0)
      const pool = ready.length ? ready : own
      const i = pool.findIndex((u) => u.id === s.selectedUnitId)
      const n = i < 0 ? 0 : (i + (dir > 0 ? 1 : -1) + pool.length) % pool.length
      store.selectUnit(pool[n].id)
    },

    setPending(id) {
      if (mock) mock.state.pendingAction = id
    },

    clearPending() {
      if (mock) mock.state.pendingAction = null
    },

    confirmShot() {
      const t = store.target()
      if (!t) return
      ctx.bus.emit('ui:ability', { ability: 'fire' })
      ctx.bus.emit('unit:click', { unitId: t.id, button: 0 })
    },

    shotVisible() {
      const s = store.state()
      if (s.phase === 'over') return false
      const a = store.selected()
      const t = store.target()
      if (!a || !t) return false
      if (mock) return true
      return s.phase === 'targeting' || s.pendingAction === 'fire' || !!s.targetUnitId
    },

    /** Cached previewShot — recomputed on change, and never more than 4x/sec. */
    preview() {
      const a = store.selected()
      const t = store.target()
      if (!a || !t) return null
      const key = `${a.id}:${a.ap}:${a.weapon?.ammo}:${a.x},${a.z},${a.elevation}|${t.id}:${t.hp}:${t.x},${t.z},${t.elevation}:${t.hunkered ? 1 : 0}:${t.flanked ? 1 : 0}`
      const now = ctx.time || 0
      if (cache.key === key && cache.value && now - cache.at < 0.25) return cache.value
      let v = null
      try {
        // In uitest the mock wins outright: the harness must render the same
        // numbers every run regardless of how far along the rules module is.
        if (mock) {
          v = mock.previewShot(a, t)
        } else {
          const fn = ctx.game?.previewShot || ctx.state?.previewShot
          if (fn) v = fn.call(ctx.game || ctx.state, a, t)
        }
      } catch (err) {
        console.warn('[ui] previewShot failed', err)
      }
      if (!v || typeof v.hitChance !== 'number') {
        // Degrade to something honest rather than something wrong.
        v = {
          hitChance: 0,
          critChance: 0,
          dodgeChance: t.dodge || 0,
          dmgMin: a.weapon?.dmgMin ?? 0,
          dmgMax: a.weapon?.dmgMax ?? 0,
          modifiers: [{ label: 'Awaiting firing solution', value: 0 }],
        }
      }
      cache = { key, value: v, at: now }
      return v
    },

    tile(x, z) {
      if (mock) return mock.tiles.get(`${x},${z}`) || null
      const w = ctx.world
      if (w?.getTile) {
        try { return w.getTile(x, z) } catch { return null }
      }
      const s = ctx.state
      if (s?.getTile) {
        try { return s.getTile(x, z) } catch { return null }
      }
      if (Array.isArray(s?.tiles)) return s.tiles[z * (ctx.grid?.W || 24) + x] || null
      return null
    },
  }

  return store
}

/* ================================================================== init */

export async function init(ctx) {
  const params = new URLSearchParams(location.search)
  const uitest = params.get('uitest') === '1'
  const mock = uitest ? buildMock() : null

  const root = document.createElement('div')
  root.className = 'ui-root'
  root.id = 'ui-root'
  root.dataset.team = '0'
  root.innerHTML = '<div class="ui-grain" aria-hidden="true"></div><div class="ui-vig" aria-hidden="true"></div>'
  document.body.appendChild(root)

  const store = createStore(ctx, mock)

  const parts = []
  const safe = (name, fn) => {
    try {
      const p = fn()
      parts.push(p)
      return p
    } catch (err) {
      console.error(`[ui] component "${name}" failed to build`, err)
      return { update() {}, dispose() {} }
    }
  }

  const hud = safe('hud', () => createHud(ctx, root, store))
  const abar = safe('abilitybar', () => createAbilityBar(ctx, root, store))
  const shot = safe('shotpanel', () => createShotPanel(ctx, root, store))
  const world = safe('worldui', () => createWorldUI(ctx, root, store))
  const banners = safe('banners', () => createBanners(ctx, root, store))

  /* ------------------------------------------------------------ keyboard */
  const KEYMAP = {}
  for (const a of ABILITIES) KEYMAP[a.key] = a.id

  function onKey(e) {
    const tag = e.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return

    // Any key clears a live turn banner — never make a player wait on chrome.
    if (banners.busy) {
      banners.skip()
      if (e.key !== 'Escape') return
    }

    const k = e.key
    if (KEYMAP[k]) {
      e.preventDefault()
      abar.trigger(KEYMAP[k])
      return
    }

    switch (k) {
      case ' ':
      case 'Spacebar':
        e.preventDefault()
        abar.trigger('endturn')
        break
      case 'Escape':
        e.preventDefault()
        store.clearPending()
        ctx.bus.emit('ui:cancel', {})
        break
      case 'Enter':
        e.preventDefault()
        if (store.shotVisible()) store.confirmShot()
        break
      case 'Tab':
        e.preventDefault()
        store.cycleUnit(e.shiftKey ? -1 : 1)
        break
      case 'q':
      case 'Q':
      case 'ArrowLeft':
        if (store.shotVisible()) {
          e.preventDefault()
          store.cycleTarget(-1)
        }
        break
      case 'e':
      case 'E':
      case 'ArrowRight':
        if (store.shotVisible()) {
          e.preventDefault()
          store.cycleTarget(1)
        }
        break
      default:
        break
    }
  }
  window.addEventListener('keydown', onKey)

  /* ---------------------------------------------------------------- loop */
  // DOM panels diff their own content, but there is no reason to run that diff
  // 60x a second — 20 Hz is imperceptible for text and a third of the work.
  let acc = 0
  const PANEL_HZ = 1 / 20

  function frame(dt) {
    acc += dt
    if (acc >= PANEL_HZ) {
      acc = 0
      try { hud.update() } catch (err) { console.warn('[ui] hud', err) }
      try { abar.update() } catch (err) { console.warn('[ui] abar', err) }
      try { shot.update() } catch (err) { console.warn('[ui] shot', err) }
    }
    try { shot.tick(dt) } catch { /* count-up is cosmetic */ }
    try { world.update(dt) } catch (err) { console.warn('[ui] worldui', err) }
  }
  const offUpdate = ctx.onUpdate(frame)

  /* --------------------------------------------------------- bus reactions */
  const off = []
  const on = (ev, fn) => off.push(ctx.bus.on(ev, fn))

  on('turn:start', () => {
    root.dataset.team = String((ctx.state?.activeTeam ?? store.state().activeTeam) === 1 ? 1 : 0)
  })
  on('game:over', () => {
    root.classList.add('is-over')
    world.setEnabled(false)
  })
  on('unit:aim', (p) => p?.targetId && store.setTarget(p.targetId))
  on('game:ready', () => hud.update())

  // first paint before the boot screen lifts
  try { hud.update(); abar.update(); shot.update() } catch { /* first paint is best-effort */ }
  requestAnimationFrame(() => root.classList.add('is-live'))

  let demoTimer = 0
  if (uitest) {
    // Exercise the world layer without a game driving it. Looped, because the
    // floaters live ~1.5s and a screenshot taken after settle would otherwise
    // always catch an empty overlay.
    const demo = () => {
      world.spawn('u_5', '−7', 'crit', 'CRITICAL')
      world.spawn('u_4', 'MISS', 'miss', '')
      world.spawn('u_6', '−2', 'graze', 'GRAZE')
      world.spawn('u_0', '−4', 'dmg', '')
    }
    setTimeout(demo, 200)
    demoTimer = setInterval(demo, 2600)
    setTimeout(() => banners.alert('overwatch', 'MBEKI ON OVERWATCH'), 120)
  }

  const api = {
    root,
    hud,
    abar,
    shot,
    world,
    banners,
    /** Manually raise a transient alert — audio/fx can call this. */
    alert: (kind, title) => banners.alert(kind, title),
    /** Force the turn banner (used by game/ if it wants an explicit hand-over). */
    showTurnBanner: (team, turn) => banners.showTurn(team, turn),
    /** Spawn a world-anchored number. */
    floater: (unitId, text, kind, tag) => world.spawn(unitId, text, kind, tag),
    setVisible(v) {
      root.classList.toggle('is-hidden', !v)
      world.setEnabled(!!v)
    },
    dispose() {
      offUpdate?.()
      if (demoTimer) clearInterval(demoTimer)
      off.forEach((f) => f && f())
      window.removeEventListener('keydown', onKey)
      parts.forEach((p) => {
        try { p.dispose?.() } catch { /* ignore */ }
      })
      root.remove()
    },
  }

  ctx.register('ui', api)
  return api
}
