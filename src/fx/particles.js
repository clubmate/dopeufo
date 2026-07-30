/**
 * GPU particle core.
 *
 * ARCHITECTURE
 *  - One `Layer` per (texture, blend mode, feature set). A layer is a single
 *    InstancedBufferGeometry of quads and therefore exactly ONE draw call
 *    regardless of how many particles are live.
 *  - A particle's whole life is described by 7 vec4 attributes written once at
 *    spawn. Position, size, colour, rotation, flipbook frame and velocity
 *    stretch are all evaluated in the vertex shader from `uTime`. The CPU never
 *    touches a live particle again — per-frame cost is one uniform write and
 *    one glBufferSubData of only the slots dirtied this frame.
 *  - Slots are a ring buffer. There is no allocation after warmup: spawn
 *    parameters are written through a single reused struct (`sys.p`).
 *  - Soft particles sample a half-resolution depth prepass this module renders
 *    itself, so it does not depend on the render module exposing anything.
 */
import * as THREE from 'three'
import PARTICLE_VERT from './shaders/particle.vert.glsl?raw'
import PARTICLE_FRAG from './shaders/particle.frag.glsl?raw'

const STRIDE = 4 // all attributes are vec4

/** Reusable spawn descriptor — filled by callers, read by `emit`. Never copied. */
class SpawnParams {
  constructor() { this.reset() }
  reset() {
    this.x = 0; this.y = 0; this.z = 0
    this.vx = 0; this.vy = 0; this.vz = 0
    this.drag = 0
    this.life = 1
    this.size0 = 1; this.size1 = 1; this.sizeCurve = 1
    this.rot = 0; this.rotVel = 0
    this.frame = 0; this.frameRate = 0
    this.r0 = 1; this.g0 = 1; this.b0 = 1; this.a0 = 1
    this.r1 = 1; this.g1 = 1; this.b1 = 1; this.a1 = 0
    this.gravity = 0
    this.turb = 0
    this.fadeIn = 0.08
    this.stretch = 0
    this.delay = 0
    return this
  }
  /** convenience: same colour at both ends, alpha fading to 0 */
  tint(r, g, b, a = 1) {
    this.r0 = r; this.g0 = g; this.b0 = b; this.a0 = a
    this.r1 = r; this.g1 = g; this.b1 = b; this.a1 = 0
    return this
  }
  tint2(r0, g0, b0, a0, r1, g1, b1, a1) {
    this.r0 = r0; this.g0 = g0; this.b0 = b0; this.a0 = a0
    this.r1 = r1; this.g1 = g1; this.b1 = b1; this.a1 = a1
    return this
  }
  pos(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this }
  vel(v) { this.vx = v.x; this.vy = v.y; this.vz = v.z; return this }
}

