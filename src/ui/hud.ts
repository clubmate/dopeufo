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

/**
 * DOM-based HUD overlay, laid out on the XCOM 2 grid: objectives top-left,
 * turn/end-turn top-right, soldier identity bottom-left, ability bar
 * bottom-center, weapon panel bottom-right, squad roster on the right edge.
 */
export class Hud {
  private objectives: HTMLElement;
  private topright: HTMLElement;
  private soldier: HTMLElement;
  private abilitybar: HTMLElement;
  private weaponpanel: HTMLElement;
  private roster: HTMLElement;
  private tooltip: HTMLElement;
  private logline: HTMLElement;

  constructor(
    hudRoot: HTMLElement,
    private labelsRoot: HTMLElement,
    private handlers: HudHandlers,
  ) {
    this.objectives = el('div', 'objectives');
    this.topright = el('div', 'topright');
    this.soldier = el('div', 'soldierpanel');
    this.abilitybar = el('div', 'abilitybar');
    this.weaponpanel = el('div', 'weaponpanel');
    this.roster = el('div', 'roster');
    this.tooltip = el('div', 'tooltip');
    this.tooltip.style.display = 'none';
    this.logline = el('div', 'logline');
    this.logline.style.display = 'none';
    hudRoot.append(
      this.objectives,
      this.topright,
      this.soldier,
      this.abilitybar,
      this.weaponpanel,
      this.roster,
      this.tooltip,
      this.logline,
    );
  }

  refresh(state: GameState, viewer: PlayerId, selected: Unit | null, actions: ActionButton[]): void {
    const playerColor = state.currentPlayer === 1 ? 'var(--p1)' : 'var(--p2)';

    // --- objectives (top-left) ---
    this.objectives.innerHTML =
      `<div class="head">◈ Objectives</div>` +
      `<div class="goal"><span class="tick"></span>Neutralize all enemy targets</div>`;

    // --- turn block (top-right) ---
    this.topright.innerHTML = '';
    const turnbox = el('div', 'turnbox');
    turnbox.innerHTML =
      `<div class="turnnum">Turn ${state.turn}</div>` +
      `<div class="player" style="color:${playerColor}">Player ${state.currentPlayer}</div>`;
    const endBtn = document.createElement('button');
    endBtn.className = 'endturn';
    endBtn.innerHTML = `End Turn <span class="key">⏎</span>`;
    endBtn.onclick = () => this.handlers.onEndTurn();
    const hint = el('div', 'hint');
    hint.textContent = 'Q/E rotate · WASD pan · scroll zoom · Tab next unit · Esc cancel';
    this.topright.append(turnbox, endBtn, hint);

    // --- soldier identity (bottom-left) + weapon (bottom-right) ---
    if (selected) {
      const cls = state.ruleset.classes.get(selected.classId)!;
      const weapon = state.ruleset.weapons.get(selected.weaponId)!;
      this.soldier.innerHTML =
        `<div class="cls" style="color:${cls.color}">▸ ${cls.name}</div>` +
        `<div class="name">${selected.name}</div>` +
        `<div class="row">HP ${hpPips(selected.hp, selected.maxHp, true)}</div>` +
        `<div class="row">AP <span class="appips">${'◆'.repeat(selected.ap)}${'◇'.repeat(Math.max(0, 2 - selected.ap))}</span>` +
        `<span class="sub">Aim ${selected.aim}</span></div>`;
      this.weaponpanel.innerHTML =
        `<div class="wname">${weapon.name}</div>` +
        `<div class="ammo">${ammoPips(selected.ammo, weapon.clip)}</div>`;
      this.soldier.style.display = '';
      this.weaponpanel.style.display = '';
    } else {
      this.soldier.style.display = 'none';
      this.weaponpanel.style.display = 'none';
    }

    // --- ability bar (bottom-center) ---
    this.abilitybar.innerHTML = '';
    if (selected && actions.length > 0) {
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'ability' + (a.active ? ' active' : '');
        b.disabled = !a.enabled;
        b.title = (a.title ? a.title + ' — ' : '') + a.apCost;
        b.innerHTML =
          `<span class="ap">${a.apCost.replace(' AP', '')}</span>` +
          `<span class="lbl">${a.label}</span>` +
          `<span class="key">${a.hotkey}</span>`;
        b.onclick = () => this.handlers.onAction(a.id);
        this.abilitybar.append(b);
      }
      this.abilitybar.style.display = '';
    } else {
      this.abilitybar.style.display = 'none';
    }

    // --- roster (right edge) ---
    this.roster.innerHTML = '';
    for (const u of livingUnits(state, viewer)) {
      const cls = state.ruleset.classes.get(u.classId)!;
      const b = document.createElement('button');
      b.className = (selected?.id === u.id ? 'selected ' : '') + (u.ap === 0 ? 'spent' : '');
      const status = u.overwatch ? ' ⏿' : u.hunkered ? ' ⛨' : '';
      b.innerHTML =
        `<b>${u.name}</b> <span style="color:${cls.color}">${cls.name}</span>${status}` +
        ` <span style="float:right">${'◆'.repeat(u.ap)}${'◇'.repeat(Math.max(0, 2 - u.ap))}</span>` +
        `<div class="hprow">${hpPips(u.hp, u.maxHp, true)}</div>`;
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
      const status = u.overwatch ? '<div class="status">OVERWATCH</div>' : u.hunkered ? '<div class="status">HUNKER</div>' : '';
      label.innerHTML =
        `<div style="color:${u.player === 1 ? 'var(--p1)' : 'var(--p2)'}">${u.name}</div>` +
        `${hpPips(u.hp, u.maxHp, mine)}${status}`;
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

/** XCOM-style segmented HP bar: one pip per hit point, green for friendlies, red for enemies. */
function hpPips(hp: number, maxHp: number, friendly: boolean): string {
  const tone = friendly ? '' : ' foe';
  return `<span class="pips">${Array.from(
    { length: maxHp },
    (_, i) => `<span class="pip${tone}${i < hp ? '' : ' empty'}"></span>`,
  ).join('')}</span>`;
}

/** Ammo pips: one segment per round in the clip. */
function ammoPips(ammo: number, clip: number): string {
  return Array.from({ length: clip }, (_, i) => `<span class="apip${i < ammo ? '' : ' empty'}"></span>`).join('');
}
