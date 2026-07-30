import * as THREE from 'three'

export const TILE = 2.0
export const ELEV_STEP = 2.0

/**
 * Canonical grid <-> world conversion. Every module must go through this so a
 * change to tile size never desynchronises rendering from the rules.
 */
export function createGrid(W = 24, H = 24) {
  const grid = {
    W,
    H,
    TILE,
    ELEV_STEP,

    /** Grid coords -> world position (tile centre, top of the elevation slab). */
    toWorld(x, z, elevation = 0, target = new THREE.Vector3()) {
      return target.set(
        (x - W / 2 + 0.5) * TILE,
        elevation * ELEV_STEP,
        (z - H / 2 + 0.5) * TILE
      )
    },

    /** World position -> nearest grid coords. Does not clamp elevation. */
    toGrid(v3) {
      return {
        x: Math.floor(v3.x / TILE + W / 2),
        z: Math.floor(v3.z / TILE + H / 2),
      }
    },

    inBounds(x, z) {
      return x >= 0 && z >= 0 && x < W && z < H
    },

    /** Chebyshev distance in tiles — matches XCOM-style 8-way movement. */
    dist(a, b) {
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))
    },

    /** Euclidean tile distance, for range falloff. */
    distEuclid(a, b) {
      return Math.hypot(a.x - b.x, a.z - b.z)
    },

    key(x, z) {
      return x + z * W
    },
  }
  return grid
}
