import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__CTX.state, w=g.world||window.__CTX.world
  let walkable=0
  for(let x=0;x<24;x++)for(let z=0;z<24;z++){const t=g.getTile?.(x,z);if(t&&t.walkable)walkable++}
  const rows=[]
  for(const u of g.units.filter(u=>u.alive)){
    const r=g.getReachable?.(u); if(!r)continue
    const blue=r.blue?.size??0, dash=r.dash?.size??0
    rows.push({unit:u.name,cls:u.className,mob:u.mobility,
      blue, dash, total:blue+dash,
      pctBlue:+(100*blue/walkable).toFixed(1),
      pctTotal:+(100*(blue+dash)/walkable).toFixed(1)})
  }
  return {walkableTiles:walkable, units:rows}
}),null,2))
await b.close()
