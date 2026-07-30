import puppeteer from 'puppeteer'
const b = await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p = await b.newPage(); await p.setViewport({width:1600,height:900})
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
const out = await p.evaluate(() => {
  const c = window.__CTX, THREE = c.THREE
  const r = { unitsApiCount:null, rootChildren:null, rootInScene:null, handles:[], spawnTest:null }
  try { r.unitsApiCount = c.units?.count?.() } catch(e){ r.unitsApiCount = 'ERR '+e.message }
  const root = c.units?.root
  r.rootChildren = root?.children?.length ?? null
  r.rootInScene = !!root && (() => { let o=root; while(o){ if(o===c.scene) return true; o=o.parent } return false })()
  try {
    for (const u of (c.state?.units||[]).slice(0,3)) {
      const obj = c.units?.getObject?.(u.id)
      const wp = obj ? obj.getWorldPosition(new THREE.Vector3()) : null
      r.handles.push({ id:u.id, tile:[u.x,u.z], alive:u.alive, hasObj:!!obj,
        visible: obj?.visible, worldPos: wp?[+wp.x.toFixed(2),+wp.y.toFixed(2),+wp.z.toFixed(2)]:null,
        childCount: obj?.children?.length })
    }
  } catch(e){ r.handles.push('ERR '+e.message) }
  // count skinned/meshes under units root
  let meshes=0, skinned=0
  root?.traverse?.(o=>{ if(o.isSkinnedMesh) skinned++; else if(o.isMesh) meshes++ })
  r.meshCount=meshes; r.skinnedCount=skinned
  return r
})
console.log(JSON.stringify(out,null,2))
if(errs.length){ console.log('\nERRORS:'); [...new Set(errs)].slice(0,10).forEach(e=>console.log(' - '+e.slice(0,250))) }
await b.close()
