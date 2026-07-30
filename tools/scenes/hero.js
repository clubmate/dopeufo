/**
 * Hero-shot poser. Evaluated in the page by tools/shoot.mjs after boot.
 *
 * Poses the camera at a cinematic tactical angle for critique screenshots.
 * Deliberately defensive: any subsystem may be missing or mid-rewrite while the
 * parallel agents work, and a failed pose must degrade to "whatever the default
 * camera sees" rather than aborting the capture.
 *
 * Override via URL params consumed here: ?az=, ?elev=, ?dist=, ?tx=, ?tz=
 */
(async () => {
  const ctx = window.__CTX
  if (!ctx) return { posed: false, reason: 'no ctx' }

  const p = new URLSearchParams(location.search)
  const num = (k, d) => (p.has(k) ? parseFloat(p.get(k)) : d)

  const pose = {
    azimuth: num('az', Math.PI * 0.25),
    elevation: num('elev', 0.62), // radians above horizon — high enough to read the grid, low enough to keep silhouettes
    distance: num('dist', 34),
    target: { x: num('tx', 0), y: 0, z: num('tz', 0) },
  }

  let posed = false

  // Preferred path: the input agent's rig knows about damping and clamping.
  if (ctx.cameraRig?.setPose) {
    try {
      ctx.cameraRig.setPose(pose)
      ctx.cameraRig.setCinematicsEnabled?.(false) // no drifting mid-capture
      posed = true
    } catch (e) {
      console.warn('[hero] setPose failed, falling back', e)
    }
  }

  // Fallback: drive the raw camera ourselves using the same spherical model.
  if (!posed && ctx.camera) {
    const { azimuth: a, elevation: e, distance: d, target: t } = pose
    ctx.camera.position.set(
      t.x + Math.cos(a) * Math.cos(e) * d,
      t.y + Math.sin(e) * d,
      t.z + Math.sin(a) * Math.cos(e) * d
    )
    ctx.camera.lookAt(t.x, t.y, t.z)
    ctx.camera.updateProjectionMatrix()
    posed = true
  }

  // Let damped rigs settle rather than capturing them mid-spring.
  await new Promise((done) => {
    let n = 0
    const step = () => (++n >= 45 ? done() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  })

  return {
    posed,
    usedRig: !!ctx.cameraRig?.setPose,
    modules: {
      render: !!ctx.materials,
      world: !!ctx.world,
      units: !!ctx.units,
      game: !!ctx.state,
      fx: !!ctx.fx,
      audio: !!ctx.audio,
      ui: !!ctx.ui,
      cameraRig: !!ctx.cameraRig,
    },
  }
})()
