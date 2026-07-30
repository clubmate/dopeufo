/**
 * Seeded, reproducible RNG.
 *
 * The whole tactical sim must be replayable: same seed + same inputs => same
 * match. Nothing in game/ may call Math.random().
 *
 * mulberry32 — tiny, fast, good enough distribution for d100 rolls, and its
 * state is a single uint32 so a save file / test fixture can carry it.
 */

/** Hash an arbitrary string/number into a uint32 seed. */
export function hashSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input >>> 0
  const s = String(input ?? '')
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function createRNG(seed = 0xdec0de) {
  let state = hashSeed(seed)
  let calls = 0

  const rng = {
    /** Float in [0,1). */
    next() {
      calls++
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },

    /** Integer in [0, n). */
    int(n) {
      return Math.floor(rng.next() * n)
    },

    /** Integer in [min, max] inclusive. */
    range(min, max) {
      if (max <= min) return min
      return min + Math.floor(rng.next() * (max - min + 1))
    },

    /** Classic d100: returns 1..100. */
    d100() {
      return 1 + Math.floor(rng.next() * 100)
    },

    /**
     * Percentage roll. `chance(75)` succeeds 75% of the time.
     * Returns { success, roll } so combat logs can show the die.
     */
    roll(pct) {
      const r = rng.d100()
      return { success: r <= pct, roll: r }
    },

    chance(pct) {
      return rng.roll(pct).success
    },

    pick(arr) {
      return arr[Math.floor(rng.next() * arr.length)]
    },

    shuffle(arr) {
      const a = arr.slice()
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
      }
      return a
    },

    /** Independent stream derived from this one — keeps subsystems from
     *  desynchronising each other's roll order. */
    fork(label = '') {
      return createRNG(hashSeed(`${state}:${label}`))
    },

    getState() {
      return { state, calls }
    },

    setState(s) {
      state = s.state >>> 0
      calls = s.calls | 0
    },

    reseed(s) {
      state = hashSeed(s)
      calls = 0
    },
  }

  return rng
}
