/**
 * game/ — the tactical simulation and the turn controller.
 *
 * This module owns truth. Rendering, UI, audio and FX are downstream: they react
 * to the events emitted here and never mutate state themselves.
 *
 * It is deliberately survivable:
 *   - `ctx.world` missing or half-built  -> a complete fallback battlefield is
 *     synthesised (see state.js `adaptWorld`), per-method.
 *   - `ctx.units` missing                -> every animation call becomes a
 *     resolved promise, so the sim runs (and is testable) with no renderer.
 * Nothing in game/ imports three.js.
 */

import { adaptWorld, createGameState, unitById, unitAt, teamUnits, toWorld } from './state.js'
import { createRNG } from './rng.js'
import { createPathfinding } from './pathfinding.js'
import { createLOS } from './los.js'
import { createCover } from './cover.js'
import { createCombat } from './combat.js'
import { createRules } from './rules.js'
import { createAbilities } from './abilities.js'
import { createSquad, DEFAULT_SQUAD, resetUnitIds } from './units.js'

const resolved = () => Promise.resolve()

/** Wrap ctx.units so a missing/partial renderer can never break the rules. */
export function createRendererBridge(units) {
  const has = (n) => !!(units && typeof units[n] === 'function')
  const safe = (n, args) => {
    if (!has(n)) return resolved()
    try {
      const v = units[n](...args)
      return v && typeof v.then === 'function' ? v.catch((e) => console.warn(`[game] units.${n} rejected`, e)) : resolved()
    } catch (err) {
      console.warn(`[game] units.${n} threw`, err)
      return resolved()
    }
  }
  return {
    hasRenderer: !!(units && (has('moveAlongPath') || has('spawn'))),
    spawn(u) { if (has('spawn')) { try { units.spawn(u) } catch (e) { console.warn('[game] units.spawn threw', e) } } },
    despawn(id) { if (has('despawn')) { try { units.despawn(id) } catch { /* optional */ } } },
    moveAlongPath(id, path) { return safe('moveAlongPath', [id, path]) },
    playAction(id, action) { return safe('playAction', [id, action]) },
    setPose(id, pose) { if (has('setPose')) { try { units.setPose(id, pose) } catch { /* optional */ } } },
    faceTo(id, angle) { if (has('faceTo')) { try { units.faceTo(id, angle) } catch { /* optional */ } } },
    getMuzzlePosition(id) {
      if (!has('getMuzzlePosition')) return null
      try { return units.getMuzzlePosition(id) } catch { return null }
    },
  }
}

/**
 * Build the whole simulation. Exported separately from `init` so tests can
 * construct a headless match with no ctx, no bus and no renderer.
 */
export function createSimulation({ world = null, bus = null, units = null, grid = null, seed = 'dopeufo', squads = null } = {}) {
  const W = adaptWorld(world, grid || { W: 24, H: 24 })
  const state = createGameState({ seed })
  const rng = createRNG(seed)
  const renderer = createRendererBridge(units)

  const pathfinding = createPathfinding({ world: W, state })
  const los = createLOS({ world: W, state })
  const cover = createCover({ world: W, state, los })
  const combat = createCombat({ world: W, state, los, cover, rng })
  const rules = createRules({ world: W, state, bus, los, cover, combat, pathfinding })
  const abilities = createAbilities({ world: W, state, bus, rules, los, cover, combat, pathfinding, rng, renderer })

  // --- deployment ----------------------------------------------------------
  function deploy(comp = DEFAULT_SQUAD) {
    resetUnitIds()
    state.units.length = 0
    for (const team of [0, 1]) {
      const zone = W.getDeployZone(team)
      const spots = pickSpread(zone, comp.length)
      const squad = createSquad(team, spots, comp)
      state.units.push(...squad)
    }
    for (const u of state.units) {
      const t = W.getTile(u.x, u.z)
      u.elevation = t?.elevation || 0
    }
    rules.syncOccupancy()
    rules.refreshFlankFlags()
    for (const u of state.units) renderer.spawn(u)
    return state.units
  }

  /** Evenly spaced picks so a squad doesn't spawn stacked in one corner. */
  function pickSpread(zone, n) {
    if (!zone.length) return Array.from({ length: n }, (_, i) => ({ x: 2 + i * 2, z: 2 }))
    const sorted = zone.slice().sort((a, b) => a.x - b.x || a.z - b.z)
    const out = []
    for (let i = 0; i < n; i++) {
      const idx = Math.min(sorted.length - 1, Math.round(((i + 0.5) / n) * sorted.length))
      let pick = sorted[idx]
      let step = 1
      while (out.some((p) => p.x === pick.x && p.z === pick.z) && step < sorted.length) {
        pick = sorted[(idx + step) % sorted.length]
        step++
      }
      out.push(pick)
    }
    return out
  }

  if (squads !== false) deploy(squads || DEFAULT_SQUAD)

  return { state, world: W, rng, renderer, pathfinding, los, cover, combat, rules, abilities, deploy }
}

