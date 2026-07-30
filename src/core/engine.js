import * as THREE from 'three'
import { EventBus } from './bus.js'
import { createGrid } from './grid.js'

/**
 * Owns the renderer, camera, frame loop and the shared `ctx` object.
 * Subsystems never touch the renderer directly — they register update callbacks
 * and attach their API to ctx.
 */
export function createEngine({ canvas, quality = 'auto' } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // post stack owns AA (SMAA); MSAA would fight the composer
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
  })

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(window.innerWidth, window.innerHeight)

  // Colour pipeline: linear workspace, ACES filmic on output. Everything the
  // art modules author must assume this — no manual gamma anywhere else.
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.info.autoReset = false

  const resolved = quality === 'auto' ? detectQuality(renderer) : quality

  const scene = new THREE.Scene()

  // Low FOV perspective: reads as isometric but keeps parallax depth cues that
  // a true orthographic camera throws away. XCOM does the same.
  const camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.5,
    500
  )
  camera.position.set(28, 30, 28)
  camera.lookAt(0, 0, 0)

  const clock = new THREE.Clock()
  const bus = new EventBus()
  const grid = createGrid(24, 24)

  /** @type {Array<(dt:number, time:number)=>void>} */
  const updaters = []

  const ctx = {
    THREE,
    scene,
    camera,
    renderer,
    composer: null,
    clock,
    dt: 0,
    time: 0,
    bus,
    grid,
    quality: resolved,
    state: null,
    world: null,
    units: null,
    fx: null,
    audio: null,
    ui: null,
    cameraRig: null,
    materials: null,

    register(name, api) {
      ctx[name] = api
      return api
    },

    onUpdate(fn) {
      updaters.push(fn)
      return () => {
        const i = updaters.indexOf(fn)
        if (i !== -1) updaters.splice(i, 1)
      }
    },
  }

  // --- frame loop ---------------------------------------------------------
  let running = false
  let frame = 0
  let fpsAccum = 0
  let fpsFrames = 0
  ctx.fps = 0

  function tick() {
    if (!running) return
    requestAnimationFrame(tick)

    // Clamp dt so a stalled tab (or a devtools pause) can't teleport anything.
    const dt = Math.min(clock.getDelta(), 1 / 20)
    ctx.dt = dt
    ctx.time += dt
    frame++

    fpsAccum += dt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      ctx.fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
    }

    for (const fn of updaters) {
      try {
        fn(dt, ctx.time)
      } catch (err) {
        console.error('[engine] update callback failed', err)
      }
    }

    renderer.info.reset()
    if (ctx.composer) ctx.composer.render(dt)
    else renderer.render(scene, camera)
  }

  function start() {
    if (running) return
    running = true
    clock.getDelta() // discard the load-time spike
    requestAnimationFrame(tick)
  }

  function stop() {
    running = false
  }

  function onResize() {
    const w = window.innerWidth
    const h = window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    ctx.composer?.setSize?.(w, h)
    bus.emit('engine:resize', { width: w, height: h })
  }
  window.addEventListener('resize', onResize)

  ctx.start = start
  ctx.stop = stop
  ctx.getFrame = () => frame

  return ctx
}

function detectQuality(renderer) {
  const gl = renderer.getContext()
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
  const cores = navigator.hardwareConcurrency || 4
  // Apple Silicon and modern discrete GPUs take the full stack.
  if (/apple m[1-9]|radeon pro|rtx|geforce/i.test(name) && cores >= 8) return 'ultra'
  if (cores >= 8) return 'high'
  if (cores >= 4) return 'medium'
  return 'low'
}
