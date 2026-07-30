import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__CTX.state
  const out={}
  // Move a shooter next to an enemy so a shot is definitely legal.
  const a=g.units.find(u=>u.team===0&&u.alive)
  const e=g.units.find(u=>u.team===1&&u.alive)
  a.x=e.x+1; a.z=e.z; a.elevation=e.elevation
  const pv=g.previewShot(a,e)
  out.pre={hit:pv.hitChance,canFire:pv.canFire,hp:e.hp,ap:a.ap}
  if(!pv.canFire) return out
  g.selectUnit(a.id); await new Promise(r=>setTimeout(r,60))
  out.busyBeforeFire=g.isBusy?.()
  g.fireAt(e.id)
  // sample isBusy at fine granularity right after the call
  const samples=[]
  for(let i=0;i<12;i++){ samples.push([i*10, g.isBusy?.()]); await new Promise(r=>setTimeout(r,10)) }
  out.busySamplesMs=samples
  await new Promise(r=>setTimeout(r,2500))
  out.post={hp:e.hp,ap:a.ap,busy:g.isBusy?.()}
  return out
}),null,2))
await b.close()
