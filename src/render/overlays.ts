import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GameState, PlayerId, isSmoked } from '../core/state';
import { ReachResult } from '../core/path/pathfind';
import { GridPos, keyPos, posKey, euclid, CARDINALS } from '../core/math/grid';
import { VoxelType } from '../core/map/voxelmap';
import { coverProfile, CoverType } from '../core/los/cover';
import { LEVEL_H } from './scene';

/** Height of a tile's walkable surface in world units. */
export function surfaceY(state: GameState, p: GridPos): number {
  const v = state.map.getP(p);
  if (v.type === VoxelType.Stairs) return p.z * LEVEL_H + LEVEL_H * 0.5;
  if (v.type === VoxelType.Floor) return p.z * LEVEL_H + 0.09;
  return p.z * LEVEL_H;
}

/**
 * All transient tactical overlays: move zones (blue/dash), path preview,
 * hover cursor, AoE preview, cover markers, smoke clouds, and the fog veil.
 */
export class OverlayRenderer {
  readonly root = new THREE.Group();
  private reachGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private aoeGroup = new THREE.Group();
  private coverGroup = new THREE.Group();
  private smokeGroup = new THREE.Group();
  private fogGroup = new THREE.Group();
  private hover: THREE.LineLoop;

  constructor(private state: GameState) {
    this.root.add(this.reachGroup, this.pathGroup, this.aoeGroup, this.coverGroup, this.smokeGroup, this.fogGroup);
    const pts = [
      new THREE.Vector3(0.03, 0, 0.03),
      new THREE.Vector3(0.97, 0, 0.03),
      new THREE.Vector3(0.97, 0, 0.97),
      new THREE.Vector3(0.03, 0, 0.97),
    ];
    this.hover = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.hover.visible = false;
    this.root.add(this.hover);
  }

  setHover(p: GridPos | null): void {
    if (!p) {
      this.hover.visible = false;
      return;
    }
    this.hover.position.set(p.x, surfaceY(this.state, p) + 0.03, p.y);
    this.hover.visible = true;
  }

  showReachable(reach: ReachResult | null): void {
    clearGroup(this.reachGroup);
    if (!reach) return;
    const blue: THREE.BufferGeometry[] = [];
    const yellow: THREE.BufferGeometry[] = [];
    for (const [key, tile] of reach.tiles) {
      if (tile.passOnly) continue;
      const p = keyPos(key);
      const g = new THREE.PlaneGeometry(0.9, 0.9);
      g.rotateX(-Math.PI / 2);
      g.translate(p.x + 0.5, surfaceY(this.state, p) + 0.02, p.y + 0.5);
      (tile.apCost === 1 ? blue : yellow).push(g);
    }
    addMerged(this.reachGroup, blue, 0x57a7ff, 0.28);
    addMerged(this.reachGroup, yellow, 0xffce57, 0.22);
  }

  showPath(path: GridPos[] | null): void {
    clearGroup(this.pathGroup);
    if (!path || path.length === 0) return;
    const dots: THREE.BufferGeometry[] = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const last = i === path.length - 1;
      const g = new THREE.CircleGeometry(last ? 0.3 : 0.11, last ? 24 : 12);
      g.rotateX(-Math.PI / 2);
      g.translate(p.x + 0.5, surfaceY(this.state, p) + 0.04, p.y + 0.5);
      dots.push(g);
    }
    addMerged(this.pathGroup, dots, 0xeaf4ff, 0.85);
  }

  showAoe(center: GridPos | null, radius: number): void {
    clearGroup(this.aoeGroup);
    if (!center) return;
    const tiles: THREE.BufferGeometry[] = [];
    const r = Math.ceil(radius);
    for (let z = Math.max(0, center.z - r); z <= Math.min(this.state.map.d - 1, center.z + r); z++) {
      for (let y = Math.max(0, center.y - r); y <= Math.min(this.state.map.h - 1, center.y + r); y++) {
        for (let x = Math.max(0, center.x - r); x <= Math.min(this.state.map.w - 1, center.x + r); x++) {
          if (euclid(center, { x, y, z }) > radius) continue;
          const p = { x, y, z };
          // Only paint tiles that have a visible surface.
          if (!this.state.map.isStandable(x, y, z) && this.state.map.getP(p).type === VoxelType.Empty) continue;
          const g = new THREE.PlaneGeometry(0.86, 0.86);
          g.rotateX(-Math.PI / 2);
          g.translate(x + 0.5, surfaceY(this.state, p) + 0.05, y + 0.5);
          tiles.push(g);
        }
      }
    }
    addMerged(this.aoeGroup, tiles, 0xff5f4d, 0.33);
  }

  /** Cover bars on the edges of a tile (shown for hovered path tiles / selected unit). */
  showCover(p: GridPos | null): void {
    clearGroup(this.coverGroup);
    if (!p) return;
    const prof = coverProfile(this.state.map, p);
    const y = surfaceY(this.state, p);
    for (let d = 0; d < 4; d++) {
      if (prof[d] === CoverType.None) continue;
      const c = CARDINALS[d];
      const full = prof[d] === CoverType.Full;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(c.dy !== 0 ? 0.8 : 0.08, full ? 0.55 : 0.28, c.dx !== 0 ? 0.8 : 0.08),
        new THREE.MeshBasicMaterial({ color: full ? 0xffd76b : 0xbfd4ea, transparent: true, opacity: 0.9 }),
      );
      mesh.position.set(p.x + 0.5 + c.dx * 0.46, y + (full ? 0.28 : 0.14), p.y + 0.5 + c.dy * 0.46);
      this.coverGroup.add(mesh);
    }
  }

  /** Sync smoke clouds from sim state. */
  syncSmoke(): void {
    clearGroup(this.smokeGroup);
    const seen = new Set<number>();
    for (const [key] of this.state.smoke) {
      const p = keyPos(key);
      if (!isSmoked(this.state, p) || seen.has(key)) continue;
      seen.add(key);
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xb9c2cc, transparent: true, opacity: 0.45, roughness: 1 }),
      );
      puff.position.set(p.x + 0.5, p.z * LEVEL_H + 0.5, p.y + 0.5);
      puff.scale.y = 0.8;
      this.smokeGroup.add(puff);
    }
  }

  /** Dark veil over every walkable surface the viewing player cannot see. */
  syncFog(viewer: PlayerId): void {
    clearGroup(this.fogGroup);
    const vision = this.state.vision[viewer];
    const geos: THREE.BufferGeometry[] = [];
    const map = this.state.map;
    for (let z = 0; z < map.d; z++) {
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          if (!map.isStandable(x, y, z)) continue;
          const p = { x, y, z };
          if (vision.tiles.has(posKey(p))) continue;
          const g = new THREE.PlaneGeometry(1, 1);
          g.rotateX(-Math.PI / 2);
          g.translate(x + 0.5, surfaceY(this.state, p) + 0.015, y + 0.5);
          geos.push(g);
        }
      }
    }
    addMerged(this.fogGroup, geos, 0x05070c, 0.52);
  }
}

function addMerged(group: THREE.Group, geos: THREE.BufferGeometry[], color: number, opacity: number): void {
  if (geos.length === 0) return;
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  group.add(mesh);
}

function clearGroup(g: THREE.Group): void {
  for (const child of [...g.children]) {
    g.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.LineLoop) {
      (child as THREE.Mesh).geometry.dispose();
      const m = (child as THREE.Mesh).material;
      if (m instanceof THREE.Material) m.dispose();
    }
  }
}
