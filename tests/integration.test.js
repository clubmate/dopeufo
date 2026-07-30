import test from 'node:test'
import assert from 'node:assert/strict'
import { EventBus, recorder } from './helpers.mjs'
import { init, createSimulation, createRendererBridge } from '../src/game/index.js'
import { adaptWorld } from '../src/game/state.js'

/** A ctx stand-in: a bus, a grid, and deliberately no world and no units. */
function fakeCtx({ world = null, units = null } = {}) {
  const bus = new EventBus()
  const ctx = {
    bus,
    grid: { W: 24, H: 24 },
    world, units,
    register(name, api) { ctx[name] = api; return api },
    onUpdate() { return () => {} },
  }
  return ctx
}

test('the sim builds a complete battlefield with no world module at all', () => {
  const sim = createSimulation({ seed: 'fallback' })
  assert.equal(sim.world.usingFallbackTiles, true)
  assert.equal(sim.world.W, 24)
  assert.equal(sim.state.units.length, 8, 'two full squads')

  const seen = new Set()
  for (const u of sim.state.units) {
    assert.equal(sim.world.isWalkable(u.x, u.z), true, `${u.id} spawned on a walkable tile`)
    const k = `${u.x},${u.z}`
    assert.ok(!seen.has(k), 'no two units share a tile')
    seen.add(k)
  }
  assert.equal(sim.state.units.filter((u) => u.team === 0).length, 4)
  assert.equal(sim.state.units.filter((u) => u.team === 1).length, 4)
  assert.ok(sim.world.blockersForLOS().length > 0, 'the fallback map has cover')
})

test('a world module that throws on every call degrades to the fallback', () => {
  const hostile = {
    W: 24, H: 24,
    getTile() { throw new Error('boom') },
    isWalkable() { throw new Error('boom') },
    coverAt() { throw new Error('boom') },
    blockersForLOS() { throw new Error('boom') },
    getDeployZone() { throw new Error('boom') },
    destroyCover() { throw new Error('boom') },
  }
  const w = adaptWorld(hostile, { W: 24, H: 24 })
  assert.ok(w.getTile(3, 3), 'still returns tiles')
  assert.equal(typeof w.isWalkable(3, 3), 'boolean')
  assert.ok(Array.isArray(w.blockersForLOS()))
  assert.ok(w.getDeployZone(0).length > 0)

  const sim = createSimulation({ world: hostile, seed: 'hostile' })
  assert.equal(sim.state.units.length, 8)
})

test('a partial world module keeps whatever it does provide', () => {
  const partial = {
    W: 10, H: 10,
    getTile(x, z) {
      if (x < 0 || z < 0 || x >= 10 || z >= 10) return null
      return { x, z, elevation: x === 5 ? 2 : 0, walkable: x !== 3, cost: 1, cover: { n: 0, e: 0, s: 0, w: 0 } }
    },
  }
  const w = adaptWorld(partial, { W: 10, H: 10 })
  assert.equal(w.usingFallbackTiles, false)
  assert.equal(w.isWalkable(3, 4), false, 'uses the real walkability')
  assert.equal(w.getTile(5, 5).elevation, 2)
  assert.ok(Array.isArray(w.blockersForLOS()), 'synthesises the missing method')
  assert.ok(w.getDeployZone(1).length > 0)
})

test('the renderer bridge no-ops safely when ctx.units is missing or broken', async () => {
  const none = createRendererBridge(null)
  assert.equal(none.hasRenderer, false)
  await none.moveAlongPath('u_0', [])
  await none.playAction('u_0', 'fire')
  none.setPose('u_0', 'idle')
  none.faceTo('u_0', 0)
  assert.equal(none.getMuzzlePosition('u_0'), null)

  const broken = createRendererBridge({
    spawn() { throw new Error('nope') },
    moveAlongPath() { throw new Error('nope') },
    playAction() { return Promise.reject(new Error('nope')) },
    getMuzzlePosition() { throw new Error('nope') },
  })
  assert.equal(broken.hasRenderer, true)
  broken.spawn({})
  await broken.moveAlongPath('u_0', [])
  await broken.playAction('u_0', 'fire')
  assert.equal(broken.getMuzzlePosition('u_0'), null)
})

