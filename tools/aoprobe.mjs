#!/usr/bin/env node
/**
 * Reads back the RAW GTAO render target.
 *
 * This is the objective test for "is AO actually computing anything". When the
 * pass is fed a depth buffer that never received the scene, its shader discards
 * every fragment and the target stays at its 0xffffff clear colour — so the
 * multiply blend scales the beauty by exactly 1.0 and produces no visible
 * occlusion while looking perfectly configured from the outside.
 *
 * pctOccluded near 0 with min ~255  => broken (white target, no AO)
 * pctOccluded well above 0, min low => working
 */
import puppeteer from 'puppeteer'

const URL = process.argv[2] || 'http://localhost:5173'
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'],
})
const p = await b.newPage()
await p.setViewport({ width: 1280, height: 720 })
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForFunction('window.__READY === true', { timeout: 60000, polling: 100 })
await new Promise((r) => setTimeout(r, 3000))

const stats = await p.evaluate(() => {
  const c = window.__CTX
  const ao = c.composer?.passes?.find((x) => x.constructor.name.includes('GTAO'))
  if (!ao) return { err: 'no GTAO pass in composer' }
  const rt = ao.gtaoRenderTarget
  if (!rt) return { err: 'no gtaoRenderTarget' }

  const w = rt.width
  const h = rt.height
  const buf = new Uint8Array(w * h * 4)
  c.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)

  let min = 255
  let max = 0
  let sum = 0
  let n = 0
  let occluded = 0
  for (let i = 0; i < buf.length; i += 4) {
    const v = buf[i]
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    n++
    if (v < 250) occluded++
  }
  return {
    target: `${w}x${h}`,
    min,
    max,
    mean: +(sum / n).toFixed(1),
    pctOccluded: +((100 * occluded) / n).toFixed(1),
    blendIntensity: ao.blendIntensity,
    enabled: ao.enabled,
  }
})

console.log(JSON.stringify(stats, null, 2))
if (stats.err) {
  console.log('\nVERDICT: could not measure')
} else if (stats.pctOccluded < 1 && stats.min > 240) {
  console.log('\nVERDICT: BROKEN — AO target is white, contributing nothing')
} else {
  console.log(`\nVERDICT: WORKING — ${stats.pctOccluded}% of pixels carry occlusion (darkest ${stats.min}/255)`)
}
await b.close()
