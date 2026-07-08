import { GridPos, CARDINALS, euclid } from '../math/grid';
import { VoxelMap } from '../map/voxelmap';
import { traceRay, Vec3 } from './raycast';
import { coverProfile, CoverType } from './cover';

export const EYE_HEIGHT = 0.7;
export const CENTER_HEIGHT = 0.5;

export function eyePos(p: GridPos): Vec3 {
  return { x: p.x + 0.5, y: p.y + 0.5, z: p.z + EYE_HEIGHT };
}

export function centerPos(p: GridPos): Vec3 {
  return { x: p.x + 0.5, y: p.y + 0.5, z: p.z + CENTER_HEIGHT };
}

/**
 * Peek origins for a unit at `p`: its own tile plus side-steps into standable
 * cardinal neighbors when the unit is next to cover (stepping out of cover to
 * shoot around a corner, like XCOM). Order is fixed (self, N, E, S, W) for
 * determinism.
 */
export function peekOrigins(map: VoxelMap, p: GridPos): GridPos[] {
  const origins: GridPos[] = [p];
  const prof = coverProfile(map, p);
  const hasCover = prof.some((c) => c !== CoverType.None);
  if (!hasCover) return origins;
  for (let d = 0; d < 4; d++) {
    const c = CARDINALS[d];
    const n = { x: p.x + c.dx, y: p.y + c.dy, z: p.z };
    if (map.isStandable(n.x, n.y, n.z)) origins.push(n);
  }
  return origins;
}

/**
 * Line of sight from a viewer tile to a target tile (both unit-height),
 * including peeking. Returns the origin used, or null when blocked.
 * Deterministic: origins are tried in fixed order.
 */
export function lineOfSight(map: VoxelMap, from: GridPos, to: GridPos): GridPos | null {
  for (const origin of peekOrigins(map, from)) {
    if (traceRay(map, eyePos(origin), centerPos(to))) return origin;
  }
  return null;
}

/** Can a unit at `from` with sight radius `range` see the unit tile `to`? */
export function canSeeUnit(map: VoxelMap, from: GridPos, to: GridPos, range: number): boolean {
  if (euclid(from, to) > range) return false;
  return lineOfSight(map, from, to) !== null;
}

/**
 * Tile visibility for fog of war: no peeking (cheaper, and fog is about
 * area awareness, not corner shots).
 */
export function canSeeTile(map: VoxelMap, from: GridPos, tile: GridPos, range: number): boolean {
  if (euclid(from, tile) > range) return false;
  return traceRay(map, eyePos(from), centerPos(tile));
}
