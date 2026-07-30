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
 * Category matters just as much. reference/manifest.json splits the set into
 * tactical / shotcam / character / ui, because most of it is promo material:
 * cinematic close-ups and menu screens. Pairing our overview camera against a
 * depth-of-field character render asks the critic to score us on a shot our
 * camera cannot take, and every note that comes back is noise. So --b must
 * belong to the requested --category, or this refuses to build the composite.
 *
 * Usage:
 *   # pick a tactical reference automatically (default category)
 *   node tools/blind.mjs --a shots/hero.png --out shots/blind/round1.png --seed 42
 *
 *   # explicit reference, must match the category
 *   node tools/blind.mjs --a shots/shot.png --b reference/xcom2_14.jpg \
 *                        --category shotcam --out shots/blind/round2.png
 *
 *   [--w 1920] [--seed 42] [--force to override the category check]
 */
import puppeteer from 'puppeteer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, extname, basename, join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)

const REF_DIR = 'reference'
const MANIFEST = JSON.parse(readFileSync(join(REF_DIR, 'manifest.json'), 'utf8'))
const CATEGORY = args.category || 'tactical'

if (!MANIFEST.categories[CATEGORY]) {
  console.error(`unknown --category "${CATEGORY}". known: ${Object.keys(MANIFEST.categories).join(', ')}`)
  process.exit(1)
}

const inCategory = Object.entries(MANIFEST.images)
  .filter(([, meta]) => meta.category === CATEGORY)
  .map(([file]) => file)
  .sort()

// Seeded so a rerun of the same round pairs against the same reference; without
// a seed we sample the pool, which is what you want across a batch of rounds.
function pickReference() {
  if (!inCategory.length) {
    console.error(`no reference images in category "${CATEGORY}"`)
    process.exit(1)
  }
  const r = seed !== null ? Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1 : Math.random()
  return join(REF_DIR, inCategory[Math.floor(r * inCategory.length) % inCategory.length])
}

// Coin flip decides which image is on the left.
const seed = args.seed !== undefined ? parseInt(args.seed, 10) : null

const A = resolve(args.a)                                   // ours
const bPath = args.b && args.b !== true ? args.b : pickReference()
const B = resolve(bPath)                                    // reference

const bMeta = MANIFEST.images[basename(bPath)]
if (!bMeta) {
  console.warn(`⚠ ${basename(bPath)} is not in ${REF_DIR}/manifest.json — classify it there so the critic pairs it correctly`)
} else if (bMeta.category !== CATEGORY && !args.force) {
  console.error(
    `✗ refusing to pair a "${CATEGORY}" capture against ${basename(bPath)}, which is "${bMeta.category}".\n` +
      `  ${MANIFEST.categories[bMeta.category]}\n` +
      `  Pass --category ${bMeta.category} if that is really what you are judging, or --force to override.`
  )
  process.exit(1)
}

const OUT = resolve(args.out || 'shots/blind/blind.png')
const PANEL_W = parseInt(args.w || '1920', 10)
const PANEL_H = Math.round((PANEL_W * 9) / 16)

mkdirSync(dirname(OUT), { recursive: true })

function dataUri(p) {
  const ext = extname(p).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
}

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

const key = {
  A: left.tag,
  B: right.tag,
  ours: left.tag === 'OURS' ? 'A' : 'B',
  category: CATEGORY,
  reference: { file: basename(bPath), note: bMeta?.note ?? null },
  files: { left: left.src, right: right.src },
}
writeFileSync(`${OUT}.key.json`, JSON.stringify(key, null, 2))

console.log(`✓ ${OUT}`)
console.log(`  category ${CATEGORY} vs ${basename(bPath)}${bMeta?.note ? ` — ${bMeta.note}` : ''}`)
console.log(`  key written to ${OUT}.key.json (do NOT show this to the critic)`)
console.log(`KEY:${JSON.stringify(key)}`)