test('init(ctx) registers state and starts the match on game:ready', async () => {
  const ctx = fakeCtx()
  const rec = recorder(ctx.bus)
  const api = await init(ctx)

  assert.equal(ctx.state, api)
  assert.equal(ctx.game, api)
  assert.equal(api.started, false, 'waits for boot to finish')

  ctx.bus.emit('game:ready', { failed: [] })
  assert.equal(api.started, true)
  assert.equal(api.turn, 1)
  assert.equal(api.activeTeam, 0)
  assert.equal(api.phase, 'select')
  assert.ok(api.selectedUnitId, 'auto-selects the first ready soldier')

  const start = rec.of('turn:start')[0]
  assert.deepEqual(start.payload, { team: 0, turn: 1 })
  assert.ok(rec.of('unit:selected').length >= 1)

  // the whole documented query surface exists
  for (const fn of ['selectUnit', 'moveTo', 'fireAt', 'useAbility', 'endTurn', 'canAct', 'previewShot', 'previewMove', 'getReachable', 'abilitiesFor', 'dispose']) {
    assert.equal(typeof api[fn], 'function', `api.${fn} missing`)
  }
  // GameState fields per ARCHITECTURE.md
  for (const f of ['turn', 'activeTeam', 'phase', 'units', 'selectedUnitId', 'targetUnitId', 'pendingAction', 'winner']) {
    assert.ok(f in api, `state.${f} missing`)
  }
  api.dispose()
})

test('the controller drives a move from bus events alone', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})
  const rec = recorder(ctx.bus)

  const u = api.getSelected()
  const before = { x: u.x, z: u.z }
  const reach = api.getReachable(u)
  const dest = [...reach.blue].map((k) => ({ x: k % 24, z: Math.floor(k / 24) }))
    .find((t) => Math.abs(t.x - u.x) + Math.abs(t.z - u.z) >= 3)
  assert.ok(dest, 'found a blue tile to walk to')

  ctx.bus.emit('tile:hover', dest)
  assert.ok(rec.of('game:preview').length >= 1, 'hover produces a live preview')

  ctx.bus.emit('tile:click', { x: dest.x, z: dest.z, button: 0 })
  await new Promise((r) => setTimeout(r, 30))

  assert.deepEqual({ x: u.x, z: u.z }, dest)
  assert.notDeepEqual({ x: u.x, z: u.z }, before)
  assert.equal(u.ap, 1)
  const names = rec.names()
  assert.ok(names.includes('unit:moveStart'))
  assert.ok(names.includes('unit:moveStep'))
  assert.ok(names.includes('unit:moveEnd'))
  const ms = rec.of('unit:moveStart')[0].payload
  assert.equal(ms.unitId, u.id)
  assert.ok(Array.isArray(ms.path))
  assert.ok(ms.path.every((p) => Number.isInteger(p.x) && Number.isInteger(p.z) && Number.isInteger(p.elevation)))
  api.dispose()
})

test('ui:endTurn hands the hotseat over', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})
  const rec = recorder(ctx.bus)
  ctx.bus.emit('ui:endTurn', {})
  assert.equal(api.activeTeam, 1)
  assert.deepEqual(rec.of('turn:end')[0].payload, { team: 0 })
  assert.deepEqual(rec.of('turn:start')[0].payload, { team: 1, turn: 1 })
  assert.ok(api.getSelected(), 'the new team gets a selection')
  assert.equal(api.getSelected().team, 1)
  api.dispose()
})

