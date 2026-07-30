/**
 * Procedural synthesis primitives.
 *
 * Everything in this file is pure WebAudio node-graph construction — no samples,
 * no external assets. Each `layer` helper schedules a self-contained voice layer
 * into a destination node at an absolute context time and returns the time at
 * which it has fully decayed, so callers can compute a real voice lifetime.
 *
 * All helpers take `E` (the audio engine) purely to reach `E.ctx` and its cached
 * noise buffers / waveshaper curves, which keeps them usable against an
 * OfflineAudioContext for offline rendering and analysis.
 */

// --- small random helpers ---------------------------------------------------

export const rnd = (a = 0, b = 1) => a + Math.random() * (b - a)
export const rndi = (a, b) => Math.floor(a + Math.random() * (b - a + 1))
export const pick = (arr) => arr[(Math.random() * arr.length) | 0]
/** Random walk around 1.0 in semitone-ish terms — used to detune every shot. */
export const jitter = (amount = 0.06) => 1 + (Math.random() * 2 - 1) * amount

// --- buffer generation ------------------------------------------------------

/**
 * Coloured noise with a seamless wrap.
 *
 * We synthesise `len + fade` samples of a continuous stream, then fold the tail
 * back over the head with an equal-power crossfade. The result is that sample
 * [0] is drawn from the *continuation* of sample [len-1], so looping the buffer
 * is statistically indistinguishable from letting the generator keep running —
 * there is no seam, not even a low-frequency one, which is what kills naive
 * pink/brown noise loops.
 */
export function makeNoiseBuffer(ctx, kind = 'white', seconds = 4, channels = 1) {
  const sr = ctx.sampleRate
  const len = Math.max(1024, Math.floor(sr * seconds))
  const fade = Math.min(len >> 2, Math.floor(sr * 0.25))
  const buf = ctx.createBuffer(channels, len, sr)

  for (let ch = 0; ch < channels; ch++) {
    const gen = new Float32Array(len + fade)
    fillNoise(gen, kind)
    const out = buf.getChannelData(ch)
    for (let i = fade; i < len; i++) out[i] = gen[i]
    for (let i = 0; i < fade; i++) {
      const a = (i / fade) * Math.PI * 0.5
      out[i] = gen[i] * Math.sin(a) + gen[len + i] * Math.cos(a)
    }
    // strip DC so brown noise can't push a bus off-centre
    let dc = 0
    for (let i = 0; i < len; i++) dc += out[i]
    dc /= len
    let peak = 1e-9
    for (let i = 0; i < len; i++) {
      out[i] -= dc
      const a = Math.abs(out[i])
      if (a > peak) peak = a
    }
    const norm = 0.92 / peak
    for (let i = 0; i < len; i++) out[i] *= norm
  }
  return buf
}

function fillNoise(out, kind) {
  const n = out.length
  if (kind === 'white') {
    for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1
    return
  }
  if (kind === 'brown') {
    let y = 0
    for (let i = 0; i < n; i++) {
      y = (y + 0.028 * (Math.random() * 2 - 1)) / 1.028
      out[i] = y * 12
    }
    return
  }
  // pink — Paul Kellet's economy filter, flat-ish -3dB/oct to 20 Hz
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.15
    b6 = w * 0.115926
  }
}

/**
 * Procedural impulse response.
 *
 * A real room IR is (a) a direct-ish onset, (b) a handful of loud discrete early
 * reflections off nearby surfaces, and (c) a diffuse exponentially decaying tail
 * whose high frequencies die considerably faster than its lows. Outdoor urban
 * space is mostly (b): sparse, hard slap-backs off building faces with a thin
 * diffuse wash. An alley/interior is mostly (c): dense, dark, long.
 *
 * The time-varying one-pole lowpass is what makes this not sound like a
 * synthetic "noise burst reverb" — air and material absorption is frequency
 * dependent, and modelling that is 90% of the realism.
 */
