import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1500,height:850})
await p.goto('http://localhost:5173/?tx=8&tz=-6&dist=13&elev=0.72',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
// Sample the orange blob region and report which mesh is under it via raycast
console.log(JSON.stringify(await p.evaluate(()=>{
  const c=window.__CTX, THREE=c.THREE
  const rc=new THREE.Raycaster()
  const hits=[]
  // sample a grid of NDC points over the lower-right region where the blobs are
  for(const [nx,ny] of [[0.28,-0.52],[0.31,-0.60],[0.24,-0.46],[0.20,-0.40]]){
    rc.setFromCamera(new THREE.Vector2(nx,ny), c.camera)
    const is=rc.intersectObject(c.world.group,true)
    if(is.length) hits.push({ndc:[nx,ny], mesh:is[0].object.name,
      mat:is[0].object.material?.name||'?',
      dist:+is[0].distance.toFixed(1)})
    else hits.push({ndc:[nx,ny], mesh:'MISS'})
  }
  return hits
}),null,2))
await b.close()
