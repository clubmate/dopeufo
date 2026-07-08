import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GameState } from '../core/state';
import { VoxelType } from '../core/map/voxelmap';
import { CARDINALS, posKey } from '../core/math/grid';
import { LEVEL_H } from './scene';

/**
 * Terrain renderer: one merged mesh per z-level (so the floor cutaway can
 * hide upper storeys), plus individually animatable door meshes. Levels are
 * rebuilt wholesale when destruction/doors change them — maps are small
 * enough that this is instant.
 */
export class TerrainRenderer {
  readonly root = new THREE.Group();
  private levelGroups: THREE.Group[] = [];
  private doorPivots = new Map<number, THREE.Group>();
  private levelCap = Infinity;

  constructor(private state: GameState) {
    this.buildAll();
  }

  buildAll(): void {
    this.root.clear();
    this.levelGroups = [];
    this.doorPivots.clear();
    for (let z = 0; z < this.state.map.d; z++) {
      const g = this.buildLevel(z);
      this.levelGroups.push(g);
      this.root.add(g);
    }
    this.applyLevelCap();
  }

  rebuildLevel(z: number): void {
    const old = this.levelGroups[z];
    disposeGroup(old);
    this.root.remove(old);
    for (const [k, pivot] of this.doorPivots) {
      if (k >> 20 === z) {
        this.doorPivots.delete(k);
        void pivot;
      }
    }
    const g = this.buildLevel(z);
    this.levelGroups[z] = g;
    this.root.add(g);
    this.applyLevelCap();
  }

  /** Hide all levels above `cap` (cutaway to see interiors). Infinity = show all. */
  setLevelCap(cap: number): void {
    this.levelCap = cap;
    this.applyLevelCap();
  }

  get cap(): number {
    return this.levelCap;
  }

  private applyLevelCap(): void {
    this.levelGroups.forEach((g, z) => {
      g.visible = z <= this.levelCap;
    });
  }

  /** Animate/snap a door panel. */
  setDoorOpen(pos: { x: number; y: number; z: number }, open: boolean): void {
    const pivot = this.doorPivots.get(posKey(pos));
    if (pivot) pivot.rotation.y = open ? -Math.PI * 0.45 : 0;
  }

