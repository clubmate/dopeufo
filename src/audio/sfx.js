/**
 * The sound catalogue.
 *
 * Every entry declares its mix routing (bus / reverb send / priority / expected
 * lifetime) and a `render(E, v, t, o)` that schedules its layers into the voice.
 * Nothing here plays a sample; every sound is built from noise, oscillators,
 * filters and waveshapers at trigger time, with per-trigger randomisation, so
 * two consecutive shots are never bit-identical.
 */

import {
  rnd, rndi, jitter,
  noiseBurst, driveNoise, toneBurst, modal, resonantSweep,
  slapTap, combTube, biquad, gainNode, chain,
} from './synth.js'

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * A gunshot is four simultaneous events, not one sound:
 *
 *  1. the muzzle blast transient — a few milliseconds of extremely bright,
 *     near-impulsive noise; this is what makes it read as "sharp" rather than
 *     "loud", and it lives above 3 kHz;
 *  2. the body thump — the pressure wave, a fast downward pitch sweep in the
 *     40–200 Hz region, which is what you feel;
 *  3. the "meat" — waveshaped noise through a downward-sweeping resonant band,
 *     supplying the 500 Hz–3 kHz mass that separates a rifle from a firecracker;
 *  4. the tail — discrete slap-backs off nearby facades plus a reverb send.
 *
 * Everything is detuned/re-timed per trigger. Copy-paste bursts are the single
 * loudest tell of cheap game audio, so the burst scheduler also varies the
 * inter-shot interval and each shot's level.
 */
function gunshot(E, v, t, s, o = {}) {
  const g = (o.gain ?? 1) * (s.gain ?? 1)
  const p = o.rate ?? jitter(s.pitchJitter ?? 0.05)
  let end = t

  // slap-back taps: everything below feeds these as well as the dry path
  const dry = gainNode(E, 1)
  dry.connect(v.input)
  for (const sl of s.slaps || []) {
    const tap = slapTap(E, v.input, {
      time: sl.t * rnd(0.94, 1.06),
      gain: sl.g * g,
      lp: sl.lp,
      hpF: sl.hp ?? 200,
    })
    dry.connect(tap)
  }

  // 1 — transient
  end = Math.max(end, noiseBurst(E, dry, t, {
    rate: p * rnd(0.95, 1.06),
    filters: [
      ['highpass', s.clickHp * p, 0.7],
      ['peaking', s.clickPeak * p * rnd(0.94, 1.07), 1.4, 9],
      ['lowpass', 16000, 0.5],
    ],
    gain: s.clickGain * g,
    attack: 0.0004,
    decay: s.clickDecay * rnd(0.9, 1.12),
  }))

  // 1b — the initial crack: a very short, very bright near-impulse
  end = Math.max(end, noiseBurst(E, dry, t, {
    rate: p,
    filters: [['highpass', 5200, 0.6], ['peaking', 9000, 1.1, 6]],
    gain: s.clickGain * 0.55 * g,
    attack: 0.00015,
    decay: 0.006 * rnd(0.8, 1.3),
  }))

  // 3 — mid meat
  end = Math.max(end, driveNoise(E, dry, t, {
    rate: p * rnd(0.93, 1.08),
    drive: s.drive ?? 2.6,
    curve: s.curve ?? 4.5,
    f0: s.meatF0 * p * rnd(0.94, 1.07),
    f1: s.meatF1 * p,
    q: s.meatQ ?? 1.1,
    gain: s.meatGain * g,
    attack: 0.0009,
    decay: s.meatDecay * rnd(0.92, 1.1),
  }))

  // a second, lower band gives the report width without mud
  end = Math.max(end, driveNoise(E, dry, t + 0.0008, {
    rate: p,
    drive: (s.drive ?? 2.6) * 0.7,
    curve: 3,
    filterType: 'lowpass',
    f0: s.meatF0 * 0.55 * p,
    f1: s.meatF1 * 0.5 * p,
    q: 3.2,
    gain: s.meatGain * 0.6 * g,
    attack: 0.0012,
    decay: s.meatDecay * 1.6,
  }))

  // 2 — body + sub
  end = Math.max(end, toneBurst(E, dry, t, {
    type: 'triangle',
    f0: s.bodyF0 * p * rnd(0.96, 1.05),
    f1: s.bodyF1 * p,
    pitchTime: s.bodyDecay * 0.42,
    gain: s.bodyGain * g,
    attack: 0.0009,
    decay: s.bodyDecay * rnd(0.93, 1.09),
    lp: 900,
  }))
  end = Math.max(end, toneBurst(E, dry, t + 0.001, {
    type: 'sine',
    f0: s.subF0 * rnd(0.97, 1.04),
    f1: s.subF1,
    pitchTime: s.subDecay * 0.6,
    gain: s.subGain * g,
    attack: 0.0016,
    decay: s.subDecay * rnd(0.94, 1.08),
  }))

  // 4 — the room roar under the tail
  if (s.roarGain > 0) {
    end = Math.max(end, noiseBurst(E, dry, t + 0.004, {
      kind: 'pink',
      rate: rnd(0.9, 1.1),
      filters: [['lowpass', [s.roarF ?? 1800, (s.roarF ?? 1800) * 0.35], 0.9], ['highpass', 150, 0.6]],
      gain: s.roarGain * g,
      attack: 0.008,
      decay: s.roarDecay ?? 0.32,
    }))
  }

  // mechanical action cycling — automatics only
  if (s.action) {
    const at = t + s.action.t * rnd(0.85, 1.2)
    noiseBurst(E, dry, at, {
      filters: [['bandpass', rnd(2400, 3600), 6], ['highpass', 1200, 0.7]],
      gain: 0.05 * g,
      attack: 0.0004,
      decay: 0.02,
    })
    modal(E, dry, at + 0.002, {
      f0: rnd(1500, 2100),
      gain: 0.028 * g,
      partials: [
        { r: 1, g: 1, decay: 0.035 },
        { r: 2.41, g: 0.5, decay: 0.02 },
      ],
    })
  }

  return end
}

