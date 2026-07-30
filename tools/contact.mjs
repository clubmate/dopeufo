import puppeteer from 'puppeteer'
import { readFileSync, readdirSync } from 'node:fs'
const files = readdirSync('reference').filter(f=>f.endsWith('.jpg')).sort()
const cells = files.map((f,i)=>`<div class="c"><img src="data:image/jpeg;base64,${readFileSync('reference/'+f).toString('base64')}"><span>${f.replace('xcom2_','').replace('.jpg','')}</span></div>`).join('')
const html=`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(4,480px);gap:6px}
.c{position:relative;width:480px;height:270px}.c img{width:100%;height:100%;object-fit:cover}
.c span{position:absolute;left:4px;top:4px;color:#fff;background:#000c;padding:2px 8px;font:700 20px system-ui}</style>${cells}`
const b=await puppeteer.launch({headless:true,args:['--no-sandbox','--hide-scrollbars']})
const p=await b.newPage(); await p.setViewport({width:4*480+30,height:4*276+30})
await p.setContent(html,{waitUntil:'load'})
await p.evaluate(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))))
await p.screenshot({path:'shots/reference-sheet.png'}); await b.close()
console.log('ok', files.length)
