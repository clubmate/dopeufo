/** All gameplay-tunable data. Loaded from JSON so rules are moddable without code changes. */

export type ShotMode = 'snap' | 'aimed' | 'auto';

export interface ShotModeDef {
  apCost: number;
  endsTurn: boolean;
  aimMod: number;
  critMod: number;
  shots: number;
}

export type RangeCurve = 'rifle' | 'sniper' | 'shotgun' | 'launcher';

export interface WeaponDef {
  id: string;
  name: string;
  curve: RangeCurve;
  damage: [number, number];
  critChance: number;
  clip: number;
  /** Max targeting range in tiles (LoF still required). */
  range: number;
  modes: Partial<Record<ShotMode, ShotModeDef>>;
  /** Present on AoE weapons (grenade launcher): shot targets a tile, detonates. */
  explosive?: { radius: number };
}

export interface MeleeDef {
  damage: [number, number];
  apCost: number;
  endsTurn: boolean;
  aimBonus: number;
}

export interface ClassDef {
  id: string;
  name: string;
  hp: number;
  aim: number;
  mobility: number; // tiles per single move action
  sight: number; // tiles
  weapon: string;
  melee?: MeleeDef;
  items: string[];
  color: string; // accent color for rendering
}

export interface ItemDef {
  id: string;
  name: string;
  type: 'grenade' | 'smoke' | 'medkit';
  apCost: number;
  endsTurn: boolean;
  range: number;
  radius?: number;
  damage?: [number, number];
  heal?: number;
  duration?: number; // smoke turns
}

export interface RulesetConstants {
  apPerTurn: number;
  halfCoverDefense: number;
  fullCoverDefense: number;
  hunkerMultiplier: number;
  heightAimBonus: number;
  overwatchAimMalus: number;
  flankCritBonus: number;
  smokeDefense: number;
  minHitChance: number;
  maxHitChance: number;
  fallDamagePerLevel: number;
  critMultiplier: number;
}

export interface Ruleset {
  name: string;
  squadSize: number; // 4..8
  /** Class ids, length == squadSize; both players get the same squad. */
  squad: string[];
  constants: RulesetConstants;
  classes: Map<string, ClassDef>;
  weapons: Map<string, WeaponDef>;
  items: Map<string, ItemDef>;
}

export function buildRuleset(
  rulesetJson: {
    name: string;
    squadSize: number;
    squad: string[];
    constants: RulesetConstants;
  },
  classesJson: ClassDef[],
  weaponsJson: WeaponDef[],
  itemsJson: ItemDef[],
): Ruleset {
  const classes = new Map(classesJson.map((c) => [c.id, c]));
  const weapons = new Map(weaponsJson.map((w) => [w.id, w]));
  const items = new Map(itemsJson.map((i) => [i.id, i]));
  if (rulesetJson.squadSize < 4 || rulesetJson.squadSize > 8) {
    throw new Error(`squadSize must be 4..8, got ${rulesetJson.squadSize}`);
  }
  if (rulesetJson.squad.length !== rulesetJson.squadSize) {
    throw new Error(`squad list length ${rulesetJson.squad.length} != squadSize ${rulesetJson.squadSize}`);
  }
  for (const cid of rulesetJson.squad) {
    const cls = classes.get(cid);
    if (!cls) throw new Error(`unknown class in squad: ${cid}`);
    if (!weapons.has(cls.weapon)) throw new Error(`class ${cid}: unknown weapon ${cls.weapon}`);
    for (const it of cls.items) if (!items.has(it)) throw new Error(`class ${cid}: unknown item ${it}`);
  }
  return { ...rulesetJson, classes, weapons, items };
}
