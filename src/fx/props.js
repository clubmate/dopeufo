/**
 * Non-particle FX props: pooled dynamic lights, pooled rigid bodies (debris
 * chunks, shell casings) with real bounce physics, and a decal pool used only
 * when the world module does not provide `addDecal`.
 *
 * Everything here is pooled and permanently parented at init — in particular the
 * point lights are added once with intensity 0 so no shader recompile ever
 * happens mid-combat.
 */
import * as THREE from 'three'

const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _s = new THREE.Vector3()
const Z_AXIS = new THREE.Vector3(0, 0, 1)

// ---------------------------------------------------------------------------
// dynamic light pool
// ---------------------------------------------------------------------------

export function createLightPool(ctx, count = 4) {
  const lights = []
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 30, 2)
    l.castShadow = false
    l.visible = true
    ctx.scene.add(l)
    lights.push({ light: l, t: 0, dur: 0, peak: 0, curve: 1, busy: false, prio: 0 })
  }

  function flash(pos, color, intensity, distance, duration, curve = 2.2, prio = 1) {
    let slot = lights.find((s) => !s.busy)
    if (!slot) {
      // steal the weakest one rather than dropping the effect
      slot = lights.reduce((a, b) => (a.peak * (1 - a.t / a.dur) < b.peak * (1 - b.t / b.dur) ? a : b))
      if (slot.prio > prio) return null
    }
    slot.busy = true
    slot.t = 0
    slot.dur = duration
    slot.peak = intensity
    slot.curve = curve
    slot.prio = prio
    slot.light.color.setRGB(color[0], color[1], color[2])
    slot.light.distance = distance
    slot.light.decay = 2
    slot.light.position.set(pos.x, pos.y, pos.z)
    slot.light.intensity = intensity
    return slot
  }

  function update(dt) {
    for (const s of lights) {
      if (!s.busy) continue
      s.t += dt
      const k = s.t / s.dur
      if (k >= 1) {
        s.busy = false
        s.prio = 0
        s.light.intensity = 0
        continue
      }
      // hot spike then exponential-ish falloff; a linear ramp reads as a fade,
      // not as a detonation
      const rise = Math.min(1, s.t / (s.dur * 0.08))
      s.light.intensity = s.peak * rise * Math.pow(1 - k, s.curve)
    }
  }

  return {
    flash,
    update,
    get active() { return lights.filter((l) => l.busy).length },
    dispose() { for (const s of lights) s.light.removeFromParent() },
  }
}

// ---------------------------------------------------------------------------
// rigid body pool — CPU physics, GPU instanced draw
// ---------------------------------------------------------------------------

function rockGeometry(seed = 1) {
  const g = new THREE.IcosahedronGeometry(0.5, 0)
  const pos = g.getAttribute('position')
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  for (let i = 0; i < pos.count; i++) {
    const k = 0.55 + rnd() * 0.9
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * (0.6 + rnd() * 0.7), pos.getZ(i) * k)
  }
  g.computeVertexNormals()
  return g
}

export function createRigidPool(ctx, opts) {
  const {
    count = 64,
    geometry,
    material,
    restitution = 0.34,
    friction = 0.62,
    ttl = 7,
    name = 'debris',
  } = opts

  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.name = `fx.${name}`
  mesh.count = count
  const colors = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
  mesh.instanceColor = colors
  colors.setUsage(THREE.DynamicDrawUsage)
  ctx.scene.add(mesh)

  const bodies = []
  for (let i = 0; i < count; i++) {
    bodies.push({
      i, alive: false,
      p: new THREE.Vector3(), v: new THREE.Vector3(),
      q: new THREE.Quaternion(), w: new THREE.Vector3(),
      scale: 1, target: 1, ground: 0, age: 0, ttl, settled: false, bounces: 0,
    })
    _m.makeScale(0, 0, 0)
    mesh.setMatrixAt(i, _m)
  }
  mesh.instanceMatrix.needsUpdate = true

  let cursor = 0
  let active = 0

  function spawn(px, py, pz, vx, vy, vz, size, groundY, tint) {
    let b = null
    for (let n = 0; n < count; n++) {
      const c = bodies[(cursor + n) % count]
      if (!c.alive) { b = c; cursor = (cursor + n + 1) % count; break }
    }
    if (!b) { b = bodies[cursor]; cursor = (cursor + 1) % count }   // steal oldest
    else active++

    b.alive = true
    b.settled = false
    b.bounces = 0
    b.age = 0
    b.p.set(px, py, pz)
    b.v.set(vx, vy, vz)
    b.q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    b.w.set((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26)
    b.scale = size
    b.ground = groundY
    if (tint) colors.setXYZ(b.i, tint[0], tint[1], tint[2])
    else colors.setXYZ(b.i, 1, 1, 1)
    colors.needsUpdate = true
    return b
  }

  const GRAV = 24 // heavier-than-real gravity: game debris must settle fast
  function update(dt) {
    if (active === 0) return
    let dirty = false
    let n = 0
    for (let i = 0; i < count; i++) {
      const b = bodies[i]
      if (!b.alive) continue
      n++
      b.age += dt
      if (!b.settled) {
        b.v.y -= GRAV * dt
        b.p.addScaledVector(b.v, dt)
        const half = b.scale * 0.4
        if (b.p.y - half <= b.ground) {
          b.p.y = b.ground + half
          if (Math.abs(b.v.y) < 1.1 && b.bounces > 0) {
            b.settled = true
            b.v.set(0, 0, 0)
            b.w.multiplyScalar(0)
          } else {
            b.bounces++
            b.v.y = -b.v.y * restitution
            b.v.x *= friction
            b.v.z *= friction
            b.w.multiplyScalar(0.55)
          }
        }
        if (!b.settled) {
          const wl = b.w.length()
          if (wl > 1e-4) {
            _q.setFromAxisAngle(_v.copy(b.w).divideScalar(wl), wl * dt)
            b.q.premultiply(_q).normalize()
          }
        }
      }
      let sc = b.scale
      if (b.age > b.ttl) {
        const k = 1 - (b.age - b.ttl) / 0.6
        if (k <= 0) {
          b.alive = false
          active--
          _m.makeScale(0, 0, 0)
          mesh.setMatrixAt(b.i, _m)
          dirty = true
          continue
        }
        sc *= k
      }
      _s.set(sc, sc, sc)
      _m.compose(b.p, b.q, _s)
      mesh.setMatrixAt(b.i, _m)
      dirty = true
    }
    if (n === 0) active = 0
    if (dirty) mesh.instanceMatrix.needsUpdate = true
  }

  return {
    spawn,
    update,
    mesh,
    get active() { return active },
    dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose() },
  }
}

