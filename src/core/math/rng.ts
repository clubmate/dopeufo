/**
 * Deterministic seeded PRNG (mulberry32). The single RNG stream lives in
 * GameState; every random decision in the simulation must go through it so
 * that identical seeds + identical commands produce identical games.
 */
export interface RngState {
  s: number; // uint32
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

/** Returns a float in [0, 1) and advances the state. */
export function rngNext(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, max] inclusive. */
export function rngInt(rng: RngState, min: number, max: number): number {
  return min + Math.floor(rngNext(rng) * (max - min + 1));
}

/** Percentile roll: true with probability `percent`/100. */
export function rngRoll(rng: RngState, percent: number): boolean {
  return rngNext(rng) * 100 < percent;
}
