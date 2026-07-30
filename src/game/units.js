/**
 * Unit factory + stat blocks. DATA ONLY — nothing here knows about three.js,
 * meshes or the scene graph. `src/units/` owns rendering; it receives the plain
 * objects produced here via `ctx.units.spawn(unitData)`.
 *
 * Shape is the `Unit` record from ARCHITECTURE.md, verbatim.
 */

export const TEAM_NAMES = ['ADVENT', 'XCOM']

/**
 * Weapon range curves.
 *
 * Each curve is a list of [tileDistance, aimModifier] keypoints, linearly
 * interpolated and clamped at the ends. This is the `rangeMod` term of the hit
 * formula and is the main reason weapon choice matters:
 *
 *   rifle    — flat-ish, best at mid range (the generalist)
 *   sniper   — heavily punished up close, rewarded at long range
 *   shotgun  — brutal in your face, useless past ~10 tiles
 *   cannon   — wide effective band, mild falloff
 *   pistol   — short, forgiving, low damage
 */
export const RANGE_CURVES = {
  rifle: [
    [0, -6], [2, 0], [4, 6], [7, 10], [10, 4], [14, -6], [18, -16], [24, -26],
  ],
  sniper: [
    [0, -30], [2, -24], [4, -14], [7, -2], [10, 6], [14, 10], [20, 10], [30, 4],
  ],
  shotgun: [
    [0, 26], [2, 20], [4, 10], [6, 0], [9, -14], [12, -30], [16, -45],
  ],
  cannon: [
    [0, 2], [3, 6], [8, 6], [12, 0], [16, -10], [22, -24],
  ],
  pistol: [
    [0, 10], [4, 4], [8, -4], [12, -16], [16, -30],
  ],
}

/** Interpolate a curve at distance d (tiles). Returns an integer aim modifier. */
export function rangeModifier(curveName, d) {
  const c = RANGE_CURVES[curveName] || RANGE_CURVES.rifle
  if (d <= c[0][0]) return c[0][1]
  const last = c[c.length - 1]
  if (d >= last[0]) return last[1]
  for (let i = 0; i < c.length - 1; i++) {
    const [d0, m0] = c[i]
    const [d1, m1] = c[i + 1]
    if (d >= d0 && d <= d1) {
      const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0)
      return Math.round(m0 + (m1 - m0) * t)
    }
  }
  return 0
}

export const WEAPONS = {
  rifle: {
    name: 'Mag Rifle', curve: 'rifle',
    dmgMin: 4, dmgMax: 6, critBonus: 10, range: 22,
    ammo: 4, ammoMax: 4, spread: 0.02, shots: 1,
  },
  sniper: {
    name: 'Gauss Sniper', curve: 'sniper',
    dmgMin: 5, dmgMax: 8, critBonus: 20, range: 30,
    ammo: 3, ammoMax: 3, spread: 0.008, shots: 1,
  },
  shotgun: {
    name: 'Shard Shotgun', curve: 'shotgun',
    dmgMin: 5, dmgMax: 7, critBonus: 15, range: 16,
    ammo: 4, ammoMax: 4, spread: 0.05, shots: 1,
  },
  cannon: {
    name: 'Mag Cannon', curve: 'cannon',
    dmgMin: 5, dmgMax: 7, critBonus: 0, range: 22,
    ammo: 3, ammoMax: 3, spread: 0.04, shots: 1,
  },
  pistol: {
    name: 'Mag Pistol', curve: 'pistol',
    dmgMin: 2, dmgMax: 4, critBonus: 10, range: 16,
    ammo: 6, ammoMax: 6, spread: 0.03, shots: 1,
  },
}

/**
 * Classes. `signature` is the class-unique ability id resolved in abilities.js.
 * Stats are XCOM-2-ish: aim 65-80, defense 0 (cover does the work), mobility in
 * tiles per single move action.
 *
 * MOBILITY IS TUNED TO MAP SIZE, not copied from XCOM. XCOM's ~12-15 mobility
 * sits on maps 60-80 tiles across; this board is 24x24 with 458 walkable tiles.
 * At the original 7-9, a 2-AP dash reached 35-48% of the walkable map *from a
 * corner deploy* and substantially more from midfield — so any unit could
 * threaten almost anywhere and choosing where to stand stopped mattering.
 * Halving it restores the thing that makes cover-based tactics work: you commit
 * to an approach lane and you live with it. Measured after the change:
 * blue ~5-9% of the map, blue+dash ~17-24%.
 */
