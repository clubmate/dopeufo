import { GridPos, posKey } from './math/grid';
import { RngState, createRng } from './math/rng';
import { VoxelMap, Material } from './map/voxelmap';
import { LoadedMap } from './map/loader';
import { Ruleset } from './rules/ruleset';

export type PlayerId = 1 | 2;

export interface Unit {
  id: number;
  player: PlayerId;
  classId: string;
  name: string;
  pos: GridPos;
  hp: number;
  maxHp: number;
  aim: number;
  mobility: number;
  sight: number;
  weaponId: string;
  ammo: number;
  /** Remaining consumables (item ids; duplicates = multiple charges). */
  items: string[];
  ap: number;
  overwatch: boolean;
  hunkered: boolean;
  /** Free door interaction already used this turn. */
  doorUsed: boolean;
  alive: boolean;
}

export interface Ghost {
  unitId: number;
  pos: GridPos;
  turnSeen: number;
}

export interface PlayerVision {
  /** posKeys of tiles currently visible to this player. */
  tiles: Set<number>;
  /** Enemy unit ids currently spotted. */
  units: Set<number>;
  /** Last-seen memory for enemies not currently visible. */
  ghosts: Map<number, Ghost>;
}

export interface GameState {
  seed: number;
  rng: RngState;
  ruleset: Ruleset;
  mapName: string;
  map: VoxelMap;
  materials: Map<string, Material>;
  units: Unit[];
  currentPlayer: PlayerId;
  turn: number;
  /** posKey -> expiry turn (smoke persists while state.turn < expiry). */
  smoke: Map<number, number>;
  vision: Record<PlayerId, PlayerVision>;
  winner: PlayerId | 0;
}

const FIRST_NAMES = [
  'Vega', 'Okafor', 'Brandt', 'Ishii', 'Moreau', 'Castillo', 'Novak', 'Adeyemi',
  'Lindqvist', 'Petrov', 'Anand', 'Duarte', 'Kowalski', 'Reyes', 'Haugen', 'Mbeki',
];

export function createGame(loaded: LoadedMap, ruleset: Ruleset, seed: number): GameState {
  const rng = createRng(seed);
  const units: Unit[] = [];
  let id = 1;
  for (const player of [1, 2] as const) {
    const spawnList = player === 1 ? loaded.spawns.p1 : loaded.spawns.p2;
    if (spawnList.length < ruleset.squadSize) {
      throw new Error(`Map ${loaded.name} has only ${spawnList.length} spawns for player ${player}`);
    }
    ruleset.squad.forEach((classId, i) => {
      const cls = ruleset.classes.get(classId)!;
      const weapon = ruleset.weapons.get(cls.weapon)!;
      units.push({
        id: id++,
        player,
        classId,
        name: FIRST_NAMES[(id - 1) % FIRST_NAMES.length],
        pos: { ...spawnList[i] },
        hp: cls.hp,
        maxHp: cls.hp,
        aim: cls.aim,
        mobility: cls.mobility,
        sight: cls.sight,
        weaponId: cls.weapon,
        ammo: weapon.clip,
        items: [...cls.items],
        ap: ruleset.constants.apPerTurn,
        overwatch: false,
        hunkered: false,
        doorUsed: false,
        alive: true,
      });
    });
  }

  return {
    seed,
    rng,
    ruleset,
    mapName: loaded.name,
    map: loaded.map,
    materials: loaded.materials,
    units,
    currentPlayer: 1,
    turn: 1,
    smoke: new Map(),
    vision: {
      1: { tiles: new Set(), units: new Set(), ghosts: new Map() },
      2: { tiles: new Set(), units: new Set(), ghosts: new Map() },
    },
    winner: 0,
  };
}

export function getUnit(state: GameState, id: number): Unit {
  const u = state.units.find((u) => u.id === id);
  if (!u) throw new Error(`no unit ${id}`);
  return u;
}

export function unitAt(state: GameState, p: GridPos): Unit | undefined {
  return state.units.find((u) => u.alive && u.pos.x === p.x && u.pos.y === p.y && u.pos.z === p.z);
}

export function livingUnits(state: GameState, player?: PlayerId): Unit[] {
  return state.units.filter((u) => u.alive && (player === undefined || u.player === player));
}

/** Monotonic half-turn counter: increments on every player switch. */
export function halfTurn(state: GameState): number {
  return state.turn * 2 + (state.currentPlayer === 2 ? 1 : 0);
}

export function isSmoked(state: GameState, p: GridPos): boolean {
  const expiry = state.smoke.get(posKey(p));
  return expiry !== undefined && halfTurn(state) < expiry;
}

/**
 * Deterministic serialization of everything gameplay-relevant. Used by tests
 * to assert replay determinism (same seed + same commands => same hash).
 */
export function stateHash(state: GameState): string {
  const parts: unknown[] = [
    state.rng.s,
    state.currentPlayer,
    state.turn,
    state.winner,
    state.units.map((u) => [u.id, u.pos.x, u.pos.y, u.pos.z, u.hp, u.ap, u.ammo, u.items.join(','), u.overwatch, u.hunkered, u.alive]),
    [...state.smoke.entries()].sort((a, b) => a[0] - b[0]),
    state.map.cells.map((v) => (v.type === 0 ? 0 : [v.type, v.hp, v.open === true ? 1 : 0])),
  ];
  return JSON.stringify(parts);
}
