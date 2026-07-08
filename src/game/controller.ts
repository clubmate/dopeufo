import { GameState, PlayerId, Unit, getUnit, livingUnits } from '../core/state';
import { Command } from '../core/actions/commands';
import { execute } from '../core/actions/execute';
import { computeReachable, extractPath, ReachResult } from '../core/path/pathfind';
import { computeShot, computeMelee, ShotPreview } from '../core/combat/hitchance';
import { CoverType } from '../core/los/cover';
import { ShotMode } from '../core/rules/ruleset';
import { GridPos, posKey, euclid } from '../core/math/grid';
import { VoxelType } from '../core/map/voxelmap';
import { hasThrowPath } from '../core/actions/validate';
import { UnitRenderer } from '../render/units';
import { TerrainRenderer } from '../render/terrain';
import { OverlayRenderer } from '../render/overlays';
import { Animator } from '../render/animation';
import { Hud, ActionButton, TargetChip, ShotPanel } from '../ui/hud';
import { showHandoff, showVictory } from '../ui/screens';
import { CameraRig } from '../camera/rig';
import { PickResult } from '../input/picker';
import { tileToWorld } from '../render/scene';

type Mode =
  | { t: 'move' }
  | { t: 'shoot'; shot: ShotMode; targetId: number | null }
  | { t: 'melee' }
  | { t: 'aoe'; itemIndex?: number }
  | { t: 'medkit'; itemIndex: number };

/**
 * Hotseat game controller: owns UI mode, translates picks into Commands,
 * feeds sim events to the animator, and manages fog handoff between players.
 */
export class Controller {
  viewer: PlayerId = 1;
  private selectedId: number | null = null;
  private mode: Mode = { t: 'move' };
  private reach: ReachResult | null = null;
  private inputLocked = false;
  private gameEnded = false;

  constructor(
    private state: GameState,
    private units: UnitRenderer,
    private terrain: TerrainRenderer,
    private overlays: OverlayRenderer,
    private animator: Animator,
    private hud: Hud,
    private rig: CameraRig,
    private overlayRoot: HTMLElement,
    private onRestart: () => void,
  ) {
    this.selectFirstUnit();
    this.syncVisuals();
    this.refreshHud();
  }

  // ---------------- selection / mode ----------------

  private get selected(): Unit | null {
    if (this.selectedId === null) return null;
    const u = getUnit(this.state, this.selectedId);
    return u.alive ? u : null;
  }

  private selectFirstUnit(): void {
    const mine = livingUnits(this.state, this.state.currentPlayer);
    const withAp = mine.find((u) => u.ap > 0) ?? mine[0];
    if (withAp) this.select(withAp.id);
  }

  select(unitId: number): void {
    const u = getUnit(this.state, unitId);
    if (u.player !== this.state.currentPlayer || !u.alive) return;
    this.selectedId = unitId;
    this.mode = { t: 'move' };
    this.rig.exitTargetView();
    this.reach = u.ap > 0 ? computeReachable(this.state, u) : null;
    this.rig.centerOn(tileToWorld(u.pos.x, u.pos.y, u.pos.z));
    this.autoCutaway();
    this.overlays.showReachable(this.reach);
    this.overlays.showPath(null);
    this.overlays.showAoe(null, 0);
    this.overlays.showCover(u.pos);
    this.syncVisuals();
    this.refreshHud();
  }

  cycleUnit(dir: 1 | -1): void {
    const mine = livingUnits(this.state, this.state.currentPlayer);
    if (mine.length === 0) return;
    const idx = mine.findIndex((u) => u.id === this.selectedId);
    for (let i = 1; i <= mine.length; i++) {
      const next = mine[(idx + dir * i + mine.length * mine.length) % mine.length];
      if (next.ap > 0 || i === mine.length) {
        this.select(next.id);
        return;
      }
    }
  }

  cancelMode(): void {
    this.mode = { t: 'move' };
    this.rig.exitTargetView();
    this.overlays.showAoe(null, 0);
    this.overlays.showPath(null);
    this.refreshHud();
  }

