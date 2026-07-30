import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, makeSim, place } from './helpers.mjs'
import { createUnit } from '../src/game/units.js'

const at = (x, z) => ({ x, z })

test('clear ground gives LOS in both directions', () => {
  const sim = makeSim(makeWorld(12, 12))
  assert.equal(sim.los.hasLOS(at(2, 2), at(9, 2)), true)
  assert.equal(sim.los.hasLOS(at(9, 2), at(2, 2)), true)
  assert.equal(sim.los.hasLOS(at(2, 2), at(9, 9)), true)
})

test('a full-height prop between two units blocks LOS', () => {
  const w = makeWorld(12, 12)
  w.prop(5, 2, 2)
  const sim = makeSim(w)
  assert.equal(sim.los.hasLOS(at(2, 2), at(8, 2)), false)
  assert.equal(sim.los.hasLOS(at(8, 2), at(2, 2)), false)
})

test('a unit\'s OWN cover never blocks its own shot', () => {
  const w = makeWorld(12, 12)
  w.prop(5, 2, 2) // shooter at (4,2) is in full cover facing east
  const sim = makeSim(w)
  assert.equal(w.getTile(4, 2).cover.e, 2, 'shooter really is in cover toward the target')
  assert.equal(sim.los.hasLOS(at(4, 2), at(9, 2)), true, 'peeks around its own crate')
})

test('a target\'s cover makes it harder to hit, never impossible to see', () => {
  const w = makeWorld(12, 12)
  w.prop(5, 2, 2) // target at (6,2) is in full cover facing west
  const sim = makeSim(w)
  assert.equal(w.getTile(6, 2).cover.w, 2)
  assert.equal(sim.los.hasLOS(at(1, 2), at(6, 2)), true)
  assert.equal(sim.los.hasLOS(at(6, 2), at(1, 2)), true)
})

test('cover two tiles deep still blocks — peeking only forgives your own cover', () => {
  const w = makeWorld(12, 12)
  w.prop(5, 2, 2).prop(6, 2, 2)
  const sim = makeSim(w)
  // shooter at (4,2) is exempt from (5,2) only; (6,2) still stops the ray
  assert.equal(sim.los.hasLOS(at(4, 2), at(9, 2)), false)
})

test('LOS is symmetric across a randomised obstacle field', () => {
  const w = makeWorld(16, 16)
  const props = [[3, 3], [4, 7], [8, 5], [9, 9], [11, 4], [6, 12], [12, 11], [2, 9], [13, 7]]
  props.forEach(([x, z], i) => w.prop(x, z, i % 2 === 0 ? 2 : 1))
  w.elevate(7, 7, 2).elevate(7, 8, 2).elevate(8, 7, 2).elevate(8, 8, 2)
  const sim = makeSim(w)

  let checked = 0
  for (let ax = 0; ax < 16; ax += 3) {
    for (let az = 0; az < 16; az += 3) {
      for (let bx = 0; bx < 16; bx += 3) {
        for (let bz = 0; bz < 16; bz += 3) {
          if (!w.isWalkable(ax, az) || !w.isWalkable(bx, bz)) continue
          const ab = sim.los.hasLOS(at(ax, az), at(bx, bz))
          const ba = sim.los.hasLOS(at(bx, bz), at(ax, az))
          assert.equal(ab, ba, `asymmetric LOS ${ax},${az} <-> ${bx},${bz}`)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 500, `checked ${checked} pairs`)
})

test('raised terrain blocks LOS across it, and grants it from on top', () => {
  const w = makeWorld(12, 12)
  w.elevate(5, 1, 2).elevate(5, 2, 2).elevate(5, 3, 2)
  const sim = makeSim(w)
  assert.equal(sim.los.hasLOS(at(2, 2), at(8, 2)), false, 'cannot see through a 2-level rise')
  assert.equal(sim.los.hasLOS(at(5, 2), at(8, 2)), true, 'standing on it sees over')
  assert.equal(sim.los.hasLOS(at(5, 2), at(2, 2)), true)
})

test('half cover never blocks line of sight', () => {
  const w = makeWorld(12, 12)
  w.prop(5, 2, 1)
  const sim = makeSim(w)
  assert.equal(sim.los.hasLOS(at(2, 2), at(8, 2)), true)
})

test('visibleEnemies and getTargets respect team, LOS and weapon range', () => {
  const w = makeWorld(24, 24)
  w.prop(10, 5, 2).prop(10, 6, 2)
  const sim = makeSim(w)
  const me = place(sim, createUnit({ team: 0, className: 'Specialist' }), 4, 5)
  const seen = place(sim, createUnit({ team: 1, className: 'Ranger' }), 8, 5)
  const hidden = place(sim, createUnit({ team: 1, className: 'Grenadier' }), 14, 5)
  const ally = place(sim, createUnit({ team: 0, className: 'Ranger' }), 5, 5)

  const vis = sim.los.visibleEnemies(me).map((u) => u.id)
  assert.ok(vis.includes(seen.id))
  assert.ok(!vis.includes(hidden.id), 'blocked by the two-deep wall')
  assert.ok(!vis.includes(ally.id), 'allies are not enemies')

  me.weapon.range = 3
  assert.equal(sim.los.getTargets(me).length, 0, 'visible but out of weapon range')
  me.weapon.range = 20
  assert.equal(sim.los.getTargets(me).length, 1)
})

test('a unit always has LOS to its own tile', () => {
  const sim = makeSim(makeWorld(8, 8))
  assert.equal(sim.los.hasLOS(at(3, 3), at(3, 3)), true)
})
