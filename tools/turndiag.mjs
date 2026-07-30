import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__CTX.state
  const sleep=ms=>new Promise(r=>setTimeout(r,ms))
  const waitIdle=async(t=8000)=>{const t0=performance.now();while(g.isBusy?.()&&performance.now()-t0<t)await sleep(40)}
  const log=[]
  for(let i=0;i<6;i++){
    const team=g.activeTeam
    const roster=g.units.filter(u=>u.team===team&&u.alive)
      .map(u=>`${u.name} ap${u.ap} act=${!!g.canAct?.(u)} ow=${!!u.overwatch} ended=${!!u.turnEnded}`)
    log.push({iter:i, turn:g.turn, activeTeam:team, phase:g.phase, roster})
    g.endTurn(); await waitIdle(); await sleep(120)
    log[log.length-1].afterEndTurn={turn:g.turn, activeTeam:g.activeTeam}
  }
  return log
}),null,2))
await b.close()
