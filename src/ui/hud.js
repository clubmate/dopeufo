/* ============================================================================
   DOPE UFO — Squad / unit HUD
   ----------------------------------------------------------------------------
   Three zones, all hugging the screen edges so the tactical centre stays clear:

     top-left      PLAYER 1 roster        (always team 0's colour)
     top-centre    turn identity + number (washes to the ACTIVE team's colour)
     top-right     PLAYER 2 roster        (always team 1's colour)
     bottom-left   selected unit dossier  (portrait, pips, AP, statuses)

   Everything is built once and then mutated in place. The only DOM the HUD
   rebuilds is a pip strip whose *total* changed (max HP, magazine size) or a
   roster whose membership changed — both are rare, both are cheap.
   ========================================================================== */

/* ---------------------------------------------------------------- icon set */
/* 24x24, currentColor, square caps. Stencil-cut rather than friendly-rounded:
   these are meant to look sprayed onto a crate, not drawn for a settings menu. */

const P = (d, extra = '') => `<path d="${d}" ${extra}/>`

export const ICONS = {
  /* isometric tile with a heading arrow inside — "go to that tile" */
  move: P('M12 2.5 22 12 12 21.5 2 12Z') + P('M12 15.5V8.5M12 8.5 8.6 12M12 8.5 15.4 12'),
  /* gun reticle */
  fire:
    `<circle cx="12" cy="12" r="6.6"/>` +
    P('M12 1.6v3.4M12 19v3.4M1.6 12h3.4M19 12h3.4') +
    `<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>`,
  /* bracketed eye — sensor on standby */
  overwatch:
    P('M2.4 12S6.3 6.2 12 6.2 21.6 12 21.6 12 17.7 17.8 12 17.8 2.4 12 2.4 12Z') +
    `<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>` +
    P('M4.6 3.4H1.8v2.8M19.4 3.4h2.8v2.8M4.6 20.6H1.8v-2.8M19.4 20.6h2.8v-2.8'),
  /* shield + down chevron */
  hunker: P('M12 2.2 20.4 5.3v6.4c0 5.3-4.1 8.1-8.4 10.1-4.3-2-8.4-4.8-8.4-10.1V5.3Z') + P('M8 10.6 12 14.4l4-3.8'),
  /* magazine + feed arrow */
  reload:
    P('M8 9.6h8v11.8H8Z') +
    P('M9.6 9.6V7.4h4.8v2.2') +
    P('M4.4 6.6A8 8 0 0 1 19 4.2') +
    P('M19.6 1.2v3.4h-3.4'),
  /* frag */
  grenade:
    `<circle cx="12" cy="14.2" r="6.4"/>` +
    P('M9.6 7.4V5h4.8v2.4') +
    P('M14.4 5.6h4.2l1.6-3') +
    P('M18.6 5.6 16 9.4'),
  /* end turn: bar + double chevron */
  endturn: P('M4 3.6v16.8') + P('M9 6.6 14.4 12 9 17.4') + P('M15 6.6 20.4 12 15 17.4'),
  /* statuses */
  wounded: P('M12 2.4 21 7.8v8.4L12 21.6 3 16.2V7.8Z') + P('M12 8v8M8 12h8'),
  noammo: P('M8 9.6h8v11.8H8Z') + P('M9.6 9.6V7.4h4.8v2.2') + P('M3.6 3.6 20.4 20.4'),
  flanked: P('M12 2.2 20.4 5.3v6.4c0 5.3-4.1 8.1-8.4 10.1') + P('M12 2.2 3.6 5.3v6.4c0 2.2.7 3.9 1.8 5.3') + P('M14.6 8 9 13.4l3.2 1-2.4 4.6'),
  dead: P('M12 2.4 21 7.8v8.4L12 21.6 3 16.2V7.8Z') + P('M8.4 8.4 15.6 15.6M15.6 8.4 8.4 15.6'),
}

/** Wrap raw path data in a stroke-only SVG. */
export function svgIcon(name, cls = '') {
  const body = ICONS[name]
  if (!body) return ''
  return (
    `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="square" stroke-linejoin="miter">${body}</svg>`
  )
}

/* -------------------------------------------------------------- portraits */
/* No art budget for headshots, so the portrait is diegetic instead: a thermal
   sensor bust. Silhouette in the team colour, scan bands over the top, corner
   ticks and a hex ID. Reads as equipment, not as a missing asset. */

const BUST = {
  Ranger: 'M12 4.6c2.4 0 3.9 1.7 3.9 4 0 2.4-1.7 4.4-3.9 4.4S8.1 11 8.1 8.6c0-2.3 1.5-4 3.9-4Z',
  default: 'M12 4.4c2.5 0 4.1 1.8 4.1 4.2 0 2.5-1.8 4.5-4.1 4.5s-4.1-2-4.1-4.5c0-2.4 1.6-4.2 4.1-4.2Z',
}

