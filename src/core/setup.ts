import { buildRuleset, Ruleset, ClassDef, WeaponDef, ItemDef, RulesetConstants } from './rules/ruleset';
import { loadMap, MapJson } from './map/loader';
import { createGame, GameState } from './state';
import { updateVision } from './fog/visibility';

import rulesetJson from '../../data/rulesets/default.json';
import classesJson from '../../data/classes.json';
import weaponsJson from '../../data/weapons.json';
import itemsJson from '../../data/items.json';
import depotJson from '../../data/maps/depot.json';
import crossfireJson from '../../data/maps/crossfire.json';

export const MAPS: Record<string, MapJson> = {
  depot: depotJson as unknown as MapJson,
  crossfire: crossfireJson as unknown as MapJson,
};

/** Squad composition by size; index 0..7. Both players always get the same squad. */
const SQUAD_ORDER = ['sniper', 'assault', 'ranger', 'grenadier', 'support', 'assault', 'ranger', 'sniper'];

export function defaultRuleset(squadSize?: number): Ruleset {
  const base = rulesetJson as { name: string; squadSize: number; squad: string[]; constants: RulesetConstants };
  const size = squadSize ?? base.squadSize;
  const json = size === base.squadSize ? base : { ...base, squadSize: size, squad: SQUAD_ORDER.slice(0, size) };
  return buildRuleset(json, classesJson as ClassDef[], weaponsJson as WeaponDef[], itemsJson as ItemDef[]);
}

export function newGame(mapId: string, seed: number, squadSize?: number): GameState {
  const mapJson = MAPS[mapId];
  if (!mapJson) throw new Error(`unknown map ${mapId}`);
  const loaded = loadMap(mapJson);
  const state = createGame(loaded, defaultRuleset(squadSize), seed);
  updateVision(state);
  return state;
}
