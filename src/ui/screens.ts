/** Fullscreen overlays: main menu, hotseat handoff (opaque — hides the enemy's fog!), victory. */

export interface MenuChoice {
  mapId: string;
  squadSize: number;
}

export function showMenu(root: HTMLElement, maps: { id: string; name: string }[], onStart: (c: MenuChoice) => void): void {
  const screen = document.createElement('div');
  screen.className = 'screen';
  let mapId = maps[0].id;
  let squadSize = 6;

  const title = document.createElement('h1');
  title.textContent = 'UFO — Tactical PvP';
  const sub = document.createElement('p');
  sub.textContent =
    'Two-player hotseat tactics. Move with the blue/yellow zones, flank your enemy, and wipe the opposing squad. Pass the device when your turn ends.';

  const mapRow = document.createElement('div');
  mapRow.className = 'options';
  const mapButtons = new Map<string, HTMLButtonElement>();
  for (const m of maps) {
    const b = document.createElement('button');
    b.textContent = m.name;
    b.className = m.id === mapId ? 'selected' : '';
    b.onclick = () => {
      mapId = m.id;
      mapButtons.forEach((btn, id) => (btn.className = id === mapId ? 'selected' : ''));
    };
    mapButtons.set(m.id, b);
    mapRow.append(b);
  }

  const sizeRow = document.createElement('div');
  sizeRow.className = 'options';
  const sizeButtons = new Map<number, HTMLButtonElement>();
  for (const n of [4, 5, 6, 7, 8]) {
    const b = document.createElement('button');
    b.textContent = `${n} soldiers`;
    b.className = n === squadSize ? 'selected' : '';
    b.onclick = () => {
      squadSize = n;
      sizeButtons.forEach((btn, k) => (btn.className = k === squadSize ? 'selected' : ''));
    };
    sizeButtons.set(n, b);
    sizeRow.append(b);
  }

  const start = document.createElement('button');
  start.className = 'bigbtn';
  start.textContent = 'Start Battle';
  start.onclick = () => {
    screen.remove();
    onStart({ mapId, squadSize });
  };

  screen.append(title, sub, mapRow, sizeRow, start);
  root.append(screen);
}

/** Opaque by design: nothing of the board may leak to the other player. */
export function showHandoff(root: HTMLElement, player: number, turn: number, onReady: () => void): void {
  const screen = document.createElement('div');
  screen.className = 'screen';
  const h = document.createElement('h2');
  h.textContent = `Turn ${turn}`;
  const big = document.createElement('h1');
  big.textContent = `Player ${player}`;
  big.style.color = player === 1 ? 'var(--p1)' : 'var(--p2)';
  const p = document.createElement('p');
  p.textContent = 'Pass the device. Press ready when only you can see the screen.';
  const btn = document.createElement('button');
  btn.className = 'bigbtn';
  btn.textContent = 'Ready — Begin Turn';
  btn.onclick = () => {
    screen.remove();
    onReady();
  };
  screen.append(h, big, p, btn);
  root.append(screen);
}

export function showVictory(root: HTMLElement, winner: number, onRestart: () => void): void {
  const screen = document.createElement('div');
  screen.className = 'screen translucent';
  const h = document.createElement('h1');
  h.textContent = `Player ${winner} wins!`;
  h.style.color = winner === 1 ? 'var(--p1)' : 'var(--p2)';
  const p = document.createElement('p');
  p.textContent = 'The enemy squad has been eliminated.';
  const btn = document.createElement('button');
  btn.className = 'bigbtn';
  btn.textContent = 'Back to Menu';
  btn.onclick = () => {
    screen.remove();
    onRestart();
  };
  screen.append(h, p, btn);
  root.append(screen);
}
