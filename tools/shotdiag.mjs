import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__CTX.state
  const out={ shots:[], events:[] }
  // record combat events
  const bus=window.__CTX.bus
  bus.on('unit:shoot',e=>out.events.push({ev:'shoot',hit:e.hit,dmg:e.dmg,crit:e.crit,killed:e.killed,t:e.targetId}))
  bus.on('unit:damaged',e=>out.events.push({ev:'damaged',id:e.unitId,dmg:e.dmg}))
  // place two units adjacent, in the open, guaranteed LOS
  const a=g.units.find(u=>u.team===0&&u.alive), d=g.units.find(u=>u.team===1&&u.alive)
  const pv = g.previewShot?.(a,d)
  out.preview = pv ? {hit:pv.hitChance,crit:pv.critChance,dmgMin:pv.dmgMin,dmgMax:pv.dmgMax,
                      mods:(pv.modifiers||[]).map(m=>`${m.label}:${m.value}`)} : null
  // roll the raw combat resolver many times to see the distribution
  if(g.combat?.resolveShot){
    const res=[]
    for(let i=0;i<40;i++){ try{ res.push(g.combat.resolveShot(a,d,{})) }catch(e){ res.push({err:String(e.message)}) } }
    const hits=res.filter(r=>r&&r.hit).length
    out.rawResolver={ n:res.length, hits, sample:res.slice(0,3) }
  } else out.rawResolver='no combat.resolveShot'
  out.rngProbe = g.rng ? [g.rng.next?.(),g.rng.next?.(),g.rng.next?.()] : 'no rng'
  out.targetHpBefore = d.hp
  return out
}),null,2))
await b.close()
