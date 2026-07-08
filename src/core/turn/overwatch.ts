import { GameState, Unit, livingUnits } from '../state';
import { SimEvent } from '../events';
import { computeShot } from '../combat/hitchance';
import { resolveAttack } from '../combat/damage';
import { canSeeUnit } from '../los/sight';

/**
 * Reaction fire check when `mover` enters a tile. Every enemy on overwatch
 * with sight + line of fire triggers once, in ascending unit id (fixed order
 * => deterministic). Returns true if the mover died and movement must stop.
 */
export function triggerOverwatch(state: GameState, mover: Unit, events: SimEvent[]): boolean {
  const enemies = livingUnits(state, mover.player === 1 ? 2 : 1)
    .filter((u) => u.overwatch)
    .sort((a, b) => a.id - b.id);

  for (const watcher of enemies) {
    if (!mover.alive) break;
    if (watcher.ammo < 1) continue;
    if (!canSeeUnit(state.map, watcher.pos, mover.pos, watcher.sight)) continue;
    const weapon = state.ruleset.weapons.get(watcher.weaponId)!;
    const mode = weapon.modes.snap ?? weapon.modes.aimed;
    if (!mode) continue;
    const modeName = weapon.modes.snap ? 'snap' : 'aimed';
    const preview = computeShot(state, watcher, mover, weapon, modeName, true);
    if (!preview.ok) continue;
    watcher.overwatch = false;
    watcher.ammo -= 1;
    events.push(resolveAttack(state, watcher, mover, preview, weapon.damage, modeName, true));
  }
  return !mover.alive;
}
