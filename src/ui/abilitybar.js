/* ============================================================================
   DOPE UFO — Ability bar
   ----------------------------------------------------------------------------
   Bottom-centre. Six bevelled command plates plus END TURN set apart on the
   right behind a gap and a divider, so nobody ever ends their turn by muscle
   memory while reaching for the grenade.

   A disabled button always says WHY on hover. "Greyed out with no explanation"
   is the single most common tactical-UI failure and it is unforgivable in a
   hotseat game where the other player is watching you flail.

   Emits, per the contract and nothing else:
     ui:ability {ability}   ui:cancel {}   ui:endTurn {}
   ========================================================================== */

import { svgIcon } from './hud.js'

export const ABILITIES = [
  { id: 'move', key: '1', label: 'Move', cost: 1, hint: 'Reposition. Second point kept for a shot.' },
  { id: 'fire', key: '2', label: 'Fire', cost: 1, ends: true, hint: 'Aimed shot. Ends the turn.' },
  { id: 'overwatch', key: '3', label: 'Overwatch', cost: 1, ends: true, hint: 'Reaction shot at −15 aim.' },
  { id: 'hunker', key: '4', label: 'Hunker', cost: 1, ends: true, hint: 'Doubles cover. No reaction fire.' },
  { id: 'reload', key: '5', label: 'Reload', cost: 1, hint: 'Refill the magazine.' },
  { id: 'grenade', key: '6', label: 'Grenade', cost: 1, ends: true, hint: 'Arcing frag. Destroys cover.' },
]

/**
 * Why can't I press this? Returns null when the ability is available.
 * Order matters — report the most specific blocker first.
 */
export function abilityBlocker(id, unit, store) {
  if (!unit) return 'No unit selected'
  if (unit.alive === false) return 'Unit is down'
  const state = store.state()
  if (unit.team !== state.activeTeam) return 'Not your unit this turn'

  const def = ABILITIES.find((a) => a.id === id)
  const cost = def ? def.cost : 1
  const ap = unit.ap | 0
  const w = unit.weapon || {}

  switch (id) {
    case 'reload':
      if ((w.ammo | 0) >= (w.ammoMax | 0)) return 'Magazine is full'
      break
    case 'fire':
      if ((w.ammo | 0) <= 0) return 'No ammo — reload first'
      if (!store.candidates().length) return 'No target in line of sight'
      break
    case 'grenade': {
      const abil = unit.abilities
      if (Array.isArray(abil) && abil.length && !abil.includes('grenade')) return 'No grenades carried'
      break
    }
    case 'overwatch':
      if ((w.ammo | 0) <= 0) return 'No ammo — reload first'
      break
    case 'hunker':
      if (unit.hunkered) return 'Already hunkered'
      break
    default:
      break
  }

  if (ap < cost) return ap <= 0 ? 'Out of action points' : 'Not enough action points'
  return null
}

