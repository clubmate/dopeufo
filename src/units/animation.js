/**
 * Animation state machine.
 *
 * Two layers of intent:
 *   - a *pose* (looping): the unit's resting state. Changing it crossfades.
 *   - an *action* (one shot): fire / reload / throw / hit / death. Actions fade
 *     in over the pose, run once, and hand control back — except death, which
 *     clamps on its final frame and latches the machine.
 *
 * playAction returns a Promise that resolves on the animation *beat* (a
 * fraction of the clip, not the very end) so the game layer can chain VFX and
 * damage at the moment the shot actually leaves the barrel rather than after
 * the follow-through.
 */
import * as THREE from 'three'

/** pose id -> clip name */
export const POSE_CLIP = {
  idle: 'idle',
  cover: 'idle_cover',
  crouch: 'crouch_idle',
  crouch_move: 'crouch_move',
  walk: 'walk',
  run: 'run',
  aim: 'aim',
  overwatch: 'overwatch',
  hunker: 'hunker',
}

/** action id -> { clip, beat (0..1), fade } */
export const ACTION_CLIP = {
  fire: { clip: 'fire', beat: 0.22, fade: 0.06 },
  reload: { clip: 'reload', beat: 0.96, fade: 0.16 },
  throw: { clip: 'throw', beat: 0.50, fade: 0.12 },
  hit: { clip: 'hit', beat: 0.45, fade: 0.08 },
  death: { clip: 'death_a', beat: 0.85, fade: 0.10 },
  death_a: { clip: 'death_a', beat: 0.85, fade: 0.10 },
  death_b: { clip: 'death_b', beat: 0.85, fade: 0.10 },
}

const POSE_FADE = {
  default: 0.22,
  walk: 0.16,
  run: 0.14,
  aim: 0.18,
  hunker: 0.30,
  cover: 0.28,
}

export class AnimatorSet {
  /**
   * @param {THREE.Object3D} root  skinned model root
   * @param {THREE.AnimationClip[]} clips  shared clip library
   */
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root)
    this.actions = Object.create(null)
    this.clipNames = []
    for (const c of clips || []) {
      try {
        const a = this.mixer.clipAction(c)
        a.enabled = true
        this.actions[c.name] = a
        this.clipNames.push(c.name)
      } catch (err) {
        /* a clip that does not bind is simply unavailable */
      }
    }
    this.pose = null
    this.current = null
    this.oneShot = null
    this.dead = false
    this.speed = 1
    this._pending = []
    this._onFinished = (e) => this._finished(e)
    this.mixer.addEventListener('finished', this._onFinished)
  }

  has(name) {
    return !!this.actions[name]
  }

  /** Crossfade to a looping pose. No-op if already there. */
  setPose(pose, fade) {
    if (this.dead) return
    const clip = POSE_CLIP[pose] || POSE_CLIP.idle
    if (this.pose === pose && this.current) return
    const next = this.actions[clip] || this.actions[POSE_CLIP.idle]
    if (!next) return
    const d = fade != null ? fade : (POSE_FADE[pose] ?? POSE_FADE.default)
    next.reset()
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = false
    next.enabled = true
    next.setEffectiveTimeScale(1)
    next.setEffectiveWeight(1)
    if (this.current && this.current !== next) {
      // keep the phase when swapping between locomotion clips so the feet do
      // not teleport mid-stride
      if (isLocomotion(this.pose) && isLocomotion(pose)) {
        const src = this.current
        const t = (src.time / (src.getClip().duration || 1)) % 1
        next.time = t * (next.getClip().duration || 1)
      }
      next.play()
      this.current.crossFadeTo(next, d, false)
    } else {
      next.play()
      if (!this.current) next.setEffectiveWeight(1)
    }
    this.current = next
    this.pose = pose
  }

  /** Scale locomotion playback so stride length matches ground speed. */
  setLocomotionRate(rate) {
    for (const n of ['walk', 'run', 'crouch_move']) {
      const a = this.actions[n]
      if (a) a.setEffectiveTimeScale(rate)
    }
  }

  /**
   * Fire a one-shot over the current pose.
   * @returns {Promise<void>} resolves at the action's beat.
   */
  playAction(id, opts = {}) {
    const def = ACTION_CLIP[id]
    if (!def) return Promise.resolve()
    const a = this.actions[def.clip]
    if (!a) return Promise.resolve()
    if (this.dead && id !== 'death' && id !== 'death_a' && id !== 'death_b') {
      return Promise.resolve()
    }

    const isDeath = def.clip.startsWith('death')
    // a second shot while firing should restart the recoil, not queue behind it
    if (this.oneShot && this.oneShot !== a) {
      this.oneShot.fadeOut(def.fade)
    }
    a.reset()
    a.setLoop(THREE.LoopOnce, 1)
    a.clampWhenFinished = true
    a.enabled = true
    a.setEffectiveTimeScale(opts.timeScale || 1)
    a.setEffectiveWeight(1)
    a.fadeIn(def.fade)
    a.play()
    this.oneShot = a
    if (isDeath) {
      this.dead = true
      if (this.current) this.current.fadeOut(def.fade * 2)
      this.current = null
      this.pose = 'dead'
    }

    const dur = (a.getClip().duration || 0.4) / (opts.timeScale || 1)
    return new Promise((resolve) => {
      this._pending.push({ action: a, resolve, at: performance.now() + dur * def.beat * 1000 })
    })
  }

  _finished(e) {
    const a = e.action
    if (!a || a !== this.oneShot) return
    const isDeath = a.getClip().name.startsWith('death')
    if (isDeath) return // clamp and stay
    a.fadeOut(0.18)
    this.oneShot = null
    if (this.current) {
      this.current.enabled = true
      this.current.setEffectiveWeight(1)
      this.current.fadeIn(0.18)
    }
  }

  update(dt) {
    this.mixer.update(dt * this.speed)
    if (this._pending.length) {
      const now = performance.now()
      for (let i = this._pending.length - 1; i >= 0; i--) {
        if (now >= this._pending[i].at) {
          const p = this._pending.splice(i, 1)[0]
          p.resolve()
        }
      }
    }
  }

  revive() {
    this.dead = false
    if (this.oneShot) {
      this.oneShot.stop()
      this.oneShot = null
    }
    this.pose = null
    this.current = null
  }

  dispose() {
    for (const p of this._pending) p.resolve()
    this._pending.length = 0
    this.mixer.removeEventListener('finished', this._onFinished)
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.mixer.getRoot())
  }
}

function isLocomotion(p) {
  return p === 'walk' || p === 'run' || p === 'crouch_move'
}
