/**
 * Procedural tactical score.
 *
 * Not a loop and not a track — a small generative system:
 *
 *   • a continuous low drone (root + fifth, three detuned saw/triangle voices)
 *     through a lowpass that opens with intensity;
 *   • a sparse pulse sequenced on a lookahead clock, whose density, tempo and
 *     accent pattern are functions of intensity;
 *   • occasional dissonant swells drawn from a D phrygian set — minor 2nds and
 *     tritones only, because that interval is the entire emotional payload of
 *     this genre;
 *   • a sub "heart" that only appears above ~0.6 intensity.
 *
 * Intensity is driven by the game: planning is calm, aiming/exposure is tense,
 * a kill spikes it. Everything cross-fades over seconds, never cuts.
 */

import { biquad, gainNode, chain, ampEnv, rnd, pick } from './synth.js'

const ROOT = 36.708 // D1
// D phrygian degrees as ratios from the root — the b2 is the whole point
const SCALE = [1, 1.0595, 1.1892, 1.3348, 1.4983, 1.5874, 1.7818]

export function createMusic(E) {
  let nodes = null
  let running = false
  let intensity = 0.2
  let target = 0.2
  let clock = 0        // next beat time
  let beat = 0
  let nextSwell = 0

  // Realtime keeps a short window so intensity changes take effect quickly;
  // an offline render has no "later", so schedule the whole thing up front.
  const LOOKAHEAD = E.offline ? 30 : 0.35

  function build() {
    const ctx = E.ctx
    const bus = E.busInput('music')
    if (!bus) return false

    const out = gainNode(E, 0)
    out.connect(bus)
    const send = gainNode(E, 0.3)
    out.connect(send)
    const rev = E.reverbInput('indoor')
    if (rev) send.connect(rev)

    const n = { out, send, osc: [], lfo: [] }

    // --- drone -------------------------------------------------------------
    const droneLp = biquad(E, 'lowpass', 220, 3.2)
    const droneHp = biquad(E, 'highpass', 30, 0.7)
    const droneGain = gainNode(E, 0.42)
    chain([droneLp, droneHp, droneGain])
    droneGain.connect(out)

    for (const [ratio, type, g, det] of [
      [1, 'sawtooth', 0.5, -7],
      [1, 'triangle', 0.42, 6],
      [1.4983, 'sawtooth', 0.22, -3],   // fifth
      [2, 'triangle', 0.14, 11],
    ]) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = ROOT * ratio
      osc.detune.value = det
      const g2 = gainNode(E, g)
      osc.connect(g2)
      g2.connect(droneLp)
      osc.start(0)
      n.osc.push(osc)
      // slow drift keeps the drone from sounding like a held synth pad
      const dl = ctx.createOscillator()
      dl.type = 'sine'
      dl.frequency.value = 0.03 + Math.random() * 0.05
      const dg = gainNode(E, 4 + Math.random() * 5)
      dl.connect(dg)
      dg.connect(osc.detune)
      dl.start(0)
      n.lfo.push(dl)
    }
    // filter breathes
    const fl = ctx.createOscillator()
    fl.type = 'sine'
    fl.frequency.value = 0.023
    const fg = gainNode(E, 55)
    fl.connect(fg)
    fg.connect(droneLp.frequency)
    fl.start(0)
    n.lfo.push(fl)
    n.droneLp = droneLp
    n.droneGain = droneGain

    // --- tension layer: a high detuned pair, gated in by intensity ---------
    const tenseLp = biquad(E, 'lowpass', 2600, 1.1)
    const tenseGain = gainNode(E, 0)
    chain([tenseLp, tenseGain])
    tenseGain.connect(out)
    for (const [mul, det] of [[8, -9], [8, 12], [12, 4]]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = ROOT * mul * (mul === 12 ? 1.0595 : 1) // the b2 up top
      osc.detune.value = det
      const g = gainNode(E, mul === 12 ? 0.05 : 0.09)
      osc.connect(g)
      g.connect(tenseLp)
      osc.start(0)
      n.osc.push(osc)
    }
    const tl = ctx.createOscillator()
    tl.type = 'sine'
    tl.frequency.value = 0.071
    const tg = gainNode(E, 700)
    tl.connect(tg)
    tg.connect(tenseLp.frequency)
    tl.start(0)
    n.lfo.push(tl)
    n.tenseGain = tenseGain

    // --- pulse / swell destinations ---------------------------------------
    const pulseGain = gainNode(E, 0.9)
    pulseGain.connect(out)
    n.pulseGain = pulseGain

    const swellLp = biquad(E, 'lowpass', 1400, 1.2)
    const swellGain = gainNode(E, 0.6)
    chain([swellLp, swellGain])
    swellGain.connect(out)
    n.swellDest = swellLp
    n.swellGain = swellGain

    nodes = n
    return true
  }

  // --- sequenced events -----------------------------------------------------

  /** Dry ticking pulse — a filtered click over a short sub, no pitch content. */
  function pulseHit(t, accent) {
    const ctx = E.ctx
    const dest = nodes.pulseGain
    const src = ctx.createBufferSource()
    src.buffer = E.noiseBuffer('white')
    src.playbackRate.value = rnd(0.9, 1.1)
    const bp = biquad(E, 'bandpass', accent ? rnd(1500, 2100) : rnd(2600, 3600), accent ? 2.2 : 3.4)
    const hp = biquad(E, 'highpass', 700, 0.7)
    const g = gainNode(E, 0)
    chain([src, bp, hp, g])
    g.connect(dest)
    const peak = (accent ? 0.1 : 0.035) * (0.6 + intensity * 0.7)
    const end = ampEnv(g.gain, t, { peak, attack: 0.0008, decay: accent ? 0.05 : 0.022 })
    src.start(t, Math.random() * 2)
    src.stop(end + 0.02)

    if (accent) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(96, t)
      osc.frequency.exponentialRampToValueAtTime(41, t + 0.09)
      const og = gainNode(E, 0)
      osc.connect(og)
      og.connect(dest)
      const e2 = ampEnv(og.gain, t, { peak: 0.16 * (0.5 + intensity * 0.8), attack: 0.003, decay: 0.24 })
      osc.start(t)
      osc.stop(e2 + 0.02)
    }
  }

  /** Sub heartbeat — only present when things are bad. */
  function heart(t) {
    const ctx = E.ctx
    for (const d of [0, 0.19]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(58, t + d)
      osc.frequency.exponentialRampToValueAtTime(31, t + d + 0.2)
      const g = gainNode(E, 0)
      osc.connect(g)
      g.connect(nodes.pulseGain)
      const peak = (d === 0 ? 0.2 : 0.12) * (intensity - 0.55) * 2.2
      const end = ampEnv(g.gain, t + d, { peak: Math.max(peak, 0.001), attack: 0.008, decay: 0.32 })
      osc.start(t + d)
      osc.stop(end + 0.02)
    }
  }

  /** A slow dissonant cluster fading in and out under everything. */
  function swell(t) {
    const ctx = E.ctx
    const dur = rnd(3.5, 7)
    const oct = pick([4, 4, 8])
    const a = pick(SCALE)
    // pair it with something a semitone or a tritone away
    const b = a * pick([1.0595, 1.4142, 0.9439])
    for (const [ratio, amp] of [[a, 1], [b, 0.75]]) {
      const osc = ctx.createOscillator()
      osc.type = pick(['sawtooth', 'triangle'])
      const f = ROOT * oct * ratio
      osc.frequency.setValueAtTime(f, t)
      osc.frequency.linearRampToValueAtTime(f * rnd(0.996, 1.004), t + dur)
      osc.detune.value = rnd(-10, 10)
      const g = gainNode(E, 0.0001)
      osc.connect(g)
      g.connect(nodes.swellDest)
      const peak = 0.05 * amp * (0.35 + intensity * 0.9)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.45)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      g.gain.setValueAtTime(0, t + dur + 0.01)
      osc.start(t)
      osc.stop(t + dur + 0.05)
    }
  }

  // --- transport ------------------------------------------------------------

  function tempo() {
    return 58 + intensity * 34 // 58 -> 92 bpm
  }

  function schedule() {
    const now = E.ctx.currentTime
    if (clock < now) clock = now + 0.1
    while (clock < now + LOOKAHEAD) {
      const spb = 60 / tempo()
      const inBar = beat % 8
      const accent = inBar === 0 || (intensity > 0.45 && inBar === 4)
      // density: at rest only the downbeat; at full tension nearly every 8th
      const density = 0.06 + intensity * 0.62
      if (accent || Math.random() < density) {
        pulseHit(clock + rnd(-0.006, 0.006), accent)
      }
      if (intensity > 0.6 && inBar === 0) heart(clock)
      beat++
      clock += spb / 2 // 8th-note grid
    }

    if (now >= nextSwell) {
      swell(now + rnd(0, 0.5))
      nextSwell = now + rnd(9, 22) * (1.25 - intensity * 0.55)
    }
  }

  // --- api ------------------------------------------------------------------

  function start() {
    if (running || !E.live()) return
    if (!nodes && !build()) return
    running = true
    const t = E.ctx.currentTime
    nodes.out.gain.cancelScheduledValues(t)
    nodes.out.gain.setValueAtTime(Math.max(nodes.out.gain.value, 0.0001), t)
    nodes.out.gain.linearRampToValueAtTime(0.45, t + 5)
    clock = t + 0.2
    nextSwell = t + rnd(6, 14)
  }

  function stop(fade = 2.5) {
    if (!running || !nodes) return
    running = false
    const t = E.ctx.currentTime
    nodes.out.gain.cancelScheduledValues(t)
    nodes.out.gain.setValueAtTime(nodes.out.gain.value, t)
    nodes.out.gain.linearRampToValueAtTime(0.0001, t + fade)
  }

  function setIntensity(v, glide = 4) {
    target = Math.max(0, Math.min(1, Number(v) || 0))
    if (!nodes || !E.live()) return
    // the audible consequences of intensity, all ramped
    E.ramp(nodes.droneLp.frequency, 175 + target * 480, glide)
    E.ramp(nodes.droneGain.gain, 0.38 + target * 0.2, glide)
    E.ramp(nodes.tenseGain.gain, Math.max(0, target - 0.28) * 0.5, glide)
    E.ramp(nodes.swellGain.gain, 0.45 + target * 0.4, glide)
  }

  // where bump() should settle back to, and when
  let decayTo = null
  let decayAt = 0

  /** Momentary spike that decays back to the standing level. */
  function bump(amount = 0.3, hold = 4) {
    const base = decayTo ?? target
    setIntensity(Math.min(1, target + amount), 0.6)
    decayTo = base
    decayAt = (E.live() ? E.ctx.currentTime : 0) + hold
  }

  function update(dt) {
    if (!running || !E.live()) return
    // smooth the working intensity toward target so pulse density doesn't jump
    intensity += (target - intensity) * Math.min(1, dt * 0.6)
    if (decayTo !== null && E.ctx.currentTime >= decayAt) {
      const to = decayTo
      decayTo = null
      setIntensity(to, 6)
    }
    schedule()
  }

  function dispose() {
    if (!nodes) return
    for (const o of [...nodes.osc, ...nodes.lfo]) { try { o.stop() } catch { /* not started */ } }
    try { nodes.out.disconnect() } catch { /* gone */ }
    try { nodes.send.disconnect() } catch { /* gone */ }
    nodes = null
    running = false
  }

  return {
    start, stop, update, setIntensity, bump, dispose,
    get intensity() { return target },
    get running() { return running },
  }
}