const GUNS = {
  rifle: {
    gain: 0.95, pitchJitter: 0.05,
    clickHp: 2700, clickPeak: 4300, clickGain: 0.5, clickDecay: 0.028,
    meatF0: 1750, meatF1: 620, meatQ: 1.05, meatGain: 0.42, meatDecay: 0.085, drive: 2.8, curve: 5,
    bodyF0: 195, bodyF1: 52, bodyGain: 0.62, bodyDecay: 0.13,
    subF0: 60, subF1: 38, subGain: 0.3, subDecay: 0.2,
    roarGain: 0.075, roarF: 1900, roarDecay: 0.3,
    slaps: [{ t: 0.052, g: 0.22, lp: 2800 }, { t: 0.128, g: 0.1, lp: 1500 }],
    action: { t: 0.048 },
  },
  sniper: {
    gain: 1.0, pitchJitter: 0.03,
    clickHp: 2300, clickPeak: 3600, clickGain: 0.55, clickDecay: 0.05,
    meatF0: 1450, meatF1: 420, meatQ: 0.95, meatGain: 0.46, meatDecay: 0.14, drive: 3.2, curve: 6,
    bodyF0: 165, bodyF1: 42, bodyGain: 0.72, bodyDecay: 0.24,
    subF0: 48, subF1: 30, subGain: 0.4, subDecay: 0.42,
    roarGain: 0.11, roarF: 1500, roarDecay: 0.62,
    slaps: [
      { t: 0.075, g: 0.28, lp: 2400 },
      { t: 0.168, g: 0.17, lp: 1400 },
      { t: 0.31, g: 0.09, lp: 800 },
    ],
  },
  smg: {
    gain: 0.8, pitchJitter: 0.07,
    clickHp: 3200, clickPeak: 5200, clickGain: 0.44, clickDecay: 0.016,
    meatF0: 2100, meatF1: 820, meatQ: 1.2, meatGain: 0.34, meatDecay: 0.05, drive: 2.4, curve: 4,
    bodyF0: 225, bodyF1: 74, bodyGain: 0.44, bodyDecay: 0.07,
    subF0: 78, subF1: 52, subGain: 0.18, subDecay: 0.1,
    roarGain: 0.04, roarF: 2200, roarDecay: 0.16,
    slaps: [{ t: 0.038, g: 0.16, lp: 3000 }],
    action: { t: 0.032 },
  },
  shotgun: {
    gain: 1.0, pitchJitter: 0.05,
    clickHp: 1900, clickPeak: 3000, clickGain: 0.46, clickDecay: 0.055,
    meatF0: 1250, meatF1: 380, meatQ: 0.8, meatGain: 0.5, meatDecay: 0.13, drive: 3.4, curve: 5.5,
    bodyF0: 175, bodyF1: 46, bodyGain: 0.68, bodyDecay: 0.19,
    subF0: 54, subF1: 34, subGain: 0.34, subDecay: 0.3,
    roarGain: 0.1, roarF: 1600, roarDecay: 0.4,
    slaps: [{ t: 0.06, g: 0.24, lp: 2300 }, { t: 0.15, g: 0.11, lp: 1200 }],
  },
  pistol: {
    gain: 0.78, pitchJitter: 0.06,
    clickHp: 3000, clickPeak: 4800, clickGain: 0.46, clickDecay: 0.02,
    meatF0: 1950, meatF1: 700, meatQ: 1.15, meatGain: 0.33, meatDecay: 0.06, drive: 2.5, curve: 4,
    bodyF0: 205, bodyF1: 62, bodyGain: 0.46, bodyDecay: 0.09,
    subF0: 70, subF1: 46, subGain: 0.2, subDecay: 0.13,
    roarGain: 0.05, roarF: 2000, roarDecay: 0.2,
    slaps: [{ t: 0.045, g: 0.18, lp: 2800 }],
    action: { t: 0.04 },
  },
}

/** Hollow launcher "thoomp" — almost no transient, all tube resonance. */
function launcher(E, v, t, o = {}) {
  const g = o.gain ?? 1
  const dry = gainNode(E, 1)
  dry.connect(v.input)
  const tube = combTube(E, dry, { freq: rnd(190, 240), feedback: 0.66, lp: 780, gain: 0.55 })

  let end = toneBurst(E, dry, t, {
    type: 'sine',
    f0: rnd(120, 140), f1: 38, pitchTime: 0.1,
    gain: 0.7 * g, attack: 0.003, decay: 0.26,
  })
  end = Math.max(end, toneBurst(E, tube, t, {
    type: 'triangle',
    f0: rnd(230, 270), f1: 96, pitchTime: 0.05,
    gain: 0.4 * g, attack: 0.002, decay: 0.09,
  }))
  end = Math.max(end, noiseBurst(E, tube, t, {
    filters: [['lowpass', [1500, 400], 1.6], ['highpass', 130, 0.7]],
    gain: 0.42 * g, attack: 0.0018, decay: 0.11,
  }))
  end = Math.max(end, noiseBurst(E, dry, t, {
    filters: [['bandpass', rnd(2600, 3400), 3]],
    gain: 0.36 * g, attack: 0.0005, decay: 0.02,
  }))
  // breech blast: a little bright grit so it isn't purely a mattress thump
  end = Math.max(end, driveNoise(E, dry, t, {
    drive: 2.2, curve: 4, f0: 1500, f1: 520, q: 1.2,
    gain: 0.2 * g, attack: 0.0008, decay: 0.07,
  }))
  return end + 0.2
}

// ---------------------------------------------------------------------------
// Impacts — surface-dependent modal + noise synthesis
// ---------------------------------------------------------------------------

