import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))

// play turns using the same logic as the playtest bot
await p.evaluate(()=>{
  const g=window.__CTX.state
  window.__ev=[]
  window.__CTX.bus.on('unit:shoot',e=>window.__ev.push(`shoot hit=${e.hit} dmg=${e.dmg} tgt=${e.targetId}`))
  window.__CTX.bus.on('unit:damaged',e=>window.__ev.push(`damaged ${e.unitId} -${e.dmg}`))
  const settle=(ms=60)=>new Promise(r=>setTimeout(r,ms))
  const waitIdle=async(t=8000)=>{const t0=performance.now();while(g.isBusy?.()&&performance.now()-t0<t)await settle(40);}
  window.__turn=async()=>{
    const team=g.activeTeam
    for(const u of g.units.filter(u=>u.team===team&&u.alive)){
      if(!g.canAct?.(u))continue
      g.selectUnit(u.id); await settle(20)
      const ts=g.getTargets?.(u)||[]
      if(ts.length){ g.fireAt(ts[0].id||ts[0]); await waitIdle(); continue }
      const en=g.units.filter(e=>e.team!==team&&e.alive); if(!en.length)break
      const nd=(x,z)=>Math.min(...en.map(e=>Math.max(Math.abs(x-e.x),Math.abs(z-e.z))))
      const r=g.getReachable?.(u); const pool=r?[...(r.blue||[]),...(r.dash||[])]:[]
      let best=null
      for(const k of pool){const t=typeof k==='object'?k:{x:k%24,z:Math.floor(k/24)};const d=nd(t.x,t.z);if(!best||d<best.d)best={d,tile:t}}
      if(best&&best.d<nd(u.x,u.z)){ g.moveTo(best.tile.x,best.tile.z); await waitIdle() }
      else { g.useAbility?.('overwatch'); await waitIdle(2500) }
    }
    g.endTurn(); await waitIdle()
  }
})
for(let i=0;i<14;i++){ await p.evaluate(()=>window.__turn()); const s=await p.evaluate(()=>({p:window.__CTX.state.phase,w:window.__CTX.state.winner,t:window.__CTX.state.turn})); if(s.p==="over"){ console.log("ENDED turn",s.t,"phase",s.p,"winner",JSON.stringify(s.w)); break } }

// now inspect the stalled state in detail
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__CTX.state
  const out={turn:g.turn,activeTeam:g.activeTeam,phase:g.phase,isBusy:g.isBusy?.(),
             alive:g.units.filter(u=>u.alive).map(u=>`${u.name} hp${u.hp} ap${u.ap} act=${!!g.canAct?.(u)}`),
             recentEvents:window.__ev.slice(-8)}
  let shooter=null,tid=null
  for(const u of g.units.filter(u=>u.team===g.activeTeam&&u.alive)){
    const t=g.getTargets?.(u)||[]
    if(t.length){shooter=u;tid=t[0].id||t[0];break}
  }
  if(!shooter){out.note='no shooter with targets';return out}
  const tgt=g.getUnit(tid)
  const pv=g.previewShot(shooter,tgt)
  out.attempt={shooter:shooter.name,ap:shooter.ap,canAct:!!g.canAct(shooter),target:tgt.name,hp:tgt.hp,
    hit:pv.hitChance,canFire:pv.canFire,hasLOS:pv.hasLOS,inRange:pv.inRange,hasAmmo:pv.hasAmmo,
    ammo:shooter.weapon?.ammo,turnEnded:shooter.turnEnded,movedThisTurn:shooter.movedThisTurn}
  const before=tgt.hp; const n=window.__ev.length
  g.selectUnit(shooter.id); await new Promise(r=>setTimeout(r,60))
  g.fireAt(tid); await new Promise(r=>setTimeout(r,1500))
  out.result={hpBefore:before,hpAfter:g.getUnit(tid).hp,newEvents:window.__ev.slice(n)}
  return out
}),null,2))
await b.close()
