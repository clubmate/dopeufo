import * as THREE from 'three';
import { SimEvent } from '../core/events';
import { GameState, getUnit } from '../core/state';
import { GridPos } from '../core/math/grid';
import { UnitRenderer } from './units';
import { TerrainRenderer } from './terrain';
import { tileToWorld } from './scene';
import { surfaceY } from './overlays';

export interface AnimCallbacks {
  /** Floating combat text at a world position. */
  floater(world: THREE.Vector3, text: string, color: string): void;
  /** Fired when the sim says sightlines changed (fog/units need re-sync). */
  onVisibility(): void;
  onTurnEnded(): void;
  onGameOver(winner: number): void;
  /** Smoke clouds changed. */
  onSmoke(): void;
  centerCamera(world: THREE.Vector3): void;
  shake(strength: number): void;
}

interface ActiveTween {
  update(dt: number): boolean; // false when finished
}

/**
 * Plays the sim's event stream sequentially so the player can follow what
 * happened: step tweens, tracers, explosions, deaths. The controller locks
 * input while `busy`.
 */
export class Animator {
  private queue: SimEvent[] = [];
  private active: ActiveTween | null = null;
  private onDone: (() => void) | null = null;
  private effects = new THREE.Group();

  constructor(
    private state: GameState,
    private units: UnitRenderer,
    private terrain: TerrainRenderer,
    scene: THREE.Scene,
    private cb: AnimCallbacks,
  ) {
    scene.add(this.effects);
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  play(events: SimEvent[], onDone: () => void): void {
    this.queue.push(...events);
    this.onDone = onDone;
  }

  update(dt: number): void {
    if (this.active) {
      if (this.active.update(dt)) return;
      this.active = null;
    }
    while (!this.active && this.queue.length > 0) {
      this.active = this.startEvent(this.queue.shift()!);
    }
    if (!this.active && this.queue.length === 0 && this.onDone) {
      const cb = this.onDone;
      this.onDone = null;
      cb();
    }
  }

  private startEvent(ev: SimEvent): ActiveTween | null {
    switch (ev.kind) {
      case 'step':
        return this.tweenMove(ev.unitId, ev.from, ev.to, 0.13);

      case 'fall': {
        const t = this.tweenMove(ev.unitId, ev.from, ev.to, 0.25);
        if (ev.damage > 0) {
          this.cb.floater(tileToWorld(ev.to.x, ev.to.y, ev.to.z), `-${ev.damage}`, '#ff9d5c');
        }
        return t;
      }

      case 'shot': {
        const shooter = getUnit(this.state, ev.shooterId);
        const target = getUnit(this.state, ev.targetId);
        const from = tileToWorld(shooter.pos.x, shooter.pos.y, shooter.pos.z).add(new THREE.Vector3(0, 0.55, 0));
        const to = tileToWorld(target.pos.x, target.pos.y, target.pos.z).add(new THREE.Vector3(0, 0.5, 0));
        if (!ev.hit) to.add(new THREE.Vector3((Math.random() - 0.5) * 1.4, 0.3, (Math.random() - 0.5) * 1.4));
        this.spawnTracer(from, to, ev.mode === 'melee');
        const targetMesh = this.units.mesh(ev.targetId);
        const text = ev.hit ? (ev.crit ? `CRIT -${ev.damage}` : `-${ev.damage}`) : 'MISS';
        const color = ev.hit ? (ev.crit ? '#ffd76b' : '#ff6b5c') : '#9fb2c8';
        this.cb.floater(to.clone().add(new THREE.Vector3(0, 0.4, 0)), text, color);
        if (ev.reaction) {
          this.cb.floater(from.clone().add(new THREE.Vector3(0, 0.6, 0)), 'REACTION FIRE', '#ffd76b');
        }
        this.cb.centerCamera(to);
        const dieAt = 0.25;
        let t = 0;
        const dur = 0.55;
        return {
          update: (dt) => {
            t += dt;
            if (ev.killed && t > dieAt) {
              targetMesh.rotation.z = Math.min(Math.PI / 2, ((t - dieAt) / 0.3) * (Math.PI / 2));
              if (t > dieAt + 0.35) targetMesh.visible = false;
            }
            return t < dur;
          },
        };
      }

      case 'explosion': {
        const center = tileToWorld(ev.center.x, ev.center.y, ev.center.z).add(new THREE.Vector3(0, 0.4, 0));
        this.cb.centerCamera(center);
        this.cb.shake(0.5);
        const flash = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xffb45c, transparent: true, opacity: 0.95 }),
        );
        flash.position.copy(center);
        this.effects.add(flash);
        for (const c of ev.casualties) {
          const u = getUnit(this.state, c.unitId);
          this.cb.floater(tileToWorld(u.pos.x, u.pos.y, u.pos.z).add(new THREE.Vector3(0, 1, 0)), `-${c.damage}`, '#ff6b5c');
          if (c.killed) this.units.mesh(c.unitId).visible = false;
        }
        // Rebuild affected terrain levels once the flash peaks.
        const levels = new Set<number>(ev.destroyed.map((p: GridPos) => p.z));
        let rebuilt = false;
        let t = 0;
        return {
          update: (dt) => {
            t += dt;
            flash.scale.setScalar(1 + t * ev.radius * 3.2);
            (flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.95 - t * 1.6);
            if (t > 0.25 && !rebuilt) {
              rebuilt = true;
              for (const z of levels) this.terrain.rebuildLevel(z);
            }
            if (t >= 0.7) {
              this.effects.remove(flash);
              flash.geometry.dispose();
              (flash.material as THREE.Material).dispose();
              return false;
            }
            return true;
          },
        };
      }

