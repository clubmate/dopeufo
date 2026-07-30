import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:900,height:600})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(()=>{
  const out=[]
  const seen=new Set()
  window.__CTX.world.group.traverse(o=>{
    if(!o.isMesh||!o.material)return
    const m=o.material
    if(seen.has(m.uuid))return; seen.add(m.uuid)
    out.push({mesh:o.name, mat:m.name||'(unnamed)',
      color:'#'+m.color?.getHexString(),
      hasMap:!!m.map, vertexColors:!!m.vertexColors,
      rough:m.roughness, metal:m.metalness})
  })
  return out
}),null,2))
await b.close()
