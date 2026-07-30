#!/usr/bin/env node
/**
 * Runtime API prober. Boots the game and reports the ACTUAL shape of every
 * module's registered API, plus which bus events actually fire during a
 * scripted interaction.
 *
 * Eight agents built against a written contract in parallel; this is how we find
 * out where reality diverged from ARCHITECTURE.md before trying to play a match.
 *
 * Usage: node tools/probe.mjs [--url http://localhost:5173]
 */
import puppeteer from 'puppeteer'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)
const URL = args.url || 'http://localhost:5173'

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 900 })

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction('window.__READY === true', { timeout: 60000, polling: 100 })

const report = await page.evaluate(async () => {
  const ctx = window.__CTX
  const out = { modules: {}, state: null, world: null, busEvents: [], errors: window.__ERRORS || [] }

  const describe = (obj) => {
    if (!obj) return null
    const fns = []
    const props = []
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'function') fns.push(`${k}(${obj[k].length})`)
      else props.push(`${k}:${Array.isArray(obj[k]) ? 'array' : typeof obj[k]}`)
    }
    return { fns: fns.sort(), props: props.sort() }
  }

  for (const name of ['materials', 'world', 'units', 'fx', 'audio', 'ui', 'cameraRig', 'state', 'game', 'rules']) {
    out.modules[name] = describe(ctx[name])
  }

  // Snapshot game state shape
  if (ctx.state) {
    const s = ctx.state
    out.state = {
      keys: Object.keys(s),
      turn: s.turn, activeTeam: s.activeTeam, phase: s.phase,
      unitCount: Array.isArray(s.units) ? s.units.length : null,
      sampleUnit: Array.isArray(s.units) && s.units[0] ? Object.keys(s.units[0]) : null,
    }
  }

  // Snapshot world data shape
  if (ctx.world) {
    try {
      const t = ctx.world.getTile?.(5, 5)
      out.world = { sampleTileKeys: t ? Object.keys(t) : null, sampleTile: t ?? null,
                    tileCount: ctx.world.tiles?.length ?? null }
    } catch (e) { out.world = { error: String(e.message) } }
  }

  // Record every bus event for a few seconds of scripted interaction.
  const seen = new Map()
  const origEmit = ctx.bus.emit.bind(ctx.bus)
  ctx.bus.emit = (ev, payload) => {
    if (!seen.has(ev)) seen.set(ev, payload ? Object.keys(payload) : [])
    return origEmit(ev, payload)
  }

  // Poke the game the way a player would, and see what actually fires.
  try {
    const first = ctx.state?.units?.find?.((u) => u.team === 0 && u.alive)
    if (first) {
      ctx.bus.emit('unit:click', { unitId: first.id, button: 0 })
      await new Promise((r) => setTimeout(r, 400))
      ctx.bus.emit('tile:hover', { x: first.x + 2, z: first.z })
      await new Promise((r) => setTimeout(r, 400))
      ctx.bus.emit('ui:ability', { ability: 'overwatch' })
      await new Promise((r) => setTimeout(r, 400))
      ctx.bus.emit('ui:endTurn', {})
      await new Promise((r) => setTimeout(r, 800))
    }
  } catch (e) {
    out.interactionError = String(e.message)
  }

  ctx.bus.emit = origEmit
  out.busEvents = [...seen.entries()].map(([ev, keys]) => `${ev} {${keys.join(',')}}`).sort()

  out.perf = {
    fps: Math.round(ctx.fps || 0),
    calls: ctx.renderer?.info?.render?.calls,
    tris: ctx.renderer?.info?.render?.triangles,
    programs: ctx.renderer?.info?.programs?.length,
    textures: ctx.renderer?.info?.memory?.textures,
    geometries: ctx.renderer?.info?.memory?.geometries,
  }
  out.failedModules = window.__FAILED_MODULES || []
  return out
})

await browser.close()

console.log('═══ MODULE APIs ═══')
for (const [name, api] of Object.entries(report.modules)) {
  if (!api) { console.log(`  ${name.padEnd(11)} MISSING`); continue }
  console.log(`  ${name}`)
  if (api.fns.length) console.log(`    fns  : ${api.fns.join(', ')}`)
  if (api.props.length) console.log(`    props: ${api.props.join(', ')}`)
}
console.log('\n═══ STATE ═══');  console.log(JSON.stringify(report.state, null, 2))
console.log('\n═══ WORLD ═══');  console.log(JSON.stringify(report.world, null, 2))
console.log('\n═══ BUS EVENTS OBSERVED ═══')
report.busEvents.forEach((e) => console.log(`  ${e}`))
console.log('\n═══ PERF ═══');   console.log(JSON.stringify(report.perf, null, 2))
if (report.failedModules.length) console.log(`\n!!! DEGRADED: ${report.failedModules.join(', ')}`)
if (report.interactionError) console.log(`\n!!! INTERACTION ERROR: ${report.interactionError}`)
const errs = [...new Set([...report.errors, ...pageErrors])]
if (errs.length) { console.log(`\n═══ ${errs.length} ERROR(S) ═══`); errs.slice(0, 25).forEach((e) => console.log(`  - ${e.slice(0, 300)}`)) }
