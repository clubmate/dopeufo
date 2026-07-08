import { GameState, Unit } from '../state';
import { rngInt, rngRoll } from '../math/rng';
import { SimEvent } from '../events';
import { ShotMode } from '../rules/ruleset';
import { ShotPreview } from './hitchance';

/** Applies damage to a unit; returns true if it died. */
export function applyDamage(unit: Unit, amount: number): boolean {
  unit.hp = Math.max(0, unit.hp - amount);
  if (unit.hp === 0 && unit.alive) {
    unit.alive = false;
    unit.overwatch = false;
    unit.hunkered = false;
    return true;
  }
  return false;
}

/**
 * Rolls one attack (hit roll, crit roll, damage roll) and mutates the target.
 * RNG order is fixed: hit, then crit, then damage — never reorder, replays
 * depend on it.
 */
export function resolveAttack(
  state: GameState,
  shooter: Unit,
  target: Unit,
  preview: ShotPreview,
  damageRange: [number, number],
  mode: ShotMode | 'melee',
  reaction: boolean,
): SimEvent {
  const hit = rngRoll(state.rng, preview.chance);
  let crit = false;
  let damage = 0;
  let killed = false;
  if (hit) {
    crit = preview.critChance > 0 && rngRoll(state.rng, preview.critChance);
    damage = rngInt(state.rng, damageRange[0], damageRange[1]);
    if (crit) damage = Math.round(damage * state.ruleset.constants.critMultiplier);
    killed = applyDamage(target, damage);
  }
  return {
    kind: 'shot',
    shooterId: shooter.id,
    targetId: target.id,
    mode,
    reaction,
    hitChance: preview.chance,
    hit,
    crit,
    damage,
    killed,
  };
}