const SURFACES = {
  concrete(E, dest, t, g) {
    let end = noiseBurst(E, dest, t, {
      filters: [['bandpass', rnd(1700, 2600), 1.6], ['highpass', 700, 0.7]],
      gain: 0.4 * g, attack: 0.0003, decay: 0.035 * rnd(0.8, 1.3),
    })
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['highpass', 5500, 0.7]],
      gain: 0.2 * g, attack: 0.0002, decay: 0.008,
    }))
    // dust / grit falling away
    end = Math.max(end, noiseBurst(E, dest, t + 0.012, {
      kind: 'pink',
      filters: [['lowpass', [2200, 500], 0.8], ['highpass', 220, 0.6]],
      gain: 0.1 * g, attack: 0.004, decay: 0.22,
    }))
    end = Math.max(end, toneBurst(E, dest, t, {
      type: 'sine', f0: rnd(130, 180), f1: 70, pitchTime: 0.03,
      gain: 0.17 * g, attack: 0.001, decay: 0.055,
    }))
    return end
  },

  metal(E, dest, t, g) {
    g *= 0.5
    const f0 = rnd(620, 1150)
    let end = modal(E, dest, t, {
      f0, gain: 0.24 * g, detune: 0.03,
      partials: [
        { r: 1, g: 1, decay: rnd(0.45, 0.8) },
        { r: 2.756, g: 0.62, decay: rnd(0.3, 0.55) },
        { r: 5.404, g: 0.44, decay: rnd(0.18, 0.34), bend: 0.995 },
        { r: 8.933, g: 0.3, decay: 0.14 },
        { r: 13.34, g: 0.17, decay: 0.08 },
      ],
    })
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['highpass', 3800, 0.7], ['peaking', 7000, 1.2, 8]],
      gain: 0.34 * g, attack: 0.0002, decay: 0.012,
    }))
    // gritty ring: high-Q noise adds the "sheet" character sines alone miss
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['bandpass', f0 * 2.76, 26], ['bandpass', f0 * 2.76, 14]],
      gain: 0.1 * g, attack: 0.001, decay: 0.3,
    }))
    return end
  },

  wood(E, dest, t, g) {
    g *= 0.75
    const f0 = rnd(210, 330)
    let end = modal(E, dest, t, {
      f0, gain: 0.28 * g, detune: 0.05,
      partials: [
        { r: 1, g: 1, decay: 0.075 },
        { r: 2.14, g: 0.55, decay: 0.05 },
        { r: 3.87, g: 0.32, decay: 0.03 },
        { r: 6.4, g: 0.16, decay: 0.018 },
      ],
    })
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['bandpass', rnd(900, 1500), 1.1], ['lowpass', 4200, 0.7]],
      gain: 0.34 * g, attack: 0.0004, decay: 0.045,
    }))
    end = Math.max(end, noiseBurst(E, dest, t + 0.008, {
      filters: [['bandpass', rnd(320, 480), 2.4]],
      gain: 0.14 * g, attack: 0.003, decay: 0.13,
    }))
    // splinters
    for (let i = 0; i < rndi(1, 3); i++) {
      noiseBurst(E, dest, t + rnd(0.02, 0.11), {
        filters: [['bandpass', rnd(2500, 5200), 5]],
        gain: 0.045 * g, attack: 0.0003, decay: 0.014,
      })
    }
    return end
  },

  dirt(E, dest, t, g) {
    g *= 0.55
    let end = noiseBurst(E, dest, t, {
      kind: 'pink',
      filters: [['lowpass', [1300, 260], 1.1], ['highpass', 90, 0.6]],
      gain: 0.42 * g, attack: 0.0008, decay: 0.075,
    })
    end = Math.max(end, toneBurst(E, dest, t, {
      type: 'sine', f0: rnd(95, 130), f1: 52, pitchTime: 0.04,
      gain: 0.3 * g, attack: 0.0015, decay: 0.09,
    }))
    // scattering grit
    end = Math.max(end, noiseBurst(E, dest, t + 0.02, {
      filters: [['bandpass', 3200, 1.4], ['highpass', 1600, 0.7]],
      gain: 0.022 * g, attack: 0.006, decay: 0.18,
    }))
    return end
  },

  flesh(E, dest, t, g) {
    g *= 0.55
    let end = noiseBurst(E, dest, t, {
      filters: [['lowpass', [1400, 240], 2.2], ['highpass', 120, 0.6]],
      gain: 0.5 * g, attack: 0.0007, decay: 0.06,
    })
    end = Math.max(end, toneBurst(E, dest, t, {
      type: 'sine', f0: rnd(105, 145), f1: 46, pitchTime: 0.05,
      gain: 0.26 * g, attack: 0.0016, decay: 0.11,
    }))
    // the wet component: a fast resonant sweep reads as a squelch
    end = Math.max(end, noiseBurst(E, dest, t + 0.004, {
      filters: [['bandpass', [2600, 520], 4.5]],
      gain: 0.34 * g, attack: 0.002, decay: 0.09, sweepTime: 0.07,
    }))
    end = Math.max(end, driveNoise(E, dest, t, {
      drive: 2.2, curve: 3, filterType: 'lowpass', f0: 900, f1: 260, q: 1.4,
      gain: 0.24 * g, attack: 0.001, decay: 0.13,
    }))
    return end
  },

  glass(E, dest, t, g) {
    g *= 0.6
    let end = modal(E, dest, t, {
      f0: rnd(2400, 3600), gain: 0.14 * g, detune: 0.06,
      partials: [
        { r: 1, g: 1, decay: 0.28 },
        { r: 1.63, g: 0.8, decay: 0.22 },
        { r: 2.39, g: 0.6, decay: 0.16 },
        { r: 3.71, g: 0.45, decay: 0.1 },
      ],
    })
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['highpass', 4200, 0.7]],
      gain: 0.3 * g, attack: 0.0002, decay: 0.02,
    }))
    // shards
    for (let i = 0; i < rndi(4, 9); i++) {
      const st = t + rnd(0.03, 0.5)
      modal(E, dest, st, {
        f0: rnd(2600, 6200), gain: 0.035 * g,
        partials: [{ r: 1, g: 1, decay: rnd(0.02, 0.07) }, { r: 2.3, g: 0.5, decay: 0.02 }],
      })
      end = Math.max(end, st + 0.09)
    }
    return end
  },

  water(E, dest, t, g) {
    let end = noiseBurst(E, dest, t, {
      filters: [['bandpass', [700, 2600], 1.2], ['highpass', 300, 0.7]],
      gain: 0.3 * g, attack: 0.001, decay: 0.09, sweepTime: 0.08,
    })
    end = Math.max(end, toneBurst(E, dest, t + 0.006, {
      type: 'sine', f0: 380, f1: 900, pitchTime: 0.05,
      gain: 0.1 * g, attack: 0.004, decay: 0.07,
    }))
    return end
  },
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const gunEntry = (key) => ({
  bus: 'sfx', priority: 0.95, reverb: key === 'sniper' ? 0.42 : key === 'smg' ? 0.16 : 0.24,
  dur: key === 'sniper' ? 1.1 : 0.6,
  render: (E, v, t, o) => gunshot(E, v, t, GUNS[key], o),
})

const impactEntry = (key, reverb = 0.16, dur = 0.7) => ({
  bus: 'sfx', priority: 0.6, reverb, dur,
  render: (E, v, t, o) => SURFACES[key](E, v.input, t, o.gain ?? 1),
})

