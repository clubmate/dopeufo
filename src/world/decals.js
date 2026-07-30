/**
 * world/decals.js — projected surface detail.
 *
 * One procedurally-drawn 1024² atlas holds every decal (road paint, oil, cracks,
 * scorch, blood, graffiti, manholes, tyre marks). Static decals are conforming
 * quads baked into a single mesh; runtime decals live in a fixed-size ring
 * buffer inside a second mesh. Two draw calls for the whole lot.
 *
 * Runtime entry point (used by fx/):  api.addDecal(type, position, rotation, scale)
 */
import * as THREE from 'three'
import { makeRng, wfbm, clamp01 } from './kit.js'

const ATLAS_CELLS = 4
const CELL = {
  paint: [0, 0],
  arrow: [1, 0],
  manhole: [2, 0],
  tyre: [3, 0],
  oil: [0, 1],
  crack: [1, 1],
  scorch: [2, 1],
  grime: [3, 1],
  puddle: [0, 2],
  blood: [1, 2],
  bay: [2, 2],
  soot: [3, 2],
  graffiti0: [0, 3],
  graffiti1: [1, 3],
  graffiti2: [2, 3],
  graffiti3: [3, 3],
}
const TYPE_TO_CELL = {
  dash: 'paint',
  zebra: 'paint',
  line: 'paint',
  arrow: 'arrow',
  manhole: 'manhole',
  tyre: 'tyre',
  oil: 'oil',
  crack: 'crack',
  scorch: 'scorch',
  grime: 'grime',
  puddle: 'puddle',
  blood: 'blood',
  bay: 'bay',
  soot: 'soot',
  impact: 'scorch',
  burn: 'scorch',
}
const TYPE_TINT = {
  dash: 0xe8e4d8,
  zebra: 0xe8e4d8,
  line: 0xd8d4c6,
  arrow: 0xe8e4d8,
  bay: 0xd6d2c4,
  oil: 0x1a1714,
  crack: 0x1d1c1a,
  scorch: 0x171514,
  soot: 0x131211,
  grime: 0x2a2825,
  puddle: 0x2b3236,
  manhole: 0x4c4a46,
  tyre: 0x1c1b19,
  blood: 0x53100e,
  impact: 0x171514,
  burn: 0x171514,
}

const MAX_DYNAMIC = 96
const GRID = 2 // quad subdivisions -> conforms to ground undulation
const VERTS_PER = GRID * GRID * 6

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

