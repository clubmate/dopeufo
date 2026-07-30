/**
 * A* / Dijkstra on the 8-way tactical grid, with elevation.
 *
 * Movement rules (deliberate, documented, all unit-tested):
 *   - 8 neighbours. Orthogonal and diagonal steps cost the same (XCOM does not
 *     charge sqrt(2) — the tile budget IS the movement stat).
 *   - Diagonals never cut corners: both shared orthogonal neighbours must be
 *     enterable, and a diagonal may not change elevation at all.
 *   - Elevation: a step of 1 level up is a climb — legal, +CLIMB_COST tiles.
 *     A step of 2+ levels up is only legal onto/off a ramp tile. Dropping down
 *     1 level is free; dropping 2+ needs a ramp as well (no leaping off roofs).
 *   - Enemies block. Allies can be walked through but not stopped on.
 *
 * Two-tier range: `blue` = reachable for 1 AP (unit.mobility tiles),
 * `dash` = reachable only by spending both AP (2 * mobility), which forbids
 * firing afterwards.
 */

import { unitAt } from './state.js'

export const CLIMB_COST = 1
export const MAX_CLIMB = 1        // levels you can scale without a ramp
export const MAX_RAMP_CLIMB = 2   // levels a ramp/stairs tile lets you cover
export const MAX_DROP = 1         // levels you can drop without a ramp

const NEIGHBOURS = [
  { dx: 0, dz: -1, diag: false },
  { dx: 1, dz: 0, diag: false },
  { dx: 0, dz: 1, diag: false },
  { dx: -1, dz: 0, diag: false },
  { dx: 1, dz: -1, diag: true },
  { dx: 1, dz: 1, diag: true },
  { dx: -1, dz: 1, diag: true },
  { dx: -1, dz: -1, diag: true },
]

// ---------------------------------------------------------------------------
// Binary min-heap. Small maps do not need it; hover-recompute at 60fps does.
// ---------------------------------------------------------------------------
export class BinaryHeap {
  constructor() {
    this.items = []
    this.prio = []
  }
  get size() { return this.items.length }
  push(item, priority) {
    this.items.push(item)
    this.prio.push(priority)
    let i = this.items.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.prio[p] <= this.prio[i]) break
      this._swap(i, p)
      i = p
    }
  }
  pop() {
    const n = this.items.length
    if (n === 0) return undefined
    const top = this.items[0]
    const lastItem = this.items.pop()
    const lastPrio = this.prio.pop()
    if (n > 1) {
      this.items[0] = lastItem
      this.prio[0] = lastPrio
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r
        if (m === i) break
        this._swap(i, m)
        i = m
      }
    }
    return top
  }
  _swap(a, b) {
    const ti = this.items[a]; this.items[a] = this.items[b]; this.items[b] = ti
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp
  }
}

