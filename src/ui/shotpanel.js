/* ============================================================================
   DOPE UFO — Shot panel  (the signature screen)
   ----------------------------------------------------------------------------
   This is the one panel players stare at, so it is built as a *ballistic
   computer ledger* rather than a tooltip: every modifier gets a signed value
   AND a magnitude bar growing out of a centre line, then a hairline rule, then
   the total. The arithmetic is visible. If the numbers don't add up the player
   can see that they don't add up, which is the entire point of XCOM's
   transparency contract.

   Numbers come from ctx.game.previewShot(attacker, target):
     { hitChance, critChance, dodgeChance, dmgMin, dmgMax, modifiers:[{label,value}] }
   ========================================================================== */

/* red → ember → warm bone → phosphor lime.
   Deliberately NOT red→amber→green: saturated amber is Player 1's identity
   colour and must never double as a probability signal. */
const RAMP = [
  [0, 0xff, 0x23, 0x40],
  [30, 0xff, 0x5a, 0x3c],
  [52, 0xef, 0xe3, 0xc8],
  [74, 0xc6, 0xf0, 0x75],
  [100, 0x7c, 0xff, 0x4a],
]

function rampColor(pct) {
  const p = Math.max(0, Math.min(100, pct || 0))
  let a = RAMP[0]
  let b = RAMP[RAMP.length - 1]
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (p >= RAMP[i][0] && p <= RAMP[i + 1][0]) {
      a = RAMP[i]
      b = RAMP[i + 1]
      break
    }
  }
  const t = b[0] === a[0] ? 0 : (p - a[0]) / (b[0] - a[0])
  const r = Math.round(a[1] + (b[1] - a[1]) * t)
  const g = Math.round(a[2] + (b[2] - a[2]) * t)
  const bl = Math.round(a[3] + (b[3] - a[3]) * t)
  return `${r} ${g} ${bl}`
}