export function makeImpulseResponse(ctx, o = {}) {
  const {
    rt60 = 1.4,
    predelay = 0.008,
    dampStart = 9000,
    dampEnd = 900,
    dampTime = 0.45,
    hp = 110,
    buildup = 0.03,
    tailGain = 0.5,
    taps = [],
    width = 0.85,
  } = o
  const sr = ctx.sampleRate
  const dur = Math.max(0.15, rt60 * 1.05 + predelay)
  const len = Math.floor(sr * dur)
  const buf = ctx.createBuffer(2, len, sr)
  const pre = Math.floor(predelay * sr)
  const kDecay = 6.907755 / rt60 // -60 dB at rt60

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    let hpS = 0
    const kh = (2 * Math.PI * hp) / sr
    for (let i = pre; i < len; i++) {
      const tt = (i - pre) / sr
      const env = Math.exp(-tt * kDecay)
      const x = (Math.random() * 2 - 1) * env
      const fc = Math.max(dampEnd, dampStart * Math.exp(-tt / dampTime))
      const k = 1 - Math.exp((-2 * Math.PI * fc) / sr)
      lp += (x - lp) * k
      hpS += (lp - hpS) * kh
      const grow = tt < buildup ? tt / buildup : 1
      d[i] = (lp - hpS) * grow * tailGain
    }
    // discrete early reflections: building faces, ground bounce
    for (const t of taps) {
      const jitterT = t.t * (1 + (ch === 0 ? -1 : 1) * (1 - width) * 0.06)
      const idx = pre + Math.floor(jitterT * sr)
      if (idx < 1 || idx >= len - 64) continue
      const g = t.g * (ch === 0 ? 1 : t.w ?? 1)
      // each reflection is a short filtered burst, not a naked click
      const n = Math.max(2, Math.floor((t.spread ?? 0.0015) * sr))
      let s = 0
      for (let j = 0; j < n && idx + j < len; j++) {
        const e = Math.exp((-j / n) * 4)
        s += ((Math.random() * 2 - 1) * e - s) * 0.55
        d[idx + j] += s * g * (t.pol ?? 1)
      }
    }
  }

  // normalise deterministically so convolver loudness is predictable
  let peak = 1e-9
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i])
  }
  const g = 0.85 / peak
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] *= g
  }
  return buf
}

/** Soft-saturation transfer curve. Linear below `knee`, tanh above, bounded < 1. */
export function makeSoftClipCurve(knee = 0.7, n = 2048) {
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    c[i] = Math.sign(x) * y * 0.995
  }
  return c
}

/** Asymmetric drive curve for the "meat" layer of a gunshot. */
export function makeDriveCurve(drive = 4, n = 2048) {
  const c = new Float32Array(n)
  const k = drive
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    // asymmetric: positive half saturates harder -> even harmonics, more "body"
    const kk = x >= 0 ? k : k * 0.62
    c[i] = Math.tanh(x * kk) / Math.tanh(kk)
  }
  return c
}

// --- envelope helpers -------------------------------------------------------

/**
 * Percussive amplitude envelope. Exponential in both directions because that is
 * how real transients behave and how ears read them; a linear decay sounds
 * synthetic no matter how good the source is.
 */
export function ampEnv(param, t0, o = {}) {
  const peak = Math.max(o.peak ?? 1, 1e-6)
  const attack = o.attack ?? 0.0008
  const hold = o.hold ?? 0
  const decay = o.decay ?? 0.2
  const floor = peak * (o.floorRatio ?? 0.0008)
  param.cancelScheduledValues(t0)
  param.setValueAtTime(floor, t0)
  param.exponentialRampToValueAtTime(peak, t0 + attack)
  const dStart = t0 + attack + hold
  if (hold > 0) param.setValueAtTime(peak, dStart)
  param.exponentialRampToValueAtTime(floor, dStart + decay)
  param.setValueAtTime(0, dStart + decay + 0.002)
  return dStart + decay + 0.004
}

/** Exponential parameter sweep (pitch, filter cutoff). */
export function sweep(param, t0, from, to, time) {
  param.cancelScheduledValues(t0)
  param.setValueAtTime(Math.max(from, 1e-3), t0)
  param.exponentialRampToValueAtTime(Math.max(to, 1e-3), t0 + Math.max(time, 0.001))
  return t0 + time
}

// --- node builders ----------------------------------------------------------