export function createDebrisPools(ctx, lowSpec) {
  const rock = rockGeometry(9)
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0, vertexColors: false, flatShading: true,
  })
  const chunks = createRigidPool(ctx, {
    count: lowSpec ? 28 : 64, geometry: rock, material: rockMat, name: 'chunks',
    restitution: 0.3, friction: 0.55, ttl: 8,
  })

  const shellGeo = new THREE.CylinderGeometry(0.016, 0.014, 0.055, 6, 1, false)
  shellGeo.rotateZ(Math.PI / 2)
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xffc46a, roughness: 0.32, metalness: 0.95, flatShading: true,
  })
  const shells = createRigidPool(ctx, {
    count: lowSpec ? 16 : 40, geometry: shellGeo, material: shellMat, name: 'shells',
    restitution: 0.42, friction: 0.7, ttl: 9,
  })

  return { chunks, shells, update(dt) { chunks.update(dt); shells.update(dt) },
    dispose() { chunks.dispose(); shells.dispose() } }
}

// ---------------------------------------------------------------------------
// decal pool (fallback when world/ exposes no addDecal)
// ---------------------------------------------------------------------------

const DECAL_TILE = { hole: [0, 0], scorch: [1, 0], blood: [0, 1], scuff: [1, 1] }

export function createDecalPool(ctx, atlasTex, perType = 40) {
  const types = {}
  const quad = new THREE.PlaneGeometry(1, 1)

  for (const key in DECAL_TILE) {
    const [c, r] = DECAL_TILE[key]
    const tex = atlasTex.clone()
    tex.needsUpdate = true
    tex.repeat.set(0.5, 0.5)
    // frame 0 is bottom-left in the atlas, matching the particle convention
    tex.offset.set(c * 0.5, r * 0.5)
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      roughness: key === 'blood' ? 0.35 : 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      toneMapped: true,
    })

    const mesh = new THREE.InstancedMesh(quad, mat, perType)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.renderOrder = 1500
    mesh.name = `fx.decal.${key}`
    mesh.count = perType
    for (let i = 0; i < perType; i++) { _m.makeScale(0, 0, 0); mesh.setMatrixAt(i, _m) }
    mesh.instanceMatrix.needsUpdate = true
    ctx.scene.add(mesh)
    types[key] = { mesh, cursor: 0, anims: [] }
  }

  function add(type, position, normal, scale, roll = Math.random() * Math.PI * 2) {
    const t = types[type] || types.scuff
    const i = t.cursor
    t.cursor = (t.cursor + 1) % t.mesh.count
    _v.copy(normal || Z_AXIS).normalize()
    if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0)
    _q.setFromUnitVectors(Z_AXIS, _v)
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, roll))
    const p = new THREE.Vector3().copy(position).addScaledVector(_v, 0.022)
    t.anims.push({ i, p, q: _q.clone(), s: scale, t: 0, mesh: t.mesh })
    return i
  }

  function update(dt) {
    for (const key in types) {
      const t = types[key]
      if (!t.anims.length) continue
      let dirty = false
      for (let n = t.anims.length - 1; n >= 0; n--) {
        const a = t.anims[n]
        a.t += dt
        const k = Math.min(1, a.t / 0.16)
        // slight overshoot as it settles so a new decal reads as an event
        const sc = a.s * (0.55 + 0.50 * k - 0.05 * k * k)
        _s.set(sc, sc, 1)
        _m.compose(a.p, a.q, _s)
        a.mesh.setMatrixAt(a.i, _m)
        dirty = true
        if (k >= 1) t.anims.splice(n, 1)
      }
      if (dirty) t.mesh.instanceMatrix.needsUpdate = true
    }
  }

  return {
    add,
    update,
    dispose() {
      for (const k in types) { types[k].mesh.removeFromParent(); types[k].mesh.material.dispose() }
      quad.dispose()
    },
  }
}