  /** Enter the over-the-shoulder targeting view on a visible enemy (target chip click). */
  selectTarget(enemyId: number): void {
    if (this.inputLocked || this.gameEnded) return;
    const u = this.selected;
    if (!u) return;
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
    if (weapon.explosive) return;
    const target = getUnit(this.state, enemyId);
    if (!target.alive || target.player === this.viewer || !this.state.vision[this.viewer].units.has(enemyId)) return;
    const shot = this.mode.t === 'shoot' ? this.mode.shot : this.defaultShotMode(u);
    this.mode = { t: 'shoot', shot, targetId: enemyId };
    this.overlays.showPath(null);
    this.overlays.showAoe(null, 0);
    this.rig.enterTargetView(tileToWorld(u.pos.x, u.pos.y, u.pos.z), tileToWorld(target.pos.x, target.pos.y, target.pos.z));
    // Presentation only: shooter and target square off.
    this.units.mesh(u.id).rotation.y = Math.atan2(target.pos.x - u.pos.x, target.pos.y - u.pos.y);
    this.units.mesh(target.id).rotation.y = Math.atan2(u.pos.x - target.pos.x, u.pos.y - target.pos.y);
    this.refreshHud();
  }

  /** Fire at the locked target (FIRE button / Space). */
  fire(): void {
    if (this.inputLocked || this.gameEnded) return;
    const u = this.selected;
    if (!u || this.mode.t !== 'shoot' || this.mode.targetId === null) return;
    this.issue({ kind: 'shoot', unitId: u.id, targetId: this.mode.targetId, mode: this.mode.shot });
  }

  // ---------------- actions from HUD ----------------

  onAction(id: string): void {
    if (this.inputLocked || this.gameEnded) return;
    const u = this.selected;
    if (!u) return;
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;

    if (id === 'snap' || id === 'aimed' || id === 'auto') {
      if (weapon.explosive) {
        this.mode = { t: 'aoe' };
      } else {
        // Switching shot mode keeps a locked target (and the targeting view).
        this.mode = { t: 'shoot', shot: id, targetId: this.mode.t === 'shoot' ? this.mode.targetId : null };
      }
    } else if (id === 'melee') {
      this.mode = { t: 'melee' };
      this.rig.exitTargetView();
    } else if (id === 'reload') {
      this.issue({ kind: 'reload', unitId: u.id });
      return;
    } else if (id === 'overwatch') {
      this.issue({ kind: 'overwatch', unitId: u.id });
      return;
    } else if (id === 'hunker') {
      this.issue({ kind: 'hunker', unitId: u.id });
      return;
    } else if (id.startsWith('item')) {
      this.rig.exitTargetView();
      const itemIndex = parseInt(id.slice(4), 10);
      const item = this.state.ruleset.items.get(u.items[itemIndex]);
      if (!item) return;
      if (item.type === 'medkit') {
        this.mode = { t: 'medkit', itemIndex };
      } else {
        this.mode = { t: 'aoe', itemIndex };
      }
    }
    this.refreshHud();
  }

  endTurn(): void {
    if (this.inputLocked || this.gameEnded) return;
    this.issue({ kind: 'endTurn' });
  }

  // ---------------- picking ----------------