  private buildLevel(z: number): THREE.Group {
    const { map, materials } = this.state;
    const group = new THREE.Group();
    const geos: THREE.BufferGeometry[] = [];
    const glowGeos: THREE.BufferGeometry[] = [];

    // Ground continues past the playable bounds and fades into the dark, with
    // scattered silhouette props, so the map reads as part of a larger place.
    if (z === 0) {
      const M = 10; // fade-out margin in tiles
      const bg = new THREE.Color(0x0b0e14);

      const apron = new THREE.BoxGeometry(map.w + 2 * M + 6, 0.04, map.h + 2 * M + 6);
      apron.translate(map.w / 2, -0.08, map.h / 2);
      setColor(apron, bg.clone().multiplyScalar(1.1));
      geos.push(apron);

      // Glowing red frame marking the edge of the playable area: a bright line
      // on a wider dim under-glow. Strips butt against each other (no overlap).
      const lineC = new THREE.Color(0xe04040);
      const glowC = new THREE.Color(0x4a1512);
      const frame = (w: number, d: number, cx: number, cz: number, y: number, h: number, c: THREE.Color): void => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(cx, y, cz);
        setColor(g, c);
        glowGeos.push(g);
      };
      for (const cz of [0, map.h]) {
        frame(map.w + 0.3, 0.24, map.w / 2, cz, 0.008, 0.014, glowC);
        frame(map.w + 0.12, 0.06, map.w / 2, cz, 0.028, 0.022, lineC);
      }
      for (const cx of [0, map.w]) {
        frame(0.24, map.h - 0.24, cx, map.h / 2, 0.008, 0.014, glowC);
        frame(0.06, map.h - 0.06, cx, map.h / 2, 0.028, 0.022, lineC);
      }

      for (let y = -M; y < map.h + M; y++) {
        for (let x = -M; x < map.w + M; x++) {
          // Distance past the playable edge -> 1 (at the edge) .. 0 (margin rim).
          const dx = Math.max(0, -x, x - (map.w - 1));
          const dy = Math.max(0, -y, y - (map.h - 1));
          const d = Math.max(dx, dy);
          const fade = Math.pow(Math.max(0, 1 - d / M), 1.6);

          const g = new THREE.BoxGeometry(0.97, 0.06, 0.97);
          g.translate(x + 0.5, -0.03, y + 0.5);
          const shade = 0.85 + 0.15 * hash2(x, y);
          // Mix mossy and concrete panels for a patchy industrial floor.
          const c = new THREE.Color(hash2(x * 7, y * 13) < 0.35 ? 0x474e42 : 0x454a52).multiplyScalar(shade);
          if ((x + y) % 2 === 0) c.multiplyScalar(0.93);
          if (hash2(x * 17, y * 29) < 0.07) c.multiplyScalar(0.6); // stains
          setColor(g, c.lerp(bg, 1 - fade));
          geos.push(g);

          // Non-playable dressing outside the bounds (never adjacent to the edge).
          if (d >= 2) {
            // Low-frequency blob hash clusters wall blocks into building-like masses.
            const blob = hash2(Math.floor(x / 3) * 7, Math.floor(y / 3) * 13);
            if (blob < 0.17 && hash2(x * 19, y * 23) > 0.3) {
              // Taller masses only further out so they never occlude playable tiles.
              const storeys = Math.min(1 + Math.floor(hash2(x * 29, y * 31) * 2.3), Math.max(1, d - 1));
              const wall = new THREE.BoxGeometry(1, storeys * LEVEL_H, 1);
              wall.translate(x + 0.5, (storeys * LEVEL_H) / 2, y + 0.5);
              setColor(wall, new THREE.Color(0x50555e).lerp(bg, 1 - fade));
              geos.push(wall);
            } else {
              const roll = hash2(x * 3 + 7, y * 5 + 11);
              if (roll < 0.045) {
                const crate = new THREE.BoxGeometry(0.85, 0.42, 0.85);
                crate.translate(x + 0.5, 0.21, y + 0.5);
                setColor(crate, new THREE.Color(0x7a6a48).lerp(bg, 1 - fade));
                geos.push(crate);
              } else if (roll < 0.07) {
                const drum = new THREE.CylinderGeometry(0.3, 0.31, 0.42, 10);
                drum.translate(x + 0.5, 0.21, y + 0.5);
                setColor(drum, new THREE.Color(0x6e523a).lerp(bg, 1 - fade));
                geos.push(drum);
              }
            }
          }
        }
      }
    }

    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const v = map.get(x, y, z);
        if (v.type === VoxelType.Empty) continue;
        const baseColor = new THREE.Color(materials.get(v.material)?.color ?? 0x888888).multiplyScalar(
          0.85 + 0.15 * hash2(x * 3 + z, y * 5),
        );
        const y0 = z * LEVEL_H;

