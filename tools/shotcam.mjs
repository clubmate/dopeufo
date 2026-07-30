import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1200,height:700})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const c=window.__CTX, g=c.state, THREE=c.THREE
  // put a shooter next to a target so a real shot resolves
  const a=g.units.find(u=>u.team===0&&u.alive), t=g.units.find(u=>u.team===1&&u.alive)
  a.x=t.x+2; a.z=t.z; a.elevation=t.elevation
  const shooterPos=c.grid.toWorld(a.x,a.z,a.elevation,new THREE.Vector3())
  const targetPos=c.grid.toWorld(t.x,t.z,t.elevation,new THREE.Vector3())
  g.selectUnit(a.id); await new Promise(r=>setTimeout(r,80))
  const samples=[]
  const rec=()=>{
    const cp=c.camera.position
    samples.push({
      t:+performance.now().toFixed(0),
      cam:[+cp.x.toFixed(2),+cp.y.toFixed(2),+cp.z.toFixed(2)],
      distToShooter:+cp.distanceTo(shooterPos).toFixed(2),
      distToTarget:+cp.distanceTo(targetPos).toFixed(2),
    })
  }
  rec()
  g.fireAt(t.id)
  for(let i=0;i<26;i++){ await new Promise(r=>requestAnimationFrame(r)); if(i%3===0) rec() }
  await new Promise(r=>setTimeout(r,900)); rec()
  return {shooter:[+shooterPos.x.toFixed(1),+shooterPos.y.toFixed(1),+shooterPos.z.toFixed(1)],
          target:[+targetPos.x.toFixed(1),+targetPos.y.toFixed(1),+targetPos.z.toFixed(1)],
          shooterTargetDist:+shooterPos.distanceTo(targetPos).toFixed(2),
          samples}
}),null,2))
await b.close()
