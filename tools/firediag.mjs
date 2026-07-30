import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__CTX.state, bus=window.__CTX.bus
  const ev=[]
  bus.on('unit:shoot',e=>ev.push(`shoot hit=${e.hit} dmg=${e.dmg} killed=${e.killed}`))
  bus.on('unit:damaged',e=>ev.push(`damaged ${e.unitId} -${e.dmg}`))
  const sleep=ms=>new Promise(r=>setTimeout(r,ms))
  const out={steps:[]}
  // find a shooter that actually HAS a target per getTargets
  let shooter=null,target=null
  for(const u of g.units.filter(u=>u.team===g.activeTeam&&u.alive)){
    const t=g.getTargets?.(u)||[]
    if(t.length){ shooter=u; target=t[0]; break }
  }
  if(!shooter){ return {err:'no shooter with targets on active team', activeTeam:g.activeTeam} }
  const tid=target.id||target.unitId||target
  const tgt=g.getUnit?.(tid)||target
  out.shooter={id:shooter.id,name:shooter.name,ap:shooter.ap,canAct:g.canAct?.(shooter)}
  out.target={id:tid,hp:tgt.hp}
  const pv=g.previewShot?.(shooter,tgt)
  out.preview={hit:pv?.hitChance,canFire:pv?.canFire,hasLOS:pv?.hasLOS,inRange:pv?.inRange,hasAmmo:pv?.hasAmmo}
  g.selectUnit(shooter.id); await sleep(80)
  out.afterSelect={selected:g.selectedUnitId, phase:g.phase}
  const r=g.fireAt(tid)
  out.fireAtReturn=r===undefined?'undefined':JSON.parse(JSON.stringify(r??null))
  await sleep(1500)
  out.events=ev
  out.targetHpAfter=(g.getUnit?.(tid)||tgt).hp
  out.shooterApAfter=shooter.ap
  out.phaseAfter=g.phase
  return out
}),null,2))
await b.close()
