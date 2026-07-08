/** Integer grid position. x/y are the ground plane, z is the height level. */
export interface GridPos {
  x: number;
  y: number;
  z: number;
}

export function pos(x: number, y: number, z: number): GridPos {
  return { x, y, z };
}

export function posEq(a: GridPos, b: GridPos): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function posKey(p: GridPos): number {
  // Packs a position into one integer; supports maps up to 1024x1024x64.
  return (p.z << 20) | (p.y << 10) | p.x;
}

export function keyPos(k: number): GridPos {
  return { x: k & 1023, y: (k >> 10) & 1023, z: k >> 20 };
}

/** Chebyshev-ish distance used for ranges: diagonal steps count 1.5 (x2 int). */
export function moveDist2(a: GridPos, b: GridPos): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const diag = Math.min(dx, dy);
  return diag * 3 + (Math.max(dx, dy) - diag) * 2;
}

/** Euclidean tile distance (3D), used for weapon range curves and sight. */
export function euclid(a: GridPos, b: GridPos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const CARDINALS: ReadonlyArray<Readonly<{ dx: number; dy: number }>> = [
  { dx: 0, dy: -1 }, // N
  { dx: 1, dy: 0 }, // E
  { dx: 0, dy: 1 }, // S
  { dx: -1, dy: 0 }, // W
];

export const DIAGONALS: ReadonlyArray<Readonly<{ dx: number; dy: number }>> = [
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
];
