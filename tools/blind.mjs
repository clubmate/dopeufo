#!/usr/bin/env node
/**
 * Blind A/B composite builder.
 *
 * Takes our screenshot and a reference screenshot, normalises both to identical
 * dimensions and encoding (so resolution or JPEG artefacts can't leak the
 * answer), randomises which side each lands on, and writes:
 *   - <out>          the unlabelled side-by-side the critic sees
 *   - <out>.key.json the answer, which the critic must never be shown
 *
 * Normalisation matters: if ours is a crisp 2560px PNG and the reference is a
 * 1920px JPEG, a sharp critic identifies them by artefacts alone and the "blind"
 * test is worthless.
 *
 * Usage:
 *   node tools/blind.mjs --a shots/hero.png --b reference/xcom2_03.jpg \
 *                        --out shots/blind/round1.png [--w 1920] [--seed 42]
 */
import puppeteer from 'puppeteer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, extname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)

const A = resolve(args.a)          // ours
const B = resolve(args.b)          // reference
const OUT = resolve(args.out || 'shots/blind/blind.png')
const PANEL_W = parseInt(args.w || '1920', 10)
const PANEL_H = Math.round((PANEL_W * 9) / 16)

mkdirSync(dirname(OUT), { recursive: true })

function dataUri(p) {
  const ext = extname(p).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
}

// Coin flip decides which image is on the left.
const seed = args.seed !== undefined ? parseInt(args.seed, 10) : null
const flip = seed !== null ? (Math.sin(seed) * 10000) % 1 > 0.5 : Math.random() > 0.5
const left = flip ? { src: A, tag: 'OURS' } : { src: B, tag: 'REFERENCE' }
const right = flip ? { src: B, tag: 'REFERENCE' } : { src: A, tag: 'OURS' }

const html = `<!doctype html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${PANEL_W * 2 + 24}px; height:${PANEL_H + 64}px; background:#111; display:flex;
         flex-direction:column; align-items:center; font-family:system-ui,sans-serif; }
  .row { display:flex; gap:24px; }
  .cell { width:${PANEL_W}px; height:${PANEL_H}px; overflow:hidden; background:#000;
          display:flex; align-items:center; justify-content:center; }
  .cell img { width:100%; height:100%; object-fit:cover; image-rendering:auto; }
  .labels { display:flex; gap:24px; margin-top:16px; }
  .labels div { width:${PANEL_W}px; text-align:center; color:#ddd; font-size:28px;
                letter-spacing:.3em; font-weight:600; }
</style></head><body>
  <div class="row">
    <div class="cell"><img src="${dataUri(left.src)}"></div>
    <div class="cell"><img src="${dataUri(right.src)}"></div>
  </div>
  <div class="labels"><div>IMAGE A</div><div>IMAGE B</div></div>
</body></html>`

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars'] })
const page = await browser.newPage()
await page.setViewport({ width: PANEL_W * 2 + 24, height: PANEL_H + 64, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {}))))
await page.screenshot({ path: OUT, type: 'png' })
await browser.close()

const key = { A: left.tag, B: right.tag, ours: left.tag === 'OURS' ? 'A' : 'B', files: { left: left.src, right: right.src } }
writeFileSync(`${OUT}.key.json`, JSON.stringify(key, null, 2))

console.log(`✓ ${OUT}`)
console.log(`  key written to ${OUT}.key.json (do NOT show this to the critic)`)
console.log(`KEY:${JSON.stringify(key)}`)