export function createAbilityBar(ctx, root, store) {
  const el = document.createElement('div')
  el.className = 'abar'

  el.innerHTML = `
    <div class="abar__deck">
      ${ABILITIES.map(
        (a, i) => `
        <button type="button" class="ab" data-ab="${a.id}" style="--i:${i}">
          <span class="ab__bg" aria-hidden="true"></span>
          <span class="ab__key num">${a.key}</span>
          <span class="ab__ico">${svgIcon(a.id)}</span>
          <span class="ab__label">${a.label.toUpperCase()}</span>
          <span class="ab__cost" data-cost aria-hidden="true"></span>
          ${a.ends ? '<span class="ab__ends" aria-hidden="true">ENDS</span>' : ''}
          <span class="ab__lock" aria-hidden="true"></span>
        </button>`
      ).join('')}
    </div>

    <div class="abar__split" aria-hidden="true"></div>

    <button type="button" class="ab ab--end" data-ab="endturn" style="--i:6">
      <span class="ab__bg" aria-hidden="true"></span>
      <span class="ab__key num">SPACE</span>
      <span class="ab__ico">${svgIcon('endturn')}</span>
      <span class="ab__label">END TURN</span>
    </button>

    <div class="tip" data-tip role="status">
      <span class="tip__t" data-tip-t></span>
      <span class="tip__r" data-tip-r></span>
    </div>
  `
  root.appendChild(el)

  const tip = el.querySelector('[data-tip]')
  const tipT = el.querySelector('[data-tip-t]')
  const tipR = el.querySelector('[data-tip-r]')
  const btns = new Map()
  for (const b of el.querySelectorAll('[data-ab]')) btns.set(b.dataset.ab, b)

  function showTip(btn) {
    const id = btn.dataset.ab
    const def = ABILITIES.find((a) => a.id === id)
    const reason = btn.dataset.reason || ''
    tipT.textContent = def ? def.hint : 'Pass the turn to the other player.'
    tipR.textContent = reason
    tip.classList.toggle('is-blocked', !!reason)
    tip.classList.add('is-on')
    const r = btn.getBoundingClientRect()
    const host = el.getBoundingClientRect()
    tip.style.setProperty('--x', `${r.left + r.width / 2 - host.left}px`)
  }
  function hideTip() {
    tip.classList.remove('is-on')
  }

  for (const [id, btn] of btns) {
    btn.addEventListener('mouseenter', () => showTip(btn))
    btn.addEventListener('focus', () => showTip(btn))
    btn.addEventListener('mouseleave', hideTip)
    btn.addEventListener('blur', hideTip)
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      trigger(id)
    })
  }

  /** Central entry point — the keyboard map calls this too. */
  function trigger(id) {
    const btn = btns.get(id)
    if (id === 'endturn') {
      punch(btn)
      ctx.bus.emit('ui:endTurn', {})
      ctx.bus.emit('ui:ability', { ability: 'endturn' })
      return true
    }
    const unit = store.selected()
    const reason = abilityBlocker(id, unit, store)
    if (reason) {
      deny(btn, reason)
      return false
    }
    punch(btn)
    store.setPending(id)
    ctx.bus.emit('ui:ability', { ability: id })
    return true
  }

  function punch(btn) {
    if (!btn) return
    btn.classList.remove('is-punch')
    void btn.offsetWidth
    btn.classList.add('is-punch')
  }

  function deny(btn, reason) {
    if (!btn) return
    btn.dataset.reason = reason
    btn.classList.remove('is-deny')
    void btn.offsetWidth
    btn.classList.add('is-deny')
    showTip(btn)
    clearTimeout(btn.__denyT)
    btn.__denyT = setTimeout(hideTip, 1600)
  }

  function update() {
    const state = store.state()
    const unit = store.selected()
    const pending = state.pendingAction

    for (const a of ABILITIES) {
      const btn = btns.get(a.id)
      const reason = abilityBlocker(a.id, unit, store)
      const on = !reason
      if (btn.__on !== on) {
        btn.__on = on
        btn.classList.toggle('is-off', !on)
        btn.setAttribute('aria-disabled', String(!on))
      }
      btn.dataset.reason = reason || ''
      const armed = pending === a.id
      if (btn.__armed !== armed) {
        btn.__armed = armed
        btn.classList.toggle('is-armed', armed)
      }
      const costHost = btn.querySelector('[data-cost]')
      const cost = a.cost
      if (costHost.__c !== cost) {
        costHost.__c = cost
        costHost.innerHTML = new Array(cost).fill('<i></i>').join('')
      }
      // dim the cost pips a unit can't pay
      costHost.classList.toggle('is-unaffordable', !!unit && (unit.ap | 0) < cost)
    }

    const endBtn = btns.get('endturn')
    const urgent = !!unit && (unit.ap | 0) <= 0
    if (endBtn.__urgent !== urgent) {
      endBtn.__urgent = urgent
      endBtn.classList.toggle('is-urgent', urgent)
    }
    el.classList.toggle('is-locked', state.phase === 'animating' || state.phase === 'over')
  }

  requestAnimationFrame(() => el.classList.add('is-in'))

  return {
    el,
    update,
    trigger,
    dispose() {
      el.remove()
      btns.clear()
    },
  }
}