  onHover(pick: PickResult, clientX: number, clientY: number): void {
    if (this.inputLocked || this.gameEnded) {
      this.hud.setTooltip(0, 0, null);
      return;
    }
    const u = this.selected;
    this.overlays.setHover(pick.tile);

    if (!u) return;

    if (this.mode.t === 'move') {
      if (pick.unitId !== null) {
        const target = getUnit(this.state, pick.unitId);
        if (target.player !== this.viewer && this.state.vision[this.viewer].units.has(target.id)) {
          this.hud.setTooltip(clientX, clientY, this.shotTooltip(u, target, this.defaultShotMode(u)));
        } else {
          this.hud.setTooltip(clientX, clientY, null);
        }
        this.overlays.showPath(null);
        return;
      }
      if (pick.tile && this.reach) {
        const tile = this.reach.tiles.get(posKey(pick.tile));
        if (tile && !tile.passOnly && tile.apCost <= u.ap) {
          const path = extractPath(this.reach, u.pos, pick.tile);
          this.overlays.showPath(path);
          this.overlays.showCover(pick.tile);
          const tiles = (tile.cost / 2).toFixed(1).replace('.0', '');
          this.hud.setTooltip(
            clientX,
            clientY,
            `<span class="big">${tile.apCost === 1 ? 'Move' : 'Dash'}</span> — ${tile.apCost} AP\n${tiles} tiles`,
          );
        } else {
          this.overlays.showPath(null);
          this.overlays.showCover(u.pos);
          this.hud.setTooltip(clientX, clientY, null);
        }
      }
      return;
    }

    if (this.mode.t === 'shoot' && pick.unitId !== null) {
      const target = getUnit(this.state, pick.unitId);
      if (target.player !== this.viewer) {
        this.hud.setTooltip(clientX, clientY, this.shotTooltip(u, target, this.mode.shot));
        return;
      }
    }

    if (this.mode.t === 'melee' && pick.unitId !== null) {
      const target = getUnit(this.state, pick.unitId);
      if (target.player !== this.viewer) {
        const prev = computeMelee(this.state, u, target);
        this.hud.setTooltip(clientX, clientY, prev.ok ? `<span class="big">${prev.chance}%</span> melee` : prev.reason!);
        return;
      }
    }

    if (this.mode.t === 'aoe') {
      const target = pick.tile ?? (pick.unitId !== null ? getUnit(this.state, pick.unitId).pos : null);
      if (target) {
        const radius = this.aoeRadius(u);
        this.overlays.showAoe(target, radius);
        const range = this.aoeRange(u);
        const dist = euclid(u.pos, target);
        const okRange = dist <= range && hasThrowPath(this.state, u, target);
        this.hud.setTooltip(clientX, clientY, okRange ? `<span class="big">Detonate</span> r=${radius}` : 'Out of range / blocked');
      }
      return;
    }

    if (this.mode.t === 'medkit' && pick.unitId !== null) {
      const target = getUnit(this.state, pick.unitId);
      if (target.player === this.viewer) {
        this.hud.setTooltip(clientX, clientY, `Heal ${target.name}`);
        return;
      }
    }

    this.hud.setTooltip(clientX, clientY, null);
  }

  /** Left click (no drag): select own units. */
  onSelect(pick: PickResult): void {
    if (this.inputLocked || this.gameEnded) return;
    if (pick.unitId === null) return;
    const clicked = getUnit(this.state, pick.unitId);
    if (clicked.player === this.state.currentPlayer) this.select(clicked.id);
  }