function portraitSVG(unit) {
  const head = BUST[unit?.className] || BUST.default
  const kit =
    unit?.className === 'Sharpshooter'
      ? '<path d="M6.2 7.4h4.2v2H6.2z"/>'
      : unit?.className === 'Grenadier'
        ? '<path d="M6.6 5.2h10.8v1.7H6.6z"/>'
        : unit?.className === 'Specialist'
          ? '<path d="M15.6 5.4h2.4v3.6h-2.4z"/>'
          : '<path d="M7.4 5.6h9.2v1.4H7.4z"/>'
  return (
    `<svg class="port__bust" viewBox="0 0 24 24" preserveAspectRatio="xMidYMax meet" aria-hidden="true">` +
    `<g fill="currentColor">` +
    `<path d="${head}"/>` +
    `<path d="M12 13.6c4.5 0 7.6 2.6 8.3 6.6l.4 3.8H3.3l.4-3.8c.7-4 3.8-6.6 8.3-6.6Z"/>` +
    kit +
    `</g></svg>`
  )
}

/* ------------------------------------------------------------------ pips */

/**
 * Segmented pip strip. Rebuilds children only when the segment count changes;
 * otherwise it just retoggles classes, so a unit taking damage costs no layout
 * beyond a class flip.
 */
function syncPips(host, total, filled, mods = {}) {
  total = Math.max(0, Math.min(40, Math.round(total || 0)))
  if (host.__total !== total) {
    host.__total = total
    let html = ''
    for (let i = 0; i < total; i++) html += '<i></i>'
    host.innerHTML = html
    host.__pips = [...host.children]
  }
  const pips = host.__pips || []
  for (let i = 0; i < pips.length; i++) {
    const on = i < filled
    const p = pips[i]
    if (p.__on !== on) {
      p.__on = on
      p.classList.toggle('is-on', on)
    }
    // "critical" styling on the last surviving pips
    const crit = !!mods.critical && on && i < 2
    if (p.__crit !== crit) {
      p.__crit = crit
      p.classList.toggle('is-crit', crit)
    }
  }
}

function hpTone(unit) {
  if (!unit || !unit.alive) return 'dead'
  const f = unit.hpMax ? unit.hp / unit.hpMax : 1
  if (f <= 0.34) return 'crit'
  if (f <= 0.67) return 'hurt'
  return 'ok'
}

function statusesOf(u) {
  const out = []
  if (!u) return out
  if (u.overwatch) out.push('overwatch')
  if (u.hunkered) out.push('hunker')
  if (u.flanked) out.push('flanked')
  if (u.weapon && u.weapon.ammo <= 0) out.push('noammo')
  if (u.hpMax && u.hp / u.hpMax <= 0.34 && u.alive) out.push('wounded')
  if (u.alive === false) out.push('dead')
  for (const s of u.statuses || []) {
    if (s && s.type && !out.includes(s.type) && ICONS[s.type]) out.push(s.type)
  }
  return out.slice(0, 4)
}

/* ================================================================== HUD */

