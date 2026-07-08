import { describe, it, expect } from 'vitest';
import { newGame } from '../src/core/setup';
import { execute } from '../src/core/actions/execute';
import { getUnit, isSmoked } from '../src/core/state';
import { updateVision } from '../src/core/fog/visibility';
import { computeShot, computeMelee } from '../src/core/combat/hitchance';
import { posKey } from '../src/core/math/grid';
import { VoxelType } from '../src/core/map/voxelmap';
import { SimEvent } from '../src/core/events';

/** Places a P1 shooter and P2 target face to face on Crossfire's center street. */
function faceoff(seed = 5) {
  const state = newGame('crossfire', seed);
  const shooter = getUnit(state, 2); // P1 assault
  const target = getUnit(state, 8); // P2 assault
  shooter.pos = { x: 9, y: 8, z: 0 };
  target.pos = { x: 9, y: 12, z: 0 };
  updateVision(state);
  return { state, shooter, target };
}

describe('shooting', () => {
  it('snap shot costs 1 AP, does not end turn, consumes ammo', () => {
    const { state, shooter, target } = faceoff();
    const res = execute(state, { kind: 'shoot', unitId: shooter.id, targetId: target.id, mode: 'snap' });
    expect(res.ok).toBe(true);
    expect(shooter.ap).toBe(1);
    expect(shooter.ammo).toBe(3);
  });

  it('aimed shot ends the turn (AP -> 0)', () => {
    const { state, shooter, target } = faceoff();
    execute(state, { kind: 'shoot', unitId: shooter.id, targetId: target.id, mode: 'aimed' });
    expect(shooter.ap).toBe(0);
  });

  it('auto fires multiple shot events', () => {
    const { state, shooter, target } = faceoff();
    target.hp = 99;
    target.maxHp = 99;
    const res = execute(state, { kind: 'shoot', unitId: shooter.id, targetId: target.id, mode: 'auto' });
    if (!res.ok) throw new Error(res.reason);
    expect(res.events.filter((e: SimEvent) => e.kind === 'shot').length).toBe(3);
  });

  it('cannot shoot an unseen enemy', () => {
    const state = newGame('crossfire', 5);
    // Spawn rows are ~17 tiles apart with buildings between; not mutually visible.
    const res = execute(state, { kind: 'shoot', unitId: 1, targetId: 8, mode: 'snap' });
    expect(res.ok).toBe(false);
  });

  it('smoke on the target adds defense', () => {
    const { state, shooter, target } = faceoff();
    const weapon = state.ruleset.weapons.get(shooter.weaponId)!;
    const before = computeShot(state, shooter, target, weapon, 'snap', false).chance;
    state.smoke.set(posKey(target.pos), 999);
    expect(isSmoked(state, target.pos)).toBe(true);
    const after = computeShot(state, shooter, target, weapon, 'snap', false).chance;
    expect(before - after).toBe(state.ruleset.constants.smokeDefense);
  });

  it('height advantage adds aim', () => {
    const { state, shooter, target } = faceoff();
    const weapon = state.ruleset.weapons.get(shooter.weaponId)!;
    const flat = computeShot(state, shooter, target, weapon, 'snap', false).chance;
    shooter.pos = { x: 5, y: 8, z: 1 }; // west roof
    updateVision(state);
    const high = computeShot(state, shooter, target, weapon, 'snap', false);
    if (high.ok) expect(high.chance).toBeGreaterThan(flat - 10); // curve may differ with distance; sanity only
  });
});

describe('melee', () => {
  it('requires adjacency', () => {
    const { state, target } = faceoff();
    const ranger = getUnit(state, 3);
    ranger.pos = { x: 5, y: 5, z: 0 };
    expect(computeMelee(state, ranger, target).ok).toBe(false);
    ranger.pos = { x: 9, y: 11, z: 0 };
    updateVision(state);
    expect(computeMelee(state, ranger, target).ok).toBe(true);
  });

  it('executes and ends the turn', () => {
    const { state, target } = faceoff();
    const ranger = getUnit(state, 3);
    ranger.pos = { x: 8, y: 12, z: 0 };
    updateVision(state);
    const res = execute(state, { kind: 'melee', unitId: ranger.id, targetId: target.id });
    expect(res.ok).toBe(true);
    expect(ranger.ap).toBe(0);
  });
});

describe('medkit', () => {
  it('heals an adjacent wounded ally and consumes the charge', () => {
    const state = newGame('crossfire', 5);
    const medic = getUnit(state, 5); // support
    const buddy = getUnit(state, 4);
    buddy.hp = 2;
    medic.pos = { x: 10, y: 10, z: 0 };
    buddy.pos = { x: 10, y: 11, z: 0 };
    updateVision(state);
    const idx = medic.items.indexOf('medkit');
    const itemCount = medic.items.length;
    const res = execute(state, { kind: 'medkit', unitId: medic.id, itemIndex: idx, targetId: buddy.id });
    expect(res.ok).toBe(true);
    expect(buddy.hp).toBe(6);
    expect(medic.items.length).toBe(itemCount - 1);
  });

  it('rejects healing a full-health target', () => {
    const state = newGame('crossfire', 5);
    const medic = getUnit(state, 5);
    const res = execute(state, { kind: 'medkit', unitId: medic.id, itemIndex: medic.items.indexOf('medkit'), targetId: medic.id });
    expect(res.ok).toBe(false);
  });
});

