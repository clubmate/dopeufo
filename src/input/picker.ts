import * as THREE from 'three';
import { GridPos } from '../core/math/grid';
import { GameState } from '../core/state';
import { VoxelType } from '../core/map/voxelmap';
import { LEVEL_H } from '../render/scene';

export interface PickResult {
  tile: GridPos | null;
  unitId: number | null;
  doorPos: GridPos | null;
}

/**
 * Mouse picking: raycast against unit meshes first, then terrain surfaces.
 * A terrain hit resolves to the cell sitting on the hit surface (nudged along
 * the face normal), clamped to a standable cell when possible.
 */
export class Picker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(
    private state: GameState,
    private camera: THREE.Camera,
  ) {}

  pick(clientX: number, clientY: number, unitObjects: THREE.Object3D[], terrainRoot: THREE.Object3D): PickResult {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);

    const unitHits = this.ray.intersectObjects(unitObjects, true);
    for (const hit of unitHits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o.userData.unitId !== undefined) {
          return { tile: null, unitId: o.userData.unitId as number, doorPos: null };
        }
        o = o.parent;
      }
    }

    const terrainHits = this.ray.intersectObject(terrainRoot, true);
    for (const hit of terrainHits) {
      // Door panels carry their grid position on an ancestor.
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o.userData.doorPos !== undefined) {
          return { tile: null, unitId: null, doorPos: o.userData.doorPos as GridPos };
        }
        o = o.parent;
      }
      const tile = this.resolveTile(hit);
      if (tile) return { tile, unitId: null, doorPos: null };
    }

    // Fallback: ground plane (lets you click slightly outside geometry).
    const pt = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(this.groundPlane, pt)) {
      const tile = { x: Math.floor(pt.x), y: Math.floor(pt.z), z: 0 };
      if (this.state.map.inBounds(tile.x, tile.y, tile.z)) return { tile, unitId: null, doorPos: null };
    }
    return { tile: null, unitId: null, doorPos: null };
  }

  private resolveTile(hit: THREE.Intersection): GridPos | null {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    const p = hit.point.clone().addScaledVector(n, 0.02);
    const tile = { x: Math.floor(p.x), y: Math.floor(p.z), z: Math.max(0, Math.floor(p.y / LEVEL_H + 0.0001)) };
    if (!this.state.map.inBounds(tile.x, tile.y, tile.z)) return null;
    // Clicking the side of a wall: prefer the standable cell in front of it.
    if (this.state.map.isStandable(tile.x, tile.y, tile.z)) return tile;
    // Clicking on top of a half-height crate resolves to that cell (not standable) —
    // try the cell above, then give the raw cell back for targeting purposes.
    const v = this.state.map.getP(tile);
    if (v.type === VoxelType.Half && this.state.map.inBounds(tile.x, tile.y, tile.z)) return tile;
    return tile;
  }
}
