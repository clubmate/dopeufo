import { GameState, PlayerId, livingUnits, halfTurn } from '../state';
import { SimEvent } from '../events';

/** Squad wiped => other player wins. Returns true if the game just ended. */
export function checkWinCondition(state: GameState, events: SimEvent[]): boolean {
  if (state.winner !== 0) return false;
  const p1Alive = livingUnits(state, 1).length > 0;
  const p2Alive = livingUnits(state, 2).length > 0;
  if (p1Alive && p2Alive) return false;
  state.winner = p1Alive ? 1 : 2;
  events.push({ kind: 'gameOver', winner: state.winner });
  return true;
}

/** Ends the current player's turn and prepares the next player's units. */
export function endTurn(state: GameState, events: SimEvent[]): void {
  const prev = state.currentPlayer;
  const next: PlayerId = prev === 1 ? 2 : 1;
  state.currentPlayer = next;
  if (next === 1) state.turn += 1;

  for (const u of livingUnits(state, next)) {
    u.ap = state.ruleset.constants.apPerTurn;
    u.hunkered = false;
    u.overwatch = false; // overwatch lasts until your own next turn starts
    u.doorUsed = false;
  }

  // Smoke expiry is stored as an absolute half-turn stamp; prune what lapsed.
  for (const [key, expiry] of state.smoke) {
    if (halfTurn(state) >= expiry) state.smoke.delete(key);
  }

  events.push({ kind: 'turnEnded', player: prev, nextPlayer: next, turn: state.turn });
}
