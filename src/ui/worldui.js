/* ============================================================================
   DOPE UFO — World-anchored UI
   ----------------------------------------------------------------------------
   Health bars, floating damage numbers and cover shields, all drawn to a single
   2D canvas overlay.

   Why canvas and not DOM: this runs every frame at 1440p. One canvas is one
   composited layer with zero style recalculation, versus ~40 absolutely
   positioned elements each dirtying layout. Everything here is pooled — the
   per-frame path allocates nothing: scratch vectors, the floater pool and the
   colour strings are all created once at init.
   ========================================================================== */

const BONE = '#E6E9DE'
const SLATE = '#7E8A7C'
const EMBER = '#FF5A3C'
const CRIMSON = '#FF2340'
const LIME = '#7CFF4A'
const TEAM_COL = ['#FFAE1A', '#A855FF']

/* Bar fill reads HEALTH, not team — team lives in the 3px edge tab. A frame of
   eight saturated team-coloured bars out-shouts the soldiers; a frame of eight
   bone-grey ones lets the two that are actually hurt do the talking. */
const HP_OK = '#B6C1B2'
const HP_HURT = '#E2A63E'
const HP_CRIT = '#F2503E'

/* Base geometry in CSS px at scale 1 / 1080p. Everything else derives. */
const BAR_W = 34
const BAR_H = 4.2
const BAR_TAB = 3
const BAR_GAP = 2 // tab -> bar
const HEAD_PAD = 3 // bar bottom above the projected head point
const HEAD_Y = 1.86 // metres above the unit origin — just clear of the helmet
const STACK_PAD = 3 // min vertical air between two stacked bars

/* Must match --f-display in fonts.css: canvas has no cascade to inherit from. */
const FONT = '"DIN Condensed","DIN Alternate","PT Sans Narrow","Arial Narrow",sans-serif'

const POOL = 40

