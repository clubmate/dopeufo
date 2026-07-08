import { GameState, PlayerId, livingUnits } from '../state';
import { posKey } from '../math/grid';
import { canSeeTile, canSeeUnit } from '../los/sight';

/**
 * Recomputes both players' vision: visible tile set (fog dimming), spotted
 * enemy units, and last-seen ghosts. Called by the sim after any event that
 * can change sightlines (movement, doors, destruction, death).
 */
export function updateVision(state: GameState): void {
  for (const player of [1, 2] as const) {
    updatePlayerVision(state, player);
  }
}

function updatePlayerVision(state: GameState, player: PlayerId): void {
  const vision = state.vision[player];
  const map = state.map;
  const mine = livingUnits(state, player);

  const tiles = new Set<number>();
  for (const u of mine) {
    const r = u.sight;
    const rCeil = Math.ceil(r);
    for (let dz = 0; dz < map.d; dz++) {
      for (let y = Math.max(0, u.pos.y - rCeil); y <= Math.min(map.h - 1, u.pos.y + rCeil); y++) {
        for (let x = Math.max(0, u.pos.x - rCeil); x <= Math.min(map.w - 1, u.pos.x + rCeil); x++) {
          const tile = { x, y, z: dz };
          const k = posKey(tile);
          if (tiles.has(k)) continue;
          if (canSeeTile(map, u.pos, tile, r)) tiles.add(k);
        }
      }
    }
  }

  const enemies = livingUnits(state, player === 1 ? 2 : 1);
  const spotted = new Set<number>();
  for (const e of enemies) {
    for (const u of mine) {
      if (canSeeUnit(map, u.pos, e.pos, u.sight)) {
        spotted.add(e.id);
        break;
      }
    }
  }

  // Ghost bookkeeping: while an enemy is spotted we keep refreshing its
  // last-known position; once it leaves sight the stale entry *is* the ghost
  // (rendered only for enemies not currently spotted). Death clears it.
  for (const e of enemies) {
    if (spotted.has(e.id)) {
      vision.ghosts.set(e.id, { unitId: e.id, pos: { ...e.pos }, turnSeen: state.turn });
    }
  }
  for (const [unitId] of vision.ghosts) {
    const unit = state.units.find((u) => u.id === unitId);
    if (!unit || !unit.alive) vision.ghosts.delete(unitId);
  }

  vision.tiles = tiles;
  vision.units = spotted;
}
