import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2000))
const info = await p.evaluate(()=>{
  const c=window.__CTX
  const out={ composer:!!c.composer, passes:[], renderParams:null }
  if(c.composer?.passes) out.passes = c.composer.passes.map(x=>({
    name:x.constructor?.name, enabled:x.enabled!==false,
    scale:x._scale??x.scale??null,
    output: x.output ?? null,
    blend: x.blendIntensity ?? x.blendMode ?? null,
    radius: x.radius ?? (x.pdParams?.radius) ?? null,
  }))
  out.renderParams = c.render?.params ? JSON.parse(JSON.stringify(c.render.params)) : null
  out.toneMapping = c.renderer.toneMapping
  out.exposure = c.renderer.toneMappingExposure
  out.shadowsEnabled = c.renderer.shadowMap.enabled
  out.envSet = !!c.scene.environment
  return out
})
console.log(JSON.stringify(info,null,2))
await b.close()
