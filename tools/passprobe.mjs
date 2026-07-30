import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1600,height:900})
await p.goto('http://localhost:5173/?tx=0&tz=0&dist=34',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,3000))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const c=window.__CTX,r=c.renderer,gl=r.getContext()
  const time=async()=>{
    await new Promise(d=>{let n=0;const s=()=>(++n>=15?d():requestAnimationFrame(s));requestAnimationFrame(s)})
    const t0=performance.now();let f=0
    await new Promise(d=>{const s=()=>{if(f>=40){d();return}f++
      if(c.composer)c.composer.render(0.016);else r.render(c.scene,c.camera)
      gl.finish();requestAnimationFrame(s)};requestAnimationFrame(s)})
    return (performance.now()-t0)/f
  }
  const base=await time()
  const rows=[{pass:'BASELINE',ms:+base.toFixed(2),delta:0}]
  for(const pass of c.composer.passes){
    if(pass.constructor.name==='RenderPass') continue
    const was=pass.enabled
    pass.enabled=false
    const t=await time()
    pass.enabled=was
    rows.push({pass:pass.constructor.name, ms:+t.toFixed(2), delta:+(base-t).toFixed(2),
      size: pass.renderTarget?.width ? `${pass.renderTarget.width}x${pass.renderTarget.height}` : null})
  }
  return {rows, viewport:`${r.domElement.width}x${r.domElement.height}`, pixelRatio:r.getPixelRatio()}
}),null,2))
await b.close()