export function createHud(ctx, root, store) {
  const el = document.createElement('div')
  el.className = 'hud'
  el.innerHTML = `
    <div class="hud__top">
      <div class="roster roster--l" data-team="0">
        <div class="roster__hd"><span class="roster__tag">P1</span><span class="roster__call" data-call></span><span class="roster__ct num" data-count></span></div>
        <div class="roster__list" data-list></div>
      </div>

      <div class="turnbar plate" data-turnbar>
        <div class="turnbar__rail"><i></i></div>
        <div class="turnbar__grid">
          <div class="turnbar__who">
            <span class="turnbar__player" data-player>PLAYER 1</span>
            <span class="turnbar__call" data-tcall>ARCLIGHT</span>
          </div>
          <div class="turnbar__sep" aria-hidden="true"></div>
          <div class="turnbar__turn">
            <span class="turnbar__lbl">TURN</span>
            <span class="turnbar__no num" data-turn>01</span>
          </div>
        </div>
        <div class="turnbar__ticks" aria-hidden="true"></div>
      </div>

      <div class="roster roster--r" data-team="1">
        <div class="roster__hd"><span class="roster__ct num" data-count></span><span class="roster__call" data-call></span><span class="roster__tag">P2</span></div>
        <div class="roster__list" data-list></div>
      </div>
    </div>

    <div class="ucard plate" data-ucard>
      <div class="ucard__grid">
        <div class="port">
          <div class="port__frame">
            <div class="port__scan" aria-hidden="true"></div>
            <div class="port__img" data-port></div>
            <span class="port__id num" data-portid>—</span>
          </div>
          <div class="port__rank" data-rank></div>
        </div>

        <div class="ucard__main">
          <div class="ucard__hd">
            <h2 class="ucard__name" data-name>NO UNIT SELECTED</h2>
            <span class="ucard__cls" data-cls></span>
          </div>

          <div class="stat" data-row="hp">
            <span class="stat__k">HP</span>
            <span class="pips pips--hp" data-hp></span>
            <span class="stat__v num" data-hpv>—</span>
          </div>
          <div class="stat" data-row="armor">
            <span class="stat__k">ARM</span>
            <span class="pips pips--armor" data-armor></span>
            <span class="stat__v num" data-armorv></span>
          </div>
          <div class="stat" data-row="ammo">
            <span class="stat__k">MAG</span>
            <span class="pips pips--ammo" data-ammo></span>
            <span class="stat__v num" data-ammov>—</span>
          </div>

          <div class="ucard__ft">
            <div class="ap" data-aphost>
              <span class="ap__k">AP</span>
              <span class="ap__d" data-ap></span>
            </div>
            <div class="statuses" data-status></div>
            <div class="wep" data-wep></div>
          </div>
        </div>
      </div>
    </div>
  `
  root.appendChild(el)

  const q = (s) => el.querySelector(s)
  const rosters = [...el.querySelectorAll('.roster')]
  const ref = {
    player: q('[data-player]'),
    tcall: q('[data-tcall]'),
    turn: q('[data-turn]'),
    turnbar: q('[data-turnbar]'),
    ucard: q('[data-ucard]'),
    name: q('[data-name]'),
    cls: q('[data-cls]'),
    rank: q('[data-rank]'),
    port: q('[data-port]'),
    portid: q('[data-portid]'),
    hp: q('[data-hp]'),
    hpv: q('[data-hpv]'),
    armor: q('[data-armor]'),
    armorv: q('[data-armorv]'),
    ammo: q('[data-ammo]'),
    ammov: q('[data-ammov]'),
    ap: q('[data-ap]'),
    status: q('[data-status]'),
    wep: q('[data-wep]'),
  }

  // roster row cache, keyed by unit id
  const rows = new Map()

  function rosterFor(team) {
    return rosters[team] || rosters[0]
  }

  function buildRow(u) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rost'
    b.dataset.id = u.id
    b.innerHTML = `
      <span class="rost__glyph">${portraitSVG(u)}</span>
      <span class="rost__meta">
        <span class="rost__name"></span>
        <span class="pips pips--mini" data-hp></span>
      </span>
      <span class="rost__st"></span>`
    b.addEventListener('click', () => store.selectUnit(u.id))
    b.addEventListener('mouseenter', () => ctx.bus.emit('unit:hover', { unitId: u.id }))
    b.addEventListener('mouseleave', () => ctx.bus.emit('unit:hover', null))
    return b
  }

  function syncRosters(state) {
    const byTeam = [[], []]
    for (const u of state.units || []) byTeam[u.team === 1 ? 1 : 0].push(u)

    for (let t = 0; t < 2; t++) {
      const host = rosterFor(t)
      const list = host.querySelector('[data-list]')
      const units = byTeam[t]
      const sig = units.map((u) => u.id).join(',')
      if (list.__sig !== sig) {
        list.__sig = sig
        list.textContent = ''
        rows.forEach((v, k) => {
          if (!units.some((u) => u.id === k)) rows.delete(k)
        })
        units.forEach((u, i) => {
          let row = rows.get(u.id)
          if (!row) rows.set(u.id, (row = buildRow(u)))
          row.style.setProperty('--i', i)
          list.appendChild(row)
        })
      }

      const alive = units.filter((u) => u.alive !== false).length
      host.querySelector('[data-count]').textContent = `${alive}/${units.length}`
      host.querySelector('[data-call]').textContent = store.callsign(t)
      host.classList.toggle('is-active', state.activeTeam === t)
      host.classList.toggle('is-idle', state.activeTeam !== t)

      for (const u of units) {
        const row = rows.get(u.id)
        if (!row) continue
        const nm = row.querySelector('.rost__name')
        if (nm.textContent !== u.name) nm.textContent = u.name || u.id
        syncPips(row.querySelector('[data-hp]'), u.hpMax || 0, u.alive === false ? 0 : u.hp)
        row.dataset.tone = hpTone(u)
        row.classList.toggle('is-sel', state.selectedUnitId === u.id)
        row.classList.toggle('is-tgt', state.targetUnitId === u.id)
        row.classList.toggle('is-dead', u.alive === false)
        row.classList.toggle('is-spent', u.alive !== false && (u.ap | 0) <= 0)
        const st = statusesOf(u)
        const ssig = st.join(',')
        const box = row.querySelector('.rost__st')
        if (box.__sig !== ssig) {
          box.__sig = ssig
          box.innerHTML = st.map((s) => svgIcon(s, `ico--${s}`)).join('')
        }
      }
    }
  }

  function syncTurn(state) {
    const t = state.activeTeam === 1 ? 1 : 0
    ref.player.textContent = `PLAYER ${t + 1}`
    ref.tcall.textContent = store.callsign(t)
    const n = String(Math.max(1, state.turn || 1)).padStart(2, '0')
    if (ref.turn.textContent !== n) {
      ref.turn.textContent = n
      ref.turnbar.classList.remove('is-bump')
      void ref.turnbar.offsetWidth
      ref.turnbar.classList.add('is-bump')
    }
    if (ref.turnbar.dataset.team !== String(t)) ref.turnbar.dataset.team = String(t)
  }

  let portSig = ''

  function syncCard(state) {
    const u = store.selected()
    ref.ucard.classList.toggle('is-empty', !u)
    if (!u) {
      ref.name.textContent = 'NO UNIT SELECTED'
      ref.cls.textContent = ''
      ref.portid.textContent = '——'
      ref.hpv.textContent = '—'
      ref.ammov.textContent = '—'
      ref.wep.textContent = ''
      syncPips(ref.hp, 0, 0)
      syncPips(ref.ammo, 0, 0)
      syncPips(ref.armor, 0, 0)
      syncPips(ref.ap, 0, 0)
      ref.status.innerHTML = ''
      ref.status.__sig = ''
      ref.rank.innerHTML = ''
      ref.rank.__n = -1
      return
    }

    ref.ucard.dataset.team = String(u.team === 1 ? 1 : 0)
    ref.ucard.dataset.tone = hpTone(u)

    if (ref.name.textContent !== (u.name || u.id)) ref.name.textContent = u.name || u.id
    const cls = (u.className || 'SOLDIER').toUpperCase()
    if (ref.cls.textContent !== cls) ref.cls.textContent = cls

    const psig = u.id + '|' + u.className
    if (psig !== portSig) {
      portSig = psig
      ref.port.innerHTML = portraitSVG(u)
      ref.portid.textContent = String(u.id).replace(/[^0-9]/g, '').padStart(3, '0')
    }

    const rank = Math.max(0, Math.min(7, u.rank ?? 3))
    if (ref.rank.__n !== rank) {
      ref.rank.__n = rank
      ref.rank.innerHTML = new Array(rank).fill('<i></i>').join('')
    }

    syncPips(ref.hp, u.hpMax || 0, u.hp || 0, { critical: hpTone(u) === 'crit' })
    ref.hpv.textContent = `${u.hp | 0}/${u.hpMax | 0}`

    const armor = u.armor | 0
    el.querySelector('[data-row="armor"]').classList.toggle('is-off', armor <= 0)
    syncPips(ref.armor, armor, armor)
    ref.armorv.textContent = armor > 0 ? String(armor) : ''

    const w = u.weapon || {}
    syncPips(ref.ammo, w.ammoMax || 0, w.ammo || 0)
    ref.ammov.textContent = `${w.ammo | 0}/${w.ammoMax | 0}`
    el.querySelector('[data-row="ammo"]').dataset.tone = (w.ammo | 0) <= 0 ? 'crit' : (w.ammo | 0) <= 2 ? 'hurt' : 'ok'

    const wep = w.name ? `${w.name.toUpperCase()} · ${w.dmgMin ?? 0}–${w.dmgMax ?? 0}` : ''
    if (ref.wep.textContent !== wep) ref.wep.textContent = wep

    syncPips(ref.ap, u.apMax || 2, u.ap || 0)

    const st = statusesOf(u)
    const ssig = st.join(',')
    if (ref.status.__sig !== ssig) {
      ref.status.__sig = ssig
      ref.status.innerHTML = st
        .map(
          (s) =>
            `<span class="chip chip--${s}">${svgIcon(s)}<b>${
              { overwatch: 'OVERWATCH', hunker: 'HUNKERED', wounded: 'WOUNDED', noammo: 'DRY', flanked: 'FLANKED', dead: 'DOWN' }[s] || s.toUpperCase()
            }</b></span>`
        )
        .join('')
    }
  }

  function update() {
    const state = store.state()
    el.dataset.team = String(state.activeTeam === 1 ? 1 : 0)
    syncTurn(state)
    syncRosters(state)
    syncCard(state)
  }

  // staggered entrance — nothing pops in
  requestAnimationFrame(() => el.classList.add('is-in'))

  return {
    el,
    update,
    dispose() {
      el.remove()
      rows.clear()
    },
  }
}
