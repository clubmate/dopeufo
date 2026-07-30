import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, makeSim, place, recorder, EventBus } from './helpers.mjs'
import { createUnit } from '../src/game/units.js'

function match({ W = 16, H = 16, seed = 'turns' } = {}) {
  const bus = new EventBus()
  const w = makeWorld(W, H)
  return { bus, w, mk: (world = w) => makeSim(world, { seed, bus }) }
}

test('a fresh turn gives every unit of the active team 2 AP', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 1 }), 2, 12)
  sim.rules.startMatch()

  assert.equal(sim.state.activeTeam, 0)
  assert.equal(sim.state.turn, 1)
  assert.equal(sim.state.phase, 'select')
  assert.equal(a.ap, 2)
  assert.equal(sim.rules.canAct(a), true)
  assert.equal(sim.rules.canAct(b), false, 'the other team cannot act on your turn')
})

test('AP accounting: move 1, dash 2, fire always ends the turn', async () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const u = place(sim, createUnit({ team: 0, className: 'Specialist', overrides: { mobility: 4 } }), 2, 2)
  const enemy = place(sim, createUnit({ team: 1, className: 'Ranger' }), 8, 2)
  sim.rules.startMatch()

  // 1 AP move
  let path = sim.pathfinding.findPath(u, 5, 2)
  await sim.abilities.executeMove(u, path, { apCost: 1 })
  assert.equal(u.ap, 1)
  assert.equal(u.x, 5)
  assert.equal(u.turnEnded, false)

  // firing spends the last AP and ends the turn
  await sim.abilities.executeFire(u, enemy)
  assert.equal(u.ap, 0)
  assert.equal(u.turnEnded, true)

  // fresh unit, dash burns both AP at once
  const v = place(sim, createUnit({ team: 0, className: 'Ranger', overrides: { mobility: 4 } }), 2, 6)
  sim.rules.refreshTeam(0)
  path = sim.pathfinding.findPath(v, 9, 6)
  assert.equal(sim.pathfinding.apForPath(v, path), 2)
  await sim.abilities.executeMove(v, path, { apCost: 2, isDash: true })
  assert.equal(v.ap, 0)
  assert.equal(v.turnEnded, true, 'a dashing unit cannot fire')
})

test('firing with 2 AP still ends the unit turn (XCOM rule)', async () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const u = place(sim, createUnit({ team: 0 }), 2, 2)
  const e = place(sim, createUnit({ team: 1 }), 6, 2)
  sim.rules.startMatch()
  assert.equal(u.ap, 2)
  await sim.abilities.executeFire(u, e)
  assert.equal(u.ap, 0)
  assert.equal(u.turnEnded, true)
})

test('overwatch and hunker consume all remaining AP and end the turn', async () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 0 }), 3, 2)
  sim.rules.startMatch()

  await sim.abilities.executeOverwatch(a)
  assert.equal(a.overwatch, true)
  assert.equal(a.ap, 0)
  assert.equal(a.turnEnded, true)

  await sim.abilities.executeHunker(b)
  assert.equal(b.hunkered, true)
  assert.equal(b.ap, 0)
})

test('reload costs 1 AP and does not end the turn', async () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const u = place(sim, createUnit({ team: 0 }), 2, 2)
  sim.rules.startMatch()
  u.weapon.ammo = 0
  await sim.abilities.executeReload(u)
  assert.equal(u.weapon.ammo, u.weapon.ammoMax)
  assert.equal(u.ap, 1)
  assert.equal(u.turnEnded, false)
})

test('turn hands over, refreshes the new team and increments the round', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const rec = recorder(bus)
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 1 }), 2, 12)
  sim.rules.startMatch()
  rec.clear()

  a.ap = 0
  sim.rules.endTurn()
  assert.equal(sim.state.activeTeam, 1)
  assert.equal(sim.state.turn, 1, 'the round only ticks when it comes back to team 0')
  assert.equal(b.ap, 2)
  assert.deepEqual(rec.names(), ['turn:end', 'turn:start'])
  assert.deepEqual(rec.of('turn:end')[0].payload, { team: 0 })
  assert.deepEqual(rec.of('turn:start')[0].payload, { team: 1, turn: 1 })

  sim.rules.endTurn()
  assert.equal(sim.state.activeTeam, 0)
  assert.equal(sim.state.turn, 2)
  assert.equal(a.ap, 2)
})

