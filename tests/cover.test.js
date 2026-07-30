import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, makeSim, place } from './helpers.mjs'
import { createUnit } from '../src/game/units.js'

/** Target sits at (6,6) behind a full-cover crate on its NORTH side. */
function scene({ coverValue = 2, dir = 'n' } = {}) {
  const w = makeWorld(14, 14)
  const off = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[dir]
  w.prop(6 + off[0], 6 + off[1], coverValue)
  const sim = makeSim(w)
  const target = place(sim, createUnit({ team: 1, className: 'Ranger' }), 6, 6)
  const attacker = place(sim, createUnit({ team: 0, className: 'Sharpshooter' }), 6, 1)
  return { sim, target, attacker, w }
}

test('cover only counts when it is between target and attacker', () => {
  const { sim, target, attacker } = scene()
  assert.equal(sim.world.getTile(6, 6).cover.n, 2)

  // due north — behind the crate
  attacker.x = 6; attacker.z = 1
  let c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.value, 2)
  assert.equal(c.coverDir, 'n')
  assert.equal(c.flanked, false)

  // due south — the crate is behind the target, useless
  attacker.x = 6; attacker.z = 11
  c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.value, 0)
  assert.equal(c.flanked, true)
})

test('an attacker exactly perpendicular to the cover is flanking', () => {
  const { sim, target, attacker } = scene()
  attacker.x = 12; attacker.z = 6 // due east of a north-facing crate
  const c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.value, 0)
  assert.equal(c.flanked, true, 'the flank line is exactly perpendicular')
})

test('a diagonal attacker inside the cover arc is still blocked', () => {
  const { sim, target, attacker } = scene()
  attacker.x = 10; attacker.z = 2 // north-east
  const c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.value, 2)
  assert.equal(c.flanked, false)
})

test('cover values map to the documented aim penalties', () => {
  const half = scene({ coverValue: 1 })
  assert.equal(half.sim.cover.coverBetween(half.attacker, half.target).penalty, 20)

  const full = scene({ coverValue: 2 })
  assert.equal(full.sim.cover.coverBetween(full.attacker, full.target).penalty, 40)

  full.target.hunkered = true
  const h = full.sim.cover.coverBetween(full.attacker, full.target)
  assert.equal(h.penalty, 80, 'hunkering doubles cover')
  assert.equal(h.hunkered, true)
})

test('hunkering in the open gives nothing', () => {
  const { sim, target, attacker } = scene()
  attacker.x = 12; attacker.z = 6
  target.hunkered = true
  const c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.penalty, 0)
  assert.equal(c.hunkered, false)
})

test('the best applicable cover wins when two sides apply', () => {
  const w = makeWorld(14, 14)
  w.prop(6, 5, 1) // half cover north
  w.prop(7, 6, 2) // full cover east
  const sim = makeSim(w)
  const target = place(sim, createUnit({ team: 1 }), 6, 6)
  const attacker = place(sim, createUnit({ team: 0 }), 10, 2) // north-east

  const c = sim.cover.coverBetween(attacker, target)
  assert.equal(c.value, 2)
  assert.equal(c.coverDir, 'e')
  assert.deepEqual(c.applicable.sort(), ['e', 'n'])
})

test('destroying cover flanks the target', () => {
  const { sim, target, attacker } = scene()
  assert.equal(sim.cover.coverBetween(attacker, target).flanked, false)
  sim.world.destroyCover(6, 6, 'n')
  sim.los.invalidate()
  assert.equal(sim.cover.coverBetween(attacker, target).flanked, true)
})

test('previewCoverAt reports what a prospective tile would give you', () => {
  const w = makeWorld(14, 14)
  w.prop(6, 5, 2)
  const sim = makeSim(w)
  const me = place(sim, createUnit({ team: 0 }), 2, 2)
  const enemyN = place(sim, createUnit({ team: 1 }), 6, 1)

  const p = sim.cover.previewCoverAt(me, 6, 6)
  assert.equal(p.sides.n, 2)
  assert.equal(p.best, 2)
  assert.equal(p.bestDir, 'n')
  assert.equal(p.effective, 2, 'covered from the only enemy that can see the tile')
  assert.equal(p.vsEnemies.length, 1)
  assert.equal(p.vsEnemies[0].unitId, enemyN.id)
  assert.equal(p.vsEnemies[0].flanked, false)

  enemyN.x = 12; enemyN.z = 6 // walk round to the flank
  const p2 = sim.cover.previewCoverAt(me, 6, 6)
  assert.equal(p2.effective, 0)
  assert.equal(p2.exposedTo, 1)
  assert.equal(p2.vsEnemies[0].flanked, true)
})

test('height advantage is strictly higher elevation', () => {
  const w = makeWorld(14, 14)
  w.elevate(3, 3, 1)
  const sim = makeSim(w)
  const high = place(sim, createUnit({ team: 0 }), 3, 3)
  const low = place(sim, createUnit({ team: 1 }), 6, 6)
  assert.equal(sim.cover.hasHeightAdvantage(high, low), true)
  assert.equal(sim.cover.hasHeightAdvantage(low, high), false)
  low.elevation = 1
  assert.equal(sim.cover.hasHeightAdvantage(high, low), false, 'equal elevation is not an advantage')
})
