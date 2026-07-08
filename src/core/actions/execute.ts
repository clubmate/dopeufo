import { GameState, getUnit, halfTurn } from '../state';
import { Command } from './commands';
import { validate, Validation } from './validate';
import { SimEvent } from '../events';
import { computeReachable, extractPath } from '../path/pathfind';
import { computeShot, computeMelee } from '../combat/hitchance';
import { resolveAttack, applyDamage } from '../combat/damage';
import { detonate } from '../combat/explosion';
import { triggerOverwatch } from '../turn/overwatch';
import { endTurn, checkWinCondition } from '../turn/turnmanager';
import { updateVision } from '../fog/visibility';
import { posKey, euclid, GridPos } from '../math/grid';

export type ExecResult = { ok: true; events: SimEvent[] } | { ok: false; reason: string };

/**
 * Validates and executes one command against the state, returning the event
 * stream for the presentation layer. This is the single entry point for all
 * game mutations.
 */
export function execute(state: GameState, cmd: Command): ExecResult {
  const v: Validation = validate(state, cmd);
  if (!v.ok) return { ok: false, reason: v.reason };

  const events: SimEvent[] = [];
  switch (cmd.kind) {
    case 'move':
      execMove(state, cmd.unitId, cmd.to, events);
      break;

    case 'shoot': {
      const unit = getUnit(state, cmd.unitId);
      const target = getUnit(state, cmd.targetId);
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      const mode = weapon.modes[cmd.mode]!;
      unit.ap = mode.endsTurn ? 0 : unit.ap - mode.apCost;
      unit.hunkered = false;
      unit.ammo -= 1;
      for (let i = 0; i < mode.shots && target.alive; i++) {
        const preview = computeShot(state, unit, target, weapon, cmd.mode, false);
        if (!preview.ok) break;
        events.push(resolveAttack(state, unit, target, preview, weapon.damage, cmd.mode, false));
      }
      break;
    }

    case 'shootTile': {
      const unit = getUnit(state, cmd.unitId);
      const weapon = state.ruleset.weapons.get(unit.weaponId)!;
      const mode = weapon.modes.snap!;
      unit.ap = mode.endsTurn ? 0 : unit.ap - mode.apCost;
      unit.hunkered = false;
      unit.ammo -= 1;
      detonate(state, cmd.target, weapon.explosive!.radius, weapon.damage, events, { ...unit.pos });
      break;
    }

    case 'melee': {
      const unit = getUnit(state, cmd.unitId);
      const target = getUnit(state, cmd.targetId);
      const melee = state.ruleset.classes.get(unit.classId)!.melee!;
      unit.ap = melee.endsTurn ? 0 : unit.ap - melee.apCost;
      unit.hunkered = false;
      const preview = computeMelee(state, unit, target);
      events.push(resolveAttack(state, unit, target, preview, melee.damage, 'melee', false));
      break;
    }

    case 'throw': {
      const unit = getUnit(state, cmd.unitId);
      const item = state.ruleset.items.get(unit.items[cmd.itemIndex])!;
      unit.items.splice(cmd.itemIndex, 1);
      unit.ap = item.endsTurn ? 0 : unit.ap - item.apCost;
      unit.hunkered = false;
      if (item.type === 'grenade') {
        detonate(state, cmd.target, item.radius!, item.damage!, events, { ...unit.pos });
      } else {
        const tiles = smokeTiles(state, cmd.target, item.radius!);
        const expiry = halfTurn(state) + item.duration!;
        for (const t of tiles) state.smoke.set(posKey(t), expiry);
        events.push({ kind: 'smoke', center: cmd.target, radius: item.radius!, tiles, from: { ...unit.pos } });
      }
      break;
    }

    case 'medkit': {
      const unit = getUnit(state, cmd.unitId);
      const target = getUnit(state, cmd.targetId);
      const item = state.ruleset.items.get(unit.items[cmd.itemIndex])!;
      unit.items.splice(cmd.itemIndex, 1);
      unit.ap -= item.apCost;
      const amount = Math.min(item.heal!, target.maxHp - target.hp);
      target.hp += amount;
      events.push({ kind: 'heal', medicId: unit.id, targetId: target.id, amount });
      break;
    }

    case 'reload': {
      const unit = getUnit(state, cmd.unitId);
      unit.ap -= 1;
      unit.ammo = state.ruleset.weapons.get(unit.weaponId)!.clip;
      events.push({ kind: 'reload', unitId: unit.id });
      break;
    }

    case 'overwatch': {
      const unit = getUnit(state, cmd.unitId);
      unit.ap = 0;
      unit.overwatch = true;
      events.push({ kind: 'overwatchSet', unitId: unit.id });
      break;
    }

    case 'hunker': {
      const unit = getUnit(state, cmd.unitId);
      unit.ap = 0;
      unit.hunkered = true;
      events.push({ kind: 'hunker', unitId: unit.id });
      break;
    }

    case 'door': {
      const unit = getUnit(state, cmd.unitId);
      if (unit.doorUsed) unit.ap -= 1;
      unit.doorUsed = true;
      const voxel = state.map.getP(cmd.pos);
      const open = voxel.open !== true;
      state.map.set(cmd.pos.x, cmd.pos.y, cmd.pos.z, { ...voxel, open });
      events.push({ kind: 'door', unitId: unit.id, pos: cmd.pos, open });
      break;
    }

    case 'endTurn':
      endTurn(state, events);
      break;
  }

  updateVision(state);
  events.push({ kind: 'visibility' });
  checkWinCondition(state, events);
  return { ok: true, events };
}

function execMove(state: GameState, unitId: number, to: GridPos, events: SimEvent[]): void {
  const unit = getUnit(state, unitId);
  const reach = computeReachable(state, unit);
  const tile = reach.tiles.get(posKey(to))!;
  const path = extractPath(reach, unit.pos, to)!;
  unit.ap -= tile.apCost;
  unit.hunkered = false;

  let prev = unit.pos;
  for (const step of path) {
    const dropped = prev.z - step.z;
    unit.pos = step;
    if (dropped > 1) {
      const dmg = (dropped - 1) * state.ruleset.constants.fallDamagePerLevel;
      events.push({ kind: 'fall', unitId: unit.id, from: prev, to: step, damage: dmg });
      if (applyDamage(unit, dmg)) break;
    } else {
      events.push({ kind: 'step', unitId: unit.id, from: prev, to: step });
    }
    // Vision must be current before overwatch asks who sees the mover.
    updateVision(state);
    if (triggerOverwatch(state, unit, events)) break;
    prev = step;
  }
}

/** Tiles covered by a smoke cloud: same-level disc, clipped by walls. */
function smokeTiles(state: GameState, center: GridPos, radius: number): GridPos[] {
  const out: GridPos[] = [];
  const r = Math.ceil(radius);
  for (let y = Math.max(0, center.y - r); y <= Math.min(state.map.h - 1, center.y + r); y++) {
    for (let x = Math.max(0, center.x - r); x <= Math.min(state.map.w - 1, center.x + r); x++) {
      const t = { x, y, z: center.z };
      if (euclid(center, t) > radius) continue;
      if (state.map.blocksMove(x, y, center.z)) continue;
      out.push(t);
    }
  }
  return out;
}