test('your own overwatch expires when your next turn begins', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  place(sim, createUnit({ team: 1 }), 2, 12)
  sim.rules.startMatch()
  a.overwatch = true
  a.hunkered = true
  sim.rules.endTurn() // -> team 1
  assert.equal(a.overwatch, true, 'still watching during the enemy turn')
  sim.rules.endTurn() // -> team 0
  assert.equal(a.overwatch, false)
  assert.equal(a.hunkered, false)
})

test('allSpent detects a team that has nothing left to do', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 0 }), 3, 2)
  place(sim, createUnit({ team: 1 }), 2, 12)
  sim.rules.startMatch()
  assert.equal(sim.rules.allSpent(0), false)
  a.ap = 0
  assert.equal(sim.rules.allSpent(0), false)
  b.ap = 0
  assert.equal(sim.rules.allSpent(0), true)
})

// ---------------------------------------------------------------------------
// Overwatch interrupt ordering
// ---------------------------------------------------------------------------

/**
 * A one-tile corridor at z = 7 (walled off at z = 6), with a double-thickness
 * wall along z = 8 / z = 9 that has a single gap column at x = 8. The watcher
 * sits south of the wall and can only see into the corridor through that gap.
 */
function overwatchScene() {
  const bus = new EventBus()
  const w = makeWorld(16, 16)
  for (let x = 0; x < 16; x++) {
    w.prop(x, 6, 2)
    if (x === 8) continue
    w.prop(x, 8, 2)
    w.prop(x, 9, 2)
  }
  const sim = makeSim(w, { seed: 'ow', bus })
  const mover = place(sim, createUnit({ team: 0, className: 'Ranger', overrides: { mobility: 14 } }), 2, 7)
  const watcher = place(sim, createUnit({ team: 1, className: 'Sharpshooter' }), 8, 12)
  sim.rules.startMatch()
  watcher.overwatch = true
  return { sim, bus, mover, watcher }
}

test('the overwatch scene only exposes the mover at the gap', () => {
  const { sim, watcher } = overwatchScene()
  for (let x = 2; x <= 13; x++) {
    const seen = sim.los.hasLOS(watcher, { x, z: 7 })
    assert.equal(seen, x === 8, `x=${x} should ${x === 8 ? '' : 'not '}be visible`)
  }
})

test('overwatch interrupts the move at the exact tile LOS is gained, then the move resumes', async () => {
  const { sim, bus, mover, watcher } = overwatchScene()
  const rec = recorder(bus)
  const path = sim.pathfinding.findPath(mover, 13, 7)
  assert.equal(path.length, 12)

  watcher.aim = 200 // guarantee the reaction lands so damage ordering is testable
  await sim.abilities.executeMove(mover, path, { apCost: 1 })

  const names = rec.names()
  assert.equal(names[0], 'unit:moveStart')
  assert.equal(names[names.length - 1], 'unit:moveEnd')

  const steps = rec.of('unit:moveStep')
  assert.equal(steps.length, 11, 'one step per tile entered')

  const aimIdx = names.indexOf('unit:aim')
  const shootIdx = names.indexOf('unit:shoot')
  const dmgIdx = names.indexOf('unit:damaged')
  assert.ok(aimIdx > 0, 'a reaction shot happened')
  assert.ok(aimIdx < shootIdx && shootIdx < dmgIdx, 'aim -> shoot -> damaged')

  // the interrupt must land after the mover reaches the gap column (x = 8) and
  // before it walks on
  const stepsBefore = names.slice(0, aimIdx).filter((n) => n === 'unit:moveStep').length
  assert.equal(stepsBefore, 6, 'stopped on (8,7), the 6th tile of the walk')
  const tileAtInterrupt = steps[stepsBefore - 1].payload.tile
  assert.deepEqual({ x: tileAtInterrupt.x, z: tileAtInterrupt.z }, { x: 8, z: 7 })

  const stepsAfter = names.slice(shootIdx).filter((n) => n === 'unit:moveStep').length
  assert.equal(stepsAfter, 5, 'the move continues afterwards')

  assert.equal(rec.of('unit:shoot')[0].payload.shooterId, watcher.id)
  assert.equal(rec.of('unit:shoot')[0].payload.targetId, mover.id)
  assert.equal(watcher.overwatch, false, 'overwatch is spent')
  assert.equal(mover.x, 13, 'the mover finished the path')
})

