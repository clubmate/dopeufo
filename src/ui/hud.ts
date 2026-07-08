import { GameState, PlayerId, Unit, livingUnits } from '../core/state';

export interface ActionButton {
  id: string;
  label: string;
  apCost: string;
  hotkey: string;
  enabled: boolean;
  active: boolean;
  title?: string;
}

export interface HudHandlers {
  onAction(id: string): void;
  onSelectUnit(unitId: number): void;
  onEndTurn(): void;
}

/** DOM-based HUD overlay: top bar, unit action panel, squad roster, tooltip, combat floaters. */
export class Hud {
  private topbar: HTMLElement;
  private unitpanel: HTMLElement;
  private roster: HTMLElement;
  private tooltip: HTMLElement;
  private logline: HTMLElement;

  constructor(
    hudRoot: HTMLElement,
    private labelsRoot: HTMLElement,
    private handlers: HudHandlers,
  ) {
    this.topbar = el('div', 'topbar');
    this.unitpanel = el('div', 'unitpanel');
    this.roster = el('div', 'roster');
    this.tooltip = el('div', 'tooltip');
    this.tooltip.style.display = 'none';
    this.logline = el('div', 'logline');
    this.logline.style.display = 'none';
    hudRoot.append(this.topbar, this.unitpanel, this.roster, this.tooltip, this.logline);
  }

  refresh(state: GameState, viewer: PlayerId, selected: Unit | null, actions: ActionButton[]): void {
    // --- top bar ---
    this.topbar.innerHTML = '';
    const chip = el('span', 'player-chip');
    chip.textContent = `Player ${state.currentPlayer}`;
    chip.style.background = state.currentPlayer === 1 ? 'var(--p1)' : 'var(--p2)';
    const turn = el('span');
    turn.textContent = `Turn ${state.turn}`;
    const endBtn = document.createElement('button');
    endBtn.className = 'abtn';
    endBtn.innerHTML = `End Turn <span class="key">⏎</span>`;
    endBtn.onclick = () => this.handlers.onEndTurn();
    const hint = el('span', 'hint');
    hint.textContent = 'Q/E rotate · WASD pan · scroll zoom · Tab next unit · Esc cancel';
    this.topbar.append(chip, turn, endBtn, hint);

    // --- unit panel ---
    this.unitpanel.innerHTML = '';
    if (selected) {
      const cls = state.ruleset.classes.get(selected.classId)!;
      const weapon = state.ruleset.weapons.get(selected.weaponId)!;
      const who = el('div', 'who');
      who.innerHTML =
        `<span class="name">${selected.name}</span>` +
        `<span class="stat">${cls.name}</span>` +
        `<span class="stat">HP <b>${selected.hp}/${selected.maxHp}</b></span>` +
        `<span class="stat">AP <b>${selected.ap}</b></span>` +
        `<span class="stat">${weapon.name} <b>${selected.ammo}/${weapon.clip}</b></span>` +
        `<span class="stat">Aim <b>${selected.aim}</b></span>`;
      const bar = el('div', 'actions');
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'abtn' + (a.active ? ' active' : '');
        b.disabled = !a.enabled;
        if (a.title) b.title = a.title;
        b.innerHTML = `${a.label} <span class="ap">${a.apCost}</span><span class="key">${a.hotkey}</span>`;
        b.onclick = () => this.handlers.onAction(a.id);
        bar.append(b);
      }
      this.unitpanel.append(who, bar);
      this.unitpanel.style.display = '';
    } else {
      this.unitpanel.style.display = 'none';
    }

    // --- roster ---
    this.roster.innerHTML = '';
    for (const u of livingUnits(state, viewer)) {
      const cls = state.ruleset.classes.get(u.classId)!;
      const b = document.createElement('button');
      b.className = (selected?.id === u.id ? 'selected ' : '') + (u.ap === 0 ? 'spent' : '');
      const status = u.overwatch ? ' ⏿' : u.hunkered ? ' ⛨' : '';
      b.innerHTML =
        `<b>${u.name}</b> <span style="color:${cls.color}">${cls.name}</span>${status}` +
        ` <span style="float:right">${'●'.repeat(u.ap)}${'○'.repeat(Math.max(0, 2 - u.ap))}</span>` +
        `<div class="hpbar"><div style="width:${(u.hp / u.maxHp) * 100}%"></div></div>`;
      b.onclick = () => this.handlers.onSelectUnit(u.id);
      this.roster.append(b);
    }
  }

  setTooltip(x: number, y: number, html: string | null): void {
    if (!html) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.style.display = '';
    const pad = 16;
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    this.tooltip.style.left = `${Math.min(window.innerWidth - w - 8, x + pad)}px`;
    this.tooltip.style.top = `${Math.max(8, y - h - pad)}px`;
  }

  floater(screenX: number, screenY: number, text: string, color: string): void {
    const f = el('div', 'floater');
    f.textContent = text;
    f.style.color = color;
    f.style.left = `${screenX}px`;
    f.style.top = `${screenY}px`;
    this.labelsRoot.append(f);
    setTimeout(() => f.remove(), 1150);
  }

  log(msg: string): void {
    this.logline.textContent = msg;
    this.logline.style.display = '';
    clearTimeout(this.logTimer);
    this.logTimer = window.setTimeout(() => (this.logline.style.display = 'none'), 3500);
  }
  private logTimer = 0;

  /**
   * Per-frame unit labels (name + HP pips + status) above heads; ghosts get a
   * "last seen" marker. `project` maps world coords to screen or null when
   * behind the camera.
   */
  updateLabels(
    state: GameState,
    viewer: PlayerId,
    project: (x: number, y: number, z: number) => { x: number; y: number } | null,
  ): void {
    this.labelsRoot.querySelectorAll('.unitlabel').forEach((n) => n.remove());
    const vision = state.vision[viewer];
    for (const u of state.units) {
      if (!u.alive) continue;
      const mine = u.player === viewer;
      if (!mine && !vision.units.has(u.id)) continue;
      const s = project(u.pos.x + 0.5, u.pos.z + 1.25, u.pos.y + 0.5);
      if (!s) continue;
      const label = el('div', 'unitlabel');
      const pips = Array.from({ length: u.maxHp }, (_, i) => `<span class="pip${i < u.hp ? '' : ' empty'}"></span>`).join('');
      const status = u.overwatch ? '<div class="status">OVERWATCH</div>' : u.hunkered ? '<div class="status">HUNKER</div>' : '';
      label.innerHTML = `<div style="color:${u.player === 1 ? 'var(--p1)' : 'var(--p2)'}">${u.name}</div><div class="pips">${pips}</div>${status}`;
      label.style.left = `${s.x}px`;
      label.style.top = `${s.y}px`;
      this.labelsRoot.append(label);
    }
    for (const [unitId, ghost] of vision.ghosts) {
      if (vision.units.has(unitId)) continue;
      const s = project(ghost.pos.x + 0.5, ghost.pos.z + 1.25, ghost.pos.y + 0.5);
      if (!s) continue;
      const label = el('div', 'unitlabel');
      label.innerHTML = `<div style="color:#9aa7b8">? last seen</div>`;
      label.style.left = `${s.x}px`;
      label.style.top = `${s.y}px`;
      this.labelsRoot.append(label);
    }
  }
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
