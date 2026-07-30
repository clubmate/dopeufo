/**
 * WebAudio mixer, spatialiser and voice manager.
 *
 * Graph:
 *
 *   voice ─┬─▶ distance LP ─▶ panner ─┬─▶ voiceGain ─▶ bus in ─▶ busComp ─▶ busGain ─┐
 *          │                          └─▶ send ─▶ reverbIn[space] ─▶ conv ─▶ ret ────┤
 *          └─(non-positional)─────────────────────────────────────────────────────────┤
 *                                                                                     ▼
 *   destination ◀─ safety clip ◀─ limiter ◀─ masterGain ◀─ shock LP ◀─ duckGain ◀─ masterIn
 *
 * Autoplay policy: the AudioContext is *not constructed* until a user gesture.
 * Constructing one early is what makes Chrome print "The AudioContext was not
 * allowed to start"; deferring construction means a gesture-less environment
 * (our screenshot harness) sees an audio module that initialises, registers its
 * API, answers every call and stays completely silent — no warnings, no throws.
 */

import { makeNoiseBuffer, makeImpulseResponse, makeSoftClipCurve, makeDriveCurve } from './synth.js'

const BUS_NAMES = ['sfx', 'music', 'ambience', 'ui']

const DEFAULT_BUS_VOLUME = { sfx: 0.55, music: 0.16, ambience: 0.2, ui: 0.5 }

const BUS_COMP = {
  sfx: { threshold: -15, knee: 6, ratio: 3.6, attack: 0.003, release: 0.19 },
  music: { threshold: -20, knee: 12, ratio: 2.2, attack: 0.02, release: 0.35 },
  ambience: { threshold: -24, knee: 12, ratio: 1.8, attack: 0.05, release: 0.5 },
  ui: { threshold: -12, knee: 8, ratio: 3, attack: 0.002, release: 0.12 },
}

/** Urban street: sparse hard slap-backs off facades, thin bright-ish wash. */
const IR_OUTDOOR = {
  rt60: 1.35,
  predelay: 0.009,
  dampStart: 8200,
  dampEnd: 620,
  dampTime: 0.3,
  hp: 130,
  buildup: 0.05,
  tailGain: 0.34,
  taps: [
    { t: 0.021, g: 0.62, spread: 0.0016, w: 0.55 },
    { t: 0.037, g: 0.45, spread: 0.002, w: 1.5, pol: -1 },
    { t: 0.058, g: 0.5, spread: 0.0022, w: 0.7 },
    { t: 0.079, g: 0.33, spread: 0.003, w: 1.35 },
    { t: 0.112, g: 0.38, spread: 0.0035, w: 0.8, pol: -1 },
    { t: 0.157, g: 0.24, spread: 0.004, w: 1.2 },
    { t: 0.213, g: 0.19, spread: 0.005, w: 0.85 },
    { t: 0.284, g: 0.13, spread: 0.006, w: 1.15, pol: -1 },
  ],
}

/** Alley / interior: dense, dark, long, almost no discrete early energy. */
const IR_INDOOR = {
  rt60: 2.5,
  predelay: 0.004,
  dampStart: 4200,
  dampEnd: 320,
  dampTime: 0.55,
  hp: 95,
  buildup: 0.012,
  tailGain: 0.78,
  taps: [
    { t: 0.008, g: 0.4, spread: 0.0014, w: 0.8 },
    { t: 0.015, g: 0.34, spread: 0.0018, w: 1.25, pol: -1 },
    { t: 0.026, g: 0.3, spread: 0.0022, w: 0.75 },
    { t: 0.041, g: 0.22, spread: 0.003, w: 1.2 },
  ],
}

