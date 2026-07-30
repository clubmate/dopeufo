import puppeteer from 'puppeteer'
const b = await puppeteer.launch({headless:true, args:['--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--no-sandbox']})
const p = await b.newPage()
await p.goto('about:blank')
const info = await p.evaluate(() => {
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  if (!gl) return {error:'no webgl'}
  const d = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    version: gl.getParameter(gl.VERSION),
    webgl2: !!c.getContext('webgl2'),
    vendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES ?? 0x8D57),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
  }
})
console.log(JSON.stringify(info, null, 2))
await b.close()
