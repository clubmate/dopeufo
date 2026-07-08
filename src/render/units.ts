import * as THREE from 'three';
import { GameState, Unit, PlayerId } from '../core/state';
import { tileToWorld } from './scene';

const TEAM_COLORS: Record<PlayerId, number> = { 1: 0x4da6ff, 2: 0xff5f4d };

interface UnitVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  ring: THREE.Mesh;
  owIcon: THREE.Mesh;
}

/**
 * Procedural low-poly soldiers: team-colored body, class-colored backpack,
 * selection ring, overwatch marker. Ghost markers show last-seen enemies.
 */
export class UnitRenderer {
  readonly root = new THREE.Group();
  private visuals = new Map<number, UnitVisual>();
  private ghosts = new Map<number, THREE.Group>();

  constructor(private state: GameState) {
    for (const u of state.units) {
      const vis = buildSoldier(u, state);
      this.visuals.set(u.id, vis);
      this.root.add(vis.group);
    }
    this.syncAll(1);
  }

  mesh(unitId: number): THREE.Group {
    return this.visuals.get(unitId)!.group;
  }

  /** Snap every unit to sim state; apply viewer-dependent visibility. */
  syncAll(viewer: PlayerId, selectedId?: number): void {
    const vision = this.state.vision[viewer];
    for (const u of this.state.units) {
      const vis = this.visuals.get(u.id)!;
      const mine = u.player === viewer;
      const visible = u.alive && (mine || vision.units.has(u.id));
      vis.group.visible = visible;
      if (u.alive) {
        vis.group.position.copy(tileToWorld(u.pos.x, u.pos.y, u.pos.z));
        vis.group.rotation.z = 0;
        vis.group.scale.setScalar(u.hunkered ? 0.75 : 1);
      }
      vis.ring.visible = u.id === selectedId;
      vis.owIcon.visible = u.overwatch;
    }
    this.syncGhosts(viewer);
  }

  private syncGhosts(viewer: PlayerId): void {
    const vision = this.state.vision[viewer];
    for (const [, g] of this.ghosts) this.root.remove(g);
    this.ghosts.clear();
    for (const [unitId, ghost] of vision.ghosts) {
      if (vision.units.has(unitId)) continue; // currently visible, no ghost
      const g = buildGhost();
      g.position.copy(tileToWorld(ghost.pos.x, ghost.pos.y, ghost.pos.z));
      g.userData.ghostFor = unitId;
      this.ghosts.set(unitId, g);
      this.root.add(g);
    }
  }

  /** Meshes pickable as units (for targeting clicks). */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const [, vis] of this.visuals) if (vis.group.visible) out.push(vis.group);
    return out;
  }
}

function buildSoldier(u: Unit, state: GameState): UnitVisual {
  const cls = state.ruleset.classes.get(u.classId)!;
  const team = new THREE.Color(TEAM_COLORS[u.player]);
  const accent = new THREE.Color(cls.color);

  const group = new THREE.Group();
  group.userData.unitId = u.id;

  const bodyMat = new THREE.MeshStandardMaterial({ color: team, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.34, 4, 10), bodyMat);
  body.position.y = 0.42;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5 }),
  );
  head.position.y = 0.78;
  head.castShadow = true;
  group.add(head);

  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.22, 0.1),
    new THREE.MeshStandardMaterial({ color: accent, roughness: 0.8 }),
  );
  pack.position.set(0, 0.5, -0.2);
  group.add(pack);

  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.08, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.4 }),
  );
  gun.position.set(0.2, 0.45, 0.12);
  group.add(gun);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.38, 28),
    new THREE.MeshBasicMaterial({ color: 0xd8ecff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  group.add(ring);

  const owIcon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09),
    new THREE.MeshBasicMaterial({ color: 0xffd76b }),
  );
  owIcon.position.y = 1.05;
  owIcon.visible = false;
  group.add(owIcon);

  return { group, body, ring, owIcon };
}

function buildGhost(): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.35 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.34, 4, 8), mat);
  body.position.y = 0.42;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), mat);
  head.position.y = 0.78;
  group.add(head);
  return group;
}
