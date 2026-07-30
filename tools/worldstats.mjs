import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(()=>{
  const c=window.__CTX, w=c.world
  const out={ worldStats: w?.stats ?? null, groups:{}, totalMeshes:0, instanced:[] }
  w?.group?.traverse(o=>{
    if(o.isInstancedMesh){ out.instanced.push({name:o.name||o.material?.name||'?', count:o.count}) }
    else if(o.isMesh){ out.totalMeshes++ }
  })
  // top-level children by name
  for(const ch of (w?.group?.children||[])){
    let n=0; ch.traverse(o=>{if(o.isMesh)n++})
    out.groups[ch.name||'(unnamed)'] = { meshes:n, instanced: ch.isInstancedMesh?ch.count:0 }
  }
  return out
}),null,2))
await b.close()
