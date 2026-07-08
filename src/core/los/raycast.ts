import { VoxelMap, VoxelType } from '../map/voxelmap';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Amanatides & Woo 3D DDA voxel traversal.
 *
 * Coordinates are in tile units: cell (x,y,z) spans [x,x+1)x[y,y+1)x[z,z+1).
 * Both players run this exact routine, and ties (ray crossing an edge/corner)
 * are broken by a fixed rule — step X first, then Y, then Z — so results are
 * identical everywhere.
 *
 * Blocking rules:
 *  - Solid voxels and closed doors block.
 *  - Half voxels block only if the ray passes through their lower half
 *    (evaluated at the midpoint of the ray segment inside the cell).
 *  - Floor/stairs panels block only vertical crossings between cell z-1 and z.
 *  - The start and end cells never block (a unit sees out of its own tile).
 *
 * Returns true if the line from `a` to `b` is clear.
 */
export function traceRay(map: VoxelMap, a: Vec3, b: Vec3): boolean {
  let x = Math.floor(a.x);
  let y = Math.floor(a.y);
  let z = Math.floor(a.z);
  const ex = Math.floor(b.x);
  const ey = Math.floor(b.y);
  const ez = Math.floor(b.z);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // Parametric distance along the ray (t in [0,1]) to the next cell boundary,
  // and per-cell increments.
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = stepX !== 0 ? (stepX > 0 ? (x + 1 - a.x) / dx : (x - a.x) / dx) : Infinity;
  let tMaxY = stepY !== 0 ? (stepY > 0 ? (y + 1 - a.y) / dy : (y - a.y) / dy) : Infinity;
  let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? (z + 1 - a.z) / dz : (z - a.z) / dz) : Infinity;

  let tEnter = 0;
  const startX = x;
  const startY = y;
  const startZ = z;

  for (let guard = 0; guard < 4096; guard++) {
    const atStart = x === startX && y === startY && z === startZ;
    const atEnd = x === ex && y === ey && z === ez;

    if (!atStart && !atEnd) {
      // Segment of the ray inside this cell: [tEnter, tExit].
      const tExit = Math.min(tMaxX, tMaxY, tMaxZ, 1);
      const tMid = (tEnter + tExit) / 2;
      const zMid = a.z + dz * tMid;
      const zFrac = zMid - z;
      if (map.blocksSight(x, y, z, zFrac)) return false;
    }

    if (atEnd) return true;

    // Fixed tie-breaking: X, then Y, then Z.
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      tEnter = tMaxX;
      tMaxX += tDeltaX;
      x += stepX;
    } else if (tMaxY <= tMaxZ) {
      tEnter = tMaxY;
      tMaxY += tDeltaY;
      y += stepY;
    } else {
      tEnter = tMaxZ;
      tMaxZ += tDeltaZ;
      const zNew = z + stepZ;
      // Floors/stairs are thin panels at the bottom of a cell: crossing the
      // horizontal boundary between z and zNew is blocked by a panel in the
      // upper of the two cells (unless that cell is where the ray ends/starts).
      const upper = Math.max(z, zNew);
      const ux = x;
      const uy = y;
      const isEndpointCell =
        (ux === startX && uy === startY && upper === startZ) || (ux === ex && uy === ey && upper === ez);
      if (!isEndpointCell) {
        const v = map.get(ux, uy, upper);
        if (v.type === VoxelType.Floor || v.type === VoxelType.Stairs) return false;
      }
      z = zNew;
    }

    if (tEnter > 1) return true; // passed the target point
  }
  return true;
}