  /** Right click: contextual action — move, attack, throw, heal, door. */
  onCommand(pick: PickResult): void {
    if (this.inputLocked || this.gameEnded) return;
    const u = this.selected;
    if (!u) return;

    // Own units are action targets only for the medkit.
    if (pick.unitId !== null) {
      const clicked = getUnit(this.state, pick.unitId);
      if (clicked.player === this.state.currentPlayer) {
        if (this.mode.t === 'medkit' && clicked.player === u.player) {
          this.issue({ kind: 'medkit', unitId: u.id, itemIndex: this.mode.itemIndex, targetId: clicked.id });
        }
        return;
      }
    }

    // Door toggling by direct click.
    if (pick.doorPos) {
      this.issue({ kind: 'door', unitId: u.id, pos: pick.doorPos });
      return;
    }

    if (pick.unitId !== null) {
      const target = getUnit(this.state, pick.unitId);
      if (target.player !== this.state.currentPlayer && this.state.vision[this.viewer].units.has(target.id)) {
        if (this.mode.t === 'shoot') {
          this.issue({ kind: 'shoot', unitId: u.id, targetId: target.id, mode: this.mode.shot });
        } else if (this.mode.t === 'melee') {
          this.issue({ kind: 'melee', unitId: u.id, targetId: target.id });
        } else if (this.mode.t === 'aoe') {
          this.issueAoe(u, target.pos);
        } else if (this.mode.t === 'move') {
          // Convenience: clicking an enemy in move mode starts targeting.
          const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
          this.mode = weapon.explosive ? { t: 'aoe' } : { t: 'shoot', shot: this.defaultShotMode(u), targetId: target.id };
          this.refreshHud();
        }
        return;
      }
    }

    if (pick.tile) {
      if (this.mode.t === 'aoe') {
        this.issueAoe(u, pick.tile);
        return;
      }
      if (this.mode.t === 'move') {
        const tile = this.reach?.tiles.get(posKey(pick.tile));
        if (tile && !tile.passOnly && tile.apCost <= u.ap) {
          this.issue({ kind: 'move', unitId: u.id, to: pick.tile });
        } else {
          // Clicking a closed door tile adjacent to the unit toggles it.
          const v = this.state.map.getP(pick.tile);
          if (v.type === VoxelType.Door) this.issue({ kind: 'door', unitId: u.id, pos: pick.tile });
        }
      }
    }
  }

  private issueAoe(u: Unit, target: GridPos): void {
    if (this.mode.t !== 'aoe') return;
    if (this.mode.itemIndex !== undefined) {
      this.issue({ kind: 'throw', unitId: u.id, itemIndex: this.mode.itemIndex, target });
    } else {
      this.issue({ kind: 'shootTile', unitId: u.id, target });
    }
  }

  // ---------------- command execution ----------------

  private issue(cmd: Command): void {
    const res = execute(this.state, cmd);
    if (!res.ok) {
      this.hud.log(res.reason);
      return;
    }
    this.inputLocked = true;
    this.mode = { t: 'move' };
    this.overlays.showReachable(null);
    this.overlays.showPath(null);
    this.overlays.showAoe(null, 0);
    this.overlays.showCover(null);
    this.hud.setTooltip(0, 0, null);
    this.animator.play(res.events, () => this.afterEvents());
  }

  private afterEvents(): void {
    this.inputLocked = false;
    this.rig.exitTargetView();
    if (this.gameEnded) return;
    const u = this.selected;
    if (!u || u.player !== this.state.currentPlayer) this.selectFirstUnit();
    else {
      this.reach = u.ap > 0 ? computeReachable(this.state, u) : null;
      this.overlays.showReachable(this.reach);
      this.overlays.showCover(u.pos);
      this.autoCutaway();
    }
    this.syncVisuals();
    this.refreshHud();
  }

  /** Animator callbacks. */
  onVisibilityEvent(): void {
    this.syncVisuals();
  }

  onSmokeEvent(): void {
    this.overlays.syncSmoke();
  }

  onTurnEndedEvent(): void {
    // Opaque handoff screen first, then swap fog to the next player behind it.
    showHandoff(this.overlayRoot, this.state.currentPlayer, this.state.turn, () => {
      this.refreshHud();
    });
    this.viewer = this.state.currentPlayer;
    this.selectedId = null;
    this.selectFirstUnit();
    this.syncVisuals();
    this.overlays.syncSmoke();
  }

  onGameOverEvent(winner: number): void {
    this.gameEnded = true;
    showVictory(this.overlayRoot, winner, this.onRestart);
  }

  // ---------------- helpers ----------------

  private defaultShotMode(u: Unit): ShotMode {
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
    return weapon.modes.snap ? 'snap' : 'aimed';
  }

  private aoeRadius(u: Unit): number {
    if (this.mode.t !== 'aoe') return 0;
    if (this.mode.itemIndex !== undefined) {
      return this.state.ruleset.items.get(u.items[this.mode.itemIndex])?.radius ?? 0;
    }
    return this.state.ruleset.weapons.get(u.weaponId)!.explosive?.radius ?? 0;
  }