export function createPathfinding({ world, state }) {
  const W = world.W
  const H = world.H
  const key = (x, z) => x + z * W
  const unkeyX = (k) => k % W
  const unkeyZ = (k) => (k / W) | 0

  /** Is this tile physically standable (ignoring who is on it)? */
  function isStandable(x, z) {
    if (x < 0 || z < 0 || x >= W || z >= H) return false
    const t = world.getTile(x, z)
    return !!t && t.walkable !== false && !t.solid
  }

  /** Who blocks: enemies hard-block, allies are pass-through only. */
  function occupancy(mover, x, z) {
    const u = unitAt(state, x, z)
    if (!u || u === mover) return 'free'
    return u.team === mover?.team ? 'ally' : 'enemy'
  }

  /**
   * Elevation legality between two tiles. Returns extra move cost, or -1 if the
   * step is illegal.
   */
  function elevationCost(fromT, toT, diag) {
    const d = (toT.elevation | 0) - (fromT.elevation | 0)
    if (d === 0) return 0
    // Diagonals never change level: prevents scaling a corner of a plateau and
    // makes cover/edge geometry unambiguous.
    if (diag) return -1
    const ramp = world.isRamp(fromT.x, fromT.z) || world.isRamp(toT.x, toT.z)
    if (d > 0) {
      const max = ramp ? MAX_RAMP_CLIMB : MAX_CLIMB
      if (d > max) return -1
      return ramp ? 0 : CLIMB_COST * d
    }
    const drop = -d
    const maxDrop = ramp ? MAX_RAMP_CLIMB : MAX_DROP
    if (drop > maxDrop) return -1
    return 0
  }

  /**
   * Can `mover` step from (fx,fz) to (tx,tz)?
   * @returns {{ ok: boolean, cost: number, reason?: string, blockedByUnit?: boolean }}
   */
  function canStep(mover, fx, fz, tx, tz) {
    const dx = tx - fx
    const dz = tz - fz
    if (dx === 0 && dz === 0) return { ok: false, cost: 0, reason: 'same-tile' }
    if (Math.abs(dx) > 1 || Math.abs(dz) > 1) return { ok: false, cost: 0, reason: 'not-adjacent' }
    if (!isStandable(tx, tz)) return { ok: false, cost: 0, reason: 'blocked' }
    const fromT = world.getTile(fx, fz)
    const toT = world.getTile(tx, tz)
    if (!fromT || !toT) return { ok: false, cost: 0, reason: 'off-grid' }

    const diag = dx !== 0 && dz !== 0
    if (diag) {
      // no corner cutting — both orthogonal companions must be enterable and on
      // the same level as the tile we are leaving
      if (!isStandable(fx + dx, fz) || !isStandable(fx, fz + dz)) {
        return { ok: false, cost: 0, reason: 'corner-cut' }
      }
      const a = world.getTile(fx + dx, fz)
      const b = world.getTile(fx, fz + dz)
      if ((a.elevation | 0) !== (fromT.elevation | 0) || (b.elevation | 0) !== (fromT.elevation | 0)) {
        return { ok: false, cost: 0, reason: 'corner-elevation' }
      }
      // a full-cover wall on either shared edge blocks the squeeze
      if (fromT.cover?.[dx > 0 ? 'e' : 'w'] === 2 && fromT.cover?.[dz > 0 ? 's' : 'n'] === 2) {
        return { ok: false, cost: 0, reason: 'corner-walled' }
      }
    }

    const extra = elevationCost(fromT, toT, diag)
    if (extra < 0) return { ok: false, cost: 0, reason: 'elevation' }

    const occ = occupancy(mover, tx, tz)
    if (occ === 'enemy') return { ok: false, cost: 0, reason: 'enemy', blockedByUnit: true }

    const cost = (toT.cost > 0 ? toT.cost : 1) + extra
    return { ok: true, cost, passThroughOnly: occ === 'ally' }
  }

  /**
   * Dijkstra flood out to the dash budget.
   * @returns {{ blue:Set<number>, dash:Set<number>, cost:Map<number,number>, prev:Map<number,number>, budget:{blue:number,dash:number} }}
   */
  function flood(unit, { budget = null } = {}) {
    const blueBudget = budget?.blue ?? unit.mobility
    const dashBudget = budget?.dash ?? unit.mobility * 2
    const cost = new Map()
    const prev = new Map()
    const blue = new Set()
    const dash = new Set()
    if (!unit || !unit.alive) return { blue, dash, cost, prev, budget: { blue: blueBudget, dash: dashBudget } }

    const start = key(unit.x, unit.z)
    cost.set(start, 0)
    const open = new BinaryHeap()
    open.push(start, 0)

    while (open.size) {
      const k = open.pop()
      const g = cost.get(k)
      const x = unkeyX(k)
      const z = unkeyZ(k)
      if (g > dashBudget) continue

      for (const n of NEIGHBOURS) {
        const nx = x + n.dx
        const nz = z + n.dz
        const step = canStep(unit, x, z, nx, nz)
        if (!step.ok) continue
        const ng = g + step.cost
        if (ng > dashBudget) continue
        const nk = key(nx, nz)
        if (cost.has(nk) && cost.get(nk) <= ng) continue
        cost.set(nk, ng)
        prev.set(nk, k)
        open.push(nk, ng)
      }
    }

    for (const [k, g] of cost) {
      if (k === start) continue
      // ally-occupied tiles are pass-through, never a destination
      if (unitAt(state, unkeyX(k), unkeyZ(k))) continue
      if (g <= blueBudget) blue.add(k)
      else if (g <= dashBudget) dash.add(k)
    }

    return { blue, dash, cost, prev, budget: { blue: blueBudget, dash: dashBudget } }
  }

  /** Classic two-tier XCOM move range. */
  function getReachable(unit) {
    const r = flood(unit)
    return {
      blue: r.blue,
      dash: r.dash,
      cost: r.cost,
      key,
      toXZ: (k) => ({ x: unkeyX(k), z: unkeyZ(k) }),
      tiles: (set) => [...set].map((k) => ({ x: unkeyX(k), z: unkeyZ(k), elevation: world.getTile(unkeyX(k), unkeyZ(k))?.elevation || 0 })),
    }
  }

  /**
   * A* to a specific tile. Returns the full path INCLUDING the start tile, or
   * null if unreachable. Entries are `{x, z, elevation}` per ARCHITECTURE.md.
   */
  function findPath(unit, tx, tz, { maxCost = Infinity } = {}) {
    if (!unit) return null
    if (!isStandable(tx, tz)) return null
    if (unit.x === tx && unit.z === tz) return [tileNode(unit.x, unit.z)]
    const other = unitAt(state, tx, tz)
    if (other && other !== unit) return null

    const start = key(unit.x, unit.z)
    const goal = key(tx, tz)
    const g = new Map([[start, 0]])
    const prev = new Map()
    const closed = new Set()
    const open = new BinaryHeap()
    const h = (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz))
    open.push(start, h(unit.x, unit.z))

    while (open.size) {
      const k = open.pop()
      if (closed.has(k)) continue
      closed.add(k)
      if (k === goal) return rebuild(prev, start, goal)
      const x = unkeyX(k)
      const z = unkeyZ(k)
      const gc = g.get(k)

      for (const n of NEIGHBOURS) {
        const nx = x + n.dx
        const nz = z + n.dz
        const nk = key(nx, nz)
        if (closed.has(nk)) continue
        const step = canStep(unit, x, z, nx, nz)
        if (!step.ok) continue
        const ng = gc + step.cost
        if (ng > maxCost) continue
        if (g.has(nk) && g.get(nk) <= ng) continue
        g.set(nk, ng)
        prev.set(nk, k)
        open.push(nk, ng + h(nx, nz))
      }
    }
    return null
  }

  function tileNode(x, z) {
    return { x, z, elevation: world.getTile(x, z)?.elevation || 0 }
  }

  function rebuild(prev, start, goal) {
    const out = []
    let k = goal
    while (k !== undefined) {
      out.push(tileNode(unkeyX(k), unkeyZ(k)))
      if (k === start) break
      k = prev.get(k)
    }
    return out.reverse()
  }

  /** Total move cost of a path (excludes the start tile). */
  function pathCost(unit, path) {
    if (!path || path.length < 2) return 0
    let c = 0
    for (let i = 1; i < path.length; i++) {
      const s = canStep(unit, path[i - 1].x, path[i - 1].z, path[i].x, path[i].z)
      if (!s.ok) return Infinity
      c += s.cost
    }
    return c
  }

  /** How many AP does moving along this path cost? 0 = illegal. */
  function apForPath(unit, path) {
    const c = pathCost(unit, path)
    if (!Number.isFinite(c)) return 0
    if (c <= unit.mobility) return 1
    if (c <= unit.mobility * 2) return 2
    return 0
  }

  return {
    key, canStep, isStandable, elevationCost, flood,
    getReachable, findPath, pathCost, apForPath, tileNode,
    NEIGHBOURS,
    dispose() {},
  }
}
