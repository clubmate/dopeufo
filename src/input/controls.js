/**
 * All DOM event handling lives here so picking and the rig never fight over the
 * same pointer stream.
 *
 * Scheme (XCOM-ish, mouse-and-keyboard first):
 *   WASD / arrows ....... pan the target, camera-relative, speed scales with zoom
 *   screen edges ........ edge-scroll (canvas only, so HUD hovers don't drift)
 *   Q / E ............... rotate in 45° snaps, eased (the default)
 *   middle-drag ......... free rotate + pitch (for players who want it)
 *   shift + left-drag ... pan
 *   wheel ............... zoom (multiplicative, so it feels constant)
 *   R / F ............... reset azimuth to nearest snap / focus selected unit
 *   Esc / any input ..... skip the running cinematic
 *   left / right click .. tile or unit click, distinguished, drag-suppressed
 */
export function createControls(ctx, rig, picking) {
  const dom = ctx.renderer.domElement
  const keys = new Set()
  const disposers = []

  const cfg = {
    panSpeed: 0.42, // × distance, metres/second
    edgeMargin: 14,
    edgeSpeed: 0.7,
    dragThreshold: 5,
    edgeScroll: true,
  }

  const mouse = { x: -1, y: -1, over: false }
  const drag = {
    active: false,
    button: -1,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
  }

  function isTypingTarget(t) {
    if (!t) return false
    const tag = t.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
  }

  function userActed() {
    if (rig.isCinematic()) rig.skipCinematic()
  }

  // ------------------------------------------------------------- keyboard
  function onKeyDown(e) {
    if (isTypingTarget(e.target)) return
    const k = e.key.toLowerCase()
    if (!keys.has(k)) {
      // one-shot keys
      if (k === 'q') {
        userActed()
        rig.rotateSnap(-1)
      } else if (k === 'e') {
        userActed()
        rig.rotateSnap(1)
      } else if (k === 'r') {
        userActed()
        rig.snapToNearest()
      } else if (k === 'f') {
        userActed()
        focusSelected()
      } else if (k === 'escape') {
        rig.skipCinematic()
      }
    }
    keys.add(k)
    if (
      ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) ||
      k === 'q' ||
      k === 'e'
    ) {
      if (k.startsWith('arrow')) e.preventDefault()
      userActed()
    }
  }
  function onKeyUp(e) {
    keys.delete(e.key.toLowerCase())
  }
  function onBlur() {
    keys.clear()
    drag.active = false
    mouse.over = false
  }

  function focusSelected() {
    const id = ctx.state?.selectedUnitId
    if (!id) return
    try {
      const o = ctx.units?.getObject?.(id)
      if (o) {
        rig.focus(o.getWorldPosition(new ctx.THREE.Vector3()), false)
        return
      }
    } catch {}
    const u = ctx.state?.units?.find?.((x) => x.id === id)
    if (u) rig.focusTile(u.x, u.z, u.elevation || 0, false)
  }

  // -------------------------------------------------------------- pointer
  function onPointerDown(e) {
    if (e.target !== dom) return
    userActed()
    dom.focus?.()
    drag.active = true
    drag.button = e.button
    drag.startX = drag.lastX = e.clientX
    drag.startY = drag.lastY = e.clientY
    drag.moved = 0
    if (e.button === 1) e.preventDefault()
    try {
      dom.setPointerCapture?.(e.pointerId)
    } catch {}
  }

  function onPointerMove(e) {
    mouse.x = e.clientX
    mouse.y = e.clientY
    mouse.over = e.target === dom || drag.active

    if (drag.active) {
      const dx = e.clientX - drag.lastX
      const dy = e.clientY - drag.lastY
      drag.lastX = e.clientX
      drag.lastY = e.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)

      if (drag.button === 1) {
        rig.rotateFree(-dx * 0.0075)
        rig.pitchBy(-dy * 0.0035)
        picking.invalidate()
        return
      }
      if (drag.button === 0 && (e.shiftKey || keys.has('shift'))) {
        const s = rig.getDistance() * 0.0016
        rig.panBy(-dx * s, dy * s)
        picking.invalidate()
        return
      }
    }

    if (mouse.over) picking.setScreen(e.clientX, e.clientY)
  }

  function onPointerUp(e) {
    if (!drag.active) return
    const wasDrag = drag.moved > cfg.dragThreshold
    const btn = drag.button
    drag.active = false
    try {
      dom.releasePointerCapture?.(e.pointerId)
    } catch {}
    if (btn === 1) {
      // snapping back to the nearest 45° after a free spin keeps the board readable
      rig.snapToNearest()
      return
    }
    if (wasDrag) return
    if (e.target !== dom && !dom.contains(e.target)) return
    picking.setScreen(e.clientX, e.clientY)
    picking.click(btn)
  }

  function onWheel(e) {
    if (e.target !== dom) return
    e.preventDefault()
    userActed()
    const notches = Math.max(-3, Math.min(3, e.deltaY / (e.deltaMode === 1 ? 3 : 100)))
    rig.zoomBy(notches)
    picking.invalidate()
  }

  function onContextMenu(e) {
    e.preventDefault()
  }

  function onPointerLeave(e) {
    if (drag.active) return
    mouse.over = false
    picking.clear()
  }

  // ---------------------------------------------------------------- frame
  function update(dt) {
    let px = 0
    let pz = 0
    if (keys.has('a') || keys.has('arrowleft')) px -= 1
    if (keys.has('d') || keys.has('arrowright')) px += 1
    if (keys.has('w') || keys.has('arrowup')) pz += 1
    if (keys.has('s') || keys.has('arrowdown')) pz -= 1

    // edge scroll — only while the pointer is genuinely over the battlefield
    if (cfg.edgeScroll && mouse.over && !drag.active) {
      const w = window.innerWidth
      const h = window.innerHeight
      const m = cfg.edgeMargin
      if (mouse.x <= m) px -= cfg.edgeSpeed
      else if (mouse.x >= w - m) px += cfg.edgeSpeed
      if (mouse.y <= m) pz += cfg.edgeSpeed
      else if (mouse.y >= h - m) pz -= cfg.edgeSpeed
    }

    if (px || pz) {
      const len = Math.hypot(px, pz) || 1
      const s = (rig.getDistance() * cfg.panSpeed * dt) / len
      rig.panBy(px * s, pz * s)
      picking.invalidate()
      userActed()
    }

    if (keys.has('+') || keys.has('=')) rig.zoomBy(-dt * 6)
    if (keys.has('-') || keys.has('_')) rig.zoomBy(dt * 6)
  }

  // ----------------------------------------------------------------- bind
  const bind = (el, ev, fn, opts) => {
    el.addEventListener(ev, fn, opts)
    disposers.push(() => el.removeEventListener(ev, fn, opts))
  }

  bind(window, 'keydown', onKeyDown)
  bind(window, 'keyup', onKeyUp)
  bind(window, 'blur', onBlur)
  bind(window, 'pointermove', onPointerMove)
  bind(window, 'pointerup', onPointerUp)
  bind(dom, 'pointerdown', onPointerDown)
  bind(dom, 'pointerleave', onPointerLeave)
  bind(dom, 'wheel', onWheel, { passive: false })
  bind(dom, 'contextmenu', onContextMenu)
  bind(dom, 'dragstart', (e) => e.preventDefault())

  return {
    cfg,
    update,
    setEdgeScroll(v) {
      cfg.edgeScroll = !!v
    },
    dispose() {
      for (const d of disposers) d()
      disposers.length = 0
      keys.clear()
    },
  }
}
