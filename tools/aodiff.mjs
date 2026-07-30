import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1280,height:720})
await p.goto('http://localhost:5173/?tx=-20&tz=-17&dist=16&elev=0.5',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2500))
const grab = async (on) => {
  await p.evaluate((on)=>{
    const ao=window.__CTX.composer.passes.find(x=>x.constructor.name.includes('GTAO'))
    ao.enabled=on
  }, on)
  await p.evaluate(()=>new Promise(d=>{let n=0;const s=()=>(++n>=30?d():requestAnimationFrame(s));requestAnimationFrame(s)}))
  return await p.screenshot({encoding:'base64',clip:{x:200,y:100,width:880,height:500}})
}
const onBuf = Buffer.from(await grab(true),'base64')
const offBuf = Buffer.from(await grab(false),'base64')
console.log('identical bytes:', onBuf.equals(offBuf))
console.log('size on/off:', onBuf.length, offBuf.length)
// decode both and compute mean abs diff
const dec = async (buf) => {
  const pg = await b.newPage()
  await pg.setContent(`<img id=i src="data:image/png;base64,${buf.toString('base64')}">`)
  await pg.evaluate(()=>document.getElementById('i').decode())
  const d = await pg.evaluate(()=>{const i=document.getElementById('i');const c=document.createElement('canvas');
    c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);
    return Array.from(x.getImageData(0,0,c.width,c.height).data)})
  await pg.close(); return d
}
const A=await dec(onBuf), B=await dec(offBuf)
let sum=0,n=0,maxd=0
for(let i=0;i<A.length;i+=4){const d=Math.abs(A[i]-B[i]);sum+=d;n++;if(d>maxd)maxd=d}
console.log('mean abs diff (R):', (sum/n).toFixed(3), '| max:', maxd)
console.log(sum/n < 0.5 ? 'VERDICT: AO contributes essentially NOTHING' : 'VERDICT: AO is visibly contributing')
await b.close()
