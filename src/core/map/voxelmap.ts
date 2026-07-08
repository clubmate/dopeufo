import { CARDINALS, GridPos } from '../math/grid';

export enum VoxelType {
  Empty = 0,
  /** Full solid cube: blocks movement and LoS, walkable on top. */
  Solid = 1,
  /** Half-height obstacle (crates, low walls): blocks movement, grants half cover, LoS passes above. */
  Half = 2,
  /** Thin walkable floor panel at the bottom of the cell (upper storeys). */
  Floor = 3,
  /** Ramp connecting this cell (z) with the cell one level up in `stairDir`. */
  Stairs = 4,
  /** Door: closed = blocks movement + LoS (full cover); open = passable. */
  Door = 5,
}

export interface Material {
  id: string;
  color: number;
  hp: number; // voxel hit points vs explosions; Infinity = indestructible
}

export interface Voxel {
  type: VoxelType;
  material: string;
  hp: number;
  /** For stairs: index into CARDINALS pointing "uphill". For doors: wall axis (0 = N/S wall, 1 = E/W). */
  dir: number;
  open?: boolean; // doors only
}

const EMPTY: Readonly<Voxel> = Object.freeze({ type: VoxelType.Empty, material: '', hp: 0, dir: 0 });

/**
 * Dense 3D voxel grid. z=0 sits on indestructible bedrock, so every z=0 cell
 * without a blocking voxel is walkable ground.
 */
export class VoxelMap {
  readonly cells: Voxel[];

  constructor(
    readonly w: number,
    readonly h: number,
    readonly d: number,
  ) {
    this.cells = new Array(w * h * d).fill(EMPTY);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.w && y >= 0 && y < this.h && z >= 0 && z < this.d;
  }

  idx(x: number, y: number, z: number): number {
    return (z * this.h + y) * this.w + x;
  }

  get(x: number, y: number, z: number): Readonly<Voxel> {
    if (!this.inBounds(x, y, z)) return EMPTY;
    return this.cells[this.idx(x, y, z)];
  }

  getP(p: GridPos): Readonly<Voxel> {
    return this.get(p.x, p.y, p.z);
  }

  set(x: number, y: number, z: number, v: Voxel): void {
    this.cells[this.idx(x, y, z)] = v;
  }

  clear(x: number, y: number, z: number): void {
    this.cells[this.idx(x, y, z)] = EMPTY;
  }

  /** Can a unit occupy this cell? (does not check other units) */
  isStandable(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const v = this.get(x, y, z);
    const occupiable =
      v.type === VoxelType.Empty ||
      v.type === VoxelType.Floor ||
      v.type === VoxelType.Stairs ||
      (v.type === VoxelType.Door && v.open === true);
    if (!occupiable) return false;
    return this.hasSupport(x, y, z);
  }

  hasSupport(x: number, y: number, z: number): boolean {
    const v = this.get(x, y, z);
    if (v.type === VoxelType.Floor || v.type === VoxelType.Stairs) return true;
    if (z === 0) return true; // bedrock
    const below = this.get(x, y, z - 1);
    return below.type === VoxelType.Solid || below.type === VoxelType.Half || below.type === VoxelType.Stairs;
  }

  /** Does this cell block straight-line movement through it (walls, closed doors, low cover)? */
  blocksMove(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return true;
    const v = this.get(x, y, z);
    return (
      v.type === VoxelType.Solid ||
      v.type === VoxelType.Half ||
      (v.type === VoxelType.Door && v.open !== true)
    );
  }

  /**
   * Sight blockage of a cell for a ray passing through it at fractional
   * height `zFrac` (0 = cell bottom, 1 = cell top). Half-height voxels only
   * block the lower half; floors only block a ray crossing them vertically
   * (handled by the traversal, not here).
   */
  blocksSight(x: number, y: number, z: number, zFrac: number): boolean {
    if (!this.inBounds(x, y, z)) return false; // outside map = open sky
    const v = this.get(x, y, z);
    if (v.type === VoxelType.Solid) return true;
    if (v.type === VoxelType.Door && v.open !== true) return true;
    if (v.type === VoxelType.Half && zFrac < 0.5) return true;
    return false;
  }

  /** Stairs in `from` leading up toward `to` (same x/y step as the stair direction)? */
  stairsConnect(from: GridPos, to: GridPos): boolean {
    const v = this.getP(from);
    if (v.type !== VoxelType.Stairs) return false;
    const c = CARDINALS[v.dir];
    return to.x === from.x + c.dx && to.y === from.y + c.dy && to.z === from.z + 1;
  }
}