export function noiseSource(E, o = {}) {
  const ctx = E.ctx
  const src = ctx.createBufferSource()
  src.buffer = E.noiseBuffer(o.kind || 'white')
  src.playbackRate.value = o.rate ?? 1
  if (o.loop) {
    src.loop = true
    src.loopStart = 0
    src.loopEnd = src.buffer.duration
  }
  return src
}

export function biquad(E, type, freq, q = 1, gainDb = 0) {
  const f = E.ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = Math.min(Math.max(freq, 10), E.ctx.sampleRate * 0.49)
  f.Q.value = q
  if (gainDb) f.gain.value = gainDb
  return f
}

export function gainNode(E, v = 1) {
  const g = E.ctx.createGain()
  g.gain.value = v
  return g
}

/** Chain an array of nodes head->tail and return [head, tail]. */
export function chain(nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
  return [nodes[0], nodes[nodes.length - 1]]
}

// --- layer generators -------------------------------------------------------

/**
 * Filtered noise burst. `filters` is a list of [type, freq, Q, gainDb] or
 * [type, [f0, f1], Q, gainDb] where a pair sweeps the cutoff exponentially.
 */
export function noiseBurst(E, dest, t0, o = {}) {
  const src = noiseSource(E, { kind: o.kind || 'white', rate: o.rate ?? jitter(0.12) })
  const nodes = [src]
  const sweeps = []
  for (const f of o.filters || []) {
    const [type, freq, q = 1, gdb = 0] = f
    const isSweep = Array.isArray(freq)
    const node = biquad(E, type, isSweep ? freq[0] : freq, q, gdb)
    if (isSweep) sweeps.push([node.frequency, freq[0], freq[1]])
    nodes.push(node)
  }
  const g = gainNode(E, 0)
  nodes.push(g)
  chain(nodes)
  g.connect(dest)

  const decay = o.decay ?? 0.08
  const end = ampEnv(g.gain, t0, {
    peak: o.gain ?? 0.4,
    attack: o.attack ?? 0.0006,
    hold: o.hold ?? 0,
    decay,
  })
  const sweepTime = o.sweepTime ?? decay * 0.8
  for (const [param, a, b] of sweeps) sweep(param, t0, a, b, sweepTime)

  const off = o.offset ?? Math.random() * (src.buffer.duration - decay - 0.06)
  src.start(t0, Math.max(0, off))
  src.stop(end + 0.01)
  return end
}

/** Waveshaped noise through a resonant band — the "meat" of a weapon report. */
export function driveNoise(E, dest, t0, o = {}) {
  const ctx = E.ctx
  const src = noiseSource(E, { kind: o.kind || 'white', rate: o.rate ?? jitter(0.15) })
  const pre = gainNode(E, o.drive ?? 2.5)
  const shaper = ctx.createWaveShaper()
  shaper.curve = E.driveCurve(o.curve ?? 4)
  shaper.oversample = '4x'
  const bp = biquad(E, o.filterType || 'bandpass', o.f0 ?? 1400, o.q ?? 1.1)
  const post = gainNode(E, 0)
  chain([src, pre, shaper, bp, post])
  post.connect(dest)

  const decay = o.decay ?? 0.1
  const end = ampEnv(post.gain, t0, {
    peak: o.gain ?? 0.35,
    attack: o.attack ?? 0.0008,
    decay,
  })
  if (o.f1) sweep(bp.frequency, t0, o.f0 ?? 1400, o.f1, o.sweepTime ?? decay * 0.9)
  const off = Math.random() * (src.buffer.duration - decay - 0.06)
  src.start(t0, Math.max(0, off))
  src.stop(end + 0.01)
  return end
}

/** Pitched body layer: oscillator with an exponential pitch drop. */
export function toneBurst(E, dest, t0, o = {}) {
  const osc = E.ctx.createOscillator()
  osc.type = o.type || 'sine'
  const g = gainNode(E, 0)
  let tail = g
  if (o.lp) {
    const f = biquad(E, 'lowpass', o.lp, o.lpQ ?? 0.7)
    g.connect(f)
    tail = f
  }
  osc.connect(g)
  tail.connect(dest)

  const decay = o.decay ?? 0.15
  const end = ampEnv(g.gain, t0, {
    peak: o.gain ?? 0.5,
    attack: o.attack ?? 0.0012,
    hold: o.hold ?? 0,
    decay,
  })
  const f0 = o.f0 ?? 120
  const f1 = o.f1 ?? f0
  osc.frequency.setValueAtTime(f0, t0)
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + (o.pitchTime ?? decay * 0.5))
  osc.start(t0)
  osc.stop(end + 0.01)
  return end
}

