import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1600,height:900})
await p.goto('http://localhost:5173/?tx=0&tz=0&dist=34',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,3000))
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const c=window.__CTX, r=c.renderer
  const gl=r.getContext()
  // Measure by forcing a GPU flush each frame and timing N frames.
  const bench=async(label,setup,teardown)=>{
    setup&&setup()
    await new Promise(d=>{let n=0;const s=()=>(++n>=20?d():requestAnimationFrame(s));requestAnimationFrame(s)})
    const t0=performance.now(); let frames=0
    await new Promise(d=>{
      const s=()=>{
        if(frames>=45){d();return}
        frames++
        if(c.composer) c.composer.render(0.016); else r.render(c.scene,c.camera)
        gl.finish()
        requestAnimationFrame(s)
      }
      requestAnimationFrame(s)
    })
    const ms=(performance.now()-t0)/frames
    teardown&&teardown()
    return {label, ms:+ms.toFixed(2), fps:Math.round(1000/ms)}
  }
  const out=[]
  out.push(await bench('baseline'))
  // shadows off
  out.push(await bench('no shadows',
    ()=>{ r.shadowMap.enabled=false; c.scene.traverse(o=>{if(o.isLight&&o.castShadow){o.userData._cs=true;o.castShadow=false}}) },
    ()=>{ r.shadowMap.enabled=true; c.scene.traverse(o=>{if(o.userData._cs){o.castShadow=true;delete o.userData._cs}}) }))
  // post off
  out.push(await bench('no post',
    ()=>{ window.__savedComposer=c.composer; c.composer=null },
    ()=>{ c.composer=window.__savedComposer }))
  // world hidden
  out.push(await bench('world hidden',
    ()=>{ if(c.world?.group) c.world.group.visible=false },
    ()=>{ if(c.world?.group) c.world.group.visible=true }))
  // units hidden
  out.push(await bench('units hidden',
    ()=>{ if(c.units?.root) c.units.root.visible=false },
    ()=>{ if(c.units?.root) c.units.root.visible=true }))
  return {passes:out, info:{calls:r.info.render.calls,tris:r.info.render.triangles,
    programs:r.info.programs.length, textures:r.info.memory.textures, geometries:r.info.memory.geometries},
    shadowMapSize: (()=>{let s=null;c.scene.traverse(o=>{if(o.isLight&&o.shadow&&o.castShadow)s=o.shadow.mapSize.width});return s})()}
}),null,2))
await b.close()