export const CATALOGUE = {
  // --- weapons ---
  'gun.rifle': gunEntry('rifle'),
  'gun.sniper': gunEntry('sniper'),
  'gun.smg': gunEntry('smg'),
  'gun.shotgun': gunEntry('shotgun'),
  'gun.pistol': gunEntry('pistol'),
  'gun.launcher': {
    bus: 'sfx', priority: 0.9, reverb: 0.3, dur: 0.8,
    render: (E, v, t, o) => launcher(E, v, t, o),
  },
  'gun.dryfire': {
    bus: 'sfx', priority: 0.4, reverb: 0.06, dur: 0.2,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.9
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', rnd(2600, 3400), 7], ['highpass', 1400, 0.7]],
        gain: 0.3 * g, attack: 0.0003, decay: 0.016,
      })
      return modal(E, v.input, t + 0.001, {
        f0: rnd(1800, 2300), gain: 0.1 * g,
        partials: [{ r: 1, g: 1, decay: 0.04 }, { r: 3.1, g: 0.4, decay: 0.02 }],
      })
    },
  },

  // --- weapon mechanics ---
  'weapon.bolt': {
    bus: 'sfx', priority: 0.45, reverb: 0.08, dur: 0.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.85
      // pull back, then release: two events with different metal signatures
      const t2 = t + rnd(0.055, 0.085)
      let end = t
      for (const [tt, gg, f] of [[t, 0.6, rnd(1500, 1900)], [t2, 1.0, rnd(2100, 2700)]]) {
        noiseBurst(E, v.input, tt, {
          filters: [['bandpass', f * 1.6, 4], ['highpass', 900, 0.7]],
          gain: 0.22 * gg * g, attack: 0.0003, decay: 0.018,
        })
        end = Math.max(end, modal(E, v.input, tt, {
          f0: f, gain: 0.1 * gg * g,
          partials: [
            { r: 1, g: 1, decay: 0.06 },
            { r: 2.71, g: 0.55, decay: 0.035 },
            { r: 4.9, g: 0.3, decay: 0.02 },
          ],
        }))
        // a little sliding friction between the two clacks
        noiseBurst(E, v.input, tt + 0.004, {
          filters: [['bandpass', rnd(3800, 5200), 2.2]],
          gain: 0.035 * gg * g, attack: 0.006, decay: 0.03,
        })
      }
      return end
    },
  },
  'weapon.magOut': {
    bus: 'sfx', priority: 0.4, reverb: 0.08, dur: 0.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.85
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', rnd(1100, 1500), 3.5]],
        gain: 0.16 * g, attack: 0.0004, decay: 0.03,
      })
      return modal(E, v.input, t + 0.03, {
        f0: rnd(700, 900), gain: 0.12 * g,
        partials: [{ r: 1, g: 1, decay: 0.09 }, { r: 2.4, g: 0.5, decay: 0.05 }, { r: 4.8, g: 0.24, decay: 0.03 }],
      })
    },
  },
  'weapon.magIn': {
    bus: 'sfx', priority: 0.45, reverb: 0.09, dur: 0.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.78
      // slide, then a hard seated clack
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', [2200, 3600], 2.4]],
        gain: 0.06 * g, attack: 0.006, decay: 0.05, sweepTime: 0.05,
      })
      const ct = t + 0.06
      noiseBurst(E, v.input, ct, {
        filters: [['bandpass', rnd(1600, 2200), 4], ['highpass', 800, 0.7]],
        gain: 0.3 * g, attack: 0.0003, decay: 0.022,
      })
      let end = modal(E, v.input, ct, {
        f0: rnd(820, 1050), gain: 0.14 * g,
        partials: [{ r: 1, g: 1, decay: 0.07 }, { r: 2.9, g: 0.5, decay: 0.04 }, { r: 6.1, g: 0.22, decay: 0.02 }],
      })
      end = Math.max(end, toneBurst(E, v.input, ct, {
        type: 'sine', f0: 150, f1: 80, pitchTime: 0.03, gain: 0.11 * g, attack: 0.001, decay: 0.05,
      }))
      return end
    },
  },
  'weapon.raise': {
    bus: 'sfx', priority: 0.3, reverb: 0.06, dur: 0.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 2
      noiseBurst(E, v.input, t, {
        kind: 'pink',
        filters: [['bandpass', [600, 2400], 1.6]],
        gain: 0.09 * g, attack: 0.012, decay: 0.11, sweepTime: 0.1,
      })
      return modal(E, v.input, t + 0.09, {
        f0: rnd(1300, 1700), gain: 0.05 * g,
        partials: [{ r: 1, g: 1, decay: 0.04 }, { r: 2.6, g: 0.4, decay: 0.02 }],
      })
    },
  },
  'weapon.lower': {
    bus: 'sfx', priority: 0.28, reverb: 0.06, dur: 0.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 5.5
      return noiseBurst(E, v.input, t, {
        kind: 'pink',
        filters: [['bandpass', [2200, 500], 1.6]],
        gain: 0.08 * g, attack: 0.01, decay: 0.13, sweepTime: 0.12,
      })
    },
  },
  /** Brass hitting the ground — three bounces, each higher and quieter. */
  'weapon.shell': {
    bus: 'sfx', priority: 0.25, reverb: 0.12, dur: 1.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.95
      const f0 = rnd(2400, 3400)
      let tt = t + rnd(0.18, 0.42)
      let amp = 1
      let end = tt
      const bounces = rndi(3, 5)
      for (let i = 0; i < bounces; i++) {
        noiseBurst(E, v.input, tt, {
          filters: [['bandpass', f0 * rnd(1.5, 2.2), 8], ['highpass', 1800, 0.7]],
          gain: 0.09 * amp * g, attack: 0.0002, decay: 0.008,
        })
        end = Math.max(end, modal(E, v.input, tt, {
          f0: f0 * (1 + i * 0.06), gain: 0.07 * amp * g, detune: 0.04,
          partials: [
            { r: 1, g: 1, decay: 0.05 * amp + 0.01 },
            { r: 1.87, g: 0.6, decay: 0.03 * amp + 0.008 },
            { r: 3.31, g: 0.35, decay: 0.018 },
          ],
        }))
        tt += rnd(0.055, 0.13) * (1 - i * 0.12)
        amp *= rnd(0.42, 0.62)
      }
      return end
    },
  },

  // --- impacts ---
  'impact.concrete': impactEntry('concrete', 0.18, 0.6),
  'impact.metal': impactEntry('metal', 0.22, 1.3),
  'impact.wood': impactEntry('wood', 0.14, 0.5),
  'impact.dirt': impactEntry('dirt', 0.1, 0.5),
  'impact.flesh': impactEntry('flesh', 0.09, 0.5),
  'impact.glass': impactEntry('glass', 0.2, 1.1),
  'impact.water': impactEntry('water', 0.14, 0.4),
  'impact.ricochet': {
    bus: 'sfx', priority: 0.55, reverb: 0.34, dur: 1.0,
    render: (E, v, t, o) => {
      const g = o.gain ?? 1
      SURFACES.concrete(E, v.input, t, 0.55 * g)
      const up = Math.random() < 0.4
      const f0 = rnd(2200, 4200)
      return resonantSweep(E, v.input, t + 0.004, {
        f0, f1: up ? f0 * rnd(1.6, 2.6) : f0 * rnd(0.3, 0.5),
        q: rnd(18, 30), gain: 0.13 * g, dur: rnd(0.24, 0.45),
      })
    },
  },
  /** Round cracking past — the classic supersonic zip. */
  'impact.whizby': {
    bus: 'sfx', priority: 0.5, reverb: 0.2, dur: 0.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 1.7
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', [5000, 900], 2.2], ['highpass', 600, 0.7]],
        gain: 0.16 * g, attack: 0.002, decay: 0.11, sweepTime: 0.1,
      })
      return resonantSweep(E, v.input, t, {
        f0: rnd(2800, 4200), f1: rnd(700, 1100), q: 12, gain: 0.09 * g, dur: 0.12, attack: 0.0015,
      })
    },
  },

  // --- explosions ---
  'explosion.large': {
    bus: 'sfx', priority: 1.0, reverb: 0.55, dur: 2.6,
    render: (E, v, t, o) => explosion(E, v, t, o, 1),
  },
  'explosion.small': {
    bus: 'sfx', priority: 0.9, reverb: 0.42, dur: 1.6,
    render: (E, v, t, o) => explosion(E, v, t, o, 0.6),
  },
  'grenade.bounce': {
    bus: 'sfx', priority: 0.4, reverb: 0.14, dur: 0.5,
    render: (E, v, t, o) => {
      const g = o.gain ?? 1
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', rnd(1200, 1800), 4], ['lowpass', 6000, 0.7]],
        gain: 0.2 * g, attack: 0.0003, decay: 0.02,
      })
      return modal(E, v.input, t, {
        f0: rnd(430, 620), gain: 0.11 * g,
        partials: [{ r: 1, g: 1, decay: 0.11 }, { r: 2.3, g: 0.5, decay: 0.06 }, { r: 4.1, g: 0.25, decay: 0.03 }],
      })
    },
  },
  'grenade.throw': {
    bus: 'sfx', priority: 0.35, reverb: 0.1, dur: 0.6,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 5.5
      // cloth + arm swing: a broad band rising then falling as it passes
      let end = noiseBurst(E, v.input, t, {
        kind: 'pink',
        filters: [['bandpass', [420, 2600], 1.3], ['highpass', 260, 0.7]],
        gain: 0.11 * g, attack: 0.03, decay: 0.16, sweepTime: 0.14,
      })
      end = Math.max(end, noiseBurst(E, v.input, t + 0.1, {
        kind: 'pink',
        filters: [['bandpass', [2400, 700], 1.6]],
        gain: 0.06 * g, attack: 0.02, decay: 0.2, sweepTime: 0.18,
      }))
      return end
    },
  },
  'grenade.pin': {
    bus: 'sfx', priority: 0.35, reverb: 0.08, dur: 0.4,
    render: (E, v, t, o) => {
      const g = o.gain ?? 1
      return modal(E, v.input, t, {
        f0: rnd(3200, 4200), gain: 0.09 * g,
        partials: [{ r: 1, g: 1, decay: 0.05 }, { r: 2.17, g: 0.6, decay: 0.03 }, { r: 3.9, g: 0.3, decay: 0.016 }],
      })
    },
  },

  // --- movement ---
  'step.concrete': stepEntry('concrete'),
  'step.dirt': stepEntry('dirt'),
  'step.gravel': stepEntry('gravel'),
  'step.metal': stepEntry('metal'),
  'step.wood': stepEntry('wood'),
  'gear.rattle': {
    bus: 'sfx', priority: 0.2, reverb: 0.06, dur: 0.35,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.9
      let end = t
      for (let i = 0; i < rndi(2, 4); i++) {
        const tt = t + rnd(0, 0.09)
        end = Math.max(end, modal(E, v.input, tt, {
          f0: rnd(2200, 4800), gain: 0.035 * g,
          partials: [{ r: 1, g: 1, decay: rnd(0.012, 0.035) }, { r: 2.6, g: 0.4, decay: 0.01 }],
        }))
      }
      return end
    },
  },

  // --- UI ---
  'ui.hover': {
    bus: 'ui', priority: 0.15, reverb: 0, dur: 0.12,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.45
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', 3200, 2.2], ['highpass', 1400, 0.7]],
        gain: 0.24 * g, attack: 0.0004, decay: 0.012,
      })
      return toneBurst(E, v.input, t, {
        type: 'triangle', f0: 2100, f1: 2100, gain: 0.16 * g, attack: 0.0008, decay: 0.035, lp: 5200,
      })
    },
  },
  'ui.select': {
    bus: 'ui', priority: 0.3, reverb: 0.03, dur: 0.3,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.6
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', 2600, 1.8], ['highpass', 1000, 0.7]],
        gain: 0.26 * g, attack: 0.0003, decay: 0.018,
      })
      let end = toneBurst(E, v.input, t, {
        type: 'triangle', f0: 660, f1: 660, gain: 0.22 * g, attack: 0.001, decay: 0.075, lp: 3600,
      })
      end = Math.max(end, toneBurst(E, v.input, t + 0.014, {
        type: 'sine', f0: 990, f1: 990, gain: 0.14 * g, attack: 0.001, decay: 0.06,
      }))
      return end
    },
  },
  'ui.confirm': {
    bus: 'ui', priority: 0.4, reverb: 0.05, dur: 0.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.62
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', 3000, 1.6], ['highpass', 1200, 0.7]],
        gain: 0.2 * g, attack: 0.0003, decay: 0.014,
      })
      let end = t
      // rising fourth: reads unambiguously as "yes"
      for (const [d, f, amp] of [[0, 587.33, 1], [0.055, 880, 0.9]]) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'triangle', f0: f, f1: f, gain: 0.2 * amp * g, attack: 0.0015, decay: 0.11, lp: 4200,
        }))
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'sine', f0: f * 2, f1: f * 2, gain: 0.07 * amp * g, attack: 0.0015, decay: 0.06,
        }))
      }
      return end
    },
  },
  'ui.cancel': {
    bus: 'ui', priority: 0.35, reverb: 0.04, dur: 0.35,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.85
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', 1800, 1.6], ['lowpass', 5000, 0.7]],
        gain: 0.17 * g, attack: 0.0004, decay: 0.016,
      })
      let end = t
      for (const [d, f] of [[0, 520], [0.05, 349.23]]) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'triangle', f0: f, f1: f, gain: 0.18 * g, attack: 0.0015, decay: 0.1, lp: 3000,
        }))
      }
      return end
    },
  },
  'ui.error': {
    bus: 'ui', priority: 0.5, reverb: 0.04, dur: 0.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.8
      let end = t
      // two clipped pulses, minor 2nd apart — beating makes it read as "wrong"
      for (const d of [0, 0.1]) {
        end = Math.max(end, driveNoise(E, v.input, t + d, {
          drive: 3, curve: 6, filterType: 'bandpass', f0: 420, f1: 300, q: 3.5,
          gain: 0.16 * g, attack: 0.002, decay: 0.06,
        }))
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'square', f0: 155, f1: 155, gain: 0.09 * g, attack: 0.002, decay: 0.07, lp: 1100,
        }))
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'square', f0: 164.8, f1: 164.8, gain: 0.07 * g, attack: 0.002, decay: 0.07, lp: 1100,
        }))
      }
      return end
    },
  },
  'ui.ability': {
    bus: 'ui', priority: 0.45, reverb: 0.08, dur: 0.6,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 1.1
      let end = noiseBurst(E, v.input, t, {
        filters: [['bandpass', [2200, 6000], 2.4], ['highpass', 1500, 0.7]],
        gain: 0.11 * g, attack: 0.003, decay: 0.16, sweepTime: 0.14,
      })
      for (const [d, r] of [[0, 1], [0.03, 1.5], [0.06, 2.0]]) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'triangle', f0: 440 * r, f1: 440 * r * 1.02, pitchTime: 0.1,
          gain: 0.13 * g / r, attack: 0.002, decay: 0.16, lp: 6000,
        }))
      }
      return end
    },
  },
  'ui.tick': {
    bus: 'ui', priority: 0.1, reverb: 0, dur: 0.08,
    render: (E, v, t, o) => noiseBurst(E, v.input, t, {
      filters: [['bandpass', 3400, 2], ['highpass', 1600, 0.7]],
      gain: 0.45 * (o.gain ?? 1), attack: 0.0002, decay: 0.011,
    }),
  },

  // --- stingers (music bus so muting music silences them too) ---
  'stinger.turn': {
    bus: 'music', priority: 0.8, reverb: 0.3, space: 'indoor', dur: 2.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 2.2
      const root = o.enemy ? 51.91 : 61.74 // G#1 vs B1
      let end = toneBurst(E, v.input, t, {
        type: 'sawtooth', f0: root, f1: root, gain: 0.3 * g, attack: 0.006, decay: 1.1, lp: 420,
      })
      end = Math.max(end, toneBurst(E, v.input, t, {
        type: 'sine', f0: root * 0.5, f1: root * 0.5, gain: 0.34 * g, attack: 0.01, decay: 1.4,
      }))
      end = Math.max(end, toneBurst(E, v.input, t + 0.16, {
        type: 'triangle', f0: root * 3, f1: root * 3, gain: 0.1 * g, attack: 0.004, decay: 0.7, lp: 1800,
      }))
      // struck-metal top so it cuts through
      end = Math.max(end, modal(E, v.input, t, {
        f0: root * 8, gain: 0.07 * g,
        partials: [{ r: 1, g: 1, decay: 0.5 }, { r: 2.76, g: 0.5, decay: 0.3 }, { r: 5.4, g: 0.25, decay: 0.16 }],
      }))
      noiseBurst(E, v.input, t, {
        filters: [['bandpass', [900, 240], 1.4]], gain: 0.1 * g, attack: 0.004, decay: 0.5, sweepTime: 0.45,
      })
      return end
    },
  },
  'stinger.kill': {
    bus: 'music', priority: 0.95, reverb: 0.35, space: 'indoor', dur: 2.2,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 1.85
      let end = toneBurst(E, v.input, t, {
        type: 'sine', f0: 92, f1: 33, pitchTime: 0.35, gain: 0.42 * g, attack: 0.004, decay: 1.0,
      })
      end = Math.max(end, modal(E, v.input, t, {
        f0: 233.08, gain: 0.11 * g, detune: 0.01,
        partials: [
          { r: 1, g: 1, decay: 0.9 },
          { r: 1.414, g: 0.7, decay: 0.7 },  // tritone — unresolved, cold
          { r: 2.83, g: 0.4, decay: 0.4 },
          { r: 5.1, g: 0.2, decay: 0.2 },
        ],
      }))
      end = Math.max(end, driveNoise(E, v.input, t, {
        drive: 3, curve: 5, filterType: 'bandpass', f0: 1400, f1: 260, q: 1.2,
        gain: 0.2 * g, attack: 0.001, decay: 0.3,
      }))
      return end
    },
  },
  'stinger.overwatch': {
    bus: 'music', priority: 0.7, reverb: 0.22, dur: 1.2,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 5.4
      let end = modal(E, v.input, t, {
        f0: 1244.5, gain: 0.09 * g,
        partials: [{ r: 1, g: 1, decay: 0.45 }, { r: 1.5, g: 0.55, decay: 0.3 }, { r: 3.02, g: 0.25, decay: 0.15 }],
      })
      end = Math.max(end, toneBurst(E, v.input, t, {
        type: 'sine', f0: 155.56, f1: 155.56, gain: 0.16 * g, attack: 0.004, decay: 0.5,
      }))
      return end
    },
  },
  'stinger.alert': {
    bus: 'music', priority: 0.85, reverb: 0.3, dur: 1.6,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 5.0
      let end = t
      for (const [d, f] of [[0, 138.59], [0.13, 146.83]]) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'sawtooth', f0: f, f1: f, gain: 0.16 * g, attack: 0.004, decay: 0.55, lp: 900,
        }))
      }
      end = Math.max(end, noiseBurst(E, v.input, t, {
        filters: [['bandpass', [3200, 800], 2]], gain: 0.09 * g, attack: 0.004, decay: 0.4, sweepTime: 0.38,
      }))
      return end
    },
  },
  'stinger.down': {
    bus: 'music', priority: 0.95, reverb: 0.4, space: 'indoor', dur: 3.0,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 2.2
      let end = toneBurst(E, v.input, t, {
        type: 'sine', f0: 74, f1: 27, pitchTime: 0.6, gain: 0.45 * g, attack: 0.006, decay: 1.6,
      })
      end = Math.max(end, toneBurst(E, v.input, t + 0.02, {
        type: 'sawtooth', f0: 110, f1: 103.8, pitchTime: 1.2, gain: 0.14 * g, attack: 0.02, decay: 1.5, lp: 480,
      }))
      end = Math.max(end, noiseBurst(E, v.input, t, {
        kind: 'brown',
        filters: [['lowpass', [900, 130], 1.1]], gain: 0.18 * g, attack: 0.01, decay: 1.1,
      }))
      return end
    },
  },
  'stinger.victory': {
    bus: 'music', priority: 1.0, reverb: 0.45, space: 'indoor', dur: 4.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 2.9
      let end = t
      // open fifths climbing — triumphant without being a fanfare
      const notes = [[0, 98], [0.35, 146.83], [0.7, 196], [1.05, 293.66]]
      for (const [d, f] of notes) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'sawtooth', f0: f, f1: f, gain: 0.13 * g, attack: 0.03, decay: 1.5, lp: 1500,
        }))
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'sine', f0: f * 1.5, f1: f * 1.5, gain: 0.06 * g, attack: 0.05, decay: 1.2,
        }))
      }
      end = Math.max(end, toneBurst(E, v.input, t, {
        type: 'sine', f0: 49, f1: 49, gain: 0.3 * g, attack: 0.05, decay: 2.6,
      }))
      return end
    },
  },
  'stinger.defeat': {
    bus: 'music', priority: 1.0, reverb: 0.5, space: 'indoor', dur: 5.0,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 2.5
      let end = t
      const notes = [[0, 116.54], [0.5, 87.31], [1.1, 58.27]]
      for (const [d, f] of notes) {
        end = Math.max(end, toneBurst(E, v.input, t + d, {
          type: 'sawtooth', f0: f, f1: f * 0.985, pitchTime: 2.2,
          gain: 0.14 * g, attack: 0.06, decay: 2.0, lp: 620,
        }))
      }
      end = Math.max(end, toneBurst(E, v.input, t, {
        type: 'sine', f0: 41, f1: 38, pitchTime: 3, gain: 0.34 * g, attack: 0.08, decay: 3.4,
      }))
      end = Math.max(end, noiseBurst(E, v.input, t, {
        kind: 'brown', filters: [['lowpass', [700, 110], 1]], gain: 0.12 * g, attack: 0.2, decay: 2.6,
      }))
      return end
    },
  },

  // --- ambient one-shots ---
  'amb.creak': {
    bus: 'ambience', priority: 0.2, reverb: 0.3, dur: 2.2,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.8
      const f = rnd(320, 700)
      // stick-slip: a series of tiny grabs reads as a creak, a smooth sweep doesn't
      let end = t
      let tt = t
      const n = rndi(7, 16)
      for (let i = 0; i < n; i++) {
        end = Math.max(end, noiseBurst(E, v.input, tt, {
          filters: [['bandpass', f * (1 + i * rnd(0.02, 0.09)), 11], ['peaking', f * 2.7, 3, 9]],
          gain: 5.0 * g * (1 - i / (n * 1.4)), attack: 0.004, decay: rnd(0.03, 0.09),
        }))
        tt += rnd(0.02, 0.07)
      }
      return end
    },
  },
  'amb.groan': {
    bus: 'ambience', priority: 0.25, reverb: 0.4, dur: 3.5,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.7
      const f = rnd(90, 190)
      let end = modal(E, v.input, t, {
        f0: f, gain: 0.09 * g, detune: 0.02,
        partials: [
          { r: 1, g: 1, decay: 1.4, attack: 0.4, bend: 0.94 },
          { r: 2.41, g: 0.5, decay: 1.0, attack: 0.5, bend: 0.95 },
          { r: 4.7, g: 0.22, decay: 0.7, attack: 0.6, bend: 0.96 },
        ],
      })
      end = Math.max(end, noiseBurst(E, v.input, t, {
        filters: [['bandpass', [f * 6, f * 3], 9]], gain: 0.05 * g, attack: 0.35, decay: 1.4, sweepTime: 1.4,
      }))
      return end
    },
  },
  'amb.bird': {
    bus: 'ambience', priority: 0.15, reverb: 0.35, dur: 1.4,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 1.1
      let end = t
      const base = rnd(2600, 4400)
      for (let i = 0; i < rndi(2, 5); i++) {
        const tt = t + i * rnd(0.07, 0.17)
        const f = base * rnd(0.9, 1.15)
        end = Math.max(end, toneBurst(E, v.input, tt, {
          type: 'sine', f0: f * rnd(0.7, 0.9), f1: f * rnd(1.05, 1.35),
          pitchTime: 0.035, gain: 0.05 * g, attack: 0.006, decay: 0.05,
        }))
        // a touch of noise makes it a bird instead of a test tone
        noiseBurst(E, v.input, tt, {
          filters: [['bandpass', f, 14]], gain: 0.02 * g, attack: 0.006, decay: 0.05,
        })
      }
      return end
    },
  },
  'amb.siren': {
    bus: 'ambience', priority: 0.2, reverb: 0.55, dur: 6.0,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 0.35
      const ctx = E.ctx
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      const lp = biquad(E, 'lowpass', 900, 1.4)
      const hp = biquad(E, 'highpass', 300, 0.7)
      const amp = gainNode(E, 0)
      chain([osc, lp, hp, amp])
      amp.connect(v.input)
      const dur = 5.0
      const base = rnd(560, 760)
      osc.frequency.setValueAtTime(base, t)
      let tt = t
      while (tt < t + dur) {
        osc.frequency.exponentialRampToValueAtTime(base * 1.32, tt + 0.55)
        osc.frequency.exponentialRampToValueAtTime(base, tt + 1.1)
        tt += 1.1
      }
      amp.gain.setValueAtTime(0.0001, t)
      amp.gain.exponentialRampToValueAtTime(0.05 * g, t + 1.2)
      amp.gain.setValueAtTime(0.05 * g, t + dur - 1.6)
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.start(t)
      osc.stop(t + dur + 0.05)
      return t + dur + 0.1
    },
  },
  'amb.debris': {
    bus: 'ambience', priority: 0.15, reverb: 0.3, dur: 1.6,
    render: (E, v, t, o) => {
      const g = (o.gain ?? 1) * 1.4
      let end = t
      for (let i = 0; i < rndi(3, 8); i++) {
        const tt = t + rnd(0, 0.9)
        end = Math.max(end, SURFACES.concrete(E, v.input, tt, 0.12 * g))
      }
      return end
    },
  },
}