// ---------------------------------------------------------------------------
// The turn controller / event orchestration
// ---------------------------------------------------------------------------

export function createController(sim, bus) {
  const { state, world, rules, los, cover, combat, pathfinding, abilities } = sim
  const emit = (e, p) => bus?.emit?.(e, p)

  let busy = false
  let hoverTile = null
  let reachCache = { unitId: null, stamp: -1, data: null }
  let stamp = 0

  const touch = () => { stamp++ }

  function selected() {
    return unitById(state, state.selectedUnitId)
  }

  function getReachable(unit) {
    if (!unit) return { blue: new Set(), dash: new Set() }
    if (reachCache.unitId === unit.id && reachCache.stamp === stamp) return reachCache.data
    const data = pathfinding.getReachable(unit)
    reachCache = { unitId: unit.id, stamp, data }
    return data
  }

  // --- selection -----------------------------------------------------------

  function selectUnit(unitId) {
    const u = unitById(state, unitId)
    if (!u || !u.alive) return false
    if (u.team !== state.activeTeam) {
      // inspecting an enemy: allowed, but it is not "selection"
      state.targetUnitId = u.id
      return false
    }
    state.selectedUnitId = u.id
    state.targetUnitId = null
    state.pendingAction = null
    if (state.phase !== 'over') state.phase = 'select'
    touch()
    emit('unit:selected', { unitId: u.id })
    emit('camera:focus', { position: worldOf(u), immediate: false })
    return true
  }

  /** The UI's target cycler calls this; it only records intent. */
  function setTarget(unitId) {
    const u = unitById(state, unitId)
    if (!u || u.team === state.activeTeam) return false
    state.targetUnitId = u.id
    return true
  }

  function deselect() {
    if (!state.selectedUnitId) return
    state.selectedUnitId = null
    state.targetUnitId = null
    state.pendingAction = null
    if (state.phase !== 'over') state.phase = 'select'
    emit('unit:deselected', {})
  }

  function selectNextReady(team = state.activeTeam) {
    const list = teamUnits(state, team).filter((u) => rules.canAct(u))
    if (!list.length) return false
    const cur = list.findIndex((u) => u.id === state.selectedUnitId)
    const next = list[(cur + 1) % list.length]
    return selectUnit(next.id)
  }

  function worldOf(u) {
    return toWorld(u.x, u.z, u.elevation, world.W, world.H)
  }

  // --- previews (pure, safe to call every mouse move) -----------------------

  function previewMove(unit, x, z) {
    unit = unit || selected()
    if (!unit) return null
    const reach = getReachable(unit)
    const k = pathfinding.key(x, z)
    const inBlue = reach.blue.has(k)
    const inDash = reach.dash.has(k)
    if (!inBlue && !inDash) return { valid: false, x, z, reason: 'unreachable' }
    const path = pathfinding.findPath(unit, x, z)
    if (!path) return { valid: false, x, z, reason: 'unreachable' }
    const cost = pathfinding.pathCost(unit, path)
    const apCost = inBlue ? 1 : 2
    return {
      valid: apCost <= unit.ap,
      x, z, path, cost, apCost,
      dash: !inBlue,
      cover: cover.previewCoverAt(unit, x, z),
      exposedTo: los.visibleEnemies(unit, { from: { x, z } }).map((e) => e.id),
      reason: apCost > unit.ap ? 'not-enough-ap' : null,
    }
  }

  function previewShot(attacker, target, opts) {
    const a = typeof attacker === 'string' ? unitById(state, attacker) : attacker || selected()
    const t = typeof target === 'string' ? unitById(state, target) : target
    if (!a || !t) return null
    return combat.previewShot(a, t, opts)
  }

  // --- actions -------------------------------------------------------------

  async function run(fn) {
    if (busy || state.phase === 'over') return { ok: false, reason: 'busy' }
    busy = true
    state.phase = 'animating'
    try {
      return await fn()
    } catch (err) {
      console.error('[game] action failed', err)
      return { ok: false, reason: 'error', err }
    } finally {
      busy = false
      touch()
      if (state.phase !== 'over') state.phase = 'select'
      afterAction()
    }
  }

  function afterAction() {
    if (state.phase === 'over') return
    const sel = selected()
    if (sel && !rules.canAct(sel)) {
      state.pendingAction = null
      if (!selectNextReady()) deselect()
    }
    if (rules.allSpent(state.activeTeam)) {
      deselect()
      rules.endTurn()
      if (state.phase !== 'over') selectNextReady()
    }
  }

  async function moveTo(x, z, unit = null) {
    const u = unit || selected()
    if (!u || !rules.canAct(u)) return { ok: false, reason: 'cannot-act' }
    const p = previewMove(u, x, z)
    if (!p || !p.valid) return { ok: false, reason: p?.reason || 'unreachable' }
    return run(async () => {
      state.phase = 'moving'
      const r = await abilities.executeMove(u, p.path, { apCost: p.apCost, isDash: p.apCost >= 2 })
      return r
    })
  }

  async function fireAt(targetId, unit = null, opts = {}) {
    const u = unit || selected()
    const t = typeof targetId === 'string' ? unitById(state, targetId) : targetId
    if (!u || !t) return { ok: false, reason: 'bad-target' }
    if (!rules.canAct(u)) return { ok: false, reason: 'cannot-act' }
    return run(() => abilities.executeFire(u, t, opts))
  }

  /**
   * Single entry point the UI uses. `params` carries the target:
   *   { x, z } for tile abilities, { targetId } for unit abilities.
   */
  async function useAbility(id, params = {}, unit = null) {
    const u = unit || selected()
    if (!u) return { ok: false, reason: 'no-selection' }
    if (id !== 'endturn' && !rules.canAct(u)) return { ok: false, reason: 'cannot-act' }
    const target = params.targetId ? unitById(state, params.targetId) : null

    switch (id) {
      case 'move': return moveTo(params.x, params.z, u)
      case 'fire': return fireAt(target || state.targetUnitId, u)
      case 'overwatch': return run(() => abilities.executeOverwatch(u))
      case 'hunker': return run(() => abilities.executeHunker(u))
      case 'reload': return run(() => abilities.executeReload(u))
      case 'grenade': return run(() => abilities.executeGrenade(u, params.x, params.z))
      case 'slash': return run(() => abilities.executeSlash(u, target))
      case 'aimedShot': return run(() => abilities.executeAimedShot(u, target))
      case 'demolish': return run(() => abilities.executeDemolish(u, params.x, params.z))
      case 'heal': return run(() => abilities.executeHeal(u, target))
      case 'endturn': return endTurn()
      default: return { ok: false, reason: 'unknown-ability' }
    }
  }

  function endTurn() {
    if (busy) return { ok: false, reason: 'busy' }
    deselect()
    rules.endTurn()
    touch()
    if (state.phase !== 'over') selectNextReady()
    return { ok: true }
  }

  // --- bus wiring ----------------------------------------------------------

  const offs = []
  function wire() {
    if (!bus) return
    offs.push(bus.on('unit:click', ({ unitId, button } = {}) => {
      const u = unitById(state, unitId)
      if (!u || busy || state.phase === 'over') return
      if (u.team === state.activeTeam) {
        if (state.pendingAction === 'heal') { useAbility('heal', { targetId: u.id }); return }
        selectUnit(u.id)
      } else {
        state.targetUnitId = u.id
        const sel = selected()
        if (!sel) return
        if (state.pendingAction === 'slash') useAbility('slash', { targetId: u.id })
        else if (state.pendingAction === 'aimedShot') useAbility('aimedShot', { targetId: u.id })
        else if (state.pendingAction === 'fire' || button === 2) useAbility('fire', { targetId: u.id })
      }
    }))

    offs.push(bus.on('tile:click', ({ x, z } = {}) => {
      if (busy || state.phase === 'over') return
      const sel = selected()
      if (!sel) {
        const u = unitAt(state, x, z)
        if (u) selectUnit(u.id)
        return
      }
      const pending = state.pendingAction
      if (pending === 'grenade') useAbility('grenade', { x, z })
      else if (pending === 'demolish') useAbility('demolish', { x, z })
      else useAbility('move', { x, z })
    }))

    offs.push(bus.on('tile:hover', (p) => {
      hoverTile = p && typeof p.x === 'number' ? { x: p.x, z: p.z } : null
      const sel = selected()
      if (!sel || !hoverTile) return
      const preview = previewMove(sel, hoverTile.x, hoverTile.z)
      emit('game:preview', { kind: state.pendingAction || 'move', unitId: sel.id, tile: hoverTile, move: preview })
    }))

    offs.push(bus.on('ui:ability', ({ ability } = {}) => {
      if (busy || state.phase === 'over') return
      if (ability === 'endturn') { endTurn(); return }
      const sel = selected()
      if (!sel) return
      const def = abilities.ABILITIES[ability]
      if (!def) return
      if (!def.target) { useAbility(ability); return }
      // The HUD picks its own target before confirming a shot; if one is
      // already locked, "fire" means fire, not "enter targeting mode".
      if (def.target === 'unit' && state.targetUnitId) {
        const t = unitById(state, state.targetUnitId)
        if (t?.alive && t.team !== sel.team && los.hasLOS(sel, t)) {
          useAbility(ability, { targetId: t.id })
          return
        }
      }
      state.pendingAction = ability
      state.phase = 'targeting'
      touch()
      emit('game:targeting', {
        unitId: sel.id,
        ability,
        targets: def.target === 'unit'
          ? los.getTargets(sel).map((t) => ({ unitId: t.id, ...combat.previewShot(sel, t) }))
          : [],
      })
    }))

    offs.push(bus.on('ui:cancel', () => {
      if (busy) return
      state.pendingAction = null
      state.targetUnitId = null
      if (state.phase !== 'over') state.phase = 'select'
      touch()
      emit('game:targeting', { unitId: state.selectedUnitId, ability: null, targets: [] })
    }))

    offs.push(bus.on('ui:endTurn', () => endTurn()))
  }

  wire()

  return {
    selectUnit, deselect, selectNextReady, setTarget,
    moveTo, fireAt, useAbility, endTurn,
    previewMove, previewShot, getReachable,
    canAct: (u) => rules.canAct(typeof u === 'string' ? unitById(state, u) : u),
    isBusy: () => busy,
    hoverTile: () => hoverTile,
    touch,
    dispose() { for (const off of offs) off?.() },
  }
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

export async function init(ctx) {
  let seed = 'dopeufo'
  try {
    if (typeof location !== 'undefined') {
      seed = new URLSearchParams(location.search).get('seed') || seed
    }
  } catch { /* non-browser */ }

  const sim = createSimulation({
    world: ctx.world,
    bus: ctx.bus,
    units: ctx.units,
    grid: ctx.grid,
    seed,
  })

  const controller = createController(sim, ctx.bus)
  const { state, rules, los, cover, combat, pathfinding, abilities, world } = sim

  /**
   * The registered API *is* the GameState object — `ctx.state.phase`,
   * `ctx.state.units` etc. read live, and the methods hang off the same object
   * so the UI only needs one reference.
   */
  const api = Object.assign(state, {
    // sub-systems, for anyone who needs to ask a deeper question
    world, rules, los, cover, combat, pathfinding, abilities,
    rng: sim.rng,

    // queries
    getUnit: (id) => unitById(state, id),
    getUnitAt: (x, z) => unitAt(state, x, z),
    getTeam: (t) => teamUnits(state, t),
    getSelected: () => unitById(state, state.selectedUnitId),
    abilitiesFor: (u) => abilities.listFor(typeof u === 'string' ? unitById(state, u) : u || unitById(state, state.selectedUnitId)),
    getTargets: (u) => los.getTargets(typeof u === 'string' ? unitById(state, u) : u),
    visibleEnemies: (u) => los.visibleEnemies(typeof u === 'string' ? unitById(state, u) : u),
    coverBetween: (a, b) => cover.coverBetween(a, b),
    previewCoverAt: (u, x, z) => cover.previewCoverAt(typeof u === 'string' ? unitById(state, u) : u, x, z),
    hasLOS: (a, b) => los.hasLOS(a, b),
    getTile: (x, z) => world.getTile(x, z),

    // commands
    ...controller,

    dispose() {
      controller.dispose()
      abilities.dispose?.()
      combat.dispose?.()
      cover.dispose?.()
      los.dispose?.()
      pathfinding.dispose?.()
      rules.dispose?.()
    },
  })

  ctx.register('state', api)
  ctx.register('game', api)

  // Kick the match off on the next tick so ui/ and input/ (which boot after us)
  // have their listeners attached before the first turn:start goes out.
  const start = () => {
    try {
      rules.startMatch()
      controller.selectNextReady(0)
    } catch (err) {
      console.error('[game] failed to start match', err)
    }
  }
  if (ctx.bus) {
    ctx.bus.once('game:ready', () => { if (!state.started) start() })
    // safety net: if boot never announces itself, start anyway
    if (typeof setTimeout === 'function') {
      const t = setTimeout(() => { if (!state.started) start() }, 2000)
      t?.unref?.() // never hold a node process (or a test run) open
    } else start()
  } else {
    start()
  }

  return api
}