export function createAudioEngine(options = {}) {
  const E = {
    ctx: null,
    offline: false,
    ready: false,
    muted: false,
    failed: false,
    maxVoices: options.maxVoices ?? 24,
    masterVolume: options.masterVolume ?? 0.85,
    busVolume: { ...DEFAULT_BUS_VOLUME, ...(options.busVolume || {}) },
    nodes: null,
    voices: [],
    listener: {
      pos: { x: 0, y: 0, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fwd: { x: 0, y: 0, z: -1 },
    },
    panWidth: options.panWidth ?? 0.42,
    refDistance: options.refDistance ?? 26,
    _noise: new Map(),
    _curves: new Map(),
    _clip: null,
    _timers: new Set(),
    _onReady: [],
  }

  const lookahead = () => (E.offline ? 0 : 0.006)

  E.now = () => (E.ctx ? E.ctx.currentTime + lookahead() : 0)

  // --- lifecycle ------------------------------------------------------------

  /**
   * Build the whole graph. Called once, either on the first user gesture or
   * immediately when an external context was injected (offline rendering).
   */
  function build(ctx) {
    E.ctx = ctx
    const n = {}

    n.destination = ctx.destination

    // Guaranteed-bounded output. The compressor below is a fast limiter but a
    // DynamicsCompressor is not sample-accurate on the very first transient, so
    // a soft-clip curve backstops it: nothing can leave this graph above 1.0.
    n.safety = ctx.createWaveShaper()
    n.safety.curve = (E._clip ||= makeSoftClipCurve(0.72))
    n.safety.oversample = '2x'
    n.safety.connect(n.destination)

    n.limiter = ctx.createDynamicsCompressor()
    n.limiter.threshold.value = -1.6
    n.limiter.knee.value = 0
    n.limiter.ratio.value = 20
    n.limiter.attack.value = 0.002
    n.limiter.release.value = 0.14
    n.limiter.connect(n.safety)

    n.master = ctx.createGain()
    n.master.gain.value = E.muted ? 0 : E.masterVolume
    n.master.connect(n.limiter)

    // "shock" filter — an explosion slams this shut for ~0.9 s. Combined with
    // the duck it is the classic concussed-for-a-moment effect.
    n.shock = ctx.createBiquadFilter()
    n.shock.type = 'lowpass'
    n.shock.frequency.value = 22000
    n.shock.Q.value = 0.5
    n.shock.connect(n.master)

    n.duck = ctx.createGain()
    n.duck.gain.value = 1
    n.duck.connect(n.shock)

    n.masterIn = ctx.createGain()
    n.masterIn.gain.value = 1
    n.masterIn.connect(n.duck)

    // buses
    n.bus = {}
    for (const name of BUS_NAMES) {
      const input = ctx.createGain()
      const comp = ctx.createDynamicsCompressor()
      const cfg = BUS_COMP[name]
      comp.threshold.value = cfg.threshold
      comp.knee.value = cfg.knee
      comp.ratio.value = cfg.ratio
      comp.attack.value = cfg.attack
      comp.release.value = cfg.release
      const vol = ctx.createGain()
      vol.gain.value = E.busVolume[name]
      input.connect(comp)
      comp.connect(vol)
      vol.connect(n.masterIn)
      n.bus[name] = { input, comp, vol }
    }

    // reverb sends/returns. Convolver buffers arrive asynchronously; until then
    // a bufferless convolver simply passes silence, so sends are harmless.
    n.reverb = {}
    for (const space of ['outdoor', 'indoor']) {
      const input = ctx.createGain()
      input.gain.value = 1
      const pre = ctx.createBiquadFilter()
      pre.type = 'highpass'
      pre.frequency.value = space === 'outdoor' ? 220 : 150
      pre.Q.value = 0.6
      const conv = ctx.createConvolver()
      conv.normalize = true
      const ret = ctx.createGain()
      ret.gain.value = space === 'outdoor' ? 0.62 : 0.72
      const tone = ctx.createBiquadFilter()
      tone.type = 'lowpass'
      tone.frequency.value = space === 'outdoor' ? 7200 : 4200
      tone.Q.value = 0.5
      input.connect(pre)
      pre.connect(conv)
      conv.connect(tone)
      tone.connect(ret)
      ret.connect(n.masterIn)
      n.reverb[space] = { input, conv, ret }
    }

    E.nodes = n
    E.ready = true

    // Heavy buffer synthesis off the gesture frame so the unlocking click never
    // costs us a stutter. Offline contexts need them synchronously.
    if (E.offline) buildBuffers()
    else defer(buildBuffers)

    const cbs = E._onReady.splice(0)
    for (const cb of cbs) {
      try {
        cb()
      } catch (err) {
        report('ready callback', err)
      }
    }
  }

  function buildBuffers() {
    if (!E.ctx) return
    try {
      noiseBuffer('white')
      noiseBuffer('pink')
      noiseBuffer('brown')
      E.nodes.reverb.outdoor.conv.buffer = makeImpulseResponse(E.ctx, IR_OUTDOOR)
      E.nodes.reverb.indoor.conv.buffer = makeImpulseResponse(E.ctx, IR_INDOOR)
    } catch (err) {
      report('buffer synthesis', err)
    }
  }

  function defer(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 250 })
    else setTimeout(fn, 0)
  }

  /** Create + resume the context. Safe to call repeatedly; resolves to bool. */
  E.unlock = async function unlock() {
    if (E.failed) return false
    if (!E.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!AC) {
        E.failed = true
        return false
      }
      let ctx
      try {
        ctx = new AC({ latencyHint: 'interactive' })
      } catch (err) {
        E.failed = true
        report('context creation', err)
        return false
      }
      build(ctx)
    }
    if (E.ctx.state === 'suspended') {
      try {
        await E.ctx.resume()
      } catch {
        return false // gesture wasn't trusted; we'll get another chance
      }
    }
    return E.ctx.state === 'running'
  }

  E.onReady = function onReady(cb) {
    if (E.ready) cb()
    else E._onReady.push(cb)
  }

  /** True only when a voice would actually be heard. Everything checks this. */
  E.live = () => E.ready && !!E.ctx && (E.offline || E.ctx.state === 'running')

  // --- cached buffers / curves ---------------------------------------------

  function noiseBuffer(kind) {
    let b = E._noise.get(kind)
    if (!b) {
      b = makeNoiseBuffer(E.ctx, kind, kind === 'white' ? 3 : 5, 1)
      E._noise.set(kind, b)
    }
    return b
  }
  E.noiseBuffer = noiseBuffer

  E.driveCurve = (drive) => {
    const key = Math.round(drive * 10)
    let c = E._curves.get(key)
    if (!c) {
      c = makeDriveCurve(drive)
      E._curves.set(key, c)
    }
    return c
  }

  // --- listener -------------------------------------------------------------

  /**
   * Cache the camera basis. We keep the WebAudio listener parked at the origin
   * facing -Z and transform sources into camera space ourselves — that avoids
   * the deprecated listener.setOrientation() (which logs a warning) and lets us
   * narrow the stereo field independently of distance, which matters a lot for
   * an isometric camera 50 m away: true panning at that geometry throws sounds
   * fully hard-left/right and reads as broken rather than spatial.
   */
  E.updateListener = function updateListener(camera) {
    if (!camera) return
    const m = camera.matrixWorld.elements
    const l = E.listener
    l.right.x = m[0]; l.right.y = m[1]; l.right.z = m[2]
    l.up.x = m[4]; l.up.y = m[5]; l.up.z = m[6]
    // three's camera looks down -Z, matrix column 2 is +Z (backwards)
    l.fwd.x = -m[8]; l.fwd.y = -m[9]; l.fwd.z = -m[10]
    l.pos.x = m[12]; l.pos.y = m[13]; l.pos.z = m[14]
  }

  function toListenerSpace(p) {
    const l = E.listener
    const dx = p.x - l.pos.x
    const dy = p.y - l.pos.y
    const dz = p.z - l.pos.z
    const dist = Math.hypot(dx, dy, dz)
    // camera-space: x = right, y = up, z = -forward (WebAudio's -Z is "ahead")
    let x = dx * l.right.x + dy * l.right.y + dz * l.right.z
    let y = dx * l.up.x + dy * l.up.y + dz * l.up.z
    let z = -(dx * l.fwd.x + dy * l.fwd.y + dz * l.fwd.z)
    // narrow the lateral field, then restore the true radius so distance
    // attenuation is untouched by the cosmetic narrowing
    x *= E.panWidth
    y *= E.panWidth
    const len = Math.hypot(x, y, z) || 1
    const s = (dist || 1) / len
    return { x: x * s, y: y * s, z: z * s, dist }
  }

  // --- voices ---------------------------------------------------------------

  function killVoice(v, fade = 0.02) {
    if (v.dead) return
    v.dead = true
    const i = E.voices.indexOf(v)
    if (i !== -1) E.voices.splice(i, 1)
    if (v.timer) {
      clearTimeout(v.timer)
      E._timers.delete(v.timer)
    }
    const t = E.ctx ? E.ctx.currentTime : 0
    try {
      if (fade > 0) {
        v.out.gain.cancelScheduledValues(t)
        v.out.gain.setValueAtTime(Math.max(v.out.gain.value, 1e-4), t)
        v.out.gain.exponentialRampToValueAtTime(1e-4, t + fade)
      }
    } catch { /* param already ended */ }
    const disconnect = () => {
      try { v.head.disconnect() } catch { /* already gone */ }
      try { v.out.disconnect() } catch { /* already gone */ }
      if (v.send) { try { v.send.disconnect() } catch { /* already gone */ } }
      if (v.panner) { try { v.panner.disconnect() } catch { /* already gone */ } }
      if (v.dist) { try { v.dist.disconnect() } catch { /* already gone */ } }
    }
    if (E.offline || fade <= 0) disconnect()
    else {
      const id = setTimeout(() => { E._timers.delete(id); disconnect() }, (fade + 0.05) * 1000)
      E._timers.add(id)
    }
  }

  function reap() {
    if (E.voices.length < E.maxVoices) return
    // steal: oldest first, weighted down by priority so a gunshot outlives a
    // footstep even if it started earlier
    let worst = null
    let worstScore = Infinity
    const now = E.ctx.currentTime
    for (const v of E.voices) {
      const age = now - v.start
      const score = v.priority * 2 - age
      if (score < worstScore) {
        worstScore = score
        worst = v
      }
    }
    if (worst) killVoice(worst, 0.015)
  }

  /**
   * Allocate a voice. `input` is what a sound renders into; everything else
   * (distance filtering, panning, reverb send, lifetime) is handled here.
   */
  E.voice = function voice(o = {}) {
    if (!E.live()) return null
    const ctx = E.ctx
    reap()

    const bus = E.nodes.bus[o.bus || 'sfx'] || E.nodes.bus.sfx
    const head = ctx.createGain()
    head.gain.value = 1
    const out = ctx.createGain()
    out.gain.value = o.gain ?? 1

    const v = {
      head,
      out,
      input: head,
      start: ctx.currentTime,
      priority: o.priority ?? 0.5,
      dead: false,
      dist: null,
      panner: null,
      send: null,
      ctx,
    }

    let tail = head
    let dist = 0

    if (o.position) {
      const p = toListenerSpace(o.position)
      dist = p.dist
      // air absorption: distant reports lose their edge long before their body
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = Math.min(20000, Math.max(1400, 20000 * Math.pow(0.5, dist / 46)))
      lp.Q.value = 0.4
      const panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = E.refDistance
      panner.maxDistance = 400
      panner.rolloffFactor = o.rolloff ?? 0.95
      panner.positionX.value = p.x
      panner.positionY.value = p.y
      panner.positionZ.value = p.z
      head.connect(lp)
      lp.connect(panner)
      v.dist = lp
      v.panner = panner
      tail = panner
    }

    tail.connect(out)
    out.connect(bus.input)

    const rev = o.reverb ?? 0
    if (rev > 0) {
      const space = E.nodes.reverb[o.space || 'outdoor'] || E.nodes.reverb.outdoor
      const send = ctx.createGain()
      // wetter with distance: the direct path drops faster than the reflected one
      send.gain.value = rev * (1 + Math.min(dist, 120) / 55)
      tail.connect(send)
      send.connect(space.input)
      v.send = send
    }

    const life = (o.duration ?? 1) + (rev > 0 ? 2.0 : 0.25)
    if (!E.offline) {
      const id = setTimeout(() => {
        E._timers.delete(id)
        v.timer = null
        killVoice(v, 0)
      }, life * 1000)
      E._timers.add(id)
      v.timer = id
    }
    E.voices.push(v)
    return v
  }

  /** Release a voice early (loops, held sounds). */
  E.release = (v, fade = 0.08) => v && killVoice(v, fade)

  // --- master effects -------------------------------------------------------

  /** Duck the whole mix — used by explosions so they own the moment. */
  E.duck = function duck(amount = 0.5, attack = 0.03, release = 1.1, at = null) {
    if (!E.live()) return
    const t = at ?? E.now()
    const g = E.nodes.duck.gain
    try {
      g.cancelScheduledValues(t)
      g.setValueAtTime(Math.max(g.value, 0.001), t)
      g.linearRampToValueAtTime(Math.max(amount, 0.001), t + attack)
      g.setValueAtTime(Math.max(amount, 0.001), t + attack + 0.05)
      g.exponentialRampToValueAtTime(1, t + attack + 0.05 + release)
      g.setValueAtTime(1, t + attack + 0.06 + release)
    } catch (err) { report('duck', err) }
  }

  /** Slam the master lowpass shut and let it open — concussion / ear-ring. */
  E.shock = function shock(freq = 1100, release = 0.9, at = null) {
    if (!E.live()) return
    const t = at ?? E.now()
    const f = E.nodes.shock.frequency
    try {
      f.cancelScheduledValues(t)
      f.setValueAtTime(22000, t)
      f.exponentialRampToValueAtTime(Math.max(freq, 60), t + 0.02)
      f.exponentialRampToValueAtTime(22000, t + 0.02 + release)
      f.setValueAtTime(22000, t + 0.04 + release)
    } catch (err) { report('shock', err) }
  }

  // --- mixer controls -------------------------------------------------------

  E.setBusVolume = function setBusVolume(name, v) {
    const val = Math.max(0, Math.min(2, Number(v) || 0))
    if (name === 'master') {
      E.masterVolume = val
      if (E.ready && !E.muted) ramp(E.nodes.master.gain, val)
      return
    }
    if (!BUS_NAMES.includes(name)) return
    E.busVolume[name] = val
    if (E.ready) ramp(E.nodes.bus[name].vol.gain, val)
  }

  E.getBusVolume = (name) => (name === 'master' ? E.masterVolume : E.busVolume[name])

  E.setMute = function setMute(on) {
    E.muted = !!on
    if (E.ready) ramp(E.nodes.master.gain, E.muted ? 0 : E.masterVolume, 0.05)
  }

  function ramp(param, value, time = 0.08) {
    if (!E.ctx) return
    const t = E.ctx.currentTime
    try {
      param.cancelScheduledValues(t)
      param.setValueAtTime(param.value, t)
      param.linearRampToValueAtTime(value, t + time)
    } catch {
      param.value = value
    }
  }
  E.ramp = ramp

  E.busInput = (name) => (E.ready ? E.nodes.bus[name]?.input : null)
  E.reverbInput = (space) => (E.ready ? E.nodes.reverb[space]?.input : null)

  // --- diagnostics / teardown ----------------------------------------------

  let reported = 0
  function report(what, err) {
    // Never spam. Audio failing must be a footnote, not a wall of red.
    if (reported++ > 2) return
    console.warn(`[audio] ${what} unavailable —`, err?.message || err)
  }
  E.report = report

  E.dispose = function dispose() {
    for (const id of E._timers) clearTimeout(id)
    E._timers.clear()
    for (const v of [...E.voices]) killVoice(v, 0)
    E.voices.length = 0
    E._onReady.length = 0
    if (E.ctx && !E.offline) {
      try { E.ctx.close() } catch { /* already closed */ }
    }
    E.ctx = null
    E.nodes = null
    E.ready = false
  }

  // Offline rendering path (analysis / baking): the context already exists and
  // no gesture policy applies, so wire it up immediately.
  if (options.context) {
    E.offline = options.context.constructor?.name !== 'AudioContext'
    build(options.context)
  }

  return E
}

export { BUS_NAMES, IR_OUTDOOR, IR_INDOOR }
