/**
 * Combat maths.
 *
 * The formula, exactly as ARCHITECTURE.md specifies it:
 *
 *   hit% = aim + rangeMod - targetDefense - coverBonus + flankBonus + heightBonus
 *          clamped to [1, 100]
 *
 * Contract with the UI: `previewShot()` returns a `modifiers` array whose values
 * SUM EXACTLY to `hitChance`. There is no hidden fudge anywhere in this file — if
 * a number moves the odds, it is in that array with a label. Clamping is itself
 * a labelled modifier so the sum still holds at the rails.
 *
 * `flankBonus` is 0 aim by design: flanking's effect is that the cover term
 * becomes 0 and crit gets +30. The term is kept as a named constant so the code
 * matches the written formula one-for-one.
 */

import { rangeModifier } from './units.js'

export const FLANK_AIM_BONUS = 0
export const FLANK_CRIT_BONUS = 30
export const HEIGHT_AIM_BONUS = 20
export const REACTION_AIM_PENALTY = -15
export const GRAZE_MULT = 0.5
export const CRIT_MULT = 1.5
export const GRENADE_ARMOR_MULT = 2 // grenades are poor against armour

export function createCombat({ world, state, los, cover, rng }) {
  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Full, player-readable shot breakdown.
   *
   * @param {object} attacker
   * @param {object} target
   * @param {object} [opts]
   * @param {{x:number,z:number,elevation?:number}} [opts.from]  hypothetical firing position
   * @param {number} [opts.aimBonus]     extra aim from an ability (labelled)
   * @param {string} [opts.aimLabel]
   * @param {number} [opts.critBonus]
   * @param {boolean} [opts.reaction]    overwatch reaction shot (-15 aim)
   */
  function previewShot(attacker, target, opts = {}) {
    const from = opts.from
      ? { ...opts.from, elevation: opts.from.elevation ?? (world.getTile(opts.from.x, opts.from.z)?.elevation || 0) }
      : attacker
    const shooter = { ...attacker, x: from.x, z: from.z, elevation: from.elevation }
    const w = attacker.weapon
    const dist = Math.hypot(shooter.x - target.x, shooter.z - target.z)

    const cov = cover.coverBetween(shooter, target)
    const height = cover.hasHeightAdvantage(shooter, target)
    const rangeMod = rangeModifier(w.curve, dist)

    const modifiers = []
    const add = (label, value, always = false) => {
      if (value !== 0 || always) modifiers.push({ label, value })
    }

    add('Base Aim', attacker.aim, true)
    add(dist <= 4 ? 'Close Range' : dist >= 12 ? 'Long Range' : 'Optimal Range', rangeMod)
    add('Target Defense', -(target.defense | 0))

    if (cov.value > 0) {
      const base = cov.value === 2 ? 'Full Cover' : 'Half Cover'
      add(cov.hunkered ? `${base} (Hunkered)` : base, -cov.penalty)
    } else {
      // value 0 => flanked. Shown with its literal aim contribution so the sum
      // is auditable; the real payoff is on the crit line.
      add('Flanked — Cover Ignored', FLANK_AIM_BONUS, true)
    }

    if (height) add('Height Advantage', HEIGHT_AIM_BONUS)
    if (opts.reaction) add('Reaction Shot', REACTION_AIM_PENALTY)
    if (opts.aimBonus) add(opts.aimLabel || 'Ability', opts.aimBonus)

    for (const st of attacker.statuses || []) {
      if (st.aim) add(st.label || st.type, st.aim)
    }

    let raw = 0
    for (const m of modifiers) raw += m.value
    let hitChance = Math.max(1, Math.min(100, raw))
    if (hitChance !== raw) {
      modifiers.push({ label: hitChance === 100 ? 'Capped at 100' : 'Floored at 1', value: hitChance - raw })
    }

    // --- crit ---------------------------------------------------------------
    const critModifiers = []
    const addCrit = (label, value, always = false) => {
      if (value !== 0 || always) critModifiers.push({ label, value })
    }
    addCrit('Base Crit', attacker.crit | 0, true)
    addCrit('Weapon', w.critBonus | 0)
    if (cov.flanked) addCrit('Flanked', FLANK_CRIT_BONUS)
    if (opts.critBonus) addCrit(opts.critLabel || 'Ability', opts.critBonus)
    let rawCrit = 0
    for (const m of critModifiers) rawCrit += m.value
    let critChance = Math.max(0, Math.min(100, rawCrit))
    if (critChance !== rawCrit) {
      critModifiers.push({ label: 'Clamped', value: critChance - rawCrit })
    }

    // --- dodge --------------------------------------------------------------
    const dodgeChance = Math.max(0, Math.min(100, target.dodge | 0))

    // --- damage -------------------------------------------------------------
    const armor = Math.max(0, target.armor | 0)
    const dmgMin = damageAfter(w.dmgMin, { armor })
    const dmgMax = damageAfter(w.dmgMax, { armor })
    const critMin = damageAfter(w.dmgMin, { armor, crit: true })
    const critMax = damageAfter(w.dmgMax, { armor, crit: true })
    const grazeMin = damageAfter(w.dmgMin, { armor, graze: true })
    const grazeMax = damageAfter(w.dmgMax, { armor, graze: true })

    const inRange = dist <= (w.range ?? 20)
    const sight = los.hasLOS(shooter, target)
    const ammo = (w.ammo | 0) > 0

    return {
      shooterId: attacker.id,
      targetId: target.id,
      distance: Math.round(dist * 100) / 100,
      hitChance,
      rawHitChance: raw,
      critChance,
      dodgeChance,
      dmgMin, dmgMax,
      critDmgMin: critMin, critDmgMax: critMax,
      grazeDmgMin: grazeMin, grazeDmgMax: grazeMax,
      rawDmgMin: w.dmgMin, rawDmgMax: w.dmgMax,
      armor,
      shots: w.shots || 1,
      coverValue: cov.value,
      coverDir: cov.coverDir,
      flanked: cov.flanked,
      hunkered: cov.hunkered,
      height,
      rangeMod,
      hasLOS: sight,
      inRange,
      hasAmmo: ammo,
      canFire: sight && inRange && ammo && target.alive,
      modifiers,
      critModifiers,
    }
  }

  /**
   * Damage pipeline: base roll -> crit/graze -> armour -> min 1.
   * `armorMult` lets grenades be punished by armour (x2) per the design brief.
   */
  function damageAfter(base, { crit = false, graze = false, armor = 0, armorMult = 1 } = {}) {
    let d = base
    if (crit) d = Math.ceil(d * CRIT_MULT)
    else if (graze) d = Math.max(1, Math.round(d * GRAZE_MULT))
    d = d - armor * armorMult
    return Math.max(1, d)
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Roll a shot. Pure with respect to the RNG stream — no state mutation here
   * except weapon ammo; damage application lives in rules.js so every damage
   * source funnels through one place.
   */
  function resolveShot(attacker, target, opts = {}) {
    const preview = previewShot(attacker, target, opts)
    const shots = Math.max(1, preview.shots)
    const results = []
    let totalDmg = 0
    let anyHit = false
    let anyCrit = false
    let anyGraze = false

    for (let i = 0; i < shots; i++) {
      const hitRoll = rng.d100()
      const hit = hitRoll <= preview.hitChance
      if (!hit) {
        results.push({ hit: false, crit: false, graze: false, dmg: 0, hitRoll })
        continue
      }
      anyHit = true
      const critRoll = rng.d100()
      const crit = critRoll <= preview.critChance
      let graze = false
      let dodgeRoll = null
      if (!crit && preview.dodgeChance > 0) {
        dodgeRoll = rng.d100()
        graze = dodgeRoll <= preview.dodgeChance
      }
      const base = rng.range(attacker.weapon.dmgMin, attacker.weapon.dmgMax)
      const dmg = damageAfter(base, { crit, graze, armor: Math.max(0, target.armor | 0) })
      if (crit) anyCrit = true
      if (graze) anyGraze = true
      totalDmg += dmg
      results.push({ hit: true, crit, graze, dmg, base, hitRoll, critRoll, dodgeRoll })
    }

    return {
      preview,
      shots,
      hit: anyHit,
      crit: anyCrit,
      graze: anyGraze,
      dmg: totalDmg,
      results,
    }
  }

  /** Grenades never miss. Armour bites twice as hard. */
  function resolveExplosion(damage, target, { armorMult = GRENADE_ARMOR_MULT } = {}) {
    const dmg = damageAfter(damage, { armor: Math.max(0, target.armor | 0), armorMult })
    return { hit: true, crit: false, graze: false, dmg }
  }

  return {
    previewShot, resolveShot, resolveExplosion, damageAfter,
    FLANK_AIM_BONUS, FLANK_CRIT_BONUS, HEIGHT_AIM_BONUS, REACTION_AIM_PENALTY,
    dispose() {},
  }
}