export const CLASSES = {
  Ranger: {
    // The flanker — keeps the longest legs on purpose; closing distance is its job.
    className: 'Ranger', weapon: 'shotgun', signature: 'slash',
    hpMax: 12, armor: 0, aim: 70, defense: 0, mobility: 6, crit: 15, dodge: 15, will: 45,
    abilities: ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade', 'slash'],
  },
  Sharpshooter: {
    // Slowest: wants to pick a firing position early and hold it.
    className: 'Sharpshooter', weapon: 'sniper', signature: 'aimedShot',
    hpMax: 10, armor: 0, aim: 76, defense: 0, mobility: 4, crit: 20, dodge: 5, will: 45,
    abilities: ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade', 'aimedShot'],
  },
  Grenadier: {
    className: 'Grenadier', weapon: 'cannon', signature: 'demolish',
    hpMax: 14, armor: 1, aim: 65, defense: 0, mobility: 4, crit: 5, dodge: 5, will: 50,
    abilities: ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade', 'demolish'],
  },
  Specialist: {
    className: 'Specialist', weapon: 'rifle', signature: 'heal',
    hpMax: 11, armor: 0, aim: 70, defense: 0, mobility: 5, crit: 10, dodge: 10, will: 55,
    abilities: ['move', 'fire', 'overwatch', 'hunker', 'reload', 'grenade', 'heal'],
  },
}

const NAMES = [
  ['Vasquez', 'Okonkwo', 'Lindqvist', 'Ramos'],
  ['Novak', 'Haddad', 'Petrenko', 'Byrne'],
]

let _idCounter = 0
export function resetUnitIds() { _idCounter = 0 }

export const AP_MAX = 2

/**
 * Build a Unit record. Everything the renderer, UI and rules read lives here;
 * there are no hidden fields elsewhere.
 */
export function createUnit({
  id, team = 0, className = 'Ranger', name,
  x = 0, z = 0, elevation = 0, facing = 0,
  grenades = 1, overrides = {},
} = {}) {
  const cls = CLASSES[className] || CLASSES.Ranger
  const w = WEAPONS[cls.weapon]

  const unit = {
    id: id || `u_${_idCounter++}`,
    team,
    name: name || NAMES[team % 2][(_idCounter + team) % 4],
    className: cls.className,

    x, z, elevation, facing,

    hp: cls.hpMax,
    hpMax: cls.hpMax,
    armor: cls.armor,

    aim: cls.aim,
    defense: cls.defense,
    mobility: cls.mobility,
    crit: cls.crit,
    dodge: cls.dodge,
    will: cls.will,

    ap: AP_MAX,
    apMax: AP_MAX,

    weapon: { ...w },

    abilities: cls.abilities.slice(),
    statuses: [],

    alive: true,
    overwatch: false,
    hunkered: false,
    flanked: false,

    // --- rules bookkeeping (not in the contract table, additive & harmless) ---
    grenades,
    signature: cls.signature,
    signatureUsed: false,
    movedThisTurn: false,
    turnEnded: false,
    eyeHeight: 1.6,
    comHeight: 0.9,
    sightRange: 18,
    kills: 0,
  }

  Object.assign(unit, overrides)
  return unit
}

/** Default 4-soldier squad composition per team. */
export const DEFAULT_SQUAD = ['Ranger', 'Sharpshooter', 'Grenadier', 'Specialist']

export function createSquad(team, tiles, comp = DEFAULT_SQUAD) {
  const out = []
  for (let i = 0; i < comp.length; i++) {
    const t = tiles[i] || tiles[tiles.length - 1] || { x: 0, z: 0, elevation: 0 }
    out.push(
      createUnit({
        team,
        className: comp[i],
        x: t.x, z: t.z, elevation: t.elevation || 0,
        // teams face each other: team 0 looks +Z, team 1 looks -Z
        facing: team === 0 ? 0 : Math.PI,
      })
    )
  }
  return out
}
