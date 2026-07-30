/**
 * Abilities — the executable verbs of the game.
 *
 * Every entry declares its AP cost, whether it ends the unit's turn, and what it
 * needs to be targeted at, so the UI can build the ability bar from data instead
 * of hard-coding it. Execution is async because it awaits the unit renderer's
 * animation promises; with no renderer present every await resolves immediately
 * and the whole thing runs synchronously in a test.
 */

import { DIR_VEC, DIRS, TILE, toWorld } from './state.js'

export const GRENADE = { name: 'Frag Grenade', dmgMin: 3, dmgMax: 5, radius: 2.0, range: 9 }
export const MELEE = { name: 'Combat Knife', dmgMin: 4, dmgMax: 6, aimBonus: 20, critBonus: 25 }
export const HEAL_AMOUNT = 4
export const HEAL_RANGE = 6
export const STEP_MS = 190

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export function createAbilities({ world, state, bus, rules, los, cover, combat, pathfinding, rng, renderer }) {
  const emit = (e, p) => bus?.emit?.(e, p)
  const R = renderer

  const worldPos = (x, z, e = 0, y = 0) => {
    const p = toWorld(x, z, e, world.W, world.H)
    return { x: p.x, y: p.y + y, z: p.z }
  }

  function muzzleOf(unit) {
    const p = R.getMuzzlePosition(unit.id)
    if (p && Number.isFinite(p.x)) return { x: p.x, y: p.y, z: p.z }
    return worldPos(unit.x, unit.z, unit.elevation, 1.4)
  }
  function comOf(unit) {
    return worldPos(unit.x, unit.z, unit.elevation, unit.comHeight ?? 0.9)
  }

  // -------------------------------------------------------------------------
  // MOVE (with overwatch interrupts)
  // -------------------------------------------------------------------------

  /**
   * Move along `path` (which includes the start tile). Overwatching enemies
   * interrupt: the walk stops on the tile where the mover first enters their
   * LOS, the reaction shot resolves, then the walk continues if the mover lives.
   */
  async function executeMove(unit, path, { apCost = 1, isDash = false, free = false } = {}) {
    if (!path || path.length < 2) return { ok: false, reason: 'no-path' }

    if (!free) {
      rules.spendAP(unit, apCost)
      if (isDash) rules.endUnitTurn(unit)
    }
    unit.movedThisTurn = true

    emit('unit:moveStart', { unitId: unit.id, path })
    R.setPose(unit.id, 'run')

    const triggers = computeOverwatchTriggers(unit, path)

    let i = 0
    let interrupted = false
    while (i < path.length - 1 && unit.alive) {
      let stop = path.length - 1
      for (const idx of triggers.keys()) {
        if (idx > i && idx < stop) stop = idx
      }

      const seg = path.slice(i, stop + 1)
      await walkSegment(unit, seg)
      i = stop

      const watchers = triggers.get(i)
      if (watchers && unit.alive) {
        for (const w of watchers) {
          if (!unit.alive) break
          interrupted = true
          await reactionShot(w, unit)
        }
      }
    }

    R.setPose(unit.id, 'idle')
    emit('unit:moveEnd', { unitId: unit.id })
    rules.refreshFlankFlags()
    return { ok: true, tiles: path.length - 1, apCost: free ? 0 : apCost, interrupted }
  }

  /** First path index at which each overwatcher acquires the mover. */
  function computeOverwatchTriggers(unit, path) {
    const triggers = new Map()
    for (const w of state.units) {
      if (!w.alive || !w.overwatch || w.team === unit.team) continue
      if ((w.weapon.ammo | 0) <= 0) continue
      for (let i = 1; i < path.length; i++) {
        const p = path[i]
        const d = Math.hypot(w.x - p.x, w.z - p.z)
        if (d > (w.weapon.range ?? 20)) continue
        if (!los.hasLOS(w, { x: p.x, z: p.z, comHeight: unit.comHeight })) continue
        if (!triggers.has(i)) triggers.set(i, [])
        triggers.get(i).push(w)
        break
      }
    }
    return triggers
  }

  async function walkSegment(unit, seg) {
    if (seg.length < 2) return
    const anim = R.moveAlongPath(unit.id, seg)
    let animDone = false
    const done = anim.then(() => { animDone = true })

    for (let k = 1; k < seg.length; k++) {
      const tile = seg[k]
      rules.faceTowards(unit, tile.x, tile.z)
      rules.setPosition(unit, tile.x, tile.z)
      emit('unit:moveStep', { unitId: unit.id, tile })
      if (!animDone && R.hasRenderer && k < seg.length - 1) {
        await Promise.race([delay(STEP_MS), done])
      }
    }
    await anim
  }

  // -------------------------------------------------------------------------
  // FIRE
  // -------------------------------------------------------------------------

  async function executeFire(unit, target, opts = {}) {
    const preview = combat.previewShot(unit, target, opts)
    if (!preview.canFire && !opts.force) {
      return { ok: false, reason: !preview.hasAmmo ? 'no-ammo' : !preview.hasLOS ? 'no-los' : 'out-of-range' }
    }

    rules.faceTowards(unit, target.x, target.z)
    R.faceTo(unit.id, unit.facing)
    emit('unit:aim', { shooterId: unit.id, targetId: target.id })

    // `reaction` = an overwatch shot (free, and -15 aim).
    // `skipCost` = an ability already paid for the AP (aimed shot, slash).
    if (!opts.reaction && !opts.skipCost) {
      rules.spendAP(unit, 1)
      rules.endUnitTurn(unit) // firing always ends the turn (XCOM rule)
    }
    unit.weapon.ammo = Math.max(0, (unit.weapon.ammo | 0) - 1)

    await R.playAction(unit.id, opts.action || 'fire')

    const res = combat.resolveShot(unit, target, opts)
    const killed = res.hit && res.dmg >= target.hp

    emit('unit:shoot', {
      shooterId: unit.id,
      targetId: target.id,
      shots: res.shots,
      hit: res.hit,
      dmg: res.dmg,
      crit: res.crit,
      killed,
      from: muzzleOf(unit),
      to: comOf(target),
      // additive detail for fx/ui — never required by the contract
      graze: res.graze,
      reaction: !!opts.reaction,
      hitChance: preview.hitChance,
      results: res.results,
      fromTile: { x: unit.x, z: unit.z, elevation: unit.elevation },
      toTile: { x: target.x, z: target.z, elevation: target.elevation },
    })

    if (res.hit) {
      rules.applyDamage(target, res.dmg, { sourceId: unit.id, crit: res.crit, graze: res.graze })
    }
    rules.refreshFlankFlags()
    return { ok: true, ...res, killed }
  }

  async function reactionShot(watcher, mover) {
    watcher.overwatch = false
    if (!watcher.alive || !mover.alive) return
    if (!los.hasLOS(watcher, mover)) return
    if (Math.hypot(watcher.x - mover.x, watcher.z - mover.z) > (watcher.weapon.range ?? 20)) return
    if ((watcher.weapon.ammo | 0) <= 0) return
    rules.log(`${watcher.name} takes a reaction shot at ${mover.name}`)
    await executeFire(watcher, mover, { reaction: true, action: 'fire' })
  }

  // -------------------------------------------------------------------------
  // OVERWATCH / HUNKER / RELOAD
  // -------------------------------------------------------------------------

  async function executeOverwatch(unit) {
    if ((unit.weapon.ammo | 0) <= 0) return { ok: false, reason: 'no-ammo' }
    unit.overwatch = true
    rules.endUnitTurn(unit)
    R.setPose(unit.id, 'overwatch')
    emit('unit:overwatch', { unitId: unit.id })
    await R.playAction(unit.id, 'overwatch')
    return { ok: true }
  }

  async function executeHunker(unit) {
    unit.hunkered = true
    rules.endUnitTurn(unit)
    R.setPose(unit.id, 'hunker')
    emit('unit:hunker', { unitId: unit.id })
    await R.playAction(unit.id, 'hunker')
    return { ok: true }
  }

  async function executeReload(unit) {
    if (unit.weapon.ammo >= unit.weapon.ammoMax) return { ok: false, reason: 'full' }
    unit.weapon.ammo = unit.weapon.ammoMax
    rules.spendAP(unit, 1)
    emit('unit:reload', { unitId: unit.id })
    await R.playAction(unit.id, 'reload')
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // GRENADE / EXPLOSIONS
  // -------------------------------------------------------------------------

  function tilesInRadius(cx, cz, radius) {
    const out = []
    const r = Math.ceil(radius)
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const t = world.getTile(x, z)
        if (!t) continue
        if (Math.hypot(x - cx, z - cz) <= radius + 1e-6) out.push(t)
      }
    }
    return out
  }

  /** Shared blast resolution — grenades, demolish, anything explosive later. */
  async function detonate(source, cx, cz, { radius = GRENADE.radius, dmgMin = GRENADE.dmgMin, dmgMax = GRENADE.dmgMax, destroysCover = true, shake = 0.9 } = {}) {
    const centreTile = world.getTile(cx, cz)
    const pos = worldPos(cx, cz, centreTile?.elevation || 0, 0.5)

    emit('explosion', { position: pos, radius: radius * TILE })
    emit('camera:shake', { intensity: shake, duration: 0.5 })

    if (destroysCover) {
      // Ask for everything in the blast; the world is the authority on what is
      // actually destructible and returns false for anything it refuses.
      for (const t of tilesInRadius(cx, cz, radius)) {
        for (const d of DIRS) {
          if ((t.cover?.[d] | 0) > 0) world.destroyCover(t.x, t.z, d)
        }
      }
      los.invalidate()
    }

    const hits = []
    for (const u of state.units) {
      if (!u.alive) continue
      if (Math.hypot(u.x - cx, u.z - cz) > radius + 1e-6) continue
      const base = rng.range(dmgMin, dmgMax)
      const r = combat.resolveExplosion(base, u)
      hits.push({ unitId: u.id, dmg: r.dmg })
      emit('unit:shoot', {
        shooterId: source?.id ?? null,
        targetId: u.id,
        shots: 1,
        hit: true,
        dmg: r.dmg,
        crit: false,
        killed: r.dmg >= u.hp,
        from: pos,
        to: comOf(u),
        explosive: true,
      })
      rules.applyDamage(u, r.dmg, { sourceId: source?.id ?? null })
    }

    rules.refreshFlankFlags()
    return hits
  }

  async function executeGrenade(unit, x, z) {
    if ((unit.grenades | 0) <= 0) return { ok: false, reason: 'no-grenades' }
    const d = Math.hypot(unit.x - x, unit.z - z)
    if (d > GRENADE.range) return { ok: false, reason: 'out-of-range' }
    if (!los.hasLOS(unit, { x, z })) return { ok: false, reason: 'no-los' }

    unit.grenades--
    rules.spendAP(unit, 1)
    rules.endUnitTurn(unit)
    rules.faceTowards(unit, x, z)
    R.faceTo(unit.id, unit.facing)

    const t = world.getTile(x, z)
    emit('grenade:thrown', {
      unitId: unit.id,
      from: worldPos(unit.x, unit.z, unit.elevation, 1.2),
      to: worldPos(x, z, t?.elevation || 0, 0.2),
    })
    await R.playAction(unit.id, 'throw')

    const hits = await detonate(unit, x, z)
    return { ok: true, hits }
  }

  // -------------------------------------------------------------------------
  // SIGNATURE ABILITIES
  // -------------------------------------------------------------------------

  /** Ranger — close the distance and knife them. */
  async function executeSlash(unit, target) {
    if (unit.signatureUsed) return { ok: false, reason: 'used' }
    const spot = adjacentApproach(unit, target)
    if (!spot) return { ok: false, reason: 'unreachable' }

    unit.signatureUsed = true
    rules.spendAP(unit, 1)
    rules.endUnitTurn(unit)

    if (spot.path && spot.path.length > 1) {
      await executeMove(unit, spot.path, { free: true })
      if (!unit.alive) return { ok: true, interrupted: true }
    }

    const saved = unit.weapon
    unit.weapon = { ...saved, name: MELEE.name, dmgMin: MELEE.dmgMin, dmgMax: MELEE.dmgMax, curve: 'shotgun', range: 2, ammo: 1 }
    const res = await executeFire(unit, target, {
      skipCost: true, // AP already spent above
      force: true,
      action: 'melee',
      aimBonus: MELEE.aimBonus, aimLabel: 'Slash',
      critBonus: MELEE.critBonus, critLabel: 'Slash',
    })
    unit.weapon = saved
    return { ok: true, ...res }
  }

  function adjacentApproach(unit, target) {
    if (Math.max(Math.abs(unit.x - target.x), Math.abs(unit.z - target.z)) <= 1) return { path: null }
    const reach = pathfinding.flood(unit)
    let best = null
    for (const n of pathfinding.NEIGHBOURS) {
      const x = target.x + n.dx
      const z = target.z + n.dz
      const k = pathfinding.key(x, z)
      if (!reach.cost.has(k)) continue
      const c = reach.cost.get(k)
      if (c > reach.budget.dash) continue
      if (best === null || c < best.cost) best = { x, z, cost: c }
    }
    if (!best) return null
    const path = pathfinding.findPath(unit, best.x, best.z)
    return path ? { path } : null
  }

  /** Sharpshooter — spend both AP for a much better shot. */
  async function executeAimedShot(unit, target) {
    if (unit.ap < 2) return { ok: false, reason: 'needs-2-ap' }
    if (unit.signatureUsed) return { ok: false, reason: 'used' }
    unit.signatureUsed = true
    rules.spendAP(unit, 2)
    rules.endUnitTurn(unit)
    return executeFire(unit, target, {
      skipCost: true, // AP already accounted for above
      aimBonus: 25, aimLabel: 'Aimed Shot',
      critBonus: 25, critLabel: 'Aimed Shot',
      action: 'fire',
    })
  }

  /** Grenadier — shred the battlefield: big cover kill, light damage. */
  async function executeDemolish(unit, x, z) {
    if (unit.signatureUsed) return { ok: false, reason: 'used' }
    const d = Math.hypot(unit.x - x, unit.z - z)
    if (d > (unit.weapon.range ?? 20)) return { ok: false, reason: 'out-of-range' }
    if (!los.hasLOS(unit, { x, z })) return { ok: false, reason: 'no-los' }

    unit.signatureUsed = true
    rules.spendAP(unit, 1)
    rules.endUnitTurn(unit)
    unit.weapon.ammo = Math.max(0, unit.weapon.ammo - 1)
    rules.faceTowards(unit, x, z)
    await R.playAction(unit.id, 'fire')

    const hits = await detonate(unit, x, z, { radius: 1.5, dmgMin: 1, dmgMax: 3, shake: 0.6 })
    return { ok: true, hits }
  }

  /** Specialist — patch up a squadmate. Does not end the turn. */
  async function executeHeal(unit, target) {
    if (unit.signatureUsed) return { ok: false, reason: 'used' }
    if (!target?.alive || target.team !== unit.team) return { ok: false, reason: 'bad-target' }
    if (Math.hypot(unit.x - target.x, unit.z - target.z) > HEAL_RANGE) return { ok: false, reason: 'out-of-range' }
    if (target.hp >= target.hpMax) return { ok: false, reason: 'full-hp' }

    unit.signatureUsed = true
    rules.spendAP(unit, 1)
    rules.faceTowards(unit, target.x, target.z)
    await R.playAction(unit.id, 'heal')
    const healed = rules.heal(target, HEAL_AMOUNT, { sourceId: unit.id })
    return { ok: true, healed }
  }

  // -------------------------------------------------------------------------
  // Registry — the UI builds the ability bar from this.
  // -------------------------------------------------------------------------

  const ABILITIES = {
    move: {
      id: 'move', name: 'Move', hotkey: '1', target: 'tile', apCost: 1, endsTurn: false,
      available: (u) => rules.canAct(u),
    },
    fire: {
      id: 'fire', name: 'Fire', hotkey: '2', target: 'unit', apCost: 1, endsTurn: true,
      available: (u) => rules.canAct(u) && u.weapon.ammo > 0 && los.getTargets(u).length > 0,
    },
    overwatch: {
      id: 'overwatch', name: 'Overwatch', hotkey: '3', target: null, apCost: 'all', endsTurn: true,
      available: (u) => rules.canAct(u) && u.weapon.ammo > 0,
    },
    hunker: {
      id: 'hunker', name: 'Hunker Down', hotkey: '4', target: null, apCost: 'all', endsTurn: true,
      available: (u) => rules.canAct(u),
    },
    reload: {
      id: 'reload', name: 'Reload', hotkey: '5', target: null, apCost: 1, endsTurn: false,
      available: (u) => rules.canAct(u) && u.weapon.ammo < u.weapon.ammoMax,
    },
    grenade: {
      id: 'grenade', name: 'Frag Grenade', hotkey: '6', target: 'tile', apCost: 1, endsTurn: true,
      available: (u) => rules.canAct(u) && u.grenades > 0,
    },
    slash: {
      id: 'slash', name: 'Slash', hotkey: '7', target: 'unit', apCost: 1, endsTurn: true, className: 'Ranger',
      available: (u) => rules.canAct(u) && !u.signatureUsed,
    },
    aimedShot: {
      id: 'aimedShot', name: 'Aimed Shot', hotkey: '7', target: 'unit', apCost: 2, endsTurn: true, className: 'Sharpshooter',
      available: (u) => rules.canAct(u) && !u.signatureUsed && u.ap >= 2 && u.weapon.ammo > 0,
    },
    demolish: {
      id: 'demolish', name: 'Demolish', hotkey: '7', target: 'tile', apCost: 1, endsTurn: true, className: 'Grenadier',
      available: (u) => rules.canAct(u) && !u.signatureUsed && u.weapon.ammo > 0,
    },
    heal: {
      id: 'heal', name: 'Medikit', hotkey: '7', target: 'ally', apCost: 1, endsTurn: false, className: 'Specialist',
      available: (u) => rules.canAct(u) && !u.signatureUsed,
    },
  }

  function listFor(unit) {
    if (!unit) return []
    return (unit.abilities || [])
      .map((id) => ABILITIES[id])
      .filter(Boolean)
      .map((a) => ({
        id: a.id, name: a.name, hotkey: a.hotkey, target: a.target,
        apCost: a.apCost === 'all' ? Math.max(1, unit.ap) : a.apCost,
        endsTurn: a.endsTurn,
        available: !!a.available(unit),
      }))
  }

  return {
    ABILITIES, listFor,
    executeMove, executeFire, executeOverwatch, executeHunker, executeReload,
    executeGrenade, executeSlash, executeAimedShot, executeDemolish, executeHeal,
    detonate, reactionShot, computeOverwatchTriggers, tilesInRadius, adjacentApproach,
    GRENADE, MELEE,
    dispose() {},
  }
}
