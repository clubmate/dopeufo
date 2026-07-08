import { VoxelMap, Voxel, VoxelType, Material } from './voxelmap';
import { GridPos } from '../math/grid';

/**
 * Hand-authored map format: one ASCII grid per z-level, plus a legend mapping
 * characters to voxel types. Row 0 is y=0 (north edge). Stairs use one char
 * per uphill direction. Example legend entry: { "#": { "type": "solid", "material": "brick" } }
 */
export interface MapJson {
  name: string;
  size: [number, number, number];
  materials: Record<string, { color: string; hp: number }>;
  legend: Record<string, { type: string; material: string; dir?: 'N' | 'E' | 'S' | 'W' }>;
  layers: string[][];
  spawns: { p1: [number, number, number][]; p2: [number, number, number][] };
}

const TYPE_NAMES: Record<string, VoxelType> = {
  solid: VoxelType.Solid,
  half: VoxelType.Half,
  floor: VoxelType.Floor,
  stairs: VoxelType.Stairs,
  door: VoxelType.Door,
};

const DIR_INDEX: Record<string, number> = { N: 0, E: 1, S: 2, W: 3 };

export interface LoadedMap {
  name: string;
  map: VoxelMap;
  materials: Map<string, Material>;
  spawns: { p1: GridPos[]; p2: GridPos[] };
}

export function loadMap(json: MapJson): LoadedMap {
  const [w, h, d] = json.size;
  if (d < 3) throw new Error(`Map "${json.name}" must have at least 3 height levels, got ${d}`);
  if (json.layers.length !== d) {
    throw new Error(`Map "${json.name}": expected ${d} layers, got ${json.layers.length}`);
  }

  const materials = new Map<string, Material>();
  for (const [id, m] of Object.entries(json.materials)) {
    materials.set(id, { id, color: parseInt(m.color.replace('#', ''), 16), hp: m.hp });
  }

  const map = new VoxelMap(w, h, d);
  for (let z = 0; z < d; z++) {
    const layer = json.layers[z];
    if (layer.length !== h) throw new Error(`Map "${json.name}" layer ${z}: expected ${h} rows`);
    for (let y = 0; y < h; y++) {
      const row = layer[y];
      if (row.length !== w) throw new Error(`Map "${json.name}" layer ${z} row ${y}: expected ${w} cols`);
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const def = json.legend[ch];
        if (!def) throw new Error(`Map "${json.name}": unknown legend char "${ch}" at ${x},${y},${z}`);
        const type = TYPE_NAMES[def.type];
        if (type === undefined) throw new Error(`Map "${json.name}": unknown voxel type "${def.type}"`);
        const mat = materials.get(def.material);
        if (!mat) throw new Error(`Map "${json.name}": unknown material "${def.material}"`);
        const voxel: Voxel = {
          type,
          material: mat.id,
          hp: mat.hp,
          dir: def.dir !== undefined ? DIR_INDEX[def.dir] : 0,
        };
        if (type === VoxelType.Door) voxel.open = false;
        map.set(x, y, z, voxel);
      }
    }
  }

  // Doors: infer wall axis from solid neighbors for rendering (0 = wall runs E-W, 1 = wall runs N-S).
  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = map.get(x, y, z);
        if (v.type !== VoxelType.Door) continue;
        const solidX = map.get(x - 1, y, z).type === VoxelType.Solid || map.get(x + 1, y, z).type === VoxelType.Solid;
        map.set(x, y, z, { ...v, dir: solidX ? 0 : 1 });
      }
    }
  }

  const toPos = (a: [number, number, number]): GridPos => ({ x: a[0], y: a[1], z: a[2] });
  const spawns = { p1: json.spawns.p1.map(toPos), p2: json.spawns.p2.map(toPos) };
  for (const [pl, list] of [['p1', spawns.p1], ['p2', spawns.p2]] as const) {
    for (const s of list) {
      if (!map.isStandable(s.x, s.y, s.z)) {
        throw new Error(`Map "${json.name}": ${pl} spawn at ${s.x},${s.y},${s.z} is not standable`);
      }
    }
  }

  return { name: json.name, map, materials, spawns };
}
