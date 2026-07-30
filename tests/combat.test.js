import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, makeSim, place } from './helpers.mjs'
import { createUnit, rangeModifier } from '../src/game/units.js'
import { createRNG } from '../src/game/rng.js'
import { FLANK_CRIT_BONUS, HEIGHT_AIM_BONUS, REACTION_AIM_PENALTY } from '../src/game/combat.js'

const sumOf = (mods) => mods.reduce((a, m) => a + m.value, 0)

function duel({ cover = 0, dist = 6 } = {}) {
  const w = makeWorld(24, 24)
  if (cover) w.prop(6, 6 - 1, cover) // cover on the target's north side
  const sim = makeSim(w)
  const target = place(sim, createUnit({ team: 1, className: 'Ranger' }), 6, 6)
  const attacker = place(sim, createUnit({ team: 0, className: 'Specialist' }), 6, 6 - dist)
  return { sim, attacker, target }
}

test('modifiers sum EXACTLY to the displayed hit chance in every configuration', () => {
  let cases = 0
  for (const coverValue of [0, 1, 2]) {
    for (const hunkered of [false, true]) {
      for (const dist of [1, 3, 6, 10, 15]) {
        for (const defense of [0, 10, 25]) {
          for (const aim of [5, 45, 70, 95, 130]) {
            for (const height of [0, 1]) {
              for (const reaction of [false, true]) {
                const { sim, attacker, target } = duel({ cover: coverValue, dist })
                attacker.aim = aim
                attacker.elevation = height
                target.defense = defense
                target.hunkered = hunkered
                const p = sim.combat.previewShot(attacker, target, { reaction })
                assert.equal(
                  sumOf(p.modifiers), p.hitChance,
                  `mods ${JSON.stringify(p.modifiers)} != ${p.hitChance}`
                )
                assert.ok(p.hitChance >= 1 && p.hitChance <= 100, 'clamped to [1,100]')
                cases++
              }
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 3 * 2 * 5 * 3 * 5 * 2 * 2)
})

test('crit modifiers also sum exactly', () => {
  for (const coverValue of [0, 2]) {
    const { sim, attacker, target } = duel({ cover: coverValue })
    const p = sim.combat.previewShot(attacker, target, { critBonus: 25, critLabel: 'Aimed Shot' })
    assert.equal(sumOf(p.critModifiers), p.critChance)
  }
})

test('the hit formula reads exactly as ARCHITECTURE.md specifies', () => {
  const { sim, attacker, target } = duel({ cover: 2, dist: 6 })
  attacker.aim = 70
  target.defense = 10
  const p = sim.combat.previewShot(attacker, target)
  const expected = 70 + p.rangeMod - 10 - 40 + 0 + 0
  assert.equal(p.hitChance, Math.max(1, Math.min(100, expected)))
  assert.equal(p.coverValue, 2)
  assert.equal(p.flanked, false)
})

test('cover subtracts 20 / 40, hunkering doubles it', () => {
  const open = duel({ cover: 0 })
  const half = duel({ cover: 1 })
  const full = duel({ cover: 2 })
  // pick an aim that keeps every variant inside [1,100] so no clamp interferes
  for (const s of [open, half, full]) s.attacker.aim = 85
  const base = open.sim.combat.previewShot(open.attacker, open.target).hitChance
  assert.ok(base - 80 >= 1 && base <= 100, 'test stays off the clamp rails')
  assert.equal(half.sim.combat.previewShot(half.attacker, half.target).hitChance, base - 20)
  assert.equal(full.sim.combat.previewShot(full.attacker, full.target).hitChance, base - 40)
  full.target.hunkered = true
  assert.equal(full.sim.combat.previewShot(full.attacker, full.target).hitChance, base - 80)
})

test('height advantage is +20 aim', () => {
  const a = duel({ cover: 0 })
  const flat = a.sim.combat.previewShot(a.attacker, a.target).hitChance
  a.attacker.elevation = 1
  const high = a.sim.combat.previewShot(a.attacker, a.target)
  assert.equal(high.hitChance, flat + HEIGHT_AIM_BONUS)
  assert.ok(high.modifiers.some((m) => m.label === 'Height Advantage' && m.value === 20))
})

test('flanking zeroes cover and adds +30 crit', () => {
  const { sim, attacker, target } = duel({ cover: 2 })
  const front = sim.combat.previewShot(attacker, target)
  attacker.x = 12; attacker.z = 6 // perpendicular => flank
  const flank = sim.combat.previewShot(attacker, target)
  assert.equal(front.flanked, false)
  assert.equal(flank.flanked, true)
  assert.equal(flank.coverValue, 0)
  assert.equal(flank.critChance - front.critChance, FLANK_CRIT_BONUS)
  assert.ok(flank.modifiers.some((m) => m.label === 'Flanked — Cover Ignored'))
})

test('a reaction shot costs 15 aim', () => {
  const { sim, attacker, target } = duel({ cover: 0 })
  const normal = sim.combat.previewShot(attacker, target).hitChance
  const reaction = sim.combat.previewShot(attacker, target, { reaction: true })
  assert.equal(reaction.hitChance, normal + REACTION_AIM_PENALTY)
  assert.ok(reaction.modifiers.some((m) => m.label === 'Reaction Shot' && m.value === -15))
})

test('clamping is itself a labelled modifier so the sum still holds', () => {
  const hi = duel({ cover: 0 })
  hi.attacker.aim = 200
  const p = hi.sim.combat.previewShot(hi.attacker, hi.target)
  assert.equal(p.hitChance, 100)
  assert.ok(p.modifiers.some((m) => m.label === 'Capped at 100'))
  assert.equal(sumOf(p.modifiers), 100)

  const lo = duel({ cover: 2 })
  lo.attacker.aim = 1
  lo.target.defense = 50
  lo.target.hunkered = true
  const q = lo.sim.combat.previewShot(lo.attacker, lo.target)
  assert.equal(q.hitChance, 1)
  assert.ok(q.modifiers.some((m) => m.label === 'Floored at 1'))
  assert.equal(sumOf(q.modifiers), 1)
})

test('weapon range curves have the intended shape', () => {
  assert.ok(rangeModifier('sniper', 1) < rangeModifier('sniper', 12), 'snipers hate close range')
  assert.ok(rangeModifier('shotgun', 1) > rangeModifier('shotgun', 12), 'shotguns love close range')
  assert.ok(rangeModifier('rifle', 7) > rangeModifier('rifle', 1), 'rifles favour mid range')
  assert.ok(rangeModifier('rifle', 7) > rangeModifier('rifle', 20))
  assert.equal(rangeModifier('sniper', 0), -30)
  assert.equal(rangeModifier('shotgun', 0), 26)
  assert.equal(rangeModifier('rifle', 100), -26, 'clamps at the far end of the curve')
})

test('damage pipeline: crit +50% rounded up, graze -50%, armor flat with a floor of 1', () => {
  const { sim } = duel()
  const d = sim.combat.damageAfter
  assert.equal(d(6, {}), 6)
  assert.equal(d(5, { crit: true }), 8, 'ceil(5 * 1.5)')
  assert.equal(d(6, { crit: true }), 9)
  assert.equal(d(6, { graze: true }), 3)
  assert.equal(d(5, { graze: true }), 3, 'round(2.5)')
  assert.equal(d(6, { armor: 2 }), 4)
  assert.equal(d(6, { crit: true, armor: 2 }), 7)
  assert.equal(d(6, { graze: true, armor: 2 }), 1)
  assert.equal(d(6, { armor: 99 }), 1, 'always at least 1 through armor')
  assert.equal(d(4, { armor: 2, armorMult: 2 }), 1, 'grenades are punished by armor')
})

test('resolveShot honours the rolled hit chance', () => {
  const { sim, attacker, target } = duel({ cover: 0 })
  attacker.aim = 200 // guaranteed hit after clamping
  target.dodge = 0
  attacker.crit = 0
  attacker.weapon.critBonus = 0
  for (let i = 0; i < 25; i++) {
    const r = sim.combat.resolveShot(attacker, target)
    assert.equal(r.hit, true)
    assert.ok(r.dmg >= 1)
  }
  attacker.aim = -500
  const miss = sim.combat.resolveShot(attacker, target)
  assert.ok(miss.hit === false || miss.results[0].hitRoll === 1, 'only a natural 1 can land')
})

test('a dodged hit becomes a graze for half damage', () => {
  const { sim, attacker, target } = duel({ cover: 0 })
  attacker.aim = 200
  attacker.crit = 0
  attacker.weapon.critBonus = 0
  target.dodge = 100
  target.armor = 0
  const r = sim.combat.resolveShot(attacker, target)
  assert.equal(r.hit, true)
  assert.equal(r.graze, true)
  assert.ok(r.dmg <= Math.round(attacker.weapon.dmgMax / 2))
})

test('the same seed replays identically; a different seed diverges', () => {
  const roll = (seed) => {
    const w = makeWorld(24, 24)
    const sim = makeSim(w, { seed })
    const t = place(sim, createUnit({ team: 1, className: 'Ranger' }), 6, 6)
    const a = place(sim, createUnit({ team: 0, className: 'Sharpshooter' }), 6, 1)
    a.aim = 65
    return Array.from({ length: 40 }, () => {
      const r = sim.combat.resolveShot(a, t)
      return `${r.hit}:${r.crit}:${r.dmg}`
    }).join('|')
  }
  assert.equal(roll('alpha'), roll('alpha'))
  assert.notEqual(roll('alpha'), roll('beta'))
})

test('the RNG produces a flat d100 distribution', () => {
  const rng = createRNG('distribution')
  const buckets = new Array(10).fill(0)
  const N = 100000
  for (let i = 0; i < N; i++) {
    const r = rng.d100()
    assert.ok(r >= 1 && r <= 100)
    buckets[Math.floor((r - 1) / 10)]++
  }
  for (const b of buckets) assert.ok(Math.abs(b - N / 10) < N / 10 * 0.06, `bucket skew ${b}`)
})

test('grenades never miss but armour bites twice', () => {
  const { sim, target } = duel()
  target.armor = 2
  const r = sim.combat.resolveExplosion(6, target)
  assert.equal(r.hit, true)
  assert.equal(r.dmg, 2, '6 - 2*2')
  target.armor = 0
  assert.equal(sim.combat.resolveExplosion(6, target).dmg, 6)
})

test('previewShot exposes everything the UI needs', () => {
  const { sim, attacker, target } = duel({ cover: 1 })
  const p = sim.combat.previewShot(attacker, target)
  for (const field of ['hitChance', 'critChance', 'dodgeChance', 'dmgMin', 'dmgMax', 'modifiers']) {
    assert.ok(p[field] !== undefined, `missing ${field}`)
  }
  assert.ok(Array.isArray(p.modifiers))
  assert.ok(p.modifiers.every((m) => typeof m.label === 'string' && Number.isInteger(m.value)))
  assert.ok(p.dmgMin <= p.dmgMax)
  assert.equal(p.canFire, true)
})
