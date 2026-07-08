import { euclid, GridPos } from '../math/grid';
import { GameState, Unit, isSmoked } from '../state';
import { RangeCurve, ShotMode, WeaponDef } from '../rules/ruleset';
import { coverAgainst, CoverType } from '../los/cover';
import { lineOfSight } from '../los/sight';

export interface ShotPreview {
  ok: boolean;
  reason?: string;
  chance: number;
  critChance: number;
  cover: CoverType;
  flanked: boolean;
  /** Tile the shooter actually fires from (own tile or a peek side-step). */
  origin: GridPos;
  distance: number;
}

/** Aim modifier from weapon range profile at `dist` tiles. */
export function rangeCurveMod(curve: RangeCurve, dist: number): number {
  switch (curve) {
    case 'rifle':
      return dist <= 10 ? 0 : Math.max(-30, -(dist - 10) * 3);
    case 'sniper':
      return dist < 4 ? -(4 - dist) * 10 : 5;
    case 'shotgun':
      return dist <= 8 ? Math.round(30 * (1 - (dist - 1) / 7)) : Math.max(-40, -(dist - 8) * 4);
    case 'launcher':
      return 0;
  }
}

/**
 * Full hit-chance computation for a direct shot. Also validates LoF (with
 * peeking). Every term is data-driven from the ruleset constants.
 */
export function computeShot(
  state: GameState,
  shooter: Unit,
  target: Unit,
  weapon: WeaponDef,
  mode: ShotMode,
  reaction: boolean,
): ShotPreview {
  const k = state.ruleset.constants;
  const modeDef = weapon.modes[mode];
  const fail = (reason: string): ShotPreview => ({
    ok: false,
    reason,
    chance: 0,
    critChance: 0,
    cover: CoverType.None,
    flanked: false,
    origin: shooter.pos,
    distance: 0,
  });
  if (!modeDef) return fail(`weapon has no ${mode} mode`);

  const dist = euclid(shooter.pos, target.pos);
  if (dist > weapon.range) return fail('out of range');

  const origin = lineOfSight(state.map, shooter.pos, target.pos);
  if (!origin) return fail('no line of fire');

  const { cover, flanked } = coverAgainst(state.map, target.pos, origin);
  let defense = cover === CoverType.Full ? k.fullCoverDefense : cover === CoverType.Half ? k.halfCoverDefense : 0;
  if (target.hunkered && defense > 0) defense *= k.hunkerMultiplier;
  if (isSmoked(state, target.pos)) defense += k.smokeDefense;

  let aim = shooter.aim + modeDef.aimMod + rangeCurveMod(weapon.curve, dist);
  if (shooter.pos.z > target.pos.z) aim += k.heightAimBonus;
  if (reaction) aim -= k.overwatchAimMalus;

  const chance = Math.min(k.maxHitChance, Math.max(k.minHitChance, Math.round(aim - defense)));
  let critChance = weapon.critChance + modeDef.critMod + (flanked ? k.flankCritBonus : 0);
  if (target.hunkered) critChance = 0;
  critChance = Math.min(100, Math.max(0, critChance));

  return { ok: true, chance, critChance, cover, flanked, origin, distance: dist };
}

/** Melee preview: adjacent (incl. diagonal), same level, no cover involved. */
export function computeMelee(state: GameState, attacker: Unit, target: Unit): ShotPreview {
  const k = state.ruleset.constants;
  const cls = state.ruleset.classes.get(attacker.classId)!;
  const fail = (reason: string): ShotPreview => ({
    ok: false,
    reason,
    chance: 0,
    critChance: 0,
    cover: CoverType.None,
    flanked: false,
    origin: attacker.pos,
    distance: 0,
  });
  if (!cls.melee) return fail('no melee attack');
  const dx = Math.abs(attacker.pos.x - target.pos.x);
  const dy = Math.abs(attacker.pos.y - target.pos.y);
  if (attacker.pos.z !== target.pos.z || Math.max(dx, dy) !== 1) return fail('not adjacent');
  const chance = Math.min(k.maxHitChance, Math.max(k.minHitChance, attacker.aim + cls.melee.aimBonus));
  return {
    ok: true,
    chance,
    critChance: 15,
    cover: CoverType.None,
    flanked: false,
    origin: attacker.pos,
    distance: 1,
  };
}