class Layer {
  constructor(sys, name, opt) {
    this.sys = sys
    this.name = name
    this.capacity = opt.capacity
    this.head = 0
    this.live = 0
    this.dirtyLo = Infinity
    this.dirtyHi = -Infinity
    this.spawned = 0
    this.death = new Float32Array(opt.capacity)

    const geo = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    geo.setIndex(quad.getIndex())
    quad.dispose()
    geo.instanceCount = 0
    // Never let three cull us: the bounding volume of a GPU-simulated system is
    // unknowable on the CPU and a wrong one pops the whole layer out of view.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6))

    this.attrs = {}
    this.arrays = {}
    for (const key of ['aOrigin', 'aVel', 'aLife', 'aRot', 'aCol0', 'aCol1', 'aMisc']) {
      const arr = new Float32Array(opt.capacity * STRIDE)
      const a = new THREE.InstancedBufferAttribute(arr, STRIDE)
      a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(key, a)
      this.attrs[key] = a
      this.arrays[key] = arr
    }

    const defines = {}
    if (opt.soft) defines.SOFT = ''
    if (opt.frameBlend) defines.FRAMEBLEND = ''
    if (opt.dissolve) defines.DISSOLVE = ''
    if (opt.additive) defines.ADDITIVE = ''

    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines,
      uniforms: {
        uMap: { value: opt.map },
        uDepth: { value: sys.depthTexture },
        uTime: { value: 0 },
        uTiles: { value: new THREE.Vector2(opt.tiles[0], opt.tiles[1]) },
        uSizeScale: { value: 1 },
        uResolution: { value: sys.resolution },
        uCamRange: { value: sys.camRange },
        uSoftDist: { value: opt.softDist ?? 1.6 },
        uDissolve: { value: opt.dissolveAmount ?? 0.95 },
        uFog: { value: sys.fogColor },
        uFogRange: { value: sys.fogRange },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opt.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = opt.renderOrder ?? 3000
    this.mesh.matrixAutoUpdate = false
    this.geo = geo
    this.mat = mat
  }

  /** Write one particle from the shared descriptor. Zero allocation. */
  write(p, now) {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    const o = i * STRIDE
    const A = this.arrays

    const spawn = now + p.delay
    const a = A.aOrigin
    a[o] = p.x; a[o + 1] = p.y; a[o + 2] = p.z; a[o + 3] = spawn
    const v = A.aVel
    v[o] = p.vx; v[o + 1] = p.vy; v[o + 2] = p.vz; v[o + 3] = p.drag
    const l = A.aLife
    l[o] = p.life; l[o + 1] = p.size0; l[o + 2] = p.size1; l[o + 3] = p.sizeCurve
    const r = A.aRot
    r[o] = p.rot; r[o + 1] = p.rotVel; r[o + 2] = p.frame; r[o + 3] = p.frameRate
    const c0 = A.aCol0
    c0[o] = p.r0; c0[o + 1] = p.g0; c0[o + 2] = p.b0; c0[o + 3] = p.a0
    const c1 = A.aCol1
    c1[o] = p.r1; c1[o + 1] = p.g1; c1[o + 2] = p.b1; c1[o + 3] = p.a1
    const m = A.aMisc
    m[o] = p.gravity; m[o + 1] = p.turb; m[o + 2] = p.fadeIn; m[o + 3] = p.stretch

    this.death[i] = spawn + p.life
    if (i < this.dirtyLo) this.dirtyLo = i
    if (i > this.dirtyHi) this.dirtyHi = i
    this.spawned++
    this.live++
    if (this.live > this.capacity) this.live = this.capacity
    this.geo.instanceCount = this.capacity
    return i
  }

  flush() {
    if (this.dirtyHi < this.dirtyLo) return
    const start = this.dirtyLo * STRIDE
    const count = (this.dirtyHi - this.dirtyLo + 1) * STRIDE
    for (const k in this.attrs) {
      const a = this.attrs[k]
      if (a.addUpdateRange) { a.clearUpdateRanges(); a.addUpdateRange(start, count) }
      a.needsUpdate = true
    }
    this.dirtyLo = Infinity
    this.dirtyHi = -Infinity
  }

  /** Exact live count. Runs on a slow cadence — a few thousand float compares. */
  census(now) {
    let n = 0
    const d = this.death
    for (let i = 0; i < d.length; i++) if (d[i] > now) n++
    this.live = n
    this.geo.instanceCount = n === 0 ? 0 : this.capacity
    return n
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}

export function createParticleSystem(ctx, textures) {
  const THREE_ = ctx.THREE || THREE
  const q = ctx.quality
  const lowSpec = q === 'low' || q === 'medium'
  const scale = lowSpec ? 0.45 : 1

  const group = new THREE_.Group()
  group.name = 'fx.particles'
  group.matrixAutoUpdate = false
  ctx.scene.add(group)

  const sys = {
    group,
    layers: {},
    p: new SpawnParams(),
    resolution: new THREE_.Vector2(1, 1),
    camRange: new THREE_.Vector2(0.5, 500),
    fogColor: new THREE_.Vector4(0.5, 0.55, 0.6, 0),
    fogRange: new THREE_.Vector2(1, 200),
    depthTexture: null,
    softEnabled: true,
    sizeScale: 1,
    time: 0,
    stats: {
      live: 0, capacity: 0, spawned: 0, spawnRate: 0,
      layers: {}, depthPass: false, depthPasses: 0, bakeMs: textures.bakeMs || 0,
    },
  }

  // --- depth prepass for soft particles -------------------------------------
  let depthRT = null
  let depthMat = null
  try {
    const s = ctx.renderer.getDrawingBufferSize(new THREE_.Vector2())
    const dw = Math.max(2, Math.floor(s.x * 0.5))
    const dh = Math.max(2, Math.floor(s.y * 0.5))
    depthRT = new THREE_.WebGLRenderTarget(dw, dh, {
      minFilter: THREE_.NearestFilter,
      magFilter: THREE_.NearestFilter,
      depthBuffer: true,
      generateMipmaps: false,
    })
    depthRT.depthTexture = new THREE_.DepthTexture(dw, dh)
    depthRT.depthTexture.type = THREE_.UnsignedIntType
    depthRT.depthTexture.minFilter = THREE_.NearestFilter
    depthRT.depthTexture.magFilter = THREE_.NearestFilter
    sys.depthTexture = depthRT.depthTexture
    depthMat = new THREE_.MeshDepthMaterial()
    depthMat.side = THREE_.DoubleSide
    sys.stats.depthPass = true
  } catch (err) {
    console.warn('[fx] depth prepass unavailable, soft particles disabled', err)
    sys.softEnabled = false
    sys.depthTexture = null
  }

  // A 1x1 fallback so the sampler is always bound even without the prepass.
  const dummyDepth = new THREE_.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  dummyDepth.needsUpdate = true
  if (!sys.depthTexture) sys.depthTexture = dummyDepth

  // --- layers ---------------------------------------------------------------
  const cap = (n) => Math.max(64, Math.round(n * scale))

  const defs = {
    // dense, soft, eroding — smoke grenades, explosion columns, barrel smoke
    smoke: {
      map: textures.smoke.tex, tiles: textures.smoke.tiles, capacity: cap(2600),
      soft: true, frameBlend: true, dissolve: true, dissolveAmount: 0.95,
      softDist: 2.2, renderOrder: 3010,
    },
    // ground dust, impact puffs, dirt clods
    dust: {
      map: textures.dust.tex, tiles: textures.dust.tiles, capacity: cap(2200),
      soft: true, frameBlend: true, dissolve: true, dissolveAmount: 0.9,
      softDist: 1.1, renderOrder: 3020,
    },
    // fireballs
    fire: {
      map: textures.fire.tex, tiles: textures.fire.tiles, capacity: cap(900),
      soft: true, frameBlend: true, additive: true, softDist: 1.4, renderOrder: 3040,
    },
    // sparks, embers, tracer heads and trails
    spark: {
      map: textures.spark.tex, tiles: textures.spark.tiles, capacity: cap(3200),
      additive: true, renderOrder: 3050,
    },
    // muzzle flash crowns, explosion cores
    flash: {
      map: textures.flash.tex, tiles: textures.flash.tiles, capacity: cap(260),
      additive: true, renderOrder: 3060,
    },
    // soft light bloom, tracer glow halo
    glow: {
      map: textures.glow.tex, tiles: textures.glow.tiles, capacity: cap(700),
      additive: true, renderOrder: 3045,
    },
    // concrete chips, wood splinters, metal shards
    chip: {
      map: textures.chips.tex, tiles: textures.chips.tiles, capacity: cap(900),
      renderOrder: 3030,
    },
    // blood droplets + mist
    blood: {
      map: textures.blood.tex, tiles: textures.blood.tiles, capacity: cap(700),
      soft: true, softDist: 0.6, renderOrder: 3035,
    },
  }

  for (const name in defs) {
    const layer = new Layer(sys, name, defs[name])
    sys.layers[name] = layer
    group.add(layer.mesh)
    sys.stats.capacity += layer.capacity
    sys.stats.layers[name] = 0
  }

  // --- api ------------------------------------------------------------------

  /** Emit one particle into `layerName` from the shared descriptor `sys.p`. */
  function emit(layerName) {
    const l = sys.layers[layerName]
    if (!l) return -1
    return l.write(sys.p, sys.time)
  }

  /** Reset the shared descriptor and return it for chaining. */
  function begin() { return sys.p.reset() }

  let censusTimer = 0
  let spawnWindow = 0
  let spawnCount = 0
  let lastSpawned = 0

  function update(dt, time) {
    sys.time = time

    // camera / screen uniforms
    const cam = ctx.camera
    sys.camRange.set(cam.near, cam.far)
    ctx.renderer.getDrawingBufferSize(sys.resolution)

    const fog = ctx.scene.fog
    if (fog) {
      sys.fogColor.set(fog.color.r, fog.color.g, fog.color.b, fog.isFogExp2 ? 2 : 1)
      if (fog.isFogExp2) sys.fogRange.set(fog.density, 0)
      else sys.fogRange.set(fog.near, fog.far)
    } else {
      sys.fogColor.w = 0
    }

    let live = 0
    let softDemand = 0
    censusTimer += dt
    const doCensus = censusTimer >= 0.12
    if (doCensus) censusTimer = 0

    for (const name in sys.layers) {
      const l = sys.layers[name]
      l.mat.uniforms.uTime.value = time
      l.mat.uniforms.uSizeScale.value = sys.sizeScale
      if (doCensus) l.census(time)
      l.flush()
      live += l.live
      sys.stats.layers[name] = l.live
      if (l.live > 0 && l.mat.defines.SOFT !== undefined) softDemand += l.live
    }
    sys.stats.live = live

    spawnWindow += dt
    if (spawnWindow >= 0.5) {
      let total = 0
      for (const n in sys.layers) total += sys.layers[n].spawned
      sys.stats.spawnRate = Math.round((total - lastSpawned) / spawnWindow)
      lastSpawned = total
      sys.stats.spawned = total
      spawnWindow = 0
    }

    // The depth prepass is the only expensive thing this module does (it
    // re-renders the scene). In a turn-based game the camera is stationary most
    // of the time and a stale depth buffer is still a CORRECT depth buffer, so
    // refresh only when the view actually changed — or at 4 Hz to catch moving
    // geometry. Idle cost: zero.
    if (sys.softEnabled && softDemand > 0) {
      depthAge += dt
      const e = cam.matrixWorldInverse.elements
      let moved = false
      for (let i = 0; i < 16; i++) {
        if (Math.abs(e[i] - lastCam[i]) > 1e-6) { moved = true; break }
      }
      if (moved || depthAge > 0.25) {
        for (let i = 0; i < 16; i++) lastCam[i] = e[i]
        depthAge = 0
        renderDepth()
        sys.stats.depthPasses++
      }
    }
  }

  const lastCam = new Float32Array(16)
  let depthAge = 99
  const _oldTarget = { rt: null }
  function renderDepth() {
    if (!depthRT) return
    const r = ctx.renderer
    const s = r.getDrawingBufferSize(sys.resolution)
    const dw = Math.max(2, Math.floor(s.x * 0.5))
    const dh = Math.max(2, Math.floor(s.y * 0.5))
    if (depthRT.width !== dw || depthRT.height !== dh) depthRT.setSize(dw, dh)

    try {
      group.visible = false
      const prevOverride = ctx.scene.overrideMaterial
      const prevBg = ctx.scene.background
      _oldTarget.rt = r.getRenderTarget()
      ctx.scene.overrideMaterial = depthMat
      ctx.scene.background = null
      r.setRenderTarget(depthRT)
      r.clear(true, true, false)
      r.render(ctx.scene, ctx.camera)
      r.setRenderTarget(_oldTarget.rt)
      ctx.scene.overrideMaterial = prevOverride
      ctx.scene.background = prevBg
    } catch (err) {
      console.warn('[fx] depth prepass failed, disabling soft particles', err)
      sys.softEnabled = false
      sys.stats.depthPass = false
    } finally {
      group.visible = true
    }
  }

  function dispose() {
    for (const n in sys.layers) sys.layers[n].dispose()
    group.removeFromParent()
    depthRT?.dispose()
    depthMat?.dispose()
    dummyDepth.dispose()
  }

  return {
    sys,
    group,
    layers: sys.layers,
    p: sys.p,
    begin,
    emit,
    update,
    dispose,
    get stats() { return sys.stats },
    setSizeScale(v) { sys.sizeScale = v },
  }
}