test('a reaction shot uses the -15 reaction penalty', async () => {
  const { sim, bus, mover, watcher } = overwatchScene()
  const rec = recorder(bus)
  const clean = sim.combat.previewShot(watcher, { ...mover, x: 8, z: 7 })
  const path = sim.pathfinding.findPath(mover, 13, 7)
  await sim.abilities.executeMove(mover, path, { apCost: 1 })
  const shot = rec.of('unit:shoot')[0].payload
  assert.equal(shot.reaction, true)
  assert.equal(shot.hitChance, clean.hitChance - 15)
})

test('a lethal reaction shot stops the movement dead', async () => {
  const { sim, bus, mover, watcher } = overwatchScene()
  const rec = recorder(bus)
  watcher.aim = 500
  watcher.weapon.dmgMin = 99
  watcher.weapon.dmgMax = 99
  const path = sim.pathfinding.findPath(mover, 13, 7)
  await sim.abilities.executeMove(mover, path, { apCost: 1 })

  assert.equal(mover.alive, false)
  assert.equal(mover.x, 8, 'never took another step')
  const names = rec.names()
  assert.ok(names.includes('unit:died'))
  assert.ok(names.indexOf('unit:died') < names.lastIndexOf('unit:moveEnd'))
  assert.equal(names.filter((n) => n === 'unit:moveStep').length, 6)
})

test('an out-of-ammo overwatcher does not interrupt', async () => {
  const { sim, bus, mover, watcher } = overwatchScene()
  const rec = recorder(bus)
  watcher.weapon.ammo = 0
  const path = sim.pathfinding.findPath(mover, 13, 7)
  await sim.abilities.executeMove(mover, path, { apCost: 1 })
  assert.equal(rec.of('unit:shoot').length, 0)
  assert.equal(rec.of('unit:moveStep').length, 11)
})

// ---------------------------------------------------------------------------
// Damage / win condition
// ---------------------------------------------------------------------------

test('damage funnels through rules and emits damaged then died', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 1 }), 4, 2)
  const c = place(sim, createUnit({ team: 1 }), 5, 2)
  sim.rules.startMatch()
  const rec = recorder(bus)

  let r = sim.rules.applyDamage(b, 3, { sourceId: a.id })
  assert.equal(r.killed, false)
  assert.equal(b.hp, b.hpMax - 3)
  assert.deepEqual(rec.names(), ['unit:damaged'])
  assert.deepEqual(rec.of('unit:damaged')[0].payload, { unitId: b.id, dmg: 3, crit: false, sourceId: a.id })

  rec.clear()
  r = sim.rules.applyDamage(b, 999, { sourceId: a.id, crit: true })
  assert.equal(r.killed, true)
  assert.equal(b.alive, false)
  assert.deepEqual(rec.names(), ['unit:damaged', 'unit:died'])
  assert.equal(a.kills, 1)
  assert.equal(sim.state.phase, 'select', 'team 1 still has a unit standing')
  assert.ok(c.alive)
})

test('wiping a team ends the match with the right winner', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 1 }), 4, 2)
  sim.rules.startMatch()
  const rec = recorder(bus)

  sim.rules.applyDamage(b, 999, { sourceId: a.id })
  assert.deepEqual(rec.names(), ['unit:damaged', 'unit:died', 'game:over'])
  assert.deepEqual(rec.of('game:over')[0].payload, { winner: 0 })
  assert.equal(sim.state.phase, 'over')
  assert.equal(sim.state.winner, 0)
  assert.equal(sim.rules.canAct(a), false, 'nothing can act after the match ends')
})

test('the losing side wins if it is the survivor', () => {
  const { bus, w } = match()
  const sim = makeSim(w, { bus })
  const a = place(sim, createUnit({ team: 0 }), 2, 2)
  const b = place(sim, createUnit({ team: 1 }), 4, 2)
  sim.rules.startMatch()
  sim.rules.applyDamage(a, 999, { sourceId: b.id })
  assert.equal(sim.state.winner, 1)
})

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

