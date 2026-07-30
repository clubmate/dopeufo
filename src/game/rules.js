/**
 * Turn flow, action-point accounting, damage application, win condition.
 *
 * Every mutation of a unit's HP or AP goes through this file. Abilities and the
 * orchestrator ask rules to do it, so there is exactly one place where "did that
 * kill them / did that end the match" is decided.
 *
 * AP model (XCOM 2):
 *   - 2 AP per unit per turn.
 *   - Move within blue range: 1 AP. Dash (beyond blue, within 2x): 2 AP.
 *   - Firing costs 1 AP and ENDS the unit's turn regardless of AP left.
 *   - Overwatch / Hunker consume ALL remaining AP and end the unit's turn.
 *   - Reload costs 1 AP and does not end the turn.
 */

import { teamUnits, unitById } from './state.js'
import { AP_MAX } from './units.js'

export function createRules({ world, state, bus, los, cover, combat, pathfinding }) {
  const emit = (event, payload) => bus?.emit?.(event, payload)

  // -------------------------------------------------------------------------
  // Turn flow
  // -------------------------------------------------------------------------

  function refreshTeam(team) {
    for (const u of state.units) {
      if (u.team !== team || !u.alive) continue
      u.ap = u.apMax ?? AP_MAX
      u.turnEnded = false
      u.movedThisTurn = false
      u.hunkered = false
      u.overwatch = false // your own overwatch expires when your turn comes round
      u.signatureUsed = false
      u.flanked = false
      if (u.statuses?.length) {
        u.statuses = u.statuses
          .map((s) => ({ ...s, turns: (s.turns ?? 1) - 1 }))
          .filter((s) => s.turns > 0)
      }
    }
  }

  function startMatch() {
    state.started = true
    state.turn = 1
    state.activeTeam = 0
    state.phase = 'select'
    state.winner = null
    beginTurn(0, { firstTurn: true })
  }

  function beginTurn(team, { firstTurn = false } = {}) {
    state.activeTeam = team
    state.phase = 'select'
    state.selectedUnitId = null
    state.targetUnitId = null
    state.pendingAction = null
    refreshTeam(team)
    emit('turn:start', { team, turn: state.turn })
    if (!firstTurn) log(`Turn ${state.turn} — team ${team}`)
    return true
  }

  /** Finish the active team's turn and hand over. */
  function endTurn() {
    if (state.phase === 'over') return false
    const team = state.activeTeam
    // any unit that never acted still loses its overwatch-less AP
    for (const u of teamUnits(state, team)) u.ap = 0
    emit('turn:end', { team })
    if (checkWin()) return true
    const next = team === 0 ? 1 : 0
    if (next === 0) state.turn++
    beginTurn(next)
    return true
  }

  /** No unit on the active team can do anything -> hand over automatically. */
  function allSpent(team = state.activeTeam) {
    return teamUnits(state, team).every((u) => u.ap <= 0 || u.turnEnded)
  }

  // -------------------------------------------------------------------------
  // Action points
  // -------------------------------------------------------------------------

  function canAct(unit) {
    if (!unit || !unit.alive) return false
    if (state.phase === 'over') return false
    if (unit.team !== state.activeTeam) return false
    return unit.ap > 0 && !unit.turnEnded
  }

  function spendAP(unit, n) {
    unit.ap = Math.max(0, unit.ap - n)
    if (unit.ap === 0) unit.turnEnded = true
    return unit.ap
  }

  /** Fire/overwatch/hunker: burn everything left. */
  function endUnitTurn(unit) {
    unit.ap = 0
    unit.turnEnded = true
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * The single damage funnel. Emits `unit:damaged`, then `unit:died` + the win
   * check if it was lethal.
   * @returns {{ dmg:number, killed:boolean, hpBefore:number, hpAfter:number }}
   */
  function applyDamage(target, dmg, { sourceId = null, crit = false, graze = false } = {}) {
    if (!target || !target.alive) return { dmg: 0, killed: false, hpBefore: target?.hp ?? 0, hpAfter: target?.hp ?? 0 }
    const hpBefore = target.hp
    const amount = Math.max(0, Math.round(dmg))
    target.hp = Math.max(0, target.hp - amount)
    const killed = target.hp <= 0

    emit('unit:damaged', { unitId: target.id, dmg: amount, crit, sourceId })

    if (killed) {
      target.alive = false
      target.hp = 0
      target.overwatch = false
      target.hunkered = false
      target.ap = 0
      target.turnEnded = true
      const killer = unitById(state, sourceId)
      if (killer) killer.kills = (killer.kills || 0) + 1
      emit('unit:died', { unitId: target.id })
      log(`${target.name} (${target.className}) is down`)
      checkWin()
    }

    return { dmg: amount, killed, hpBefore, hpAfter: target.hp, graze }
  }

  function heal(target, amount, { sourceId = null } = {}) {
    if (!target?.alive) return 0
    const before = target.hp
    target.hp = Math.min(target.hpMax, target.hp + amount)
    const healed = target.hp - before
    if (healed > 0) emit('unit:damaged', { unitId: target.id, dmg: -healed, crit: false, sourceId })
    return healed
  }

  // -------------------------------------------------------------------------
  // Win condition
  // -------------------------------------------------------------------------

  function checkWin() {
    if (state.phase === 'over') return true
    const a = teamUnits(state, 0).length
    const b = teamUnits(state, 1).length
    if (a > 0 && b > 0) return false
    state.phase = 'over'
    state.winner = a > 0 ? 0 : b > 0 ? 1 : null
    emit('game:over', { winner: state.winner })
    log(state.winner === null ? 'Mutual destruction' : `Team ${state.winner} wins`)
    return true
  }

  // -------------------------------------------------------------------------
  // Facing / misc
  // -------------------------------------------------------------------------

  /** Facing is a Y rotation, 0 = +Z, CCW positive (ARCHITECTURE.md). */
  function faceTowards(unit, x, z) {
    const dx = x - unit.x
    const dz = z - unit.z
    if (dx === 0 && dz === 0) return unit.facing
    unit.facing = Math.atan2(dx, dz)
    return unit.facing
  }

  function setPosition(unit, x, z) {
    const prev = world.getTile(unit.x, unit.z)
    if (prev && prev.occupantId === unit.id) prev.occupantId = null
    unit.x = x
    unit.z = z
    const t = world.getTile(x, z)
    unit.elevation = t?.elevation || 0
    if (t) t.occupantId = unit.id
    return unit
  }

  function syncOccupancy() {
    for (let z = 0; z < world.H; z++) {
      for (let x = 0; x < world.W; x++) {
        const t = world.getTile(x, z)
        if (t) t.occupantId = null
      }
    }
    for (const u of state.units) {
      if (!u.alive) continue
      const t = world.getTile(u.x, u.z)
      if (t) t.occupantId = u.id
    }
  }

  /** Recompute the `flanked` display flag on every unit (UI reads it). */
  function refreshFlankFlags() {
    for (const u of state.units) {
      if (!u.alive) { u.flanked = false; continue }
      let flanked = false
      for (const e of state.units) {
        if (!e.alive || e.team === u.team) continue
        if (!los.hasLOS(e, u)) continue
        if (cover.coverBetween(e, u).flanked) { flanked = true; break }
      }
      u.flanked = flanked
    }
  }

  function log(msg) {
    state.log.push({ turn: state.turn, team: state.activeTeam, msg })
    if (state.log.length > 200) state.log.shift()
  }

  return {
    startMatch, beginTurn, endTurn, allSpent, refreshTeam,
    canAct, spendAP, endUnitTurn,
    applyDamage, heal, checkWin,
    faceTowards, setPosition, syncOccupancy, refreshFlankFlags, log,
    dispose() {},
  }
}