function makeAtlas(size = 1024) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  g.clearRect(0, 0, size, size)
  const cs = size / ATLAS_CELLS
  const rng = makeRng(9182)

  const cell = (name, draw) => {
    const [cx, cy] = CELL[name]
    g.save()
    g.translate(cx * cs, cy * cs)
    g.beginPath()
    g.rect(0, 0, cs, cs)
    g.clip()
    draw(g, cs, rng)
    g.restore()
  }

  // --- worn white paint bar (dashes, stop bars, bay lines) ----------------
  cell('paint', (x, s, r) => {
    x.fillStyle = '#ffffff'
    x.fillRect(s * 0.06, s * 0.06, s * 0.88, s * 0.88)
    x.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 900; i++) {
      const rr = 1 + r.next() * 9
      x.globalAlpha = 0.16 + r.next() * 0.5
      x.beginPath()
      x.arc(r.next() * s, r.next() * s, rr, 0, 7)
      x.fill()
    }
    // scuffed ends
    x.globalAlpha = 1
    for (let i = 0; i < 120; i++) {
      const e = r.chance(0.5) ? 0 : s * 0.86
      x.beginPath()
      x.arc(e + r.next() * s * 0.16, r.next() * s, 3 + r.next() * 12, 0, 7)
      x.fill()
    }
    x.globalCompositeOperation = 'source-over'
  })

  cell('arrow', (x, s, r) => {
    x.fillStyle = '#ffffff'
    x.beginPath()
    x.moveTo(s * 0.5, s * 0.08)
    x.lineTo(s * 0.86, s * 0.46)
    x.lineTo(s * 0.63, s * 0.46)
    x.lineTo(s * 0.63, s * 0.93)
    x.lineTo(s * 0.37, s * 0.93)
    x.lineTo(s * 0.37, s * 0.46)
    x.lineTo(s * 0.14, s * 0.46)
    x.closePath()
    x.fill()
    x.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 500; i++) {
      x.globalAlpha = 0.2 + r.next() * 0.6
      x.beginPath()
      x.arc(r.next() * s, r.next() * s, 1 + r.next() * 8, 0, 7)
      x.fill()
    }
    x.globalCompositeOperation = 'source-over'
  })

  cell('manhole', (x, s, r) => {
    const cx = s / 2
    x.fillStyle = '#ffffff'
    x.beginPath()
    x.arc(cx, cx, s * 0.42, 0, 7)
    x.fill()
    x.strokeStyle = 'rgba(0,0,0,0.55)'
    x.lineWidth = s * 0.02
    x.beginPath()
    x.arc(cx, cx, s * 0.42, 0, 7)
    x.stroke()
    x.beginPath()
    x.arc(cx, cx, s * 0.33, 0, 7)
    x.stroke()
    x.lineWidth = s * 0.012
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      x.beginPath()
      x.moveTo(cx + Math.cos(a) * s * 0.1, cx + Math.sin(a) * s * 0.1)
      x.lineTo(cx + Math.cos(a) * s * 0.3, cx + Math.sin(a) * s * 0.3)
      x.stroke()
    }
    for (let i = 0; i < 3; i++) {
      x.beginPath()
      x.arc(cx, cx, s * (0.13 + i * 0.07), 0, 7)
      x.stroke()
    }
  })

  cell('tyre', (x, s, r) => {
    x.fillStyle = '#ffffff'
    for (const off of [0.24, 0.6]) {
      x.globalAlpha = 0.85
      x.beginPath()
      x.moveTo(s * off, 0)
      x.bezierCurveTo(s * (off + 0.1), s * 0.35, s * (off - 0.05), s * 0.7, s * (off + 0.06), s)
      x.lineTo(s * (off + 0.2), s)
      x.bezierCurveTo(s * (off + 0.09), s * 0.7, s * (off + 0.24), s * 0.35, s * (off + 0.14), 0)
      x.closePath()
      x.fill()
    }
    x.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 700; i++) {
      x.globalAlpha = 0.2 + r.next() * 0.6
      x.beginPath()
      x.arc(r.next() * s, r.next() * s, 1 + r.next() * 7, 0, 7)
      x.fill()
    }
    x.globalCompositeOperation = 'source-over'
    x.globalAlpha = 1
  })

  const blob = (x, s, r, n, spread, alpha) => {
    for (let i = 0; i < n; i++) {
      const a = r.next() * Math.PI * 2
      const d = Math.pow(r.next(), 0.55) * s * spread
      const rr = s * (0.03 + r.next() * 0.13) * (1 - d / (s * spread) + 0.25)
      const grd = x.createRadialGradient(
        s / 2 + Math.cos(a) * d,
        s / 2 + Math.sin(a) * d,
        0,
        s / 2 + Math.cos(a) * d,
        s / 2 + Math.sin(a) * d,
        rr
      )
      grd.addColorStop(0, `rgba(255,255,255,${alpha})`)
      grd.addColorStop(1, 'rgba(255,255,255,0)')
      x.fillStyle = grd
      x.beginPath()
      x.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, rr, 0, 7)
      x.fill()
    }
  }

  cell('oil', (x, s, r) => {
    blob(x, s, r, 90, 0.36, 0.5)
    for (let i = 0; i < 22; i++) {
      const a = r.next() * 7
      const d = s * (0.25 + r.next() * 0.22)
      x.fillStyle = `rgba(255,255,255,${0.25 + r.next() * 0.4})`
      x.beginPath()
      x.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.008 + r.next() * 0.02), 0, 7)
      x.fill()
    }
  })

  cell('grime', (x, s, r) => blob(x, s, r, 70, 0.42, 0.28))
  cell('soot', (x, s, r) => blob(x, s, r, 100, 0.45, 0.3))

  cell('scorch', (x, s, r) => {
    blob(x, s, r, 120, 0.38, 0.42)
    const grd = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.44)
    grd.addColorStop(0, 'rgba(255,255,255,0.85)')
    grd.addColorStop(0.45, 'rgba(255,255,255,0.5)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = grd
    x.beginPath()
    x.arc(s / 2, s / 2, s * 0.44, 0, 7)
    x.fill()
    // radial spatter streaks
    x.strokeStyle = 'rgba(255,255,255,0.5)'
    for (let i = 0; i < 28; i++) {
      const a = r.next() * 7
      x.lineWidth = 1 + r.next() * 4
      x.beginPath()
      x.moveTo(s / 2 + Math.cos(a) * s * 0.16, s / 2 + Math.sin(a) * s * 0.16)
      x.lineTo(s / 2 + Math.cos(a) * s * (0.3 + r.next() * 0.2), s / 2 + Math.sin(a) * s * (0.3 + r.next() * 0.2))
      x.stroke()
    }
  })

  cell('blood', (x, s, r) => {
    blob(x, s, r, 55, 0.26, 0.75)
    for (let i = 0; i < 40; i++) {
      const a = r.next() * 7
      const d = s * (0.2 + Math.pow(r.next(), 0.6) * 0.28)
      const rr = s * (0.006 + r.next() * 0.028)
      x.fillStyle = `rgba(255,255,255,${0.5 + r.next() * 0.5})`
      x.beginPath()
      x.ellipse(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, rr, rr * (0.6 + r.next()), a, 0, 7)
      x.fill()
    }
  })

  cell('puddle', (x, s, r) => {
    blob(x, s, r, 60, 0.34, 0.55)
    x.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 250; i++) {
      x.globalAlpha = 0.1 + r.next() * 0.3
      x.beginPath()
      x.arc(r.next() * s, r.next() * s, 2 + r.next() * 14, 0, 7)
      x.fill()
    }
    x.globalCompositeOperation = 'source-over'
    x.globalAlpha = 1
  })

  cell('crack', (x, s, r) => {
    x.strokeStyle = '#ffffff'
    x.lineCap = 'round'
    const branch = (px, py, ang, len, w, depth) => {
      if (depth > 4 || len < 4) return
      const nx = px + Math.cos(ang) * len
      const ny = py + Math.sin(ang) * len
      x.lineWidth = w
      x.globalAlpha = clamp01(0.35 + w * 0.2)
      x.beginPath()
      x.moveTo(px, py)
      x.lineTo(nx, ny)
      x.stroke()
      const n = r.chance(0.4) ? 2 : 1
      for (let i = 0; i < n; i++) {
        branch(nx, ny, ang + (r.next() - 0.5) * 1.3, len * (0.5 + r.next() * 0.4), w * 0.68, depth + 1)
      }
    }
    for (let i = 0; i < 4; i++) {
      branch(s * (0.15 + r.next() * 0.7), s * (0.15 + r.next() * 0.7), r.next() * 7, s * 0.2, 5, 0)
    }
    x.globalAlpha = 1
  })

  cell('bay', (x, s, r) => {
    x.fillStyle = '#ffffff'
    x.font = `bold ${s * 0.62}px sans-serif`
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    x.fillText('P2', s / 2, s / 2)
    x.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 500; i++) {
      x.globalAlpha = 0.2 + r.next() * 0.6
      x.beginPath()
      x.arc(r.next() * s, r.next() * s, 1 + r.next() * 9, 0, 7)
      x.fill()
    }
    x.globalCompositeOperation = 'source-over'
    x.globalAlpha = 1
  })

  // --- graffiti tags ------------------------------------------------------
  const tagPalettes = [
    ['#e8d43a', '#1b1b1b', '#d94b2b'],
    ['#3ab0e8', '#f2f2f2', '#12304a'],
    ['#e83a7a', '#1b1b1b', '#f0c33a'],
    ['#5fd44a', '#111', '#f4f0e2'],
  ]
  for (let t = 0; t < 4; t++) {
    cell('graffiti' + t, (x, s, r) => {
      const pal = tagPalettes[t]
      x.lineCap = 'round'
      x.lineJoin = 'round'
      for (let pass = 0; pass < 3; pass++) {
        x.strokeStyle = pal[pass % pal.length]
        x.lineWidth = s * (0.075 - pass * 0.018)
        x.globalAlpha = pass === 0 ? 0.95 : 0.9
        for (let k = 0; k < 4; k++) {
          x.beginPath()
          let px = s * (0.1 + r.next() * 0.15)
          let py = s * (0.3 + r.next() * 0.4)
          x.moveTo(px, py)
          for (let i = 0; i < 4; i++) {
            const cx1 = px + s * (0.08 + r.next() * 0.16)
            const cy1 = py + (r.next() - 0.5) * s * 0.5
            px = cx1 + s * (0.04 + r.next() * 0.12)
            py = s * (0.25 + r.next() * 0.5)
            x.quadraticCurveTo(cx1, cy1, px, py)
          }
          x.stroke()
        }
      }
      // drips
      x.globalAlpha = 0.7
      x.strokeStyle = pal[0]
      for (let i = 0; i < 7; i++) {
        x.lineWidth = s * 0.012
        const px = s * (0.15 + r.next() * 0.7)
        x.beginPath()
        x.moveTo(px, s * (0.5 + r.next() * 0.2))
        x.lineTo(px, s * (0.6 + r.next() * 0.35))
        x.stroke()
      }
      x.globalAlpha = 1
    })
  }

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------