/**
 * Modal resonator bank — the correct way to synthesise struck solids.
 * Real metal/wood/glass rings at a set of inharmonic partials, each with its own
 * decay time (higher partials always die first). Feeding sine partials rather
 * than filtered noise gives clean, controllable pitch, and layering a short
 * noise transient on top supplies the strike itself.
 */
export function modal(E, dest, t0, o = {}) {
  const partials = o.partials || []
  const base = o.f0 ?? 1
  const spread = o.detune ?? 0.02
  let end = t0
  for (const p of partials) {
    const f = base * p.r * (1 + (Math.random() * 2 - 1) * spread)
    const e = toneBurst(E, dest, t0 + (p.delay ?? 0), {
      type: p.type || 'sine',
      f0: f,
      f1: p.bend ? f * p.bend : f,
      pitchTime: p.decay * 0.6,
      gain: (o.gain ?? 0.3) * p.g,
      attack: p.attack ?? 0.0006,
      decay: p.decay,
    })
    if (e > end) end = e
  }
  return end
}

/** High-Q band sweep: ricochets, whines, incoming-round zips. */
export function resonantSweep(E, dest, t0, o = {}) {
  const src = noiseSource(E, { kind: 'white', rate: jitter(0.1) })
  const bp1 = biquad(E, 'bandpass', o.f0 ?? 3000, o.q ?? 22)
  const bp2 = biquad(E, 'bandpass', o.f0 ?? 3000, (o.q ?? 22) * 0.7)
  const hp = biquad(E, 'highpass', 700, 0.7)
  const g = gainNode(E, 0)
  chain([src, bp1, bp2, hp, g])
  g.connect(dest)

  const dur = o.dur ?? 0.35
  const end = ampEnv(g.gain, t0, {
    peak: o.gain ?? 0.16,
    attack: o.attack ?? 0.004,
    hold: o.hold ?? 0.02,
    decay: dur,
  })
  const f0 = o.f0 ?? 3000
  const f1 = o.f1 ?? f0 * 0.45
  sweep(bp1.frequency, t0, f0, f1, dur * 0.95)
  sweep(bp2.frequency, t0, f0 * 1.008, f1 * 1.008, dur * 0.95)
  const off = Math.random() * (src.buffer.duration - dur - 0.1)
  src.start(t0, Math.max(0, off))
  src.stop(end + 0.01)
  return end
}

/**
 * Slap-back tap. Returns an input node: anything connected to it is echoed back
 * into `dest` once, filtered and delayed. Gunfire in a street is 40% this.
 */
export function slapTap(E, dest, { time = 0.06, gain = 0.2, lp = 2600, hpF = 180 }) {
  const ctx = E.ctx
  const input = gainNode(E, 1)
  const d = ctx.createDelay(1.0)
  d.delayTime.value = time
  const f = biquad(E, 'lowpass', lp, 0.6)
  const h = biquad(E, 'highpass', hpF, 0.6)
  const g = gainNode(E, gain)
  chain([input, d, f, h, g])
  g.connect(dest)
  return input
}

/** Feedback comb — hollow tube resonance (grenade launcher, pipes). */
export function combTube(E, dest, { freq = 230, feedback = 0.6, lp = 900, gain = 1 }) {
  const ctx = E.ctx
  const input = gainNode(E, gain)
  const d = ctx.createDelay(0.2)
  d.delayTime.value = Math.max(1 / freq, 0.004)
  const f = biquad(E, 'lowpass', lp, 0.8)
  const fb = gainNode(E, feedback)
  input.connect(d)
  d.connect(f)
  f.connect(fb)
  fb.connect(d)
  d.connect(dest)
  return input
}
