import { GameState, Unit, unitAt } from '../state';
import { Command } from './commands';
import { computeReachable } from '../path/pathfind';
import { computeShot, computeMelee } from '../combat/hitchance';
import { euclid, posKey } from '../math/grid';
import { VoxelType } from '../map/voxelmap';
import { traceRay } from '../los/raycast';
import { eyePos, centerPos } from '../los/sight';

export type Validation = { ok: true } | { ok: false; reason: string };

const ok: Validation = { ok: true };
const no = (reason: string): Validation => ({ ok: false, reason });

/**
 * Full legality check for a command in the current state. The executor
 * refuses invalid commands, so the UI can never corrupt the sim.
 */
export function validate(state: GameState, cmd: Command): Validation {
  if (state.winner !== 0) return no('game is over');
  if (cmd.kind === 'endTurn') return ok;

  const unit = state.units.find((u) => u.id === cmd.unitId);
  if (!unit) return no('no such unit');
  if (!unit.alive) return no('unit is dead');
  if (unit.player !== state.currentPlayer) return no('not your unit');

  switch (cmd.kind) {
    case 'move': {
      if (unit.ap < 1) return no('no actions left');
      const reach = computeReachable(state, unit);
      const tile = reach.tiles.get(posKey(cmd.to));
      if (!tile) return no('tile not reachable');
      if (tile.passOnly) return no('tile occupied');
      if (tile.apCost > unit.ap) return no('not enough actions');
      return ok;
    }
    case 'shoot': {
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      if (weapon.explosive) return no('use tile targeting for this weapon');
      const mode = weapon.modes[cmd.mode];
      if (!mode) return no('weapon lacks this fire mode');
      if (unit.ap < mode.apCost) return no('not enough actions');
      if (unit.ammo < 1) return no('out of ammo');
      const target = state.units.find((u) => u.id === cmd.targetId);
      if (!target || !target.alive) return no('no target');
      if (target.player === unit.player) return no('cannot target ally');
      if (!state.vision[unit.player].units.has(target.id)) return no('target not visible');
      const preview = computeShot(state, unit, target, weapon, cmd.mode, false);
      return preview.ok ? ok : no(preview.reason!);
    }
    case 'shootTile': {
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      if (!weapon.explosive) return no('weapon is not explosive');
      const mode = weapon.modes.snap!;
      if (unit.ap < mode.apCost) return no('not enough actions');
      if (unit.ammo < 1) return no('out of ammo');
      if (euclid(unit.pos, cmd.target) > weapon.range) return no('out of range');
      if (!hasThrowPath(state, unit, cmd.target)) return no('no clear shot to that tile');
      return ok;
    }
    case 'melee': {
      const cls = state.ruleset.classes.get(unit.classId)!;
      if (!cls.melee) return no('unit has no melee attack');
      if (unit.ap < cls.melee.apCost) return no('not enough actions');
      const target = state.units.find((u) => u.id === cmd.targetId);
      if (!target || !target.alive) return no('no target');
      if (target.player === unit.player) return no('cannot target ally');
      const preview = computeMelee(state, unit, target);
      return preview.ok ? ok : no(preview.reason!);
    }
    case 'throw': {
      const item = getItem(state, unit, cmd.itemIndex);
      if (typeof item === 'string') return no(item);
      if (item.type !== 'grenade' && item.type !== 'smoke') return no('item is not throwable');
      if (unit.ap < item.apCost) return no('not enough actions');
      if (euclid(unit.pos, cmd.target) > item.range) return no('out of throw range');
      if (!hasThrowPath(state, unit, cmd.target)) return no('no clear throw to that tile');
      return ok;
    }
    case 'medkit': {
      const item = getItem(state, unit, cmd.itemIndex);
      if (typeof item === 'string') return no(item);
      if (item.type !== 'medkit') return no('item is not a medkit');
      if (unit.ap < item.apCost) return no('not enough actions');
      const target = state.units.find((u) => u.id === cmd.targetId);
      if (!target || !target.alive) return no('no target');
      if (target.player !== unit.player) return no('can only heal allies');
      if (target.hp >= target.maxHp) return no('target at full health');
      const dx = Math.abs(unit.pos.x - target.pos.x);
      const dy = Math.abs(unit.pos.y - target.pos.y);
      const adjacent = target.id === unit.id || (Math.max(dx, dy) <= 1 && unit.pos.z === target.pos.z);
      return adjacent ? ok : no('target not adjacent');
    }
    case 'reload': {
      if (unit.ap < 1) return no('no actions left');
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      if (unit.ammo >= weapon.clip) return no('magazine already full');
      return ok;
    }
    case 'overwatch': {
      if (unit.ap < 1) return no('no actions left');
      if (unit.overwatch) return no('already on overwatch');
      if (unit.ammo < 1) return no('out of ammo');
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      if (weapon.explosive) return no('explosive weapons cannot overwatch');
      return ok;
    }
    case 'hunker': {
      if (unit.ap < 1) return no('no actions left');
      if (unit.hunkered) return no('already hunkered');
      return ok;
    }
    case 'door': {
      const v = state.map.getP(cmd.pos);
      if (v.type !== VoxelType.Door) return no('no door there');
      const dx = Math.abs(unit.pos.x - cmd.pos.x);
      const dy = Math.abs(unit.pos.y - cmd.pos.y);
      if (Math.max(dx, dy) !== 1 || unit.pos.z !== cmd.pos.z) return no('door not adjacent');
      if (unitAt(state, cmd.pos)) return no('doorway blocked');
      if (unit.doorUsed && unit.ap < 1) return no('no actions left');
      return ok;
    }
  }
}

function getItem(state: GameState, unit: Unit, index: number) {
  const id = unit.items[index];
  if (!id) return 'no such item';
  return state.ruleset.items.get(id) ?? 'unknown item';
}

/**
 * Grenades/launcher rounds need a clear arc: approximated as a clear ray from
 * the thrower's eye to the target cell center OR to one tile above it (lob).
 */
export function hasThrowPath(state: GameState, unit: Unit, target: { x: number; y: number; z: number }): boolean {
  const from = eyePos(unit.pos);
  if (traceRay(state.map, from, centerPos(target))) return true;
  if (target.z + 1 < state.map.d && traceRay(state.map, from, centerPos({ ...target, z: target.z + 1 }))) return true;
  return false;
}
