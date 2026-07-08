import { CARDINALS, GridPos } from '../math/grid';
import { VoxelMap, VoxelType } from '../map/voxelmap';

export enum CoverType {
  None = 0,
  Half = 1,
  Full = 2,
}

/** Cover provided to a unit standing at `p` from the cardinal direction `dirIdx`. */
export function coverInDirection(map: VoxelMap, p: GridPos, dirIdx: number): CoverType {
  const c = CARDINALS[dirIdx];
  const v = map.get(p.x + c.dx, p.y + c.dy, p.z);
  if (v.type === VoxelType.Solid) return CoverType.Full;
  if (v.type === VoxelType.Door && v.open !== true) return CoverType.Full;
  if (v.type === VoxelType.Half) return CoverType.Half;
  return CoverType.None;
}

/** All four cover values for a tile (N,E,S,W) — used for the cover-shield UI. */
export function coverProfile(map: VoxelMap, p: GridPos): [CoverType, CoverType, CoverType, CoverType] {
  return [0, 1, 2, 3].map((d) => coverInDirection(map, p, d)) as [CoverType, CoverType, CoverType, CoverType];
}

/**
 * Effective cover of a target at `target` against a shooter at `shooter`
 * (XCOM rule): a cover object counts only if the shooter lies on that side of
 * the target. Exactly-diagonal shooters activate both adjacent covers; the
 * best applicable one is used. No applicable cover => flanked.
 * Shooting from strictly above ignores same-level cover only if the height
 * difference exceeds 1 (leaning over the parapet).
 */
export function coverAgainst(map: VoxelMap, target: GridPos, shooter: GridPos): { cover: CoverType; flanked: boolean } {
  const dx = shooter.x - target.x;
  const dy = shooter.y - target.y;
  if (dx === 0 && dy === 0) return { cover: CoverType.None, flanked: true };
  if (shooter.z - target.z > 1) return { cover: CoverType.None, flanked: false };

  let best = CoverType.None;
  let anyCoverExists = false;
  for (let d = 0; d < 4; d++) {
    const cov = coverInDirection(map, target, d);
    if (cov === CoverType.None) continue;
    anyCoverExists = true;
    const c = CARDINALS[d];
    const dot = c.dx * dx + c.dy * dy;
    if (dot > 0 && cov > best) best = cov;
  }
  return { cover: best, flanked: anyCoverExists && best === CoverType.None };
}
