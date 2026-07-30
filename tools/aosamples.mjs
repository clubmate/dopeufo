import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1600,height:900})
await p.goto('http://localhost:5173/?tx=-20&tz=-17&dist=16&elev=0.5',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,3000))
const shots={}
for(const s of [8,6,4]){
  const ms=await p.evaluate(async(samples)=>{
    const c=window.__CTX,r=c.renderer,gl=r.getContext()
    const ao=c.composer.passes.find(x=>x.constructor.name.includes('GTAO'))
    ao.updateGtaoMaterial({samples})
    await new Promise(d=>{let n=0;const st=()=>(++n>=15?d():requestAnimationFrame(st));requestAnimationFrame(st)})
    const t0=performance.now();let f=0
    await new Promise(d=>{const st=()=>{if(f>=40){d();return}f++;c.composer.render(0.016);gl.finish();requestAnimationFrame(st)};requestAnimationFrame(st)})
    return (performance.now()-t0)/f
  },s)
  shots[s]=await p.screenshot({encoding:'base64',clip:{x:300,y:150,width:900,height:550}})
  console.log(`samples ${s}: ${ms.toFixed(2)} ms  (${Math.round(1000/ms)} fps)`)
}
// diff 8 vs 6 and 8 vs 4
const pg=await b.newPage()
for(const s of [6,4]){
  await pg.setContent(`<img id=a src="data:image/png;base64,${shots[8]}"><img id=b src="data:image/png;base64,${shots[s]}">`)
  await pg.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())))
  const d=await pg.evaluate(()=>{
    const [a,bb]=[document.getElementById('a'),document.getElementById('b')]
    const W=a.naturalWidth,H=a.naturalHeight
    const g=i=>{const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,W,H).data}
    const A=g(a),B=g(bb);let sum=0,n=0,max=0,over8=0
    for(let i=0;i<A.length;i+=4){const dd=(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]))/3
      sum+=dd;n++;if(dd>max)max=dd;if(dd>8)over8++}
    return {mean:+(sum/n).toFixed(3),max,pctOver8:+(100*over8/n).toFixed(2)}
  })
  console.log(`  8 vs ${s} samples -> mean ${d.mean}, max ${d.max}, ${d.pctOver8}% pixels >8`)
}
await b.close()