  private aoeRange(u: Unit): number {
    if (this.mode.t !== 'aoe') return 0;
    if (this.mode.itemIndex !== undefined) {
      return this.state.ruleset.items.get(u.items[this.mode.itemIndex])?.range ?? 0;
    }
    return this.state.ruleset.weapons.get(u.weaponId)!.range;
  }

  private shotTooltip(shooter: Unit, target: Unit, mode: ShotMode): string {
    const weapon = this.state.ruleset.weapons.get(shooter.weaponId)!;
    if (weapon.explosive) return 'Area weapon — use Launch';
    const prev: ShotPreview = computeShot(this.state, shooter, target, weapon, mode, false);
    if (!prev.ok) return prev.reason!;
    const coverTxt = prev.flanked ? 'FLANKED!' : prev.cover === CoverType.Full ? 'full cover' : prev.cover === CoverType.Half ? 'half cover' : 'no cover';
    return `<span class="big">${prev.chance}%</span> to hit (${mode})\ncrit ${prev.critChance}% · ${coverTxt} · ${prev.distance.toFixed(1)} tiles`;
  }

  /** Hide storeys above the selected unit when it is indoors. */
  private autoCutaway(): void {
    const u = this.selected;
    if (!u) return;
    const { map } = this.state;
    let roofAbove = false;
    for (let z = u.pos.z + 1; z < map.d; z++) {
      const v = map.get(u.pos.x, u.pos.y, z);
      if (v.type === VoxelType.Floor || v.type === VoxelType.Solid) {
        roofAbove = true;
        break;
      }
    }
    this.terrain.setLevelCap(roofAbove ? u.pos.z : Infinity);
  }

  adjustLevelCap(dir: 1 | -1): void {
    const current = Number.isFinite(this.terrain.cap) ? this.terrain.cap : this.state.map.d - 1;
    const next = Math.max(0, Math.min(this.state.map.d - 1, current + dir));
    this.terrain.setLevelCap(next === this.state.map.d - 1 ? Infinity : next);
  }

  private syncVisuals(): void {
    this.units.syncAll(this.viewer, this.selectedId ?? undefined);
    this.overlays.syncFog(this.viewer);
  }

  refreshHud(): void {
    this.hud.refresh(this.state, this.viewer, this.selected, this.buildActions(), this.buildTargets(), this.buildShotPanel());
  }

  /** One chip per visible enemy of the selected unit, best hit chance first. */
  private buildTargets(): TargetChip[] {
    const u = this.selected;
    if (!u) return [];
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
    if (weapon.explosive) return [];
    const mode = this.mode.t === 'shoot' ? this.mode.shot : this.defaultShotMode(u);
    const vision = this.state.vision[this.viewer];
    const out: TargetChip[] = [];
    for (const e of this.state.units) {
      if (!e.alive || e.player === this.viewer || !vision.units.has(e.id)) continue;
      const prev = computeShot(this.state, u, e, weapon, mode, false);
      out.push({
        unitId: e.id,
        name: e.name,
        chance: prev.ok ? prev.chance : null,
        active: this.mode.t === 'shoot' && this.mode.targetId === e.id,
        title: prev.ok ? `${e.name} — ${prev.chance}% to hit (${mode})` : `${e.name} — ${prev.reason}`,
      });
    }
    out.sort((a, b) => (b.chance ?? -1) - (a.chance ?? -1));
    return out;
  }

  /** Shot details for the targeting view; null while no target is locked. */
  private buildShotPanel(): ShotPanel | null {
    const u = this.selected;
    if (!u || this.mode.t !== 'shoot' || this.mode.targetId === null) return null;
    const target = getUnit(this.state, this.mode.targetId);
    if (!target.alive) return null;
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
    const prev = computeShot(this.state, u, target, weapon, this.mode.shot, false);
    return {
      targetName: target.name,
      ok: prev.ok,
      reason: prev.reason,
      chance: prev.chance,
      critChance: prev.critChance,
      coverText: prev.flanked ? 'Flanked!' : prev.cover === CoverType.Full ? 'Full cover' : prev.cover === CoverType.Half ? 'Half cover' : 'No cover',
      distance: prev.distance,
      mode: this.mode.shot,
      canFire: prev.ok,
    };
  }