test('ui:ability + unit:click resolves a shot with a full payload', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})

  // hand-build a guaranteed engagement so this never depends on map generation
  const a = api.getTeam(0)[0]
  const b = api.getTeam(1)[0]
  a.x = 5; a.z = 5; a.elevation = api.getTile(5, 5).elevation
  b.x = 5; b.z = 8; b.elevation = api.getTile(5, 8).elevation
  a.aim = 200
  api.rules.syncOccupancy()
  api.selectUnit(a.id)
  const rec = recorder(ctx.bus)

  ctx.bus.emit('ui:ability', { ability: 'fire' })
  assert.equal(api.pendingAction, 'fire')
  assert.equal(api.phase, 'targeting')
  assert.ok(rec.of('game:targeting').length === 1)

  ctx.bus.emit('unit:click', { unitId: b.id, button: 0 })
  await new Promise((r) => setTimeout(r, 30))

  const shots = rec.of('unit:shoot')
  assert.equal(shots.length, 1)
  const p = shots[0].payload
  for (const f of ['shooterId', 'targetId', 'shots', 'hit', 'dmg', 'crit', 'killed', 'from', 'to']) {
    assert.ok(f in p, `unit:shoot payload missing ${f}`)
  }
  assert.equal(p.shooterId, a.id)
  assert.equal(p.targetId, b.id)
  assert.equal(p.hit, true)
  assert.equal(typeof p.dmg, 'number')
  assert.ok(['number'].includes(typeof p.from.x) && typeof p.from.y === 'number' && typeof p.from.z === 'number')
  assert.ok(typeof p.to.x === 'number' && typeof p.to.y === 'number' && typeof p.to.z === 'number')

  const dmg = rec.of('unit:damaged')[0].payload
  assert.deepEqual(Object.keys(dmg).sort(), ['crit', 'dmg', 'sourceId', 'unitId'])
  assert.equal(a.ap, 0, 'firing ends the turn')
  api.dispose()
})

test('ui:cancel drops the pending action', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})
  api.selectUnit(api.getTeam(0)[0].id)
  ctx.bus.emit('ui:ability', { ability: 'grenade' })
  assert.equal(api.pendingAction, 'grenade')
  ctx.bus.emit('ui:cancel', {})
  assert.equal(api.pendingAction, null)
  assert.equal(api.phase, 'select')
  api.dispose()
})

test('abilitiesFor gives the UI a data-driven ability bar', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})
  const u = api.getTeam(0).find((x) => x.className === 'Sharpshooter')
  const bar = api.abilitiesFor(u)
  const ids = bar.map((a) => a.id)
  assert.deepEqual(ids, ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade', 'aimedShot'])
  for (const a of bar) {
    assert.equal(typeof a.name, 'string')
    assert.equal(typeof a.apCost, 'number')
    assert.equal(typeof a.endsTurn, 'boolean')
    assert.equal(typeof a.available, 'boolean')
  }
  assert.equal(bar.find((a) => a.id === 'reload').available, false, 'weapon starts loaded')
  api.dispose()
})

test('a full random match runs to a winner without throwing', async () => {
  const ctx = fakeCtx()
  const api = await init(ctx)
  ctx.bus.emit('game:ready', {})
  const rng = api.rng

  // A dumb-but-purposeful bot: shoot if you can, reload if you're dry,
  // otherwise advance on the nearest enemy. Enough to drive a match to a result.
  const nearestEnemy = (u) => api.units
    .filter((e) => e.alive && e.team !== u.team)
    .sort((a, b) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(b.x - u.x, b.z - u.z))[0]

  let guard = 0
  while (api.phase !== 'over' && guard++ < 3000) {
    const actors = api.getTeam(api.activeTeam).filter((u) => api.canAct(u))
    if (!actors.length) { api.endTurn(); continue }
    const u = actors[0]
    api.selectUnit(u.id)

    const targets = api.getTargets(u)
    if (targets.length && u.weapon.ammo > 0) {
      const best = targets
        .map((t) => ({ t, p: api.previewShot(u, t) }))
        .sort((a, b) => b.p.hitChance - a.p.hitChance)[0]
      await api.fireAt(best.t.id, u)
      continue
    }
    if (u.weapon.ammo <= 0) { await api.useAbility('reload', {}, u); continue }

    const foe = nearestEnemy(u)
    const reach = api.getReachable(u)
    const opts = [...reach.blue, ...reach.dash]
    if (!opts.length || !foe) { u.ap = 0; continue }
    const scored = opts
      .map((k) => ({ x: k % 24, z: Math.floor(k / 24) }))
      .sort((a, b) => Math.hypot(a.x - foe.x, a.z - foe.z) - Math.hypot(b.x - foe.x, b.z - foe.z))
    const pick = scored[rng.int(Math.min(3, scored.length))]
    const r = await api.moveTo(pick.x, pick.z, u)
    if (!r.ok) u.ap = 0
  }

  assert.equal(api.phase, 'over', `match did not resolve in ${guard} actions`)
  assert.ok(api.winner === 0 || api.winner === 1)
  const alive = api.units.filter((u) => u.alive)
  assert.ok(alive.every((u) => u.team === api.winner))
  api.dispose()
})

