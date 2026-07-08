import { GridPos } from '../math/grid';
import { ShotMode } from '../rules/ruleset';

/**
 * Commands are the only way the simulation mutates. They are plain JSON —
 * a full game is reproducible from (map, ruleset, seed, Command[]).
 */
export type Command =
  | { kind: 'move'; unitId: number; to: GridPos }
  | { kind: 'shoot'; unitId: number; targetId: number; mode: ShotMode }
  | { kind: 'shootTile'; unitId: number; target: GridPos } // AoE weapons (grenade launcher)
  | { kind: 'melee'; unitId: number; targetId: number }
  | { kind: 'throw'; unitId: number; itemIndex: number; target: GridPos }
  | { kind: 'medkit'; unitId: number; itemIndex: number; targetId: number }
  | { kind: 'reload'; unitId: number }
  | { kind: 'overwatch'; unitId: number }
  | { kind: 'hunker'; unitId: number }
  | { kind: 'door'; unitId: number; pos: GridPos }
  | { kind: 'endTurn' };