      case 'smoke':
        this.cb.onSmoke();
        return this.wait(0.25);

      case 'heal': {
        const target = getUnit(this.state, ev.targetId);
        this.cb.floater(tileToWorld(target.pos.x, target.pos.y, target.pos.z).add(new THREE.Vector3(0, 1, 0)), `+${ev.amount}`, '#62d96b');
        return this.wait(0.4);
      }

      case 'reload': {
        const u = getUnit(this.state, ev.unitId);
        this.cb.floater(tileToWorld(u.pos.x, u.pos.y, u.pos.z).add(new THREE.Vector3(0, 1, 0)), 'RELOAD', '#9fb2c8');
        return this.wait(0.3);
      }

      case 'overwatchSet': {
        const u = getUnit(this.state, ev.unitId);
        this.cb.floater(tileToWorld(u.pos.x, u.pos.y, u.pos.z).add(new THREE.Vector3(0, 1, 0)), 'OVERWATCH', '#ffd76b');
        return this.wait(0.3);
      }

      case 'hunker': {
        const u = getUnit(this.state, ev.unitId);
        this.cb.floater(tileToWorld(u.pos.x, u.pos.y, u.pos.z).add(new THREE.Vector3(0, 1, 0)), 'HUNKERED', '#9fb2c8');
        return this.wait(0.3);
      }

      case 'door':
        this.terrain.setDoorOpen(ev.pos, ev.open);
        return this.wait(0.15);

      case 'visibility':
        this.cb.onVisibility();
        return null;

      case 'turnEnded':
        this.cb.onTurnEnded();
        return null;

      case 'gameOver':
        this.cb.onGameOver(ev.winner);
        return null;
    }
  }

  private tweenMove(unitId: number, from: GridPos, to: GridPos, dur: number): ActiveTween {
    const mesh = this.units.mesh(unitId);
    const a = tileToWorld(from.x, from.y, from.z).setY(surfaceY(this.state, from));
    const b = tileToWorld(to.x, to.y, to.z).setY(surfaceY(this.state, to));
    mesh.visible = true;
    const dir = Math.atan2(b.x - a.x, b.z - a.z);
    mesh.rotation.y = dir;
    this.cb.centerCamera(b);
    let t = 0;
    return {
      update: (dt) => {
        t = Math.min(1, t + dt / dur);
        mesh.position.lerpVectors(a, b, t);
        // Small hop when changing height levels.
        if (Math.abs(b.y - a.y) > 0.01) mesh.position.y += Math.sin(t * Math.PI) * 0.1;
        return t < 1;
      },
    };
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3, melee: boolean): void {
    if (melee) return;
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 1 }));
    this.effects.add(line);
    const flash = new THREE.PointLight(0xffe9a0, 6, 4);
    flash.position.copy(from);
    this.effects.add(flash);
    let t = 0;
    const tween: ActiveTween = {
      update: (dt) => {
        t += dt;
        (line.material as THREE.LineBasicMaterial).opacity = Math.max(0, 1 - t * 4);
        flash.intensity = Math.max(0, 6 - t * 30);
        if (t > 0.3) {
          this.effects.remove(line);
          this.effects.remove(flash);
          geo.dispose();
          (line.material as THREE.Material).dispose();
          return false;
        }
        return true;
      },
    };
    this.parallel.push(tween);
  }

  private parallel: ActiveTween[] = [];

  /** Advance fire-and-forget effects (tracers) each frame. */
  updateEffects(dt: number): void {
    this.parallel = this.parallel.filter((e) => e.update(dt));
  }

  private wait(dur: number): ActiveTween {
    let t = 0;
    return {
      update: (dt) => {
        t += dt;
        return t < dur;
      },
    };
  }
}