export function createWorldUI(ctx, root, store) {
  const THREE = ctx.THREE
  const canvas = document.createElement('canvas')
  canvas.className = 'wui'
  root.appendChild(canvas)
  const g = canvas.getContext('2d', { alpha: true, desynchronized: true })

  let W = 0
  let H = 0
  let dpr = 1
  let enabled = true

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  /* -------------------------------------------------- scratch (no GC churn) */
  const vHead = new THREE.Vector3()
  const vFoot = new THREE.Vector3()
  const vCam = new THREE.Vector3()
  const vTmp = new THREE.Vector3()
  const ray = new THREE.Ray()
  const occlusion = new Map() // unitId -> { a, want } — damped 0..1 occlusion
  let occCursor = 0

  /* --------------------------------------------------------- floater pool */
  const floaters = []
  for (let i = 0; i < POOL; i++) {
    floaters.push({
      live: false,
      anchor: new THREE.Vector3(),
      t: 0,
      life: 1.5,
      vx: 0,
      text: '',
      tag: '',
      kind: 'dmg',
      size: 30,
    })
  }
  let floaterCursor = 0

  function worldOf(unitId, out) {
    const obj = ctx.units?.getObject?.(unitId)
    if (obj && obj.getWorldPosition) {
      obj.getWorldPosition(out)
      return out
    }
    const u = store.unit(unitId)
    if (!u) return null
    ctx.grid.toWorld(u.x | 0, u.z | 0, u.elevation | 0, out)
    return out
  }

  function spawn(unitId, text, kind, tag) {
    const p = worldOf(unitId, vTmp)
    if (!p) return
    const f = floaters[floaterCursor]
    floaterCursor = (floaterCursor + 1) % POOL
    f.live = true
    f.t = 0
    f.anchor.copy(p)
    f.anchor.y += 2.15
    f.text = text
    f.tag = tag || ''
    f.kind = kind
    f.vx = (Math.random() * 2 - 1) * 34
    f.life = kind === 'crit' ? 1.85 : 1.35
    f.size = kind === 'crit' ? 62 : kind === 'miss' || kind === 'graze' ? 36 : 46
  }

  /* ---------------------------------------------------------- bus wiring */
  const off = []
  const on = (ev, fn) => off.push(ctx.bus.on(ev, fn))

  on('unit:damaged', (p) => {
    if (!p || !p.unitId) return
    if (p.graze) spawn(p.unitId, `−${Math.max(0, Math.round(p.dmg || 0))}`, 'graze', 'GRAZE')
    else if (p.crit) spawn(p.unitId, `−${Math.max(0, Math.round(p.dmg || 0))}`, 'crit', 'CRITICAL')
    else spawn(p.unitId, `−${Math.max(0, Math.round(p.dmg || 0))}`, 'dmg', '')
    flash(p.unitId, p.crit ? 0.55 : 0.35)
  })
  on('unit:shoot', (p) => {
    if (!p || !p.targetId) return
    if (p.hit === false) spawn(p.targetId, 'MISS', 'miss', '')
  })
  on('unit:died', (p) => p?.unitId && flash(p.unitId, 0.8))

  const hits = new Map() // unitId -> flash amount
  function flash(id, amt) {
    hits.set(id, Math.max(hits.get(id) || 0, amt))
  }

  let hoverTile = null
  on('tile:hover', (p) => {
    hoverTile = p && typeof p.x === 'number' ? p : null
  })
  let hoverUnit = null
  on('unit:hover', (p) => {
    hoverUnit = p && p.unitId ? p.unitId : null
  })
  on('engine:resize', resize)

  /* -------------------------------------------------------------- shapes */

  /** Parallelogram — the HUD's pip language, repeated in world space. */
  function shear(x, y, w, h, k) {
    g.beginPath()
    g.moveTo(x + k, y)
    g.lineTo(x + w + k, y)
    g.lineTo(x + w, y + h)
    g.lineTo(x, y + h)
    g.closePath()
  }

  /** XCOM cover shield. level 1 = half (bottom filled), 2 = full. */
  function shield(cx, cy, r, level, col) {
    const path = new Path2D()
    path.moveTo(cx, cy - r)
    path.lineTo(cx + r * 0.82, cy - r * 0.62)
    path.lineTo(cx + r * 0.82, cy + r * 0.14)
    path.quadraticCurveTo(cx + r * 0.8, cy + r * 0.82, cx, cy + r * 1.1)
    path.quadraticCurveTo(cx - r * 0.8, cy + r * 0.82, cx - r * 0.82, cy + r * 0.14)
    path.lineTo(cx - r * 0.82, cy - r * 0.62)
    path.closePath()

    g.save()
    g.fillStyle = 'rgba(6,10,8,.72)'
    g.fill(path)
    if (level >= 2) {
      g.fillStyle = col
      g.fill(path)
    } else if (level === 1) {
      g.save()
      g.beginPath()
      g.rect(cx - r * 1.2, cy, r * 2.4, r * 1.4)
      g.clip()
      g.fillStyle = col
      g.fill(path)
      g.restore()
    }
    g.lineWidth = 1.6
    g.strokeStyle = col
    g.stroke(path)
    g.restore()
  }

  /* ------------------------------------------------------------- project */
  const scr = { x: 0, y: 0, ok: false, dist: 0, scale: 1 }
  function project(v) {
    vTmp.copy(v).project(ctx.camera)
    // Margin is just wide enough to keep a bar attached as its unit slides off
    // the edge. Wider than this and we draw at negative screen coords for units
    // that are genuinely gone.
    scr.ok = vTmp.z < 1 && vTmp.x > -1.12 && vTmp.x < 1.12 && vTmp.y > -1.12 && vTmp.y < 1.08
    scr.x = (vTmp.x * 0.5 + 0.5) * W
    scr.y = (-vTmp.y * 0.5 + 0.5) * H
    return scr
  }

  /* ------------------------------------------------------------ occlusion
     world/ exposes blockersForLOS() -> Mesh[] with a parallel `.boxes` array of
     Box3s (the same proxies the rules module shoots LOS rays through). We use
     the boxes, not the meshes: a camera->head ray tested against N AABBs is a
     handful of float compares each, where Raycaster.intersectObjects would walk
     matrices and build hit records every frame.

     Budget: at most OCC_PER_FRAME units per frame, round-robin, and the result
     drives a damped alpha rather than a hard toggle so a soldier walking behind
     a wall dissolves instead of popping. */
  const OCC_PER_FRAME = 3
  const OCC_MAX_BOXES = 900
  let boxCache = null
  let boxWarned = false

  function losBoxes() {
    if (boxCache !== null) return boxCache
    const w = ctx.world
    if (!w || typeof w.blockersForLOS !== 'function') {
      boxCache = false
      if (!boxWarned) {
        boxWarned = true
        console.warn('[ui] world.blockersForLOS() unavailable — health-bar occlusion disabled')
      }
      return false
    }
    let list = null
    try {
      list = w.blockersForLOS()
    } catch {
      list = null
    }
    const b = list && Array.isArray(list.boxes) ? list.boxes : null
    if (!b || !b.length || b.length > OCC_MAX_BOXES) {
      boxCache = false
      if (!boxWarned) {
        boxWarned = true
        console.warn(`[ui] LOS box set unusable (${b ? b.length : 'none'}) — occlusion disabled`)
      }
      return false
    }
    boxCache = b
    return b
  }

  /** 0 = clear, 1 = fully behind geometry. Damped in stepOcclusion. */
  function occlusionOf(unitId) {
    const rec = occlusion.get(unitId)
    return rec ? rec.a : 0
  }

  function stepOcclusion(units, dt) {
    const boxes = losBoxes()
    if (!boxes || !units.length) return
    ctx.camera.getWorldPosition(vCam)

    const n = Math.min(OCC_PER_FRAME, units.length)
    for (let i = 0; i < n; i++) {
      occCursor = (occCursor + 1) % units.length
      const u = units[occCursor]
      if (!u) continue
      const p = worldOf(u.id, vTmp)
      if (!p) continue
      // Aim at the bar itself, not the chest: what we care about is whether the
      // player can see the pixels we are about to draw.
      vHead.copy(p)
      vHead.y += 2.0
      const dir = vFoot.copy(vHead).sub(vCam)
      const len = dir.length()
      if (len < 0.001) continue
      dir.multiplyScalar(1 / len)
      ray.origin.copy(vCam)
      ray.direction.copy(dir)
      // Stop short of the unit so its own cover prop never hides its bar.
      const far = len - 1.3
      let blocked = false
      if (far > 0.05) {
        for (let b = 0; b < boxes.length; b++) {
          const hit = ray.intersectBox(boxes[b], vTmp)
          if (hit && vCam.distanceToSquared(vTmp) < far * far) {
            blocked = true
            break
          }
        }
      }
      let rec = occlusion.get(u.id)
      if (!rec) {
        rec = { a: 0, want: 0 }
        occlusion.set(u.id, rec)
      }
      rec.want = blocked ? 1 : 0
    }

    // damp every tracked unit toward its last sampled state
    const k = Math.min(1, dt * 7)
    for (const rec of occlusion.values()) rec.a += (rec.want - rec.a) * k
  }

  /* ----------------------------------------------------------- health bar

     One compact pip strip, roughly a quarter of the width it used to be. It has
     three loudness levels:

       rest      full hp, nobody looking at it -> ~0.3 alpha, bone-grey
       damaged   alpha ramps with missing hp   -> up to ~0.95, amber then red
       focus     selected / hovered / targeted -> full alpha + name + brackets

     Anything that is not currently costing the player a decision stays quiet. */

  function barMetrics(scale, out) {
    out.w = BAR_W * scale
    out.h = Math.max(3, BAR_H * scale)
    out.tab = BAR_TAB * scale
    out.gap = BAR_GAP * scale
    out.k = out.h * 0.55
    out.full = out.tab + out.gap + out.w + out.k
    return out
  }
  const met = { w: 0, h: 0, tab: 0, gap: 0, k: 0, full: 0 }

  function drawBar(u, sx, sy, scale, alpha, focus, isTgt) {
    barMetrics(scale, met)
    const { w, h, tab, gap, k } = met
    const x0 = Math.round(sx - (tab + gap + w) / 2)
    const y0 = Math.round(sy - h)
    const bx = x0 + tab + gap
    const col = TEAM_COL[u.team === 1 ? 1 : 0]
    const dead = u.alive === false

    const hpMax = Math.max(1, u.hpMax | 0)
    const hp = dead ? 0 : Math.max(0, Math.min(hpMax, u.hp | 0))
    const frac = hp / hpMax
    const fill = dead ? SLATE : frac <= 0.34 ? HP_CRIT : frac <= 0.67 ? HP_HURT : HP_OK

    g.save()
    g.globalAlpha = alpha

    // trough — a hair of dark under the bar so it survives a pale background
    g.fillStyle = 'rgba(4,7,6,.62)'
    shear(x0 - 1, y0 - 1, tab + gap + w + 2, h + 2, k)
    g.fill()

    // team tab: the only saturated pixel on a resting bar, and it is 3px wide
    g.fillStyle = col
    shear(x0, y0, tab, h, k)
    g.fill()

    // empty track
    g.fillStyle = 'rgba(226,232,220,.13)'
    shear(bx, y0, w, h, k)
    g.fill()

    // fill
    if (hp > 0) {
      g.fillStyle = fill
      shear(bx, y0, w * frac, h, k)
      g.fill()
    }

    // pip dividers — only while they'd still read as pips, never as noise
    const segW = w / hpMax
    if (hpMax <= 10 && segW >= 5 && hpMax > 1) {
      g.strokeStyle = 'rgba(4,7,6,.72)'
      g.lineWidth = 1
      g.beginPath()
      for (let i = 1; i < hpMax; i++) {
        const x = bx + i * segW
        g.moveTo(x + k, y0)
        g.lineTo(x, y0 + h)
      }
      g.stroke()
    }

    // hit flash
    const flashAmt = hits.get(u.id) || 0
    if (flashAmt > 0.01) {
      g.globalAlpha = Math.min(1, alpha + flashAmt)
      g.fillStyle = '#fff'
      shear(bx, y0, w, h, k)
      g.fill()
      g.globalAlpha = alpha
    }

    // focus outline replaces the old always-on border
    if (focus) {
      g.lineWidth = 1
      g.strokeStyle = isTgt ? CRIMSON : 'rgba(230,233,222,.55)'
      shear(x0 - 1, y0 - 1, tab + gap + w + 2, h + 2, k)
      g.stroke()
    }

    // armour: thin ticks hugging the top edge, and only when they're actionable
    const arm = u.armor | 0
    if (arm > 0 && !dead && (focus || frac < 1)) {
      const n = Math.min(arm, 5)
      const tw = Math.max(2, w * 0.1)
      g.strokeStyle = '#9FB4C7'
      g.lineWidth = Math.max(1, 1.4 * scale)
      g.beginPath()
      for (let i = 0; i < n; i++) {
        const x = bx + i * (tw + 2 * scale)
        g.moveTo(x + k, y0 - 2 * scale)
        g.lineTo(x + tw + k, y0 - 2 * scale)
      }
      g.stroke()
    }

    // Name: selected / hovered / targeted only. Four permanent callsigns over
    // four soldiers is a debug readout, not an interface.
    if (focus) {
      const fs = Math.max(10, 11.5 * scale)
      g.font = `700 ${fs}px ${FONT}`
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      const label = (u.name || u.id).toUpperCase()
      const ty = y0 - (arm > 0 ? 6 : 3) * scale
      g.lineWidth = 2.5
      g.lineJoin = 'round'
      g.strokeStyle = 'rgba(4,7,6,.85)'
      g.strokeText(label, sx, ty)
      g.fillStyle = isTgt ? CRIMSON : col
      g.fillText(label, sx, ty)
    }

    // target brackets
    if (isTgt) {
      const b = 3.5 * scale
      const L = x0 - 3 * scale
      const R = x0 + tab + gap + w + 3 * scale
      const T = y0 - 3 * scale
      const B = y0 + h + 3 * scale
      g.lineWidth = Math.max(1, 1.4 * scale)
      g.strokeStyle = CRIMSON
      g.beginPath()
      g.moveTo(L, T + b); g.lineTo(L, T); g.lineTo(L + b, T)
      g.moveTo(R - b, T); g.lineTo(R, T); g.lineTo(R, T + b)
      g.moveTo(R, B - b); g.lineTo(R, B); g.lineTo(R - b, B)
      g.moveTo(L + b, B); g.lineTo(L, B); g.lineTo(L, B - b)
      g.stroke()
    }

    g.restore()
  }

  /* --------------------------------------------------------------- cover */
  function drawCover(u, sx, sy, scale) {
    const tile = store.tile(u.x, u.z)
    if (!tile || !tile.cover) return
    const r = Math.max(6, 9.5 * scale)
    const off = 26 * scale
    const dirs = [
      ['n', 0, -off * 0.62],
      ['e', off, 0],
      ['s', 0, off * 0.62],
      ['w', -off, 0],
    ]
    for (const [d, dx, dy] of dirs) {
      const lvl = tile.cover[d] | 0
      if (lvl <= 0) continue
      shield(sx + dx, sy + dy, r, lvl, u.hunkered ? '#7CFF4A' : BONE)
    }
  }

  function drawPreviewCover() {
    if (!hoverTile) return
    const state = store.state()
    if (state.pendingAction !== 'move' && state.phase !== 'moving' && state.pendingAction !== null) return
    const tile = store.tile(hoverTile.x, hoverTile.z)
    if (!tile || !tile.cover) return
    ctx.grid.toWorld(hoverTile.x, hoverTile.z, tile.elevation | 0, vTmp)
    const p = project(vTmp)
    if (!p.ok) return
    const dist = ctx.camera.position.distanceTo(vTmp)
    const scale = Math.max(0.6, Math.min(1.2, 26 / Math.max(1, dist)))
    const r = Math.max(8, 13.5 * scale)
    const off = 32 * scale
    const dirs = [['n', 0, -off * 0.62], ['e', off, 0], ['s', 0, off * 0.62], ['w', -off, 0]]
    g.save()
    g.globalAlpha = 0.85
    for (const [d, dx, dy] of dirs) {
      const lvl = tile.cover[d] | 0
      if (lvl > 0) shield(p.x + dx, p.y + dy - 8 * scale, r, lvl, '#9FE8FF')
    }
    g.restore()
  }

  /* ------------------------------------------------------------ floaters */
  function drawFloaters(dt) {
    for (const f of floaters) {
      if (!f.live) continue
      f.t += dt
      if (f.t >= f.life) {
        f.live = false
        continue
      }
      const p = project(f.anchor)
      if (!p.ok) continue
      const t = f.t / f.life
      // pop -> settle
      const pop = t < 0.16 ? 0.35 + (t / 0.16) * 0.95 : 1.3 - Math.min(1, (t - 0.16) / 0.22) * 0.3
      const rise = -74 * t + 26 * t * t
      const alpha = t > 0.62 ? 1 - (t - 0.62) / 0.38 : 1
      const col =
        f.kind === 'crit' ? EMBER : f.kind === 'miss' ? SLATE : f.kind === 'graze' ? '#C9CFC0' : f.kind === 'heal' ? LIME : BONE

      g.save()
      g.globalAlpha = Math.max(0, alpha)
      g.translate(p.x + f.vx * t, p.y + rise)
      g.scale(pop, pop)
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = `700 ${f.size}px ${FONT}`
      g.lineWidth = 5
      g.lineJoin = 'round'
      g.strokeStyle = 'rgba(3,6,5,.92)'
      g.strokeText(f.text, 0, 0)
      g.fillStyle = col
      g.fillText(f.text, 0, 0)
      if (f.tag) {
        g.font = `700 ${Math.round(f.size * 0.34)}px ${FONT}`
        const ty = f.size * 0.62
        g.lineWidth = 4
        g.strokeText(f.tag, 0, ty)
        g.fillStyle = col
        g.fillText(f.tag, 0, ty)
      }
      g.restore()
    }
  }

  /* ------------------------------------------------------- placement pool
     Bars are laid out before anything is drawn so adjacent soldiers can dodge
     each other. Everything here is preallocated: the slot objects, the index
     array and the sort comparator. A frame allocates nothing. */
  const SLOTS = 48
  const slots = []
  for (let i = 0; i < SLOTS; i++) {
    slots.push({ u: null, x: 0, y: 0, scale: 1, alpha: 1, focus: false, tgt: false, w: 0, h: 0 })
  }
  const order = new Array(SLOTS)
  const byDepth = (a, b) => b.y - a.y // nearest (lowest on screen) placed first

  /** Resting alpha, before occlusion. */
  function restAlpha(u, focus, damagedFrac) {
    if (focus) return 1
    if (u.alive === false) return 0.26
    // full health, nobody's looking: barely there
    if (damagedFrac >= 1) return 0.38
    // the more it's hurt the louder it gets
    return 0.42 + (1 - damagedFrac) * 0.56
  }

  function update(dt) {
    g.clearRect(0, 0, W, H)
    if (!enabled) return

    const state = store.state()
    const units = state.units || []

    // decay hit flashes
    if (hits.size) {
      for (const [k, v] of hits) {
        const n = v - dt * 3.4
        if (n <= 0) hits.delete(k)
        else hits.set(k, n)
      }
    }

    stepOcclusion(units, dt)
    drawPreviewCover()

    const sel = store.selected()
    // Keep bars a constant fraction of the soldiers they sit on: the units grow
    // with viewport height, so the chrome has to as well.
    const res = Math.max(0.9, Math.min(1.7, H / 1080))

    /* ---- pass 1: project + measure ---- */
    let n = 0
    for (let i = 0; i < units.length && n < SLOTS; i++) {
      const u = units[i]
      if (!u) continue
      if (u.alive === false && !hits.has(u.id)) continue
      const p3 = worldOf(u.id, vHead)
      if (!p3) continue
      const dist = ctx.camera.position.distanceTo(p3)
      p3.y += HEAD_Y
      const p = project(p3)
      if (!p.ok) continue

      const occ = occlusionOf(u.id)
      const isSel = state.selectedUnitId === u.id || (sel && sel.id === u.id)
      const isTgt = state.targetUnitId === u.id
      const isHov = hoverUnit === u.id
      const focus = !!(isSel || isTgt || isHov)
      if (occ > 0.985 && !focus) continue

      const scale = res * Math.max(0.8, Math.min(1.25, 26 / Math.max(1, dist)))
      const hpMax = Math.max(1, u.hpMax | 0)
      const frac = u.alive === false ? 0 : Math.max(0, Math.min(hpMax, u.hp | 0)) / hpMax
      let alpha = restAlpha(u, focus, frac)
      // occluded units fade out; a focused one keeps a ghost so you never lose it
      alpha *= 1 - occ * (focus ? 0.62 : 1)
      if (alpha < 0.02) continue

      barMetrics(scale, met)
      const s = slots[n++]
      s.u = u
      s.x = p.x
      s.y = p.y - HEAD_PAD * scale
      s.scale = scale
      s.alpha = alpha
      s.focus = focus
      s.tgt = isTgt
      s.w = met.full
      s.h = met.h + (focus ? 13 * scale : 3 * scale) // reserve the name line
    }

    /* ---- pass 2: screen-space dodge ---- */
    for (let i = 0; i < n; i++) order[i] = slots[i]
    // partial sort over <=8 entries; Array#sort on a reused array is free here
    order.length = n
    order.sort(byDepth)
    for (let i = 0; i < n; i++) {
      const a = order[i]
      // lift above any already-placed bar we'd collide with, repeatedly, since
      // one lift can push us into a third bar
      for (let pass = 0; pass < 4; pass++) {
        let moved = false
        for (let j = 0; j < i; j++) {
          const b = order[j]
          const dx = Math.abs(a.x - b.x)
          if (dx > (a.w + b.w) * 0.5 + 2) continue
          const top = b.y - b.h
          if (a.y > top - STACK_PAD && a.y - a.h < b.y + STACK_PAD) {
            a.y = top - STACK_PAD
            moved = true
          }
        }
        if (!moved) break
      }
    }

    /* ---- pass 3: draw ---- */
    for (let i = 0; i < n; i++) {
      const s = slots[i]
      drawBar(s.u, s.x, s.y, s.scale, s.alpha, s.focus, s.tgt)
      s.u = null
    }

    /* ---- cover shields, selected unit only ---- */
    if (sel) {
      const p3 = worldOf(sel.id, vFoot)
      if (p3) {
        const dist = ctx.camera.position.distanceTo(p3)
        const scale = res * Math.max(0.8, Math.min(1.25, 26 / Math.max(1, dist)))
        const pf = project(p3)
        if (pf.ok) drawCover(sel, pf.x, pf.y, scale)
      }
    }

    drawFloaters(dt)
  }

  return {
    el: canvas,
    update,
    spawn,
    /** 0..1 — how much of this unit's bar is hidden by level geometry. */
    occlusionOf,
    setEnabled(v) {
      enabled = !!v
      if (!v) g.clearRect(0, 0, W, H)
    },
    dispose() {
      off.forEach((f) => f && f())
      off.length = 0
      window.removeEventListener('resize', resize)
      canvas.remove()
    },
  }
}