function stepEntry(surface) {
  return {
    bus: 'sfx', priority: 0.25, reverb: 0.14, dur: 0.45,
    render: (E, v, t, o) => footstep(E, v.input, t, surface, o.gain ?? 1),
  }
}

/**
 * Footsteps: a heel transient plus a body, with the body's spectrum set by the
 * surface. Combat boots also rattle kit, which is what sells "a soldier moved"
 * rather than "a sound played".
 */
function footstep(E, dest, t, surface, g) {
  g *= 1.35
  let end = t
  const p = jitter(0.1)
  if (surface === 'metal') {
    g *= 0.7
    end = modal(E, dest, t, {
      f0: rnd(380, 620), gain: 0.11 * g,
      partials: [
        { r: 1, g: 1, decay: 0.28 },
        { r: 2.4, g: 0.55, decay: 0.16 },
        { r: 4.9, g: 0.3, decay: 0.08 },
        { r: 8.1, g: 0.15, decay: 0.04 },
      ],
    })
    noiseBurst(E, dest, t, {
      filters: [['bandpass', 2600 * p, 2], ['highpass', 900, 0.7]],
      gain: 0.16 * g, attack: 0.0004, decay: 0.03,
    })
  } else if (surface === 'gravel') {
    end = noiseBurst(E, dest, t, {
      filters: [['bandpass', 2400 * p, 1.2], ['highpass', 700, 0.7]],
      gain: 0.2 * g, attack: 0.0008, decay: 0.045,
    })
    for (let i = 0; i < rndi(3, 7); i++) {
      noiseBurst(E, dest, t + rnd(0.005, 0.13), {
        filters: [['bandpass', rnd(2600, 6000), 9]],
        gain: 0.03 * g, attack: 0.0003, decay: 0.012,
      })
      end = Math.max(end, t + 0.2)
    }
  } else if (surface === 'dirt') {
    end = noiseBurst(E, dest, t, {
      kind: 'pink',
      filters: [['lowpass', [1500, 320], 1.2], ['highpass', 110, 0.6]],
      gain: 0.24 * g, attack: 0.0012, decay: 0.06,
    })
  } else if (surface === 'wood') {
    end = modal(E, dest, t, {
      f0: rnd(150, 240), gain: 0.13 * g,
      partials: [{ r: 1, g: 1, decay: 0.09 }, { r: 2.2, g: 0.5, decay: 0.05 }, { r: 4.4, g: 0.2, decay: 0.025 }],
    })
    noiseBurst(E, dest, t, {
      filters: [['bandpass', 1300 * p, 1.4], ['lowpass', 5000, 0.7]],
      gain: 0.16 * g, attack: 0.0006, decay: 0.035,
    })
  } else {
    // concrete / asphalt
    end = noiseBurst(E, dest, t, {
      filters: [['bandpass', 1500 * p, 1.1], ['highpass', 400, 0.7], ['lowpass', 7000, 0.6]],
      gain: 0.22 * g, attack: 0.0005, decay: 0.038,
    })
    end = Math.max(end, noiseBurst(E, dest, t, {
      filters: [['highpass', 4200, 0.7]],
      gain: 0.06 * g, attack: 0.0002, decay: 0.01,
    }))
  }
  // low body — the mass of a person landing. Kept well under the surface
  // layer: a boot is a click with weight behind it, not a kick drum.
  end = Math.max(end, toneBurst(E, dest, t, {
    type: 'sine', f0: rnd(105, 145), f1: rnd(58, 72), pitchTime: 0.035,
    gain: 0.055 * g, attack: 0.0018, decay: 0.05, lp: 260,
  }))
  // kit rattle
  if (Math.random() < 0.75) {
    for (let i = 0; i < rndi(1, 3); i++) {
      modal(E, dest, t + rnd(0.01, 0.08), {
        f0: rnd(2400, 5000), gain: 0.02 * g,
        partials: [{ r: 1, g: 1, decay: rnd(0.01, 0.03) }],
      })
    }
    end = Math.max(end, t + 0.15)
  }
  return end
}

