import puppeteer from 'puppeteer'
import { readFileSync, readdirSync } from 'node:fs'

// Grouped by reference/manifest.json so the sheet shows at a glance which shots
// are actually comparable to our camera. Height is derived from the file count —
// a fixed row count silently crops whatever was added last.
const manifest = JSON.parse(readFileSync('reference/manifest.json', 'utf8'))
const files = readdirSync('reference').filter(f=>f.endsWith('.jpg')).sort()
const order = ['tactical','shotcam','character','ui']
const catOf = f => manifest.images[f]?.category ?? 'unclassified'
const groups = [...order, 'unclassified'].map(c=>[c, files.filter(f=>catOf(f)===c)]).filter(([,fs])=>fs.length)

const COLS = 4, CELL_W = 480, CELL_H = 270, HEAD_H = 44
const cell = f=>`<div class="c"><img src="data:image/jpeg;base64,${readFileSync('reference/'+f).toString('base64')}"><span>${f.replace('xcom2_','').replace('.jpg','')}</span></div>`
const sections = groups.map(([c,fs])=>`<h2>${c} — ${fs.length}<em>${manifest.categories[c]??''}</em></h2><div class="g">${fs.map(cell).join('')}</div>`).join('')
const rows = groups.reduce((n,[,fs])=>n+Math.ceil(fs.length/COLS),0)
const height = rows*(CELL_H+6) + groups.length*HEAD_H + 30

const html=`<style>body{margin:0;background:#111;padding:12px;font:400 14px system-ui}
h2{color:#fff;font:700 20px system-ui;margin:10px 0 6px;text-transform:uppercase;letter-spacing:.1em}
h2 em{display:block;color:#8b9bb4;font:400 13px system-ui;text-transform:none;letter-spacing:0;margin-top:2px}
.g{display:grid;grid-template-columns:repeat(${COLS},${CELL_W}px);gap:6px}
.c{position:relative;width:${CELL_W}px;height:${CELL_H}px}.c img{width:100%;height:100%;object-fit:cover}
.c span{position:absolute;left:4px;top:4px;color:#fff;background:#000c;padding:2px 8px;font:700 20px system-ui}</style>${sections}`

const b=await puppeteer.launch({headless:true,args:['--no-sandbox','--hide-scrollbars']})
const p=await b.newPage(); await p.setViewport({width:COLS*CELL_W+3*6+24,height:Math.round(height)})
await p.setContent(html,{waitUntil:'load'})
await p.evaluate(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))))
await p.screenshot({path:'shots/reference-sheet.png',fullPage:true}); await b.close()
console.log('ok', files.length, groups.map(([c,fs])=>`${c}:${fs.length}`).join(' '))
