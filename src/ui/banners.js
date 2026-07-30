/* ============================================================================
   DOPE UFO — Banners & match flow
   ----------------------------------------------------------------------------
   Three things live here:

   1. Turn hand-over. In hotseat this is the most important moment in the game:
      two people share one screen and the wrong assumption about whose turn it
      is costs somebody the match. So the hand-over is a full-width sweep in the
      incoming player's colour, loud enough that nobody misses it and short
      enough (1.6s, skippable on any key) that nobody resents it.

   2. Transient alerts — overwatch triggered, unit down. Centre screen, ~1.3s,
      pointer-events none so they never eat a click.

   3. The end screen, with a real match summary. Shots, hits, accuracy and kills
      are accumulated off the bus, so the numbers are the game's, not ours.
   ========================================================================== */

const CALL = ['ARCLIGHT', 'NIGHTJAR']

export function createBanners(ctx, root, store) {
  const el = document.createElement('div')
  el.className = 'banners'
  el.innerHTML = `
    <div class="tb" data-tb aria-live="polite">
      <span class="tb__wipe" aria-hidden="true"></span>
      <div class="tb__bar">
        <span class="tb__hair tb__hair--t" aria-hidden="true"></span>
        <div class="tb__in">
          <span class="tb__pre">Command authority</span>
          <div class="tb__mid">
            <span class="tb__chev" aria-hidden="true"></span>
            <h1 class="tb__who" data-tb-who>PLAYER 1</h1>
            <span class="tb__chev tb__chev--r" aria-hidden="true"></span>
          </div>
          <div class="tb__meta">
            <span class="tb__call" data-tb-call>ARCLIGHT</span>
            <span class="tb__dot" aria-hidden="true"></span>
            <span class="tb__turn num" data-tb-turn>TURN 01</span>
          </div>
        </div>
        <span class="tb__hair tb__hair--b" aria-hidden="true"></span>
      </div>
      <span class="tb__skip">Any key to skip</span>
    </div>

    <div class="alerts" data-alerts></div>

    <div class="over" data-over>
      <div class="over__scrim" aria-hidden="true"></div>
      <div class="over__panel plate">
        <span class="over__eyebrow">Engagement concluded</span>
        <h1 class="over__title" data-over-title>PLAYER 1 WINS</h1>
        <span class="over__sub" data-over-sub></span>
        <div class="over__table" data-over-table></div>
        <button type="button" class="over__btn" data-rematch>
          <span class="over__btnfill" aria-hidden="true"></span>
          <span>Rematch</span>
        </button>
      </div>
    </div>
  `
  root.appendChild(el)

  const tb = el.querySelector('[data-tb]')
  const tbWho = el.querySelector('[data-tb-who]')
  const tbCall = el.querySelector('[data-tb-call]')
  const tbTurn = el.querySelector('[data-tb-turn]')
  const alerts = el.querySelector('[data-alerts]')
  const over = el.querySelector('[data-over]')
  const overTitle = el.querySelector('[data-over-title]')
  const overSub = el.querySelector('[data-over-sub]')
  const overTable = el.querySelector('[data-over-table]')

  el.querySelector('[data-rematch]').addEventListener('click', () => {
    ctx.bus.emit('ui:rematch', {})
    location.reload()
  })

  /* -------------------------------------------------------- match stats */
  const stats = [
    { shots: 0, hits: 0, crits: 0, dmg: 0, kills: 0 },
    { shots: 0, hits: 0, crits: 0, dmg: 0, kills: 0 },
  ]
  const T = (i) => stats[i === 1 ? 1 : 0]

  /* ------------------------------------------------------- turn banner */
  let tbTimer = 0
  let tbLive = false

  function showTurn(team, turn) {
    const t = team === 1 ? 1 : 0
    tb.dataset.team = String(t)
    tbWho.textContent = `PLAYER ${t + 1}`
    tbCall.textContent = store.callsign(t) || CALL[t]
    tbTurn.textContent = `TURN ${String(Math.max(1, turn || 1)).padStart(2, '0')}`
    tb.classList.remove('is-on')
    void tb.offsetWidth
    tb.classList.add('is-on')
    tbLive = true
    clearTimeout(tbTimer)
    tbTimer = setTimeout(hideTurn, 1750)
  }

  function hideTurn() {
    if (!tbLive) return
    tbLive = false
    clearTimeout(tbTimer)
    tb.classList.remove('is-on')
    tb.classList.add('is-out')
    setTimeout(() => tb.classList.remove('is-out'), 420)
  }

  /* ------------------------------------------------------------- alerts */
  const alertPool = []
  for (let i = 0; i < 5; i++) {
    const a = document.createElement('div')
    a.className = 'alert'
    a.innerHTML = '<span class="alert__k"></span><span class="alert__t"></span>'
    alerts.appendChild(a)
    alertPool.push({ el: a, until: 0 })
  }
  let alertCursor = 0

  function alert(kind, title, sub) {
    const slot = alertPool[alertCursor]
    alertCursor = (alertCursor + 1) % alertPool.length
    slot.el.dataset.kind = kind
    slot.el.querySelector('.alert__k').textContent = kind.toUpperCase()
    slot.el.querySelector('.alert__t').textContent = title
    slot.el.classList.remove('is-on')
    void slot.el.offsetWidth
    slot.el.classList.add('is-on')
    clearTimeout(slot.timer)
    slot.timer = setTimeout(() => slot.el.classList.remove('is-on'), kind === 'overwatch' ? 1100 : 1500)
  }

  /* ---------------------------------------------------------- end screen */
  function showOver(winner) {
    const w = winner === 1 || winner === 0 ? winner : null
    over.dataset.team = String(w ?? 0)
    overTitle.textContent = w === null ? 'STALEMATE' : `PLAYER ${w + 1} WINS`
    overSub.textContent = w === null ? 'No squad left standing.' : `${store.callsign(w)} holds the field.`

    const st = store.state()
    const alive = [0, 1].map((t) => (st.units || []).filter((u) => u.team === t && u.alive !== false).length)
    const rows = [0, 1].map((t) => {
      const s = T(t)
      const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0
      return { t, acc, ...s, alive: alive[t] }
    })

    overTable.innerHTML =
      `<div class="ot__hd"><span></span><span>Kills</span><span>Shots</span><span>Hits</span><span>Acc</span><span>Left</span></div>` +
      rows
        .map(
          (r) =>
            `<div class="ot__row" data-team="${r.t}"${r.t === w ? ' data-win="1"' : ''}>` +
            `<span class="ot__who"><i></i>PLAYER ${r.t + 1} <b>${store.callsign(r.t)}</b></span>` +
            `<span class="num">${r.kills}</span>` +
            `<span class="num">${r.shots}</span>` +
            `<span class="num">${r.hits}</span>` +
            `<span class="num">${r.acc}%</span>` +
            `<span class="num">${r.alive}</span>` +
            `</div>`
        )
        .join('')

    over.classList.add('is-on')
  }

  /* ---------------------------------------------------------- bus wiring */
  const off = []
  const on = (ev, fn) => off.push(ctx.bus.on(ev, fn))

  on('turn:start', (p) => showTurn(p?.team ?? 0, p?.turn ?? 1))

  on('unit:shoot', (p) => {
    if (!p) return
    const sh = store.unit(p.shooterId)
    const team = sh ? (sh.team === 1 ? 1 : 0) : 0
    const s = T(team)
    s.shots += Math.max(1, p.shots | 0 || 1)
    if (p.hit) {
      s.hits += 1
      s.dmg += p.dmg | 0
      if (p.crit) s.crits += 1
    }
    if (p.killed) s.kills += 1
    // a shot from the team that is NOT active is by definition a reaction shot
    const st = store.state()
    if (sh && st.activeTeam !== team) alert('overwatch', `${(sh.name || sh.id).toUpperCase()} REACTS`)
  })

  on('unit:overwatch', (p) => {
    const u = store.unit(p?.unitId)
    if (u) alert('overwatch', `${(u.name || u.id).toUpperCase()} ON OVERWATCH`)
  })

  on('unit:died', (p) => {
    const u = store.unit(p?.unitId)
    alert('down', u ? `${(u.name || u.id).toUpperCase()} IS DOWN` : 'UNIT DOWN')
  })

  on('game:over', (p) => setTimeout(() => showOver(p?.winner), 700))

  return {
    el,
    showTurn,
    alert,
    showOver,
    skip: hideTurn,
    get busy() {
      return tbLive
    },
    dispose() {
      off.forEach((f) => f && f())
      off.length = 0
      clearTimeout(tbTimer)
      alertPool.forEach((a) => clearTimeout(a.timer))
      el.remove()
    },
  }
}