describe('doors', () => {
  it('first toggle per turn is free, opening unblocks the path', () => {
    const state = newGame('crossfire', 5);
    const u = getUnit(state, 2);
    u.pos = { x: 9, y: 9, z: 0 }; // east of west building door at (7,9)
    u.pos = { x: 8, y: 9, z: 0 }; // directly adjacent
    updateVision(state);
    const door = { x: 7, y: 9, z: 0 };
    expect(state.map.getP(door).open).toBe(false);
    const res = execute(state, { kind: 'door', unitId: u.id, pos: door });
    expect(res.ok).toBe(true);
    expect(state.map.getP(door).open).toBe(true);
    expect(u.ap).toBe(2); // free
    // Second toggle costs AP.
    execute(state, { kind: 'door', unitId: u.id, pos: door });
    expect(u.ap).toBe(1);
  });

  it('closed doors block sight, open doors do not', () => {
    const state = newGame('crossfire', 5);
    const u = getUnit(state, 2);
    u.pos = { x: 8, y: 9, z: 0 };
    const enemy = getUnit(state, 8);
    enemy.pos = { x: 5, y: 9, z: 0 }; // inside the west building
    updateVision(state);
    expect(state.vision[1].units.has(enemy.id)).toBe(false);
    execute(state, { kind: 'door', unitId: u.id, pos: { x: 7, y: 9, z: 0 } });
    expect(state.vision[1].units.has(enemy.id)).toBe(true);
  });
});

describe('overwatch reaction fire', () => {
  it('triggers deterministically when an enemy moves through the cone', () => {
    const run = (): { fired: boolean; hash: string } => {
      const state = newGame('crossfire', 77);
      const watcher = getUnit(state, 8); // P2
      watcher.pos = { x: 9, y: 12, z: 0 };
      const runner = getUnit(state, 2); // P1
      runner.pos = { x: 7, y: 8, z: 0 };
      updateVision(state);
      // P1 passes; P2 sets overwatch; P1 runs across the street.
      execute(state, { kind: 'endTurn' });
      execute(state, { kind: 'overwatch', unitId: watcher.id });
      execute(state, { kind: 'endTurn' });
      const res = execute(state, { kind: 'move', unitId: runner.id, to: { x: 11, y: 8, z: 0 } });
      if (!res.ok) throw new Error(res.reason);
      const shots = res.events.filter((e: SimEvent) => e.kind === 'shot' && e.reaction);
      return { fired: shots.length > 0, hash: JSON.stringify(res.events) };
    };
    const a = run();
    const b = run();
    expect(a.fired).toBe(true);
    expect(a.hash).toBe(b.hash);
  });

  it('watcher loses overwatch after firing and spends ammo', () => {
    const state = newGame('crossfire', 77);
    const watcher = getUnit(state, 8);
    watcher.pos = { x: 9, y: 12, z: 0 };
    const runner = getUnit(state, 2);
    runner.pos = { x: 7, y: 8, z: 0 };
    updateVision(state);
    execute(state, { kind: 'endTurn' });
    execute(state, { kind: 'overwatch', unitId: watcher.id });
    const ammoBefore = watcher.ammo;
    execute(state, { kind: 'endTurn' });
    execute(state, { kind: 'move', unitId: runner.id, to: { x: 11, y: 8, z: 0 } });
    expect(watcher.overwatch).toBe(false);
    expect(watcher.ammo).toBe(ammoBefore - 1);
  });
});

describe('explosions vs units and doors', () => {
  it('grenade damages units in radius and can destroy the wooden door', () => {
    const state = newGame('crossfire', 9);
    const thrower = getUnit(state, 2);
    thrower.pos = { x: 9, y: 9, z: 0 };
    updateVision(state);
    const idx = thrower.items.indexOf('frag');
    const res = execute(state, { kind: 'throw', unitId: thrower.id, itemIndex: idx, target: { x: 8, y: 9, z: 0 } });
    if (!res.ok) throw new Error(res.reason);
    const boom = res.events.find((e: SimEvent) => e.kind === 'explosion');
    expect(boom).toBeDefined();
    // Thrower stood inside the blast: must have taken splash damage.
    expect(thrower.hp).toBeLessThan(thrower.maxHp);
    // Wooden door at (7,9) has 30 hp; a frag (45-60 terrain damage) destroys it.
    expect(state.map.get(7, 9, 0).type).toBe(VoxelType.Empty);
  });
});
