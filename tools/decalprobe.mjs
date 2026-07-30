import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:900,height:600})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(()=>{
  const spec=window.__CTX.world.spec
  const byType={}
  for(const d of spec.decals||[]) byType[d.type]=(byType[d.type]||0)+1
  const dress={}
  for(const d of spec.dressing||[]) dress[d.type]=(dress[d.type]||0)+1
  return {decalTotal:(spec.decals||[]).length, byType,
          dressingTotal:(spec.dressing||[]).length, dress,
          walkable:(spec.tiles||[]).filter(t=>t.walkable).length}
}),null,2))
await b.close()
