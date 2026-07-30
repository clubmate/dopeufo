import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:900,height:600})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(()=>{
  const c=window.__CTX
  const seen=new Set(), out=[]
  c.scene.traverse(o=>{
    if(!o.isMesh||!o.material) return
    const ms=Array.isArray(o.material)?o.material:[o.material]
    for(const m of ms){
      if(seen.has(m.uuid))continue; seen.add(m.uuid)
      out.push({name:m.name||'(unnamed)', rough:m.roughness, metal:m.metalness,
        envInt:m.envMapIntensity, hasRoughMap:!!m.roughnessMap, hasNormal:!!m.normalMap,
        hasEnv:!!(m.envMap||c.scene.environment)})
    }
  })
  return {envIntensityScene:c.scene.environmentIntensity ?? null,
          materials:out.filter(m=>m.metal>0 || /metal|rust|paint|glass/i.test(m.name))}
}),null,2))
await b.close()