// ---------------------------------------------------------------------------
// Interop with the real world module's contract (Mesh[] + .boxes sidecar,
// destroyCover returning false for indestructible edges)
// ---------------------------------------------------------------------------

test('blockersForLOS accepts every shape the world module might return', () => {
  const base = { W: 8, H: 8, getTile: (x, z) => (x >= 0 && z >= 0 && x < 8 && z < 8 ? { x, z, elevation: 0, walkable: true, cost: 1, cover: { n: 0, e: 0, s: 0, w: 0 } } : null) }
  const box = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2.4, z: 1 } }

  // 1. Box3-style records
  let w = adaptWorld({ ...base, blockersForLOS: () => [box] }, { W: 8, H: 8 })
  assert.equal(w.blockersForLOS().length, 1)
  assert.equal(w.blockersForLOS()[0].maxY, 2.4)

  // 2. Mesh[] with a `.boxes` Box3 sidecar (what src/world actually returns)
  const meshes = [{ isMesh: true, position: { x: 0, y: 1.2, z: 0 }, scale: { x: 2, y: 2.4, z: 2 } }]
  meshes.boxes = [box]
  w = adaptWorld({ ...base, blockersForLOS: () => meshes }, { W: 8, H: 8 })
  assert.equal(w.blockersForLOS().length, 1)
  assert.equal(w.blockersForLOS()[0].maxY, 2.4, 'prefers the Box3 sidecar')

  // 3. bare Mesh[] with userData.losBox
  const bare = [{ isMesh: true, position: { x: 0, y: 1.2, z: 0 }, scale: { x: 2, y: 2.4, z: 2 }, userData: { losBox: { cx: 0, cy: 1.2, cz: 0, hx: 1, hy: 1.2, hz: 1 } } }]
  w = adaptWorld({ ...base, blockersForLOS: () => bare }, { W: 8, H: 8 })
  const b3 = w.blockersForLOS()[0]
  assert.equal(b3.minY, 0)
  assert.ok(Math.abs(b3.maxY - 2.4) < 1e-9)
  assert.ok(b3.cells.size > 0, 'grid footprint is derived for the peek exemption')
})

test('an indestructible edge survives a grenade, and a destroyed one stops blocking LOS', () => {
  const tiles = new Map()
  const t = (x, z) => {
    const k = `${x},${z}`
    if (!tiles.has(k)) tiles.set(k, { x, z, elevation: 0, walkable: true, cost: 1, cover: { n: 0, e: 0, s: 0, w: 0 } })
    return tiles.get(k)
  }
  // a full-cover wall on the north edge of (4,5) — i.e. between (4,4) and (4,5)
  t(4, 5).cover.n = 2
  t(4, 4).cover.s = 2
  let allowDestroy = false
  const realish = {
    W: 10, H: 10,
    getTile: (x, z) => (x >= 0 && z >= 0 && x < 10 && z < 10 ? t(x, z) : null),
    blockersForLOS: () => [{ min: { x: -3, y: 0, z: -2 }, max: { x: -1, y: 2.4, z: 0 } }],
    destroyCover(x, z, dir) {
      if (!allowDestroy) return false
      t(x, z).cover[dir] = 0
      if (dir === 'n') t(x, z - 1).cover.s = 0
      return true
    },
  }
  const w = adaptWorld(realish, { W: 10, H: 10 })

  assert.equal(w.destroyCover(4, 5, 'n'), false, 'the world refused')
  assert.equal(w.getTile(4, 5).cover.n, 2, 'rules data must not diverge from the world')
  assert.equal(w.blockersForLOS().length, 1)

  allowDestroy = true
  assert.equal(w.destroyCover(4, 5, 'n'), true)
  assert.equal(w.getTile(4, 5).cover.n, 0)
  assert.equal(w.getTile(4, 4).cover.s, 0)
  assert.equal(w.blockersForLOS().length, 0, 'the stale proxy box is pruned')
})
