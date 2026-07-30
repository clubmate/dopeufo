import puppeteer from 'puppeteer'
const b=await puppeteer.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--no-sandbox']})
const p=await b.newPage(); await p.setViewport({width:1000,height:600})
await p.goto('http://localhost:5173',{waitUntil:'domcontentloaded'})
await p.waitForFunction('window.__READY===true',{timeout:60000,polling:100})
await new Promise(r=>setTimeout(r,2200))
console.log(JSON.stringify(await p.evaluate(()=>{
  const w=window.__CTX.world
  const spec=w?.spec
  if(!spec) return {err:'no spec exposed', keys:Object.keys(w||{})}
  const byType={}
  for(const pr of spec.props||[]){
    byType[pr.type]=byType[pr.type]||{count:0,variants:{},seeds:[]}
    const e=byType[pr.type]; e.count++
    e.variants[pr.variant]=(e.variants[pr.variant]||0)+1
    if(e.seeds.length<4)e.seeds.push(pr.seed)
  }
  const repeated=Object.entries(byType).filter(([,v])=>v.count>1)
    .sort((a,b)=>b[1].count-a[1].count)
    .map(([k,v])=>({type:k,count:v.count,variants:v.variants}))
  return {totalProps:(spec.props||[]).length, repeated}
}),null,2))
await b.close()
