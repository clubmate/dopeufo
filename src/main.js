import { createEngine } from './core/engine.js'

const bootEl = document.getElementById('boot')
const barEl = bootEl?.querySelector('.bar i')
const statusEl = bootEl?.querySelector('.status')

function progress(pct, label) {
  if (barEl) barEl.style.width = `${pct}%`
  if (statusEl && label) statusEl.textContent = label
}

function fatal(err) {
  console.error(err)
  const el = document.getElementById('fatal')
  if (el) {
    el.style.display = 'grid'
    el.textContent = `Boot failed\n\n${err?.stack || err}`
  }
}

/**
 * Boot order matters: render sets up lighting + the material library that world
 * and units draw from; game needs the world's tile data; input and ui need game.
 * A subsystem that fails is logged and skipped so the rest still runs — a broken
 * audio module must never cost us the frame.
 */
const MODULES = [
  { name: 'render', path: './render/index.js', label: 'lighting & atmosphere' },
  { name: 'world', path: './world/index.js', label: 'generating battlefield' },
  { name: 'units', path: './units/index.js', label: 'deploying squads' },
  { name: 'fx', path: './fx/index.js', label: 'effects' },
  { name: 'audio', path: './audio/index.js', label: 'audio' },
  { name: 'game', path: './game/index.js', label: 'tactical systems' },
  { name: 'input', path: './input/index.js', label: 'camera & input' },
  { name: 'ui', path: './ui/index.js', label: 'interface' },
]

async function boot() {
  const canvas = document.getElementById('view')
  const params = new URLSearchParams(location.search)

  const ctx = createEngine({
    canvas,
    quality: params.get('quality') || 'auto',
  })

  // Screenshot harness hooks — the critic loop drives the game through these.
  window.__CTX = ctx
  window.__READY = false
  window.__ERRORS = []
  window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => window.__ERRORS.push(String(e.reason)))

  const failed = []
  for (let i = 0; i < MODULES.length; i++) {
    const m = MODULES[i]
    progress(5 + (i / MODULES.length) * 90, m.label)
    try {
      const mod = await import(/* @vite-ignore */ m.path)
      if (typeof mod.init !== 'function') {
        throw new Error(`${m.path} does not export init(ctx)`)
      }
      await mod.init(ctx)
    } catch (err) {
      failed.push(m.name)
      console.error(`[boot] module "${m.name}" failed — continuing without it`, err)
      window.__ERRORS.push(`module:${m.name}: ${err?.message || err}`)
    }
    // yield so the progress bar actually paints between modules
    await new Promise((r) => requestAnimationFrame(r))
  }

  progress(100, failed.length ? `ready (${failed.length} degraded)` : 'ready')
  ctx.start()

  // Let one frame render before revealing, so we never flash an empty canvas.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      bootEl?.classList.add('done')
      window.__READY = true
      window.__FAILED_MODULES = failed
      ctx.bus.emit('game:ready', { failed })
    })
  )

  if (failed.length) console.warn('[boot] degraded modules:', failed)
  return ctx
}

boot().catch(fatal)
