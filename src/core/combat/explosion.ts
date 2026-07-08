import { GridPos, euclid, posKey } from '../math/grid';
import { GameState, livingUnits } from '../state';
import { VoxelType } from '../map/voxelmap';
import { rngInt } from '../math/rng';
import { traceRay } from '../los/raycast';
import { centerPos } from '../los/sight';
import { SimEvent } from '../events';
import { applyDamage } from './damage';

/** Explosion damage is multiplied by this factor against terrain voxel HP. */
const TERRAIN_DAMAGE_SCALE = 15;

function falloff(base: number, dist: number, radius: number): number {
  return Math.max(0, Math.round(base * (1 - dist / (radius + 1))));
}

/**
 * Detonates an explosion: rolls base damage once, applies distance falloff to
 * units and voxels (both require an unblocked ray from the blast center —
 * walls shield what's behind them), removes destroyed voxels, collapses
 * unsupported structure, and drops units whose floor vanished.
 */
export function detonate(
  state: GameState,
  center: GridPos,
  radius: number,
  damageRange: [number, number],
  events: SimEvent[],
  from?: GridPos,
): void {
  const { map } = state;
  const base = rngInt(state.rng, damageRange[0], damageRange[1]);
  const blast = { x: center.x + 0.5, y: center.y + 0.5, z: center.z + 0.5 };
  const r = Math.ceil(radius);

  // Terrain damage. Deterministic iteration order: z, y, x ascending.
  const destroyed: GridPos[] = [];
  for (let z = Math.max(0, center.z - r); z <= Math.min(map.d - 1, center.z + r); z++) {
    for (let y = Math.max(0, center.y - r); y <= Math.min(map.h - 1, center.y + r); y++) {
      for (let x = Math.max(0, center.x - r); x <= Math.min(map.w - 1, center.x + r); x++) {
        const v = map.get(x, y, z);
        if (v.type === VoxelType.Empty) continue;
        const dist = euclid(center, { x, y, z });
        if (dist > radius) continue;
        const dmg = falloff(base, dist, radius) * TERRAIN_DAMAGE_SCALE;
        if (dmg <= 0) continue;
        // A voxel is exposed if the ray to any of its exposed state is clear;
        // the target voxel itself never blocks its own ray (traceRay skips endpoints).
        if (!(x === center.x && y === center.y && z === center.z)) {
          if (!traceRay(map, blast, { x: x + 0.5, y: y + 0.5, z: z + 0.5 })) continue;
        }
        const hp = v.hp - dmg;
        if (hp <= 0) {
          map.clear(x, y, z);
          destroyed.push({ x, y, z });
        } else {
          map.set(x, y, z, { ...v, hp });
        }
      }
    }
  }

  // Structural collapse of anything no longer connected to support.
  destroyed.push(...collapseUnsupported(state));

  // Unit damage (after terrain so debris doesn't shield mid-blast — the ray
  // check uses the post-destruction map, which favors the attacker slightly
  // and is the simpler deterministic rule).
  const casualties: { unitId: number; damage: number; killed: boolean }[] = [];
  for (const u of livingUnits(state)) {
    const dist = euclid(center, u.pos);
    if (dist > radius + 0.5) continue;
    if (!traceRay(map, blast, centerPos(u.pos))) continue;
    const dmg = Math.max(dist <= radius + 0.5 ? 1 : 0, falloff(base, dist, radius));
    if (dmg <= 0) continue;
    const killed = applyDamage(u, dmg);
    casualties.push({ unitId: u.id, damage: dmg, killed });
  }

  events.push({ kind: 'explosion', center, radius, destroyed, casualties, from });

  // Units whose floor was destroyed fall to the next standable level.
  for (const u of livingUnits(state)) {
    if (map.isStandable(u.pos.x, u.pos.y, u.pos.z)) continue;
    let landing: GridPos | null = null;
    for (let z = u.pos.z - 1; z >= 0; z--) {
      if (map.isStandable(u.pos.x, u.pos.y, z)) {
        landing = { x: u.pos.x, y: u.pos.y, z };
        break;
      }
    }
    if (!landing) continue;
    const levels = u.pos.z - landing.z;
    const dmg = levels > 1 ? (levels - 1) * state.ruleset.constants.fallDamagePerLevel : 0;
    const from2 = { ...u.pos };
    u.pos = landing;
    applyDamage(u, dmg);
    events.push({ kind: 'fall', unitId: u.id, from: from2, to: landing, damage: dmg });
  }
}

/**
 * Support rule: a voxel is supported if it is at z=0, sits on a supported
 * non-empty voxel, or touches a supported non-empty voxel laterally (floors
 * hang off walls). Everything else crumbles. BFS from the ground up.
 */
export function collapseUnsupported(state: GameState): GridPos[] {
  const { map } = state;
  const supported = new Set<number>();
  const queue: GridPos[] = [];

  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.get(x, y, 0).type !== VoxelType.Empty) {
        const p = { x, y, z: 0 };
        supported.add(posKey(p));
        queue.push(p);
      }
    }
  }

  const offsets = [
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: -1, dz: 0 },
    { dx: 1, dy: 0, dz: 0 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
  ];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const o of offsets) {
      const n = { x: p.x + o.dx, y: p.y + o.dy, z: p.z + o.dz };
      if (!map.inBounds(n.x, n.y, n.z)) continue;
      const k = posKey(n);
      if (supported.has(k)) continue;
      if (map.get(n.x, n.y, n.z).type === VoxelType.Empty) continue;
      supported.add(k);
      queue.push(n);
    }
  }

  const collapsed: GridPos[] = [];
  for (let z = 1; z < map.d; z++) {
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (map.get(x, y, z).type === VoxelType.Empty) continue;
        if (!supported.has(posKey({ x, y, z }))) {
          map.clear(x, y, z);
          collapsed.push({ x, y, z });
        }
      }
    }
  }
  return collapsed;
}