  private buildActions(): ActionButton[] {
    const u = this.selected;
    if (!u) return [];
    const weapon = this.state.ruleset.weapons.get(u.weaponId)!;
    const cls = this.state.ruleset.classes.get(u.classId)!;
    const out: ActionButton[] = [];
    const noAp = u.ap <= 0;

    const modeNames: { id: ShotMode; key: string }[] = [
      { id: 'snap', key: '1' },
      { id: 'aimed', key: '2' },
      { id: 'auto', key: '3' },
    ];
    for (const m of modeNames) {
      const def = weapon.modes[m.id];
      if (!def) continue;
      const label = weapon.explosive ? 'Launch' : m.id === 'snap' ? 'Snap' : m.id === 'aimed' ? 'Aimed' : 'Auto';
      out.push({
        id: m.id,
        label,
        apCost: `${def.apCost} AP`,
        hotkey: m.key,
        enabled: u.ap >= def.apCost && u.ammo > 0,
        active: (this.mode.t === 'shoot' && this.mode.shot === m.id) || (this.mode.t === 'aoe' && this.mode.itemIndex === undefined && weapon.explosive !== undefined),
        title: def.endsTurn ? 'Ends this unit’s turn' : undefined,
      });
    }
    if (cls.melee) {
      out.push({
        id: 'melee',
        label: 'Slash',
        apCost: `${cls.melee.apCost} AP`,
        hotkey: 'F',
        enabled: u.ap >= cls.melee.apCost,
        active: this.mode.t === 'melee',
      });
    }
    u.items.forEach((itemId, i) => {
      const item = this.state.ruleset.items.get(itemId)!;
      out.push({
        id: `item${i}`,
        label: item.name,
        apCost: `${item.apCost} AP`,
        hotkey: `${4 + i}`,
        enabled: u.ap >= item.apCost,
        active: (this.mode.t === 'aoe' && this.mode.itemIndex === i) || (this.mode.t === 'medkit' && this.mode.itemIndex === i),
      });
    });
    out.push({
      id: 'reload',
      label: 'Reload',
      apCost: '1 AP',
      hotkey: 'R',
      enabled: !noAp && u.ammo < weapon.clip,
      active: false,
    });
    out.push({
      id: 'overwatch',
      label: 'Overwatch',
      apCost: '1 AP',
      hotkey: 'Y',
      enabled: !noAp && !u.overwatch && u.ammo > 0 && !weapon.explosive,
      active: false,
    });
    out.push({ id: 'hunker', label: 'Hunker', apCost: '1 AP', hotkey: 'H', enabled: !noAp && !u.hunkered, active: false });
    return out;
  }

  hotkey(key: string): void {
    if (this.inputLocked || this.gameEnded) return;
    const map: Record<string, string> = {
      '1': 'snap',
      '2': 'aimed',
      '3': 'auto',
      f: 'melee',
      r: 'reload',
      y: 'overwatch',
      h: 'hunker',
      '4': 'item0',
      '5': 'item1',
      '6': 'item2',
    };
    const id = map[key];
    if (id) this.onAction(id);
  }

  /** True while event animation is running (input is ignored). */
  get locked(): boolean {
    return this.inputLocked;
  }

  /** Programmatic command entry (dev tooling / scripted tests). */
  issueCommand(cmd: Command): void {
    this.issue(cmd);
  }

  /** Re-sync all visuals from sim state (dev tooling after direct state edits). */
  resync(): void {
    const u = this.selected;
    this.reach = u && u.ap > 0 ? computeReachable(this.state, u) : null;
    this.overlays.showReachable(this.reach);
    this.syncVisuals();
    this.overlays.syncSmoke();
    this.refreshHud();
  }
}
