import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__CTX.state
  const out={checked:0,disagree:[],teleportTest:null}
  // Force many geometric configurations: teleport a shooter around the map and
  // compare getTargets() against previewShot().canFire for every enemy.
  const a=g.units.find(u=>u.team===0&&u.alive)
  const ox=a.x, oz=a.z
  for(let x=1;x<23;x+=3) for(let z=1;z<23;z+=3){
    const t=g.getTile?.(x,z); if(!t||!t.walkable||t.occupantId) continue
    a.x=x; a.z=z
    const targets=(g.getTargets?.(a)||[]).map(u=>u.id||u)
    for(const e of g.units.filter(u=>u.team!==a.team&&u.alive)){
      const pv=g.previewShot?.(a,e); if(!pv) continue
      const listed=targets.includes(e.id)
      out.checked++
      if(listed!==!!pv.canFire){
        if(out.disagree.length<8) out.disagree.push({from:[x,z],target:e.id,
          inGetTargets:listed,canFire:!!pv.canFire,hasLOS:!!pv.hasLOS,inRange:!!pv.inRange,
          hasAmmo:!!pv.hasAmmo,hit:pv.hitChance})
      }
    }
  }
  a.x=ox; a.z=oz
  out.disagreeCount=out.disagree.length
  return out
}),null,2))
await b.close()
