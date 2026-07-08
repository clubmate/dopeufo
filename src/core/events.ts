import { GridPos } from './math/grid';
import { PlayerId } from './state';
import { ShotMode } from './rules/ruleset';

/**
 * Events emitted by the simulation while executing a command. The render/UI
 * layer replays them sequentially (movement steps, shots, explosions) to
 * animate exactly what the deterministic core decided.
 */
export type SimEvent =
  | { kind: 'step'; unitId: number; from: GridPos; to: GridPos }
  | { kind: 'fall'; unitId: number; from: GridPos; to: GridPos; damage: number }
  | {
      kind: 'shot';
      shooterId: number;
      targetId: number;
      mode: ShotMode | 'melee';
      reaction: boolean;
      hitChance: number;
      hit: boolean;
      crit: boolean;
      damage: number;
      killed: boolean;
    }
  | {
      kind: 'explosion';
      center: GridPos;
      radius: number;
      destroyed: GridPos[];
      casualties: { unitId: number; damage: number; killed: boolean }[];
      /** Thrown projectile origin (grenade arc / launcher tracer), if any. */
      from?: GridPos;
    }
  | { kind: 'smoke'; center: GridPos; radius: number; tiles: GridPos[]; from?: GridPos }
  | { kind: 'heal'; medicId: number; targetId: number; amount: number }
  | { kind: 'reload'; unitId: number }
  | { kind: 'overwatchSet'; unitId: number }
  | { kind: 'hunker'; unitId: number }
  | { kind: 'door'; unitId: number; pos: GridPos; open: boolean }
  | { kind: 'turnEnded'; player: PlayerId; nextPlayer: PlayerId; turn: number }
  | { kind: 'gameOver'; winner: PlayerId }
  | { kind: 'visibility' };