function cellUV(name) {
  const [cx, cy] = CELL[name] || CELL.grime
  const s = 1 / ATLAS_CELLS
  // flip Y because canvas origin is top-left
  return { u0: cx * s, v0: 1 - (cy + 1) * s, du: s, dv: s }
}

export function buildDecals(level, kit, quality = 'high') {
  const spec = level.spec
  const group = new THREE.Group()
  group.name = 'world:decals'
  const rng = makeRng(spec.seed ^ 0x0dec)

  const atlas = makeAtlas(quality === 'low' ? 512 : 1024)
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    transparent: true,
    alphaTest: 0.015,
    depthWrite: false,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
    side: THREE.DoubleSide,
  })
  mat.name = 'world:decals'

  const groundY = (X, Z) => spec.groundHeight(X, Z)

  // -------------------------------------------------------------------------
  // Static decals — conforming quads
  // -------------------------------------------------------------------------
  const P = []
  const N = []
  const U = []
  const C = []

  const _col = new THREE.Color()

  function emitGround(type, X, Z, ry, sizeX, sizeZ, opacity, tintHex) {
    const cellName = TYPE_TO_CELL[type] || 'grime'
    const { u0, v0, du, dv } = cellUV(cellName)
    _col.set(tintHex ?? TYPE_TINT[type] ?? 0xffffff)
    const cos = Math.cos(ry)
    const sin = Math.sin(ry)
    const hx = sizeX / 2
    const hz = sizeZ / 2
    const g = GRID
    const corner = (i, j) => {
      const lx = (i / g - 0.5) * sizeX
      const lz = (j / g - 0.5) * sizeZ
      const X2 = X + lx * cos - lz * sin
      const Z2 = Z + lx * sin + lz * cos
      return [X2, groundY(X2, Z2) + 0.028, Z2, u0 + (i / g) * du, v0 + (1 - j / g) * dv]
    }
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        const a = corner(i, j)
        const b = corner(i + 1, j)
        const c2 = corner(i + 1, j + 1)
        const d = corner(i, j + 1)
        for (const v of [a, b, c2, a, c2, d]) {
          P.push(v[0], v[1], v[2])
          N.push(0, 1, 0)
          U.push(v[3], v[4])
          C.push(_col.r, _col.g, _col.b, opacity)
        }
      }
    }
  }

  function emitWall(cellName, x, y, z, ry, w, h, opacity, tintHex, outX, outZ) {
    const { u0, v0, du, dv } = cellUV(cellName)
    _col.set(tintHex ?? 0xffffff)
    const cos = Math.cos(ry)
    const sin = Math.sin(ry)
    const pts = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ]
    const world = pts.map(([lx, ly]) => [x + lx * cos, y + ly, z - lx * sin])
    const uvs = [
      [u0, v0],
      [u0 + du, v0],
      [u0 + du, v0 + dv],
      [u0, v0 + dv],
    ]
    const tri = [0, 1, 2, 0, 2, 3]
    for (const i of tri) {
      P.push(world[i][0], world[i][1], world[i][2])
      N.push(outX, 0, outZ)
      U.push(uvs[i][0], uvs[i][1])
      C.push(_col.r, _col.g, _col.b, opacity)
    }
  }

  for (const d of spec.decals) {
    if (d.y > 0.1) {
      // on an elevated slab — flat quad at that height
      const cellName = TYPE_TO_CELL[d.type] || 'grime'
      const { u0, v0, du, dv } = cellUV(cellName)
      _col.set(TYPE_TINT[d.type] ?? 0xffffff)
      const sx = d.size
      const sz = d.size * (d.aspect ?? 1)
      const cos = Math.cos(d.ry)
      const sin = Math.sin(d.ry)
      const pts = [
        [-sx / 2, -sz / 2, u0, v0 + dv],
        [sx / 2, -sz / 2, u0 + du, v0 + dv],
        [sx / 2, sz / 2, u0 + du, v0],
        [-sx / 2, sz / 2, u0, v0],
      ]
      const tri = [0, 1, 2, 0, 2, 3]
      for (const i of tri) {
        const [lx, lz, uu, vv] = pts[i]
        P.push(d.x + lx * cos - lz * sin, d.y + 0.035, d.z + lx * sin + lz * cos)
        N.push(0, 1, 0)
        U.push(uu, vv)
        C.push(_col.r, _col.g, _col.b, d.opacity ?? 1)
      }
      continue
    }
    emitGround(d.type, d.x, d.z, d.ry || 0, d.size, d.size * (d.aspect ?? 1), d.opacity ?? 1)
  }

  // --- graffiti + soot on vertical surfaces --------------------------------
  const wallProps = spec.props.filter(
    (p) => (p.type === 'ruinWall' && p.variant === 1) || p.type === 'container' || p.type === 'lowWall' || p.type === 'metroHead'
  )
  for (const gf of spec.graffiti) {
    const p = wallProps[Math.floor(rng.next() * wallProps.length)]
    if (!p) break
    const cellName = 'graffiti' + (gf.variant % 4)
    // outward normal: edge props face ±local Z; block props pick a long face
    let nx = 0
    let nz = 0
    let ry = p.ry || 0
    const flip = rng.chance(0.5) ? 1 : -1
    if (p.edge) {
      nx = Math.sin(ry) * flip
      nz = Math.cos(ry) * flip
    } else {
      const useX = (p.spanX || 2) >= (p.spanZ || 2)
      nx = useX ? 0 : flip
      nz = useX ? flip : 0
    }
    const off = p.edge ? 0.24 : (p.spanX && p.spanZ ? (nx !== 0 ? p.spanX / 2 : p.spanZ / 2) : 1.2) - 0.06
    const h = p.type === 'lowWall' ? 0.6 : 1.5
    const w = p.type === 'lowWall' ? 1.5 : 2.1
    const y = (p.y || 0) + (p.type === 'lowWall' ? 0.45 : 1.25)
    const wallRy = Math.atan2(nx, nz)
    emitWall(cellName, p.x + nx * off, y, p.z + nz * off, wallRy, w, h, 0.92, 0xffffff, nx, nz)
  }
  // soot streaks above ruin window openings
  for (const p of spec.props) {
    if (p.type !== 'ruinWall' || p.variant !== 1) continue
    if (!rng.chance(0.45)) continue
    const flip = rng.chance(0.5) ? 1 : -1
    const nx = Math.sin(p.ry) * flip
    const nz = Math.cos(p.ry) * flip
    emitWall('soot', p.x + nx * 0.22, (p.y || 0) + 2.5, p.z + nz * 0.22, Math.atan2(nx, nz), 1.6, 2.0, 0.55, 0x141312, nx, nz)
  }

  const staticGeo = new THREE.BufferGeometry()
  staticGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
  staticGeo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3))
  staticGeo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2))
  staticGeo.setAttribute('color', new THREE.Float32BufferAttribute(C, 4))
  const staticMesh = new THREE.Mesh(staticGeo, mat)
  staticMesh.name = 'world:decals:static'
  staticMesh.castShadow = false
  staticMesh.receiveShadow = true
  staticMesh.renderOrder = 2
  staticMesh.matrixAutoUpdate = false
  group.add(staticMesh)

  // -------------------------------------------------------------------------
  // Runtime pool
  // -------------------------------------------------------------------------
  const dynCount = MAX_DYNAMIC * VERTS_PER
  const dp = new Float32Array(dynCount * 3)
  const dn = new Float32Array(dynCount * 3)
  const duv = new Float32Array(dynCount * 2)
  const dc = new Float32Array(dynCount * 4)
  const dynGeo = new THREE.BufferGeometry()
  dynGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3))
  dynGeo.setAttribute('normal', new THREE.BufferAttribute(dn, 3))
  dynGeo.setAttribute('uv', new THREE.BufferAttribute(duv, 2))
  dynGeo.setAttribute('color', new THREE.BufferAttribute(dc, 4))
  dynGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200)
  const dynMesh = new THREE.Mesh(dynGeo, mat)
  dynMesh.name = 'world:decals:runtime'
  dynMesh.castShadow = false
  dynMesh.receiveShadow = true
  dynMesh.renderOrder = 3
  dynMesh.frustumCulled = false
  dynMesh.matrixAutoUpdate = false
  group.add(dynMesh)

  let slot = 0
  const _v = new THREE.Vector3()

  function addDecal(type, position, rotation = 0, scale = 1, opts = {}) {
    const cellName = TYPE_TO_CELL[type] || CELL[type] ? TYPE_TO_CELL[type] || type : 'scorch'
    const { u0, v0, du, dv } = cellUV(cellName)
    const tint = new THREE.Color(opts.tint ?? TYPE_TINT[type] ?? 0x151312)
    const alpha = opts.opacity ?? 0.9
    const ry = typeof rotation === 'number' ? rotation : rotation?.y || 0
    const px = position?.x ?? 0
    const pz = position?.z ?? 0
    const baseY = position?.y ?? 0
    const s = scale
    const base = (slot % MAX_DYNAMIC) * VERTS_PER
    slot++

    const cos = Math.cos(ry)
    const sin = Math.sin(ry)
    const g = GRID
    let w = 0
    const corner = (i, j) => {
      const lx = (i / g - 0.5) * s
      const lz = (j / g - 0.5) * s
      const X2 = px + lx * cos - lz * sin
      const Z2 = pz + lx * sin + lz * cos
      const y = baseY > 0.15 ? baseY + 0.035 : groundY(X2, Z2) + 0.032
      return [X2, y, Z2, u0 + (i / g) * du, v0 + (1 - j / g) * dv]
    }
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        const a = corner(i, j)
        const b = corner(i + 1, j)
        const c2 = corner(i + 1, j + 1)
        const d = corner(i, j + 1)
        for (const v of [a, b, c2, a, c2, d]) {
          const o = base + w
          dp[o * 3] = v[0]
          dp[o * 3 + 1] = v[1]
          dp[o * 3 + 2] = v[2]
          dn[o * 3] = 0
          dn[o * 3 + 1] = 1
          dn[o * 3 + 2] = 0
          duv[o * 2] = v[3]
          duv[o * 2 + 1] = v[4]
          dc[o * 4] = tint.r
          dc[o * 4 + 1] = tint.g
          dc[o * 4 + 2] = tint.b
          dc[o * 4 + 3] = alpha
          w++
        }
      }
    }
    dynGeo.attributes.position.needsUpdate = true
    dynGeo.attributes.uv.needsUpdate = true
    dynGeo.attributes.color.needsUpdate = true
    dynGeo.attributes.normal.needsUpdate = true
    return slot - 1
  }

  function clearRuntime() {
    dp.fill(0)
    dc.fill(0)
    dynGeo.attributes.position.needsUpdate = true
    dynGeo.attributes.color.needsUpdate = true
    slot = 0
  }

  return {
    group,
    addDecal,
    clearRuntime,
    material: mat,
    dispose() {
      staticGeo.dispose()
      dynGeo.dispose()
      mat.dispose()
      atlas.dispose()
    },
  }
}
