import { CARDINALS, DIAGONALS, GridPos, posKey, keyPos } from '../math/grid';
import { VoxelMap } from '../map/voxelmap';
import { GameState, Unit, livingUnits } from '../state';

/**
 * Movement costs in half-tile integer units to stay exactly deterministic:
 * orthogonal step = 2, diagonal = 3 (~1.5 tiles), stairs / drop-off = 2.
 */
export const ORTHO_COST = 2;
export const DIAG_COST = 3;

export interface ReachableTile {
  pos: GridPos;
  cost: number; // half-tile units from the start
  apCost: 1 | 2; // move action cost: blue zone = 1, dash zone = 2
  /** Occupied by a friendly unit: can pass through but not stop here. */
  passOnly: boolean;
}

export interface ReachResult {
  /** posKey -> tile info for every tile reachable this turn. */
  tiles: Map<number, ReachableTile>;
  /** posKey -> parent posKey for path extraction. */
  parents: Map<number, number>;
  /** Half-tile budget of a single move action for this unit. */
  blueBudget: number;
  maxBudget: number;
}

interface Edge {
  to: GridPos;
  cost: number;
  /** Levels fallen when traversing this edge (fall damage applies past 1). */
  drop: number;
}

/** All legal single-step moves from `p`. Fixed enumeration order => deterministic Dijkstra. */
export function neighbors(map: VoxelMap, p: GridPos): Edge[] {
  const out: Edge[] = [];

  // Stairs up.
  for (const c of CARDINALS) {
    const up = { x: p.x + c.dx, y: p.y + c.dy, z: p.z + 1 };
    if (map.stairsConnect(p, up) && map.isStandable(up.x, up.y, up.z)) {
      out.push({ to: up, cost: ORTHO_COST, drop: 0 });
    }
  }
  // Stairs down: standing above the top end of a stair cell.
  for (const c of CARDINALS) {
    const stairCell = { x: p.x + c.dx, y: p.y + c.dy, z: p.z - 1 };
    if (map.stairsConnect(stairCell, p) && map.isStandable(stairCell.x, stairCell.y, stairCell.z)) {
      out.push({ to: stairCell, cost: ORTHO_COST, drop: 0 });
    }
  }

  // Same-level steps and drops.
  const tryLateral = (dx: number, dy: number, diagonal: boolean): void => {
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (diagonal) {
      // No corner cutting: both flanking cardinals must be open and standable.
      const aOk = !map.blocksMove(p.x + dx, p.y, p.z) && map.isStandable(p.x + dx, p.y, p.z);
      const bOk = !map.blocksMove(p.x, p.y + dy, p.z) && map.isStandable(p.x, p.y + dy, p.z);
      if (!aOk || !bOk) return;
    }
    if (map.blocksMove(nx, ny, p.z)) return;
    if (map.isStandable(nx, ny, p.z)) {
      out.push({ to: { x: nx, y: ny, z: p.z }, cost: diagonal ? DIAG_COST : ORTHO_COST, drop: 0 });
      return;
    }
    // Edge drop (orthogonal only): fall to the first standable level below.
    if (diagonal) return;
    for (let z = p.z - 1; z >= 0; z--) {
      if (map.blocksMove(nx, ny, z)) return; // falling onto a wall/crate top is a normal step case, blocked here
      if (map.isStandable(nx, ny, z)) {
        out.push({ to: { x: nx, y: ny, z }, cost: ORTHO_COST, drop: p.z - z });
        return;
      }
    }
  };

  for (const c of CARDINALS) tryLateral(c.dx, c.dy, false);
  for (const c of DIAGONALS) tryLateral(c.dx, c.dy, true);
  return out;
}

/** Binary min-heap on (cost, posKey) — posKey tiebreak keeps ordering fully deterministic. */
class Heap {
  private a: { cost: number; key: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(cost: number, key: number): void {
    const a = this.a;
    a.push({ cost, key });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }
  pop(): { cost: number; key: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  private less(x: { cost: number; key: number }, y: { cost: number; key: number }): boolean {
    return x.cost < y.cost || (x.cost === y.cost && x.key < y.key);
  }
}

/**
 * Dijkstra flood from the unit's position, bounded by its dash budget.
 * Enemy-occupied tiles are impassable; friendly-occupied tiles are
 * pass-through only. Returns exact per-tile costs for the movement preview.
 */
export function computeReachable(state: GameState, unit: Unit): ReachResult {
  const { map } = state;
  const apAvailable = unit.ap;
  const blueBudget = unit.mobility * 2;
  const maxBudget = apAvailable >= 2 ? blueBudget * 2 : apAvailable === 1 ? blueBudget : 0;

  const occupiedEnemy = new Set<number>();
  const occupiedFriendly = new Set<number>();
  for (const u of livingUnits(state)) {
    if (u.id === unit.id) continue;
    (u.player === unit.player ? occupiedFriendly : occupiedEnemy).add(posKey(u.pos));
  }

  const dist = new Map<number, number>();
  const parents = new Map<number, number>();
  const startKey = posKey(unit.pos);
  dist.set(startKey, 0);
  const heap = new Heap();
  heap.push(0, startKey);

  while (heap.size > 0) {
    const { cost, key } = heap.pop();
    if (cost !== dist.get(key)) continue; // stale entry
    const p = keyPos(key);
    for (const edge of neighbors(map, p)) {
      const nk = posKey(edge.to);
      if (occupiedEnemy.has(nk)) continue;
      const nc = cost + edge.cost;
      if (nc > maxBudget) continue;
      const prev = dist.get(nk);
      if (prev === undefined || nc < prev) {
        dist.set(nk, nc);
        parents.set(nk, key);
        heap.push(nc, nk);
      }
    }
  }

  const tiles = new Map<number, ReachableTile>();
  for (const [key, cost] of dist) {
    if (key === startKey) continue;
    tiles.set(key, {
      pos: keyPos(key),
      cost,
      apCost: cost <= blueBudget ? 1 : 2,
      passOnly: occupiedFriendly.has(key),
    });
  }
  return { tiles, parents, blueBudget, maxBudget };
}

/** Extracts the path (excluding start) to `to`; null if unreachable or stop-blocked. */
export function extractPath(reach: ReachResult, start: GridPos, to: GridPos): GridPos[] | null {
  const toKey = posKey(to);
  const tile = reach.tiles.get(toKey);
  if (!tile || tile.passOnly) return null;
  const path: GridPos[] = [];
  let k = toKey;
  const startKey = posKey(start);
  while (k !== startKey) {
    path.push(keyPos(k));
    const parent = reach.parents.get(k);
    if (parent === undefined) return null;
    k = parent;
  }
  path.reverse();
  return path;
}