const signed = (v) => (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`)

function bustSVG() {
  return (
    '<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><g fill="currentColor">' +
    '<path d="M12 4.4c2.5 0 4.1 1.8 4.1 4.2 0 2.5-1.8 4.5-4.1 4.5s-4.1-2-4.1-4.5c0-2.4 1.6-4.2 4.1-4.2Z"/>' +
    '<path d="M12 13.6c4.5 0 7.6 2.6 8.3 6.6l.4 3.8H3.3l.4-3.8c.7-4 3.8-6.6 8.3-6.6Z"/>' +
    '</g></svg>'
  )
}

export function createShotPanel(ctx, root, store) {
  const el = document.createElement('div')
  el.className = 'shot'
  el.innerHTML = `
    <div class="shot__plate plate">
      <div class="shot__hd">
        <span class="shot__eyebrow">Firing solution</span>
        <span class="shot__wep num" data-wep></span>
      </div>

      <div class="shot__hero">
        <div class="ret" data-ret>
          <svg class="ret__frame" viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor">
            <path d="M2 22V2h20M78 2h20v20M98 78v20H78M22 98H2V78" stroke-width="2"/>
            <path d="M50 0v7M50 100v-7M0 50h7M100 50h-7" stroke-width="2" opacity=".7"/>
            <circle cx="50" cy="50" r="43" stroke-width="1" opacity=".18" stroke-dasharray="3 5"/>
          </svg>
          <div class="ret__val"><span class="ret__num num" data-pct>0</span><span class="ret__pc">%</span></div>
          <div class="ret__lbl">Hit chance</div>
        </div>

        <div class="tgt">
          <div class="tgt__row">
            <span class="tgt__ix num" data-ix>—</span>
            <span class="tgt__lbl">Target</span>
          </div>
          <h3 class="tgt__name" data-name>—</h3>
          <div class="tgt__sub"><span class="tgt__cls" data-cls></span></div>
          <div class="tgt__hp">
            <span class="pips pips--mini" data-hp></span>
            <span class="tgt__hpv num" data-hpv></span>
          </div>
          <div class="tgt__port"><span class="tgt__bust">${bustSVG()}</span></div>
        </div>
      </div>

      <div class="odds">
        <div class="odd" data-odd="dmg"><span class="odd__k">Damage</span><span class="odd__v num" data-dmg>—</span></div>
        <div class="odd" data-odd="crit"><span class="odd__k">Crit</span><span class="odd__v num" data-crit>—</span></div>
        <div class="odd" data-odd="dodge"><span class="odd__k">Dodge</span><span class="odd__v num" data-dodge>—</span></div>
      </div>

      <div class="ledger">
        <div class="ledger__hd"><span>Modifier</span><span class="num">Δ Aim</span></div>
        <div class="ledger__rows" data-rows></div>
        <div class="ledger__sum">
          <span class="ledger__sumk">Total</span>
          <span class="ledger__sumbar" aria-hidden="true"></span>
          <span class="ledger__sumv num" data-sum>0</span>
        </div>
        <div class="ledger__warn" data-warn></div>
      </div>

      <div class="cyc">
        <button type="button" class="cyc__nav" data-nav="-1" aria-label="Previous target"><span>Q</span></button>
        <div class="cyc__list" data-cyc></div>
        <button type="button" class="cyc__nav" data-nav="1" aria-label="Next target"><span>E</span></button>
      </div>

      <button type="button" class="confirm" data-confirm>
        <span class="confirm__fill" aria-hidden="true"></span>
        <span class="confirm__t">Confirm shot</span>
        <span class="confirm__k num">ENTER</span>
      </button>
    </div>
  `
  root.appendChild(el)

  const q = (s) => el.querySelector(s)
  const ref = {
    plate: q('.shot__plate'),
    wep: q('[data-wep]'),
    ret: q('[data-ret]'),
    pct: q('[data-pct]'),
    ix: q('[data-ix]'),
    name: q('[data-name]'),
    cls: q('[data-cls]'),
    hp: q('[data-hp]'),
    hpv: q('[data-hpv]'),
    dmg: q('[data-dmg]'),
    crit: q('[data-crit]'),
    dodge: q('[data-dodge]'),
    rows: q('[data-rows]'),
    sum: q('[data-sum]'),
    warn: q('[data-warn]'),
    cyc: q('[data-cyc]'),
    confirm: q('[data-confirm]'),
  }

  for (const nav of el.querySelectorAll('[data-nav]')) {
    nav.addEventListener('click', () => store.cycleTarget(parseInt(nav.dataset.nav, 10)))
  }
  ref.confirm.addEventListener('click', () => store.confirmShot())
  ref.cyc.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tid]')
    if (chip) store.setTarget(chip.dataset.tid)
  })

  /* ------------------------------------------------- animated count-up */
  let shown = 0
  let goal = 0
  let vis = false

  function tick(dt) {
    if (Math.abs(shown - goal) > 0.05) {
      // critically-damped-ish approach: fast start, soft landing, never overshoots
      shown += (goal - shown) * Math.min(1, dt * 11)
      if (Math.abs(goal - shown) < 0.4) shown = goal
      const v = Math.round(shown)
      ref.pct.textContent = String(v)
      const c = rampColor(v)
      ref.plate.style.setProperty('--pct', c)
      ref.ret.style.setProperty('--fill', `${v}%`)
    }
  }

  let sig = ''
  let rowEls = []

  function buildLedger(mods) {
    const maxAbs = Math.max(10, ...mods.map((m) => Math.abs(m.value || 0)))
    ref.rows.textContent = ''
    rowEls = mods.map((m, i) => {
      const v = Math.round(m.value || 0)
      const row = document.createElement('div')
      row.className = 'lrow'
      row.dataset.sign = v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'
      row.style.setProperty('--i', i)
      row.style.setProperty('--w', `${(Math.abs(v) / maxAbs) * 50}%`)
      row.innerHTML =
        `<span class="lrow__k">${String(m.label || '').replace(/[<>]/g, '')}</span>` +
        `<span class="lrow__bar"><i></i></span>` +
        `<span class="lrow__v num">${signed(v)}</span>`
      ref.rows.appendChild(row)
      return row
    })
  }

  function update() {
    const shouldShow = store.shotVisible()
    if (shouldShow !== vis) {
      vis = shouldShow
      el.classList.toggle('is-on', vis)
      if (vis) {
        // replay the entrance + restart the count-up from zero each time the
        // panel opens; the sweep is what makes it feel like a computed solution
        shown = 0
        ref.pct.textContent = '0'
        ref.plate.classList.remove('is-in')
        void ref.plate.offsetWidth
        ref.plate.classList.add('is-in')
      }
    }
    if (!vis) return

    const a = store.selected()
    const t = store.target()
    const p = store.preview()
    if (!t || !p) return

    const cands = store.candidates()
    const idx = cands.findIndex((u) => u.id === t.id)

    const mods = Array.isArray(p.modifiers) ? p.modifiers : []
    const newSig = [
      t.id, t.hp, p.hitChance, p.critChance, p.dodgeChance, p.dmgMin, p.dmgMax,
      mods.map((m) => `${m.label}:${m.value}`).join('|'),
    ].join('~')

    if (newSig !== sig) {
      sig = newSig
      goal = Math.max(0, Math.min(100, p.hitChance || 0))

      ref.wep.textContent = (a?.weapon?.name || '').toUpperCase()
      ref.ix.textContent = `${String(idx + 1).padStart(2, '0')} / ${String(cands.length).padStart(2, '0')}`
      ref.name.textContent = (t.name || t.id || '').toUpperCase()
      ref.cls.textContent = (t.className || '').toUpperCase()
      ref.hpv.textContent = `${t.hp | 0}/${t.hpMax | 0}`
      el.dataset.tteam = String(t.team === 1 ? 1 : 0)

      // target HP pips
      const host = ref.hp
      const total = Math.max(0, Math.min(30, t.hpMax | 0))
      if (host.__total !== total) {
        host.__total = total
        host.innerHTML = new Array(total).fill('<i></i>').join('')
      }
      ;[...host.children].forEach((c, i) => c.classList.toggle('is-on', i < (t.hp | 0)))

      const armor = t.armor | 0
      ref.dmg.textContent = `${p.dmgMin ?? 0}–${p.dmgMax ?? 0}`
      el.querySelector('[data-odd="dmg"]').dataset.note = armor > 0 ? `−${armor} ARM` : ''
      ref.crit.textContent = `${Math.round(p.critChance || 0)}%`
      ref.dodge.textContent = `${Math.round(p.dodgeChance || 0)}%`

      buildLedger(mods)

      const total2 = mods.reduce((s, m) => s + (m.value || 0), 0)
      const clamped = Math.round(p.hitChance || 0)
      ref.sum.textContent = `${clamped}%`
      const drift = Math.round(total2) !== clamped
      ref.warn.textContent = drift ? `Raw ${signed(Math.round(total2))} clamped to 1–100` : ''
      ref.warn.classList.toggle('is-on', drift)

      // target chips
      const csig = cands.map((u) => `${u.id}:${u.hp}`).join(',') + '>' + t.id
      if (ref.cyc.__sig !== csig) {
        ref.cyc.__sig = csig
        ref.cyc.innerHTML = cands
          .map(
            (u, i) =>
              `<button type="button" class="tchip${u.id === t.id ? ' is-on' : ''}" data-tid="${u.id}" style="--i:${i}">` +
              `<span class="tchip__n num">${String(i + 1).padStart(2, '0')}</span>` +
              `<span class="tchip__name">${(u.name || u.id).toUpperCase()}</span>` +
              `</button>`
          )
          .join('')
      } else {
        for (const c of ref.cyc.children) c.classList.toggle('is-on', c.dataset.tid === t.id)
      }

      // re-trigger the row stagger on target change
      ref.rows.classList.remove('is-in')
      void ref.rows.offsetWidth
      ref.rows.classList.add('is-in')
    }

    const blocked = !a || (a.ap | 0) <= 0 || (a.weapon?.ammo | 0) <= 0
    ref.confirm.classList.toggle('is-off', blocked)
  }

  return {
    el,
    update,
    tick,
    dispose() {
      el.remove()
    },
  }
}

export { rampColor }
