/**
 * Ambient bed.
 *
 * Three continuously-running noise layers (low city rumble, mid wind, high air)
 * whose filters are driven by pairs of incommensurate LFOs, plus a lookahead
 * scheduler that lays in gusts and sparse one-shot events (creaks, metal
 * groans, birds, a distant siren).
 *
 * Seamlessness: nothing here is a baked loop of "an ambience". The only looping
 * buffers are the noise sources, which are generated with an equal-power
 * crossfaded wrap (see makeNoiseBuffer) so the loop point is statistically
 * identical to any other sample boundary — there is no seam to hear. Everything
 * above that is continuous modulation with irrational period ratios, so the bed
 * never repeats a recognisable figure.
 */

import { playSfx } from './sfx.js'
import { biquad, gainNode, chain, rnd, pick } from './synth.js'

export function createAmbience(E) {
  let nodes = null
  let running = false
  let intensity = 0.5
  let nextGust = 0
  let nextEvent = 0
  let nextRare = 0

  let lfoPool = []

  function lfo(rate, depth, target, phase = 0) {
    const osc = E.ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = rate
    const g = gainNode(E, depth)
    osc.connect(g)
    g.connect(target)
    osc.start(E.ctx.currentTime + phase)
    lfoPool.push(osc)
    return { osc, g }
  }

  function loopNoise(kind, rate = 1) {
    const src = E.ctx.createBufferSource()
    src.buffer = E.noiseBuffer(kind)
    src.loop = true
    src.loopStart = 0
    src.loopEnd = src.buffer.duration
    src.playbackRate.value = rate
    // random phase so two layers reading the same mono buffer are decorrelated
    // from the first sample, not just once their rates have drifted apart
    src._offset = Math.random() * src.buffer.duration
    return src
  }

  function build() {
    const ctx = E.ctx
    const bus = E.busInput('ambience')
    if (!bus) return false

    const out = gainNode(E, 0)
    out.connect(bus)
    // a touch of the outdoor IR glues the bed into the same space as the SFX
    const send = gainNode(E, 0.12)
    out.connect(send)
    const rev = E.reverbInput('outdoor')
    if (rev) send.connect(rev)

    lfoPool = []
    const n = { out, send, sources: [] }

    // --- layer 1: distant city rumble, as a decorrelated pair -------------
    // A single mono rumble dominates the bed's energy and drags the whole
    // ambience to the centre; two sources reading the buffer at different rates
    // and panned apart keep the low end wide without smearing it.
    n.rumble = []
    for (const [pan, rate, r1, r2] of [[-0.35, 0.85, 0.021, 0.0071], [0.35, 0.78, 0.0163, 0.0059]]) {
      const src = loopNoise('brown', rate)
      const lp = biquad(E, 'lowpass', 105, 0.8)
      const hp = biquad(E, 'highpass', 28, 0.7)
      const g = gainNode(E, 0.35)
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      chain([src, lp, hp, g, p])
      p.connect(out)
      lfo(r1, 26, lp.frequency)
      lfo(r2, 0.11, g.gain, 0.3)
      src.start(0, src._offset)
      n.sources.push(src)
      n.rumble.push(g)
    }

    // --- layer 2: wind, stereo, two decorrelated halves --------------------
    n.wind = []
    for (const [side, pan, rate] of [['L', -0.55, 1.0], ['R', 0.55, 0.93]]) {
      const src = loopNoise('pink', rate)
      const lp = biquad(E, 'lowpass', 520, 1.6)
      const hp = biquad(E, 'highpass', 150, 0.7)
      // the whistle: a narrow resonance drifting through the wind body is what
      // makes it read as air moving past edges rather than as a noise hiss
      const bp = biquad(E, 'bandpass', 850, 4.5)
      const bpg = gainNode(E, 0.5)
      const g = gainNode(E, 0.22)
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      src.connect(lp)
      lp.connect(hp)
      hp.connect(g)
      hp.connect(bp)
      bp.connect(bpg)
      bpg.connect(g)
      g.connect(p)
      p.connect(out)
      lfo(side === 'L' ? 0.037 : 0.043, 240, lp.frequency)
      lfo(side === 'L' ? 0.013 : 0.017, 130, lp.frequency, 0.7)
      lfo(side === 'L' ? 0.029 : 0.0233, 420, bp.frequency)
      lfo(side === 'L' ? 0.011 : 0.0093, 0.07, g.gain, 1.1)
      src.start(0, src._offset)
      n.sources.push(src)
      n.wind.push(g)
    }

    // --- layer 3: high air / hiss -----------------------------------------
    {
      const src = loopNoise('pink', 1.13)
      const hp = biquad(E, 'highpass', 2600, 0.6)
      const lp = biquad(E, 'lowpass', 9000, 0.6)
      const g = gainNode(E, 0.035)
      chain([src, hp, lp, g])
      g.connect(out)
      lfo(0.019, 900, hp.frequency)
      lfo(0.0087, 0.012, g.gain)
      src.start(0, src._offset)
      n.sources.push(src)
      n.air = g
    }

    nodes = n
    return true
  }

  function start() {
    if (running || !E.live()) return
    if (!nodes && !build()) return
    running = true
    const t = E.ctx.currentTime
    nodes.out.gain.cancelScheduledValues(t)
    nodes.out.gain.setValueAtTime(Math.max(nodes.out.gain.value, 0.0001), t)
    nodes.out.gain.linearRampToValueAtTime(0.5, t + 3.5)
    nextGust = t + rnd(4, 9)
    nextEvent = t + rnd(6, 14)
    nextRare = t + rnd(40, 90)
  }

  function stop(fade = 1.5) {
    if (!running || !nodes) return
    running = false
    const t = E.ctx.currentTime
    nodes.out.gain.cancelScheduledValues(t)
    nodes.out.gain.setValueAtTime(nodes.out.gain.value, t)
    nodes.out.gain.linearRampToValueAtTime(0.0001, t + fade)
  }

  /** 0 = still, 1 = weather picking up. Also nudged by combat intensity. */
  function setIntensity(v) {
    intensity = Math.max(0, Math.min(1, v))
    if (!nodes || !E.live()) return
    for (const g of nodes.wind) E.ramp(g.gain, 0.16 + 0.16 * intensity, 3)
    for (const g of nodes.rumble) E.ramp(g.gain, 0.3 + 0.14 * intensity, 3)
  }

  function update() {
    if (!running || !E.live()) return
    const now = E.ctx.currentTime

    // gusts — scheduled ahead so they ride the LFOs rather than fight them
    if (now >= nextGust) {
      const dur = rnd(2.5, 6)
      const peak = rnd(0.1, 0.26) * (0.7 + intensity * 0.6)
      for (const g of nodes.wind) {
        const base = 0.16 + 0.16 * intensity
        const t0 = now + rnd(0, 0.6)
        g.gain.cancelScheduledValues(t0)
        g.gain.setValueAtTime(Math.max(g.gain.value, 0.001), t0)
        g.gain.linearRampToValueAtTime(base + peak, t0 + dur * 0.42)
        g.gain.linearRampToValueAtTime(base, t0 + dur)
      }
      nextGust = now + dur + rnd(5, 16)
    }

    if (now >= nextEvent) {
      const id = pick(['amb.creak', 'amb.groan', 'amb.bird', 'amb.bird', 'amb.debris'])
      playSfx(E, id, {
        volume: rnd(0.5, 1),
        position: randomFarPosition(),
        reverb: rnd(0.25, 0.5),
      })
      nextEvent = now + rnd(9, 26)
    }

    if (now >= nextRare) {
      playSfx(E, 'amb.siren', { volume: rnd(0.5, 0.9), position: randomFarPosition(140) })
      nextRare = now + rnd(70, 160)
    }
  }

  /** Somewhere out in the block, well past the playable area. */
  function randomFarPosition(d = 60) {
    const a = Math.random() * Math.PI * 2
    const r = d * rnd(0.7, 1.4)
    const l = E.listener.pos
    return { x: l.x + Math.cos(a) * r, y: l.y + rnd(-8, 14), z: l.z + Math.sin(a) * r }
  }

  function dispose() {
    if (!nodes) return
    for (const s of [...nodes.sources, ...lfoPool]) { try { s.stop() } catch { /* not started */ } }
    lfoPool = []
    try { nodes.out.disconnect() } catch { /* gone */ }
    try { nodes.send.disconnect() } catch { /* gone */ }
    nodes = null
    running = false
  }

  return { start, stop, setIntensity, update, dispose, get running() { return running } }
}
