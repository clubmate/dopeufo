#!/usr/bin/env node
/**
 * Screenshot harness. Boots the game in headless Chrome, waits for the engine to
 * report ready, settles N frames, then captures a PNG and reports runtime health.
 *
 * Usage:
 *   node tools/shoot.mjs --out shots/foo.png [--w 2560] [--h 1440] [--settle 90]
 *                        [--url http://localhost:5173] [--script tools/scenes/x.js]
 *
 * --script points at a JS file evaluated in the page AFTER boot, so a caller can
 * pose the camera or set up a specific tactical situation before the capture.
 *
 * Exit code is 0 on success, 1 on boot failure or timeout. Runtime diagnostics
 * (console errors, fps, draw calls, triangles) go to stdout as JSON on the last
 * line, prefixed with RESULT: so callers can parse it without fighting the log.
 */
import puppeteer from 'puppeteer'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)

const URL = args.url || 'http://localhost:5173'
const OUT = args.out || 'shots/shot.png'
const W = parseInt(args.w || '2560', 10)
const H = parseInt(args.h || '1440', 10)
const SETTLE = parseInt(args.settle || '90', 10)
const TIMEOUT = parseInt(args.timeout || '60000', 10)

mkdirSync(dirname(resolve(OUT)), { recursive: true })

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-webgl',
    '--use-mock-keychain',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
  ],
})

const result = {
  ok: false,
  url: URL,
  out: OUT,
  consoleErrors: [],
  pageErrors: [],
  failedModules: [],
  fps: null,
  drawCalls: null,
  triangles: null,
  programs: null,
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })

  page.on('console', (msg) => {
    const t = msg.type()
    const text = msg.text()
    if (t === 'error') result.consoleErrors.push(text)
    if (process.env.VERBOSE) console.log(`  [page:${t}] ${text}`)
  })
  page.on('pageerror', (err) => result.pageErrors.push(String(err.message || err)))

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })

  await page.waitForFunction('window.__READY === true', { timeout: TIMEOUT, polling: 100 })

  if (args.script) {
    const code = readFileSync(resolve(args.script), 'utf8')
    await page.evaluate(code)
  }

  // Let animations, lazy shader compiles and any post-boot camera move settle.
  await page.evaluate(
    (frames) =>
      new Promise((done) => {
        let n = 0
        const step = () => (++n >= frames ? done() : requestAnimationFrame(step))
        requestAnimationFrame(step)
      }),
    SETTLE
  )

  const stats = await page.evaluate(() => {
    const c = window.__CTX
    if (!c) return null
    return {
      fps: Math.round(c.fps || 0),
      drawCalls: c.renderer?.info?.render?.calls ?? null,
      triangles: c.renderer?.info?.render?.triangles ?? null,
      programs: c.renderer?.info?.programs?.length ?? null,
      failedModules: window.__FAILED_MODULES || [],
      errors: window.__ERRORS || [],
    }
  })

  if (stats) {
    result.fps = stats.fps
    result.drawCalls = stats.drawCalls
    result.triangles = stats.triangles
    result.programs = stats.programs
    result.failedModules = stats.failedModules
    result.pageErrors.push(...stats.errors)
  }

  await page.screenshot({ path: resolve(OUT), type: 'png' })
  result.ok = true
} catch (err) {
  result.error = String(err.message || err)
} finally {
  await browser.close()
}

// Human-readable summary first, machine-readable last.
console.log(`\n${result.ok ? '✓' : '✗'} ${OUT}  ${W}x${H}`)
if (result.error) console.log(`  error: ${result.error}`)
if (result.fps !== null) {
  console.log(`  fps ${result.fps} | draws ${result.drawCalls} | tris ${result.triangles} | programs ${result.programs}`)
}
if (result.failedModules?.length) console.log(`  DEGRADED MODULES: ${result.failedModules.join(', ')}`)
const errs = [...new Set([...result.consoleErrors, ...result.pageErrors])]
if (errs.length) {
  console.log(`  ${errs.length} error(s):`)
  errs.slice(0, 15).forEach((e) => console.log(`    - ${e.slice(0, 300)}`))
}
console.log(`RESULT:${JSON.stringify(result)}`)

process.exit(result.ok && errs.length === 0 ? 0 : result.ok ? 2 : 1)
