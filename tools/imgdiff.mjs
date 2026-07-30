import puppeteer from 'puppeteer'
import { readFileSync } from 'node:fs'
const [A,B]=process.argv.slice(2)
const b=await puppeteer.launch({headless:true,args:['--no-sandbox']})
const p=await b.newPage()
const uri=f=>`data:image/png;base64,${readFileSync(f).toString('base64')}`
await p.setContent(`<img id=a src="${uri(A)}"><img id=b src="${uri(B)}">`)
await p.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())))
console.log(JSON.stringify(await p.evaluate(()=>{
  const [a,bb]=[document.getElementById('a'),document.getElementById('b')]
  const W=a.naturalWidth,H=a.naturalHeight
  const g=i=>{const c=document.createElement('canvas');c.width=W;c.height=H
    const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,W,H).data}
  const A=g(a),B=g(bb)
  let sum=0,n=0,max=0,over8=0
  for(let i=0;i<A.length;i+=4){
    const d=(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]))/3
    sum+=d;n++;if(d>max)max=d;if(d>8)over8++
  }
  return {size:`${W}x${H}`, meanDiff:+(sum/n).toFixed(3), maxDiff:max,
          pctPixelsOver8:+(100*over8/n).toFixed(2)}
}),null,2))
await b.close()
