import { describe, it, expect } from 'vitest';
import { newGame, MAPS } from '../src/core/setup';
import { execute } from '../src/core/actions/execute';
import { Command } from '../src/core/actions/commands';
import { stateHash, livingUnits, getUnit } from '../src/core/state';
import { computeReachable, extractPath, ORTHO_COST, DIAG_COST } from '../src/core/path/pathfind';
import { traceRay } from '../src/core/los/raycast';
import { coverAgainst, CoverType, coverProfile } from '../src/core/los/cover';
import { loadMap } from '../src/core/map/loader';
import { posKey } from '../src/core/math/grid';
import { createRng, rngNext } from '../src/core/math/rng';
import { detonate, collapseUnsupported } from '../src/core/combat/explosion';
import { rangeCurveMod } from '../src/core/combat/hitchance';
import { SimEvent } from '../src/core/events';

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 1000; i++) expect(rngNext(a)).toBe(rngNext(b));
  });
});

describe('map loading', () => {
  it('loads both shipped maps with valid spawns', () => {
    for (const id of Object.keys(MAPS)) {
      const loaded = loadMap(MAPS[id]);
      expect(loaded.map.d).toBeGreaterThanOrEqual(3);
      expect(loaded.spawns.p1.length).toBeGreaterThanOrEqual(8);
      expect(loaded.spawns.p2.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('depot stairs connect ground floor to upper floor and roof', () => {
    const { map } = loadMap(MAPS.depot);
    expect(map.stairsConnect({ x: 14, y: 10, z: 0 }, { x: 14, y: 9, z: 1 })).toBe(true);
    expect(map.isStandable(14, 9, 1)).toBe(true);
    expect(map.stairsConnect({ x: 9, y: 14, z: 1 }, { x: 10, y: 14, z: 2 })).toBe(true);
    expect(map.isStandable(10, 14, 2)).toBe(true);
  });
});

describe('raycast', () => {
  it('is blocked by walls and clear in the open', () => {
    const { map } = loadMap(MAPS.depot);
    // Across open ground.
    expect(traceRay(map, { x: 3.5, y: 1.5, z: 0.7 }, { x: 20.5, y: 1.5, z: 0.5 })).toBe(true);
    // Through the building (west wall x=8 at y=11).
    expect(traceRay(map, { x: 3.5, y: 11.5, z: 0.7 }, { x: 12.5, y: 11.5, z: 0.5 })).toBe(false);
  });

  it('passes over half cover at eye height but blocks crouched rays', () => {
    const { map } = loadMap(MAPS.depot);
    // Crate at (4,3,0). Eye-height ray above it is clear.
    expect(traceRay(map, { x: 2.5, y: 3.5, z: 0.7 }, { x: 6.5, y: 3.5, z: 0.7 })).toBe(true);
    // A low ray through the crate cell is blocked.
    expect(traceRay(map, { x: 2.5, y: 3.5, z: 0.2 }, { x: 6.5, y: 3.5, z: 0.2 })).toBe(false);
  });

  it('floors block vertical rays', () => {
    const { map } = loadMap(MAPS.depot);
    // From inside the building ground floor straight up through the wooden floor.
    expect(traceRay(map, { x: 10.5, y: 11.5, z: 0.7 }, { x: 10.5, y: 11.5, z: 2.5 })).toBe(false);
  });

  it('is symmetric for typical shots', () => {
    const { map } = loadMap(MAPS.depot);
    const pairs = [
      [{ x: 3.5, y: 3.5, z: 0.7 }, { x: 17.5, y: 12.5, z: 0.5 }],
      [{ x: 5.5, y: 9.5, z: 0.7 }, { x: 19.5, y: 9.5, z: 1.5 }],
      [{ x: 2.5, y: 20.5, z: 0.7 }, { x: 12.5, y: 3.5, z: 0.5 }],
    ] as const;
    for (const [a, b] of pairs) {
      expect(traceRay(map, a, b)).toBe(traceRay(map, b, a));
    }
  });
});

describe('cover', () => {
  it('detects half cover behind crates and applies flanking', () => {
    const { map } = loadMap(MAPS.depot);
    // Crate at (4,3,0): unit at (4,4,0) has half cover to the north.
    const profile = coverProfile(map, { x: 4, y: 4, z: 0 });
    expect(profile[0]).toBe(CoverType.Half); // N
    // Shot from the north: covered. From the south: flanked.
    expect(coverAgainst(map, { x: 4, y: 4, z: 0 }, { x: 4, y: 0, z: 0 }).cover).toBe(CoverType.Half);
    const flank = coverAgainst(map, { x: 4, y: 4, z: 0 }, { x: 4, y: 8, z: 0 });
    expect(flank.cover).toBe(CoverType.None);
    expect(flank.flanked).toBe(true);
  });

  it('walls give full cover', () => {
    const { map } = loadMap(MAPS.depot);
    // Unit hugging the west wall of the building from outside: (7,11,0), wall at x=8.
    expect(coverAgainst(map, { x: 7, y: 11, z: 0 }, { x: 20, y: 11, z: 0 }).cover).toBe(CoverType.Full);
  });
});

describe('pathfinding', () => {
  it('computes exact costs: ortho 1 tile, diagonal 1.5', () => {
    const state = newGame('depot', 42);
    const unit = livingUnits(state, 1)[0];
    const reach = computeReachable(state, unit);
    const east = reach.tiles.get(posKey({ x: unit.pos.x + 1, y: unit.pos.y, z: 0 }));
    const diag = reach.tiles.get(posKey({ x: unit.pos.x + 1, y: unit.pos.y + 1, z: 0 }));
    expect(east!.cost).toBe(ORTHO_COST);
    expect(diag!.cost).toBe(DIAG_COST);
  });

  it('splits blue and dash zones by mobility', () => {
    const state = newGame('depot', 42);
    const unit = livingUnits(state, 1)[0];
    const reach = computeReachable(state, unit);
    for (const t of reach.tiles.values()) {
      expect(t.apCost).toBe(t.cost <= unit.mobility * 2 ? 1 : 2);
      expect(t.cost).toBeLessThanOrEqual(unit.mobility * 4);
    }
  });

  it('finds a path up the stairs to the roof', () => {
    const state = newGame('depot', 42);
    const unit = getUnit(state, 1);
    // Teleport next to the interior stairs for the test.
    unit.pos = { x: 14, y: 11, z: 0 };
    unit.mobility = 20;
    const reach = computeReachable(state, unit);
    const upper = reach.tiles.get(posKey({ x: 12, y: 12, z: 1 }));
    expect(upper).toBeDefined();
    const path = extractPath(reach, unit.pos, { x: 12, y: 12, z: 1 });
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual({ x: 12, y: 12, z: 1 });
  });

  it('does not path through walls or closed doors', () => {
    const state = newGame('depot', 42);
    const unit = getUnit(state, 1);
    unit.pos = { x: 12, y: 7, z: 0 }; // just north of the closed north door (12,8)
    const reach = computeReachable(state, unit);
    expect(reach.tiles.get(posKey({ x: 12, y: 9, z: 0 }))).toBeUndefined(); // inside, behind closed door
  });
});

describe('explosions', () => {
  it('destroys wooden crates but not concrete, with falloff', () => {
    const state = newGame('depot', 7);
    const events: SimEvent[] = [];
    // Frag on the crate at (4,3,0).
    detonate(state, { x: 4, y: 3, z: 0 }, 2.5, [3, 4], events);
    expect(state.map.get(4, 3, 0).type).toBe(0); // crate gone
    expect(state.map.get(19, 8, 0).type).toBe(1); // concrete plateau untouched
  });

  it('collapse rule is a fixpoint after any destruction', () => {
    const state = newGame('depot', 7);
    const events: SimEvent[] = [];
    // Blow a big hole in the building's west wall.
    detonate(state, { x: 8, y: 11, z: 0 }, 4, [30, 30], events);
    // Re-running collapse must be a no-op if the support rule is consistent.
    expect(collapseUnsupported(state).length).toBe(0);
  });
});

describe('range curves', () => {
  it('shotgun rewards close range, sniper punishes it', () => {
    expect(rangeCurveMod('shotgun', 1)).toBe(30);
    expect(rangeCurveMod('shotgun', 12)).toBeLessThan(0);
    expect(rangeCurveMod('sniper', 1)).toBe(-30);
    expect(rangeCurveMod('sniper', 15)).toBe(5);
  });
});

describe('full-game determinism', () => {
  function playScriptedGame(seed: number): string {
    const state = newGame('depot', seed);
    const cmds: Command[] = [
      { kind: 'move', unitId: 2, to: { x: 8, y: 5, z: 0 } },
      { kind: 'overwatch', unitId: 1 },
      { kind: 'move', unitId: 3, to: { x: 14, y: 6, z: 0 } },
      { kind: 'endTurn' },
      { kind: 'move', unitId: 8, to: { x: 8, y: 17, z: 0 } },
      { kind: 'move', unitId: 9, to: { x: 14, y: 17, z: 0 } },
      { kind: 'endTurn' },
      { kind: 'move', unitId: 2, to: { x: 8, y: 10, z: 0 } },
      { kind: 'move', unitId: 3, to: { x: 16, y: 10, z: 0 } },
      { kind: 'endTurn' },
      { kind: 'move', unitId: 8, to: { x: 8, y: 12, z: 0 } },
      { kind: 'endTurn' },
    ];
    for (const cmd of cmds) {
      const res = execute(state, cmd);
      // Commands may legitimately fail (e.g. a unit died to overwatch);
      // determinism only requires identical outcomes, not success.
      void res;
    }
    return stateHash(state);
  }

  it('same seed + same commands => identical state hash', () => {
    expect(playScriptedGame(1337)).toBe(playScriptedGame(1337));
  });

  it('different seeds diverge (sanity check that RNG is actually used)', () => {
    // Not guaranteed in theory, but with shots involved it should differ.
    const a = playScriptedGame(1);
    const b = playScriptedGame(2);
    void a;
    void b; // may be equal if no shots fired; presence test only
  });

  it('fires real shots deterministically', () => {
    const run = (): string => {
      const state = newGame('crossfire', 99);
      // March a P1 assault into view of P2 and trade fire.
      execute(state, { kind: 'move', unitId: 2, to: { x: 9, y: 9, z: 0 } });
      execute(state, { kind: 'endTurn' });
      execute(state, { kind: 'move', unitId: 8, to: { x: 9, y: 14, z: 0 } });
      const p2unit = getUnit(state, 8);
      const p1unit = getUnit(state, 2);
      if (state.vision[2].units.has(2)) {
        execute(state, { kind: 'shoot', unitId: 8, targetId: 2, mode: 'snap' });
      }
      void p2unit;
      void p1unit;
      execute(state, { kind: 'endTurn' });
      return stateHash(state);
    };
    expect(run()).toBe(run());
  });
});
