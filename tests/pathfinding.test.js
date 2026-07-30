import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, makeSim, place } from './helpers.mjs'
import { createUnit } from '../src/game/units.js'
import { BinaryHeap, CLIMB_COST } from '../src/game/pathfinding.js'

function soldier(overrides = {}) {
  return createUnit({ team: 0, className: 'Ranger', overrides })
}

test('binary heap pops in ascending priority order', () => {
  const h = new BinaryHeap()
  const prios = [9, 3, 7, 1, 8, 2, 5, 5, 0, 4, 6]
  prios.forEach((p, i) => h.push(`n${i}`, p))
  const out = []
  while (h.size) out.push(h.pop())
  const sorted = prios.map((p, i) => [p, `n${i}`]).sort((a, b) => a[0] - b[0]).map((e) => e[1])
  assert.equal(out.length, prios.length)
  // priorities must come out sorted (ties may swap, so compare the priority run)
  const outPrios = out.map((n) => prios[Number(n.slice(1))])
  assert.deepEqual(outPrios, [...prios].sort((a, b) => a - b))
  assert.deepEqual(new Set(out), new Set(sorted))
})

test('A* finds the shortest straight path and counts cost correctly', () => {
  const w = makeWorld(12, 12)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 0, 0)
  const path = sim.pathfinding.findPath(u, 5, 0)
  assert.ok(path, 'path exists')
  assert.equal(path.length, 6, 'includes the start tile')
  assert.deepEqual(path[0], { x: 0, z: 0, elevation: 0 })
  assert.deepEqual(path[path.length - 1], { x: 5, z: 0, elevation: 0 })
  assert.equal(sim.pathfinding.pathCost(u, path), 5)
})

test('diagonals cost the same as orthogonals (XCOM tile budget)', () => {
  const w = makeWorld(12, 12)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 0, 0)
  const path = sim.pathfinding.findPath(u, 3, 3)
  assert.equal(path.length, 4)
  assert.equal(sim.pathfinding.pathCost(u, path), 3)
})

test('diagonal movement never cuts a corner', () => {
  const w = makeWorld(12, 12)
  w.block(1, 0) // wall on the shared orthogonal neighbour
  const sim = makeSim(w)
  const u = place(sim, soldier(), 0, 0)

  const step = sim.pathfinding.canStep(u, 0, 0, 1, 1)
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'corner-cut')

  // routing round the corner must cost 2, not 1
  const path = sim.pathfinding.findPath(u, 1, 1)
  assert.ok(path)
  assert.equal(sim.pathfinding.pathCost(u, path), 2)
  assert.deepEqual(path.map((p) => `${p.x},${p.z}`), ['0,0', '0,1', '1,1'])
})

test('a fully boxed corner is unreachable rather than squeezed through', () => {
  const w = makeWorld(12, 12)
  w.block(1, 0).block(0, 1)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 0, 0)
  assert.equal(sim.pathfinding.findPath(u, 1, 1), null)
})

test('elevation: one level up is a climb with extra cost', () => {
  const w = makeWorld(12, 12)
  w.elevate(3, 0, 1)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 2, 0)
  const step = sim.pathfinding.canStep(u, 2, 0, 3, 0)
  assert.equal(step.ok, true)
  assert.equal(step.cost, 1 + CLIMB_COST)
})

test('elevation: a sheer two-level wall can never be walked up', () => {
  const w = makeWorld(12, 12)
  w.elevate(3, 0, 2)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 2, 0)
  const step = sim.pathfinding.canStep(u, 2, 0, 3, 0)
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'elevation')
  assert.equal(sim.pathfinding.findPath(u, 3, 0), null)
})

test('elevation: a ramp makes the same two-level climb legal and free', () => {
  const w = makeWorld(12, 12)
  w.ramp(3, 0, 2)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 2, 0)
  const step = sim.pathfinding.canStep(u, 2, 0, 3, 0)
  assert.equal(step.ok, true)
  assert.equal(step.cost, 1, 'ramps do not charge the climb surcharge')
})

test('elevation: diagonals may not change level', () => {
  const w = makeWorld(12, 12)
  w.elevate(1, 1, 1)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 0, 0)
  const step = sim.pathfinding.canStep(u, 0, 0, 1, 1)
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'elevation')
})

test('dropping more than one level without a ramp is illegal', () => {
  const w = makeWorld(12, 12)
  w.elevate(2, 0, 2).elevate(3, 0, 2).elevate(4, 0, 2)
  const sim = makeSim(w)
  const u = place(sim, soldier(), 3, 0)
  assert.equal(sim.pathfinding.canStep(u, 3, 0, 3, 1).ok, false)
})

test('two-tier move range: blue = 1 AP, dash = 2 AP, disjoint sets', () => {
  const w = makeWorld(24, 24)
  const sim = makeSim(w)
  const u = place(sim, soldier({ mobility: 4 }), 10, 10)
  const r = sim.pathfinding.getReachable(u)
  const k = sim.pathfinding.key

  assert.ok(r.blue.has(k(14, 10)), '4 tiles east is a blue move')
  assert.ok(!r.blue.has(k(15, 10)), '5 tiles east is beyond blue')
  assert.ok(r.dash.has(k(15, 10)), '5 tiles east is a dash')
  assert.ok(r.dash.has(k(18, 10)), '8 tiles east is the dash limit')
  assert.ok(!r.dash.has(k(19, 10)), 'nothing past 2x mobility')
  for (const b of r.blue) assert.ok(!r.dash.has(b), 'blue and dash never overlap')
  assert.ok(!r.blue.has(k(10, 10)), 'the starting tile is not a move target')
})

test('enemies block movement, allies are pass-through but not destinations', () => {
  const w = makeWorld(12, 12)
  const sim = makeSim(w)
  const u = place(sim, soldier({ mobility: 6 }), 2, 5)
  const ally = place(sim, createUnit({ team: 0, className: 'Specialist' }), 3, 5)

  let step = sim.pathfinding.canStep(u, 2, 5, 3, 5)
  assert.equal(step.ok, true)
  assert.equal(step.passThroughOnly, true)
  let r = sim.pathfinding.getReachable(u)
  assert.ok(!r.blue.has(sim.pathfinding.key(3, 5)), 'cannot stop on an ally')
  assert.ok(r.blue.has(sim.pathfinding.key(4, 5)), 'can walk past an ally')

  ally.team = 1
  sim.rules.syncOccupancy()
  step = sim.pathfinding.canStep(u, 2, 5, 3, 5)
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'enemy')
})

test('apForPath maps path length onto the AP cost', () => {
  const w = makeWorld(24, 24)
  const sim = makeSim(w)
  const u = place(sim, soldier({ mobility: 5 }), 2, 2)
  assert.equal(sim.pathfinding.apForPath(u, sim.pathfinding.findPath(u, 7, 2)), 1)
  assert.equal(sim.pathfinding.apForPath(u, sim.pathfinding.findPath(u, 12, 2)), 2)
  assert.equal(sim.pathfinding.apForPath(u, sim.pathfinding.findPath(u, 15, 2)), 0)
})

test('pathfinding routes around an obstacle instead of through it', () => {
  const w = makeWorld(12, 12)
  for (let z = 0; z <= 8; z++) w.block(5, z)
  const sim = makeSim(w)
  const u = place(sim, soldier({ mobility: 30 }), 2, 2)
  const path = sim.pathfinding.findPath(u, 8, 2)
  assert.ok(path)
  assert.ok(path.every((p) => !(p.x === 5 && p.z <= 8)), 'never steps on the wall')
  assert.ok(path.some((p) => p.z >= 9), 'goes round the southern end')
})
