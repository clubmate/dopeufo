import * as THREE from 'three';
import { GameState, Unit, PlayerId } from '../core/state';
import { tileToWorld } from './scene';

const TEAM_COLORS: Record<PlayerId, number> = { 1: 0x4da6ff, 2: 0xff5f4d };
const SUIT = 0x23272e;
const GUNMETAL = 0x1a1e24;

interface UnitVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  ring: THREE.Mesh;
  owIcon: THREE.Mesh;
}

/**
 * Procedural low-poly troopers: team-colored armor plates over a dark
 * under-suit, class-colored shoulder pads/backpack, glowing visor, and a
 * per-class weapon. Ghost markers show last-seen enemies.
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

function std(color: THREE.ColorRepresentation, roughness = 0.6, metalness = 0.15): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** Soldier faces +z; movement/aim code rotates the group with rotation.y. */
function buildSoldier(u: Unit, state: GameState): UnitVisual {
  const cls = state.ruleset.classes.get(u.classId)!;
  const team = new THREE.Color(TEAM_COLORS[u.player]);
  const teamDark = team.clone().multiplyScalar(0.55);
  const accent = new THREE.Color(cls.color);

  const group = new THREE.Group();
  group.userData.unitId = u.id;

  const suitMat = std(SUIT, 0.75, 0.05);
  const armorMat = std(team, 0.5, 0.25);
  const armorDarkMat = std(teamDark, 0.55, 0.25);
  const accentMat = std(accent, 0.6, 0.1);

  // Legs and boots (under-suit).
  for (const side of [-1, 1]) {
    group.add(box(0.09, 0.09, 0.15, suitMat, side * 0.075, 0.045, 0.01));
    group.add(box(0.075, 0.21, 0.095, suitMat, side * 0.075, 0.185, 0));
    group.add(box(0.078, 0.07, 0.03, armorDarkMat, side * 0.075, 0.22, 0.055)); // knee pads
  }

  // Hips, torso armor, chest rig.
  group.add(box(0.24, 0.09, 0.16, armorDarkMat, 0, 0.325, 0));
  const body = box(0.27, 0.25, 0.18, armorMat, 0, 0.5, 0);
  group.add(body);
  group.add(box(0.21, 0.13, 0.05, suitMat, 0, 0.52, 0.1));

  // Shoulder pads carry the class color (readable from the tactical camera).
  for (const side of [-1, 1]) {
    group.add(box(0.11, 0.075, 0.13, accentMat, side * 0.185, 0.605, 0));
    group.add(box(0.065, 0.21, 0.085, suitMat, side * 0.175, 0.44, 0));
  }

  // Helmet with glowing visor.
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 12), armorDarkMat);
  helmet.position.set(0, 0.735, 0);
  group.add(helmet);
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.045, 0.05),
    new THREE.MeshStandardMaterial({
      color: 0x0a0d10,
      emissive: u.player === 1 ? 0x35d0e0 : 0xe06035,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
  );
  visor.position.set(0, 0.73, 0.07);
  group.add(visor);

  // Backpack with antenna.
  group.add(box(0.19, 0.2, 0.09, accentMat, 0, 0.5, -0.15));
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.18, 5), suitMat);
  antenna.position.set(-0.07, 0.67, -0.16);
  group.add(antenna);

  group.add(buildWeapon(u.weaponId, accent));

  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });

  // Selection ring (not a shadow caster).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.38, 28),
    new THREE.MeshBasicMaterial({ color: 0x4fe3e8, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
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

/** Held at the right side, muzzle toward +z (the facing direction). */
function buildWeapon(weaponId: string, accent: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0.19, 0.46, 0.1);
  const metal = std(GUNMETAL, 0.45, 0.35);
  const accentMat = std(accent.clone().multiplyScalar(0.8), 0.5, 0.2);

  const barrel = (r: number, len: number, z: number, y = 0): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), metal);
    m.rotation.x = Math.PI / 2;
    m.position.set(0, y, z);
    return m;
  };

  switch (weaponId) {
    case 'sniper_rifle': {
      g.add(box(0.04, 0.06, 0.52, metal, 0, 0, 0));
      g.add(barrel(0.013, 0.22, 0.35));
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.11, 8), accentMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.055, 0.02);
      g.add(scope);
      break;
    }
    case 'shotgun': {
      g.add(box(0.055, 0.08, 0.34, metal, 0, 0, 0));
      g.add(barrel(0.018, 0.12, 0.22));
      g.add(box(0.04, 0.045, 0.1, accentMat, 0, -0.045, 0.13)); // pump
      break;
    }
    case 'grenade_launcher': {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.3, 10), metal);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.01, 0.05);
      g.add(tube);
      g.add(box(0.05, 0.09, 0.14, accentMat, 0, -0.03, -0.12)); // stock
      break;
    }
    default: {
      // assault_rifle and anything unknown
      g.add(box(0.045, 0.07, 0.4, metal, 0, 0, 0));
      g.add(barrel(0.012, 0.14, 0.26));
      g.add(box(0.03, 0.08, 0.05, accentMat, 0, -0.055, 0.04)); // magazine
      break;
    }
  }
  return g;
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