test('a grenade destroys cover, damages everything in radius and never misses', async () => {
  const bus = new EventBus()
  const w = makeWorld(16, 16)
  w.prop(8, 7, 2) // cover the victim is hiding behind
  const sim = makeSim(w, { seed: 'nade', bus })
  const thrower = place(sim, createUnit({ team: 0, className: 'Grenadier' }), 8, 2)
  const victim = place(sim, createUnit({ team: 1, className: 'Ranger' }), 8, 8)
  const bystander = place(sim, createUnit({ team: 1, className: 'Specialist' }), 14, 14)
  sim.rules.startMatch()
  const rec = recorder(bus)

  assert.equal(sim.world.getTile(8, 8).cover.n, 2)
  const hpBefore = victim.hp

  const res = await sim.abilities.executeGrenade(thrower, 8, 8)
  assert.equal(res.ok, true)
  assert.ok(rec.names().includes('grenade:thrown'))
  assert.ok(rec.names().includes('explosion'))
  assert.ok(victim.hp < hpBefore, 'grenades always connect')
  assert.equal(bystander.hp, bystander.hpMax, 'outside the radius')
  assert.equal(sim.world.getTile(8, 8).cover.n, 0, 'cover is gone')
  assert.equal(thrower.grenades, 0)
  assert.equal(thrower.ap, 0, 'throwing ends the turn')

  // and now the victim is flanked
  assert.equal(sim.cover.coverBetween(thrower, victim).flanked, true)
})

// ---------------------------------------------------------------------------
// Signature abilities
// ---------------------------------------------------------------------------

test('aimed shot costs both AP and buys +25 aim / +25 crit', async () => {
  const bus = new EventBus()
  const w = makeWorld(16, 16)
  const sim = makeSim(w, { seed: 'aim', bus })
  const sharp = place(sim, createUnit({ team: 0, className: 'Sharpshooter' }), 4, 4)
  const target = place(sim, createUnit({ team: 1, className: 'Ranger' }), 12, 4)
  sim.rules.startMatch()

  const plain = sim.combat.previewShot(sharp, target)
  const aimed = sim.combat.previewShot(sharp, target, { aimBonus: 25, critBonus: 25 })
  assert.equal(aimed.hitChance, Math.min(100, plain.hitChance + 25))
  assert.equal(aimed.critChance, Math.min(100, plain.critChance + 25))

  const r = await sim.abilities.executeAimedShot(sharp, target)
  assert.equal(r.ok, true)
  assert.equal(sharp.ap, 0)
  assert.equal(sharp.signatureUsed, true)

  sharp.ap = 1
  sharp.signatureUsed = false
  assert.deepEqual(await sim.abilities.executeAimedShot(sharp, target), { ok: false, reason: 'needs-2-ap' })
})

test('the specialist medikit heals an ally without ending the turn', async () => {
  const bus = new EventBus()
  const sim = makeSim(makeWorld(16, 16), { seed: 'heal', bus })
  const spec = place(sim, createUnit({ team: 0, className: 'Specialist' }), 4, 4)
  const hurt = place(sim, createUnit({ team: 0, className: 'Ranger' }), 5, 4)
  place(sim, createUnit({ team: 1 }), 12, 12)
  sim.rules.startMatch()
  hurt.hp = 3

  const r = await sim.abilities.executeHeal(spec, hurt)
  assert.equal(r.ok, true)
  assert.equal(hurt.hp, 7)
  assert.equal(spec.ap, 1)
  assert.equal(spec.turnEnded, false)
})

test('the ranger closes the distance and slashes', async () => {
  const bus = new EventBus()
  const sim = makeSim(makeWorld(16, 16), { seed: 'slash', bus })
  const ranger = place(sim, createUnit({ team: 0, className: 'Ranger', overrides: { mobility: 8 } }), 2, 2)
  const victim = place(sim, createUnit({ team: 1, className: 'Specialist' }), 8, 2)
  sim.rules.startMatch()

  const r = await sim.abilities.executeSlash(ranger, victim)
  assert.equal(r.ok, true)
  assert.equal(Math.max(Math.abs(ranger.x - victim.x), Math.abs(ranger.z - victim.z)), 1, 'moved adjacent')
  assert.equal(ranger.ap, 0)
  assert.equal(ranger.weapon.name, 'Shard Shotgun', 'the melee weapon swap is temporary')
})

test('the grenadier demolishes cover at range', async () => {
  const bus = new EventBus()
  const w = makeWorld(16, 16)
  w.prop(8, 7, 2)
  const sim = makeSim(w, { seed: 'demo', bus })
  const gren = place(sim, createUnit({ team: 0, className: 'Grenadier' }), 8, 2)
  const victim = place(sim, createUnit({ team: 1, className: 'Ranger' }), 8, 8)
  sim.rules.startMatch()
  assert.equal(sim.world.getTile(8, 8).cover.n, 2)
  const r = await sim.abilities.executeDemolish(gren, 8, 8)
  assert.equal(r.ok, true)
  assert.equal(sim.world.getTile(8, 8).cover.n, 0)
  assert.ok(victim.hp < victim.hpMax)
})