        switch (v.type) {
          case VoxelType.Solid: {
            const g = new THREE.BoxGeometry(1, LEVEL_H, 1);
            g.translate(x + 0.5, y0 + LEVEL_H / 2, y + 0.5);
            setColor(g, baseColor);
            geos.push(g);
            // Darker trim panel sitting on exposed wall tops. Slightly raised and
            // inset so it never shares a plane with the wall top or a neighbor cap
            // (coplanar same-facing surfaces z-fight).
            const above = map.get(x, y, z + 1).type;
            if (above !== VoxelType.Solid && above !== VoxelType.Floor) {
              const cap = new THREE.BoxGeometry(0.99, 0.04, 0.99);
              cap.translate(x + 0.5, y0 + LEVEL_H + 0.021, y + 0.5);
              setColor(cap, baseColor.clone().multiplyScalar(0.55));
              geos.push(cap);
            }
            // Occasional glowing tech strip around the wall. Hash-varied height so
            // strips of adjacent walls never meet in one plane.
            const glowRoll = hash2(x * 31 + z, y * 37);
            if (glowRoll < 0.14) {
              const strip = new THREE.BoxGeometry(1.015, 0.025, 1.015);
              strip.translate(x + 0.5, y0 + LEVEL_H * (0.58 + 0.28 * hash2(x * 13 + z, y * 7)), y + 0.5);
              setColor(strip, new THREE.Color(glowRoll < 0.05 ? 0xd08a3a : 0x2fbac0));
              glowGeos.push(strip);
            }
            break;
          }
          case VoxelType.Half: {
            if (hash2(x * 11, y * 23 + z) < 0.35) {
              // Barrel with darker rims.
              const drum = new THREE.CylinderGeometry(0.32, 0.33, 0.44, 12);
              drum.translate(x + 0.5, y0 + 0.22, y + 0.5);
              const rust = hash2(x * 5, y * 3) < 0.4;
              setColor(drum, rust ? new THREE.Color(0x8a5a30) : baseColor.clone().multiplyScalar(0.9));
              geos.push(drum);
              for (const ry of [0.06, 0.44]) {
                const rim = new THREE.CylinderGeometry(0.335, 0.335, 0.035, 12);
                rim.translate(x + 0.5, y0 + ry, y + 0.5);
                setColor(rim, (rust ? new THREE.Color(0x8a5a30) : baseColor).clone().multiplyScalar(0.5));
                geos.push(rim);
              }
            } else {
              // Supply crate: body, lid, and two straps.
              const g = new THREE.BoxGeometry(0.88, LEVEL_H * 0.44, 0.88);
              g.translate(x + 0.5, y0 + LEVEL_H * 0.22, y + 0.5);
              setColor(g, baseColor);
              geos.push(g);
              const lid = new THREE.BoxGeometry(0.94, 0.06, 0.94);
              lid.translate(x + 0.5, y0 + LEVEL_H * 0.47, y + 0.5);
              setColor(lid, baseColor.clone().multiplyScalar(0.62));
              geos.push(lid);
              for (const off of [-0.18, 0.18]) {
                // Top ends inside the lid, not level with it (avoids z-fighting).
                const strap = new THREE.BoxGeometry(0.06, LEVEL_H * 0.47, 0.92);
                strap.translate(x + 0.5 + off, y0 + LEVEL_H * 0.235, y + 0.5);
                setColor(strap, baseColor.clone().multiplyScalar(0.45));
                geos.push(strap);
              }
            }
            break;
          }
          case VoxelType.Floor: {
            const g = new THREE.BoxGeometry(1, 0.09, 1);
            g.translate(x + 0.5, y0 + 0.045, y + 0.5);
            setColor(g, baseColor);
            geos.push(g);
            break;
          }
          case VoxelType.Stairs: {
            // Three rising steps toward the uphill direction.
            const c = CARDINALS[v.dir];
            for (let s = 0; s < 3; s++) {
              const h = ((s + 1) / 3) * LEVEL_H;
              const g = new THREE.BoxGeometry(c.dx !== 0 ? 1 / 3 : 1, h, c.dy !== 0 ? 1 / 3 : 1);
              const off = (s + 0.5) / 3 - 0.5;
              g.translate(x + 0.5 + off * c.dx, y0 + h / 2, y + 0.5 + off * c.dy);
              setColor(g, baseColor.clone().multiplyScalar(s % 2 === 0 ? 1 : 0.85));
              geos.push(g);
            }
            break;
          }
          case VoxelType.Door: {
            // Frame is part of the merged level mesh; the panel gets its own
            // pivot group so it can swing open.
            const alongX = v.dir === 0; // wall runs E-W? dir=0 means solid neighbors on x-axis
            const panel = new THREE.Mesh(
              new THREE.BoxGeometry(alongX ? 0.14 : 0.92, LEVEL_H * 0.95, alongX ? 0.92 : 0.14),
              new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.85 }),
            );
            panel.castShadow = true;
            panel.receiveShadow = true;
            const pivot = new THREE.Group();
            // Hinge on one edge of the doorway.
            if (alongX) {
              pivot.position.set(x + 0.5, y0 + LEVEL_H * 0.475, y + 0.04);
              panel.position.set(0, 0, 0.46);
            } else {
              pivot.position.set(x + 0.04, y0 + LEVEL_H * 0.475, y + 0.5);
              panel.position.set(0.46, 0, 0);
            }
            pivot.add(panel);
            pivot.rotation.y = v.open === true ? -Math.PI * 0.45 : 0;
            pivot.userData.doorPos = { x, y, z };
            group.add(pivot);
            this.doorPivots.set(posKey({ x, y, z }), pivot);
            break;
          }
        }
      }
    }

    if (geos.length > 0) {
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.06 }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.terrainLevel = z;
      group.add(mesh);
    }
    if (glowGeos.length > 0) {
      // Unlit strips read as emissive tech lighting; not pickable terrain.
      const merged = mergeGeometries(glowGeos);
      glowGeos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true }));
      mesh.userData.terrainLevel = z;
      group.add(mesh);
    }
    return group;
  }
}

function setColor(g: THREE.BufferGeometry, c: THREE.Color): void {
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      if (o.material instanceof THREE.Material) o.material.dispose();
    }
  });
}