/**
 * Explosion. Four stacked events plus two mix-level gestures:
 *   sub impulse -> bright shock front -> saturated body -> debris rain,
 *   and a master duck + lowpass "shock" so the blast owns the mix for a beat,
 *   followed by a very quiet ear-ring that fades as the mix reopens.
 */
function explosion(E, v, t, o, scale = 1) {
  const g = (o.gain ?? 1) * scale * 2.4
  const dest = v.input
  let end = t

  // 1 — sub impulse: the part you feel
  end = Math.max(end, toneBurst(E, dest, t, {
    type: 'sine',
    f0: 72 * rnd(0.9, 1.1) / scale ** 0.3, f1: 26, pitchTime: 0.22 * scale,
    gain: 0.85 * g, attack: 0.004, decay: 0.75 * scale,
  }))
  end = Math.max(end, toneBurst(E, dest, t + 0.004, {
    type: 'triangle', f0: 148, f1: 44, pitchTime: 0.1,
    gain: 0.4 * g, attack: 0.002, decay: 0.28 * scale, lp: 700,
  }))

  // 2 — shock front: extremely short, extremely bright
  end = Math.max(end, noiseBurst(E, dest, t, {
    filters: [['highpass', 2400, 0.7], ['peaking', 6000, 1.2, 8]],
    gain: 0.42 * g, attack: 0.0004, decay: 0.045,
  }))

  // 3 — saturated body sweeping down: the "roar"
  end = Math.max(end, driveNoise(E, dest, t, {
    kind: 'pink', drive: 3.6, curve: 6,
    filterType: 'lowpass', f0: 3600, f1: 190, q: 1.4,
    gain: 0.6 * g, attack: 0.0015, decay: 0.62 * scale, sweepTime: 0.5 * scale,
  }))
  end = Math.max(end, noiseBurst(E, dest, t + 0.01, {
    kind: 'brown',
    filters: [['lowpass', [900, 120], 1.1]],
    gain: 0.34 * g, attack: 0.01, decay: 1.05 * scale,
  }))

  // 4 — debris rain: individual pieces, thinning out
  const pieces = Math.round(rndi(11, 20) * scale)
  for (let i = 0; i < pieces; i++) {
    const tt = t + 0.09 + Math.pow(Math.random(), 0.6) * 1.25 * scale
    const amp = 0.16 * g * (1 - (tt - t) / (1.5 * scale)) * rnd(0.5, 1.2)
    if (amp <= 0) continue
    const which = Math.random()
    if (which < 0.55) SURFACES.concrete(E, dest, tt, amp)
    else if (which < 0.8) SURFACES.metal(E, dest, tt, amp * 0.5)
    else SURFACES.dirt(E, dest, tt, amp)
    end = Math.max(end, tt + 0.35)
  }
  // gravel wash under the debris
  end = Math.max(end, noiseBurst(E, dest, t + 0.12, {
    kind: 'pink',
    filters: [['bandpass', [3000, 900], 1.1], ['highpass', 500, 0.7]],
    gain: 0.06 * g, attack: 0.05, decay: 0.9 * scale,
  }))

  // Mix gestures. Both start ~60 ms late so the blast's own transient passes
  // at full level and it is the *rest* of the mix that gets shoved out of the
  // way — ducking from sample zero just makes the explosion quieter.
  E.duck(0.4 + 0.25 * (1 - scale), 0.03, 1.0 * scale, t + 0.06)
  E.shock(900 / scale, 0.85 * scale, t + 0.07)

  // ear-ring: non-positional, very quiet, fades as the mix reopens
  const ring = E.voice({ bus: 'ui', priority: 0.99, duration: 2.4 * scale })
  if (ring) {
    for (const [f, a] of [[4180, 1], [4192, 0.7], [6350, 0.35]]) {
      toneBurst(E, ring.input, t + 0.02, {
        type: 'sine', f0: f, f1: f * 0.985, pitchTime: 1.6,
        gain: 0.022 * a * scale, attack: 0.05, decay: 1.7 * scale,
      })
    }
  }
  return end
}

// ---------------------------------------------------------------------------

/** Trigger a catalogue entry. Returns the voice, or null if audio is asleep. */
export function playSfx(E, id, opts = {}) {
  const def = CATALOGUE[id]
  if (!def) return null
  if (!E.live()) return null
  const v = E.voice({
    bus: opts.bus || def.bus,
    priority: opts.priority ?? def.priority,
    reverb: opts.reverb ?? def.reverb ?? 0,
    space: opts.space || def.space || 'outdoor',
    position: opts.position || null,
    gain: opts.volume ?? 1,
    duration: (opts.duration ?? def.dur ?? 1) + (opts.delay ?? 0),
  })
  if (!v) return null
  const t = E.now() + (opts.delay ?? 0)
  try {
    def.render(E, v, t, opts)
  } catch (err) {
    E.report(`sound "${id}"`, err)
    E.release(v, 0)
    return null
  }
  return v
}

export const SFX_IDS = Object.keys(CATALOGUE)
export { GUNS, SURFACES, footstep }
