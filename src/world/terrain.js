/**
 * world/terrain.js — ground, kerbs, elevation slabs.
 *
 * The ground is a displaced 72 m mesh carrying a 4-way splat weight attribute
 * (asphalt / concrete / dirt / gravel) blended in a patched MeshStandardMaterial,
 * plus baked vertex colours for macro variation and fake contact occlusion under
 * every wall and prop. Nothing here is a flat plane and nothing tiles visibly.
 */
import * as THREE from 'three'
import { SURF } from './level.js'
import {
  bevelBox,
  worldUV,
  flatColor,
  paintGrime,
  mergeGeos,
  place,
  wfbm,
  clamp01,
  lerp,
  makeRng,
} from './kit.js'

const GROUND_SIZE = 74
const APRON_SIZE = 260

export function buildTerrain(level, kit, quality = 'high') {
  const spec = level.spec
  const { W, H, TILE } = level
  const group = new THREE.Group()
  group.name = 'world:terrain'
  const rng = makeRng(spec.seed ^ 0x51ab)

  const SEG = quality === 'low' ? 108 : quality === 'medium' ? 144 : 200

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, SEG, SEG)
  geo.rotateX(-Math.PI / 2)

  const halfW = (W * TILE) / 2
  const halfH = (H * TILE) / 2

  const surfaceAtWorld = (X, Z) => {
    const gx = Math.round(X / TILE + W / 2 - 0.5)
    const gz = Math.round(Z / TILE + H / 2 - 0.5)
    if (gx < 0 || gz < 0 || gx >= W || gz >= H) {
      // outside the play area the avenues continue; everything else degrades to
      // rubble and dirt so the border never reads as a bright halo
      const onRoad =
        (gx >= 10 && gx <= 13 && (gz < 0 || gz >= H)) || (gz >= 10 && gz <= 13 && (gx < 0 || gx >= W))
      if (onRoad) return SURF.ASPHALT
      const depth = Math.max(-gx, -gz, gx - (W - 1), gz - (H - 1))
      if (depth > 2.5) return SURF.DIRT
      return depth > 0.8 ? SURF.GRAVEL : SURF.CONCRETE
    }
    return level.surfaceAt(gx, gz)
  }

  // blocked-tile map for contact occlusion
  const blocked = new Uint8Array(W * H)
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++) {
      const t = level.getTile(x, z)
      blocked[x + z * W] = !t.walkable || t.elevation > 0 ? 1 : 0
    }

  const OCC_R = 2.4
  function occlusionAt(X, Z) {
    const gx = X / TILE + W / 2 - 0.5
    const gz = Z / TILE + H / 2 - 0.5
    const x0 = Math.floor(gx - 1.6)
    const x1 = Math.ceil(gx + 1.6)
    const z0 = Math.floor(gz - 1.6)
    const z1 = Math.ceil(gz + 1.6)
    let acc = 0
    let tot = 0
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot((x - gx) * TILE, (z - gz) * TILE)
        const w = Math.max(0, 1 - d / OCC_R)
        if (w <= 0) continue
        tot += w
        if (x >= 0 && z >= 0 && x < W && z < H && blocked[x + z * W]) acc += w
      }
    }
    return tot > 0 ? acc / tot : 0
  }

  decorate(geo)

  /**
   * Displaces a ground-plane geometry and fills splat + vertex colour. Shared by
   * the play-area mesh and the surrounding skirt so the two are literally the
   * same surface and the join is invisible.
   */
  function decorate(g) {
  const pos = g.attributes.position
  const n = pos.count
  const splat = new Float32Array(n * 4)
  const col = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const X = pos.getX(i)
    const Z = pos.getZ(i)

    // --- displacement ------------------------------------------------------
    let y = spec.groundHeight(X, Z)
    const outX = Math.max(0, Math.abs(X) - halfW - 1)
    const outZ = Math.max(0, Math.abs(Z) - halfH - 1)
    const out = Math.max(outX, outZ)
    if (out > 0) {
      y -= Math.min(out * 0.03, 0.55)
      y += (wfbm(X * 0.07, Z * 0.07, 3, 4441) - 0.5) * Math.min(out * 0.09, 1.4)
    }
    pos.setY(i, y)

    uv[i * 2] = X
    uv[i * 2 + 1] = Z

    // --- splat weights: jittered multi-sample so boundaries are organic ----
    const w = [0, 0, 0, 0]
    const j1 = (wfbm(X * 0.55, Z * 0.55, 3, 601) - 0.5) * 2.2
    const j2 = (wfbm(X * 0.55 + 31, Z * 0.55 - 17, 3, 602) - 0.5) * 2.2
    const j3 = (wfbm(X * 1.7 + 7, Z * 1.7 + 3, 2, 603) - 0.5) * 0.9
    const j4 = (wfbm(X * 1.7 - 9, Z * 1.7 + 11, 2, 604) - 0.5) * 0.9
    const samples = [
      [0, 0, 1.35],
      [j1, j2, 1.0],
      [j1 * 0.5 + j3, j2 * 0.5 + j4, 0.85],
      [-j2 * 0.7, j1 * 0.7, 0.6],
      [j3 * 1.6, j4 * 1.6, 0.5],
    ]
    for (const [dx, dz, wt] of samples) w[surfaceAtWorld(X + dx, Z + dz)] += wt

    // asphalt worn through to the substrate
    const wear = wfbm(X * 0.11 + 5, Z * 0.11 - 3, 4, 77)
    if (w[SURF.ASPHALT] > 0 && wear > 0.6) {
      const k = (wear - 0.6) * 2.6
      const take = w[SURF.ASPHALT] * Math.min(k, 0.85)
      w[SURF.ASPHALT] -= take
      w[SURF.GRAVEL] += take * 0.65
      w[SURF.DIRT] += take * 0.35
    }
    // dirt + grit collects against kerbs and walls
    const occ = occlusionAt(X, Z)
    if (occ > 0.12) {
      const k = Math.min((occ - 0.12) * 1.4, 0.55)
      const from = w[SURF.ASPHALT] + w[SURF.CONCRETE]
      w[SURF.ASPHALT] *= 1 - k
      w[SURF.CONCRETE] *= 1 - k
      w[SURF.DIRT] += from * k * 0.6
      w[SURF.GRAVEL] += from * k * 0.4
    }
    const sum = w[0] + w[1] + w[2] + w[3] || 1
    splat[i * 4] = w[0] / sum
    splat[i * 4 + 1] = w[1] / sum
    splat[i * 4 + 2] = w[2] / sum
    splat[i * 4 + 3] = w[3] / sum

    // --- vertex colour: macro variation + contact AO ----------------------
    const macro = wfbm(X * 0.04, Z * 0.04, 3, 313)
    const macro2 = wfbm(X * 0.13 + 60, Z * 0.13 + 22, 2, 411)
    let k = lerp(0.72, 1.16, macro) * lerp(0.92, 1.08, macro2)
    k *= 1 - occ * 0.62
    // gutters read darker (standing water + silt)
    const gy = y
    if (gy < -0.07) k *= lerp(1, 0.72, clamp01((-gy - 0.07) * 4))
    // Fade contrast toward the horizon so the skirt never competes for
    // attention — but only partly. At 0.55 this collapsed the whole apron onto
    // a single value, and under the warm key that read as one dead brown plane
    // filling a large part of any wide shot. Keeping more of the macro
    // variation costs nothing and gives the distance something to look at;
    // aerial perspective from the fog does the "recede" job better than
    // flattening albedo does.
    const fade = clamp01((out - 2) / 34)
    const kr = clamp01(lerp(k, 0.52, fade * 0.3))
    col[i * 3] = kr * lerp(1.0, 1.04, macro2)
    col[i * 3 + 1] = kr
    col[i * 3 + 2] = kr * lerp(1.02, 0.95, macro)
  }
  pos.needsUpdate = true
  g.setAttribute('splat', new THREE.BufferAttribute(splat, 4))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
  }

  const groundMat = makeSplatMaterial(kit)
  const ground = new THREE.Mesh(geo, groundMat)
  ground.name = 'world:ground'
  ground.receiveShadow = true
  ground.castShadow = false
  ground.matrixAutoUpdate = false
  ground.updateMatrix()
  group.add(ground)

  // --- skirt: same material, same surface, out to the horizon --------------
  {
    const inner = GROUND_SIZE / 2
    const outer = APRON_SIZE / 2
    const span = outer - inner
    const strips = [
      // [cx, cz, w, d]
      [0, -(inner + span / 2), outer * 2, span],
      [0, inner + span / 2, outer * 2, span],
      [-(inner + span / 2), 0, span, GROUND_SIZE],
      [inner + span / 2, 0, span, GROUND_SIZE],
    ]
    const parts = []
    for (const [cx, cz, w, d] of strips) {
      const p = new THREE.PlaneGeometry(w, d, Math.max(6, Math.round(w / 4)), Math.max(6, Math.round(d / 4)))
      p.rotateX(-Math.PI / 2)
      p.translate(cx, 0, cz)
      decorate(p)
      parts.push(p)
    }
    const skirtGeo = mergeGeos(parts, 'skirt', [['splat', 4]])
    if (skirtGeo) {
      const skirt = new THREE.Mesh(skirtGeo, groundMat)
      skirt.name = 'world:skirt'
      skirt.receiveShadow = false
      skirt.castShadow = false
      skirt.matrixAutoUpdate = false
      group.add(skirt)
    }
  }

  // -------------------------------------------------------------------------
  // Kerbs — individual stones, some chipped, some missing
  // -------------------------------------------------------------------------
  const kerbGeos = []
  const isRoad = (x, z) =>
    x >= 0 && z >= 0 && x < W && z < H && level.surfaceAt(x, z) === SURF.ASPHALT && level.getTile(x, z).elevation === 0
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!isRoad(x, z)) continue
      const wxc = (x - W / 2 + 0.5) * TILE
      const wzc = (z - H / 2 + 0.5) * TILE
      const sides = [
        [0, -1, 0, -TILE / 2, 0],
        [0, 1, 0, TILE / 2, 0],
        [-1, 0, -TILE / 2, 0, Math.PI / 2],
        [1, 0, TILE / 2, 0, Math.PI / 2],
      ]
      for (const [dx, dz, ox, oz, ry] of sides) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue
        if (isRoad(nx, nz)) continue
        if (level.getTile(nx, nz).elevation > 0) continue
        for (let s = 0; s < 2; s++) {
          if (rng.chance(0.07)) continue // missing stone
          const len = 0.94 - rng.next() * 0.06
          const g = bevelBox(len, 0.34, 0.24, 0.022, 1)
          worldUV(g, 1.1)
          paintGrime(g, {
            tint: 0xffffff,
            grimeHeight: 0.22,
            grimeStrength: 0.5,
            wear: 0.3,
            wearRadius: 0.05,
            mottle: 0.2,
            seed: x * 31 + z * 7 + s,
          })
          const along = (s - 0.5) * 1.0
          const tilt = rng.chance(0.13) ? (rng.next() - 0.5) * 0.16 : 0
          const dropped = rng.chance(0.1) ? -0.05 : 0
          place(
            g,
            wxc + ox + (ry === 0 ? along : dx * -0.11),
            0.09 + dropped,
            wzc + oz + (ry === 0 ? dz * -0.11 : along),
            ry + tilt * 0.4,
            1,
            1,
            1,
            ry === 0 ? tilt : 0,
            ry === 0 ? 0 : tilt
          )
          kerbGeos.push(g)
        }
      }
    }
  }
  const kerbGeo = mergeGeos(kerbGeos, 'kerbs')
  if (kerbGeo) {
    const kerbs = new THREE.Mesh(kerbGeo, kit.get('concrete', { density: 2.6, uvRepeat: 1, roughness: 0.92 }))
    kerbs.name = 'world:kerbs'
    kerbs.castShadow = true
    kerbs.receiveShadow = true
    kerbs.matrixAutoUpdate = false
    group.add(kerbs)
  }

  // -------------------------------------------------------------------------
  // Elevation slabs (elev 1): chunky bevelled concrete with broken edges
  // -------------------------------------------------------------------------
  const slabTop = []
  const slabSide = []
  const rebar = []
  const rr = makeRng(spec.seed ^ 0x77aa)

  const elevAt = (x, z) => (x >= 0 && z >= 0 && x < W && z < H ? level.getTile(x, z).elevation : -1)

  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (elevAt(x, z) !== 1) continue
      const cx = (x - W / 2 + 0.5) * TILE
      const cz = (z - H / 2 + 0.5) * TILE
      // main slab body, slightly oversized so tiles knit together
      const body = bevelBox(TILE + 0.04, 2.0, TILE + 0.04, 0.05, 1)
      worldUV(body, 1.6)
      paintGrime(body, {
        tint: 0xffffff,
        groundY: -1.0,
        grimeHeight: 0.9,
        grimeStrength: 0.5,
        wear: 0.26,
        wearRadius: 0.09,
        mottle: 0.18,
        seed: x * 17 + z * 3,
      })
      place(body, cx, 1.0, cz)
      slabSide.push(body)

      // stepped skirt + rebar on faces that meet open ground
      const faces = [
        [0, -1, 0, -TILE / 2, 0],
        [0, 1, 0, TILE / 2, Math.PI],
        [-1, 0, -TILE / 2, 0, -Math.PI / 2],
        [1, 0, TILE / 2, 0, Math.PI / 2],
      ]
      for (const [dx, dz, ox, oz, ry] of faces) {
        if (elevAt(x + dx, z + dz) !== 0) continue
        // two steps, broken into 2-3 chunks each so the edge is never a clean line
        for (let s = 0; s < 2; s++) {
          const h = 0.68 + s * 0.66
          const depth = 0.62 - s * 0.26
          const chunks = 2 + (rr.next() > 0.5 ? 1 : 0)
          for (let c = 0; c < chunks; c++) {
            const seg = TILE / chunks
            const wSeg = seg - 0.03 - rr.next() * 0.06
            const g = bevelBox(wSeg, h, depth, 0.03, 1)
            worldUV(g, 1.3)
            paintGrime(g, {
              tint: 0xffffff,
              grimeHeight: 0.5,
              grimeStrength: 0.55,
              wear: 0.3,
              wearRadius: 0.06,
              mottle: 0.2,
              seed: x * 91 + z * 13 + s * 5 + c,
            })
            const along = (c + 0.5) * seg - TILE / 2 + (rr.next() - 0.5) * 0.05
            const outward = depth * 0.5 + s * 0.3
            place(
              g,
              cx + ox + (dx === 0 ? along : dx * (outward - 0.05)),
              h * 0.5 - 0.06 + s * 0.0,
              cz + oz + (dz === 0 ? along : dz * (outward - 0.05)),
              ry,
              1,
              1,
              1
            )
            slabSide.push(g)
          }
        }
        // exposed rebar at a few broken corners
        if (rr.chance(0.34)) {
          for (let b = 0; b < 2 + Math.floor(rr.next() * 3); b++) {
            const g = new THREE.CylinderGeometry(0.016, 0.014, 0.32 + rr.next() * 0.4, 5, 1)
            flatColor(g, 0x6a4a33)
            const bend = (rr.next() - 0.5) * 1.1
            place(
              g,
              cx + ox * 0.86 + (rr.next() - 0.5) * 1.4 * (dx === 0 ? 1 : 0.2),
              1.55 + rr.next() * 0.3,
              cz + oz * 0.86 + (rr.next() - 0.5) * 1.4 * (dz === 0 ? 1 : 0.2),
              0,
              1,
              1,
              1,
              bend,
              bend * 0.6
            )
            rebar.push(g)
          }
        }
      }

      // top surface: a separate slightly-inset cap so the top reads as poured
      const cap = new THREE.PlaneGeometry(TILE + 0.02, TILE + 0.02, 2, 2)
      cap.rotateX(-Math.PI / 2)
      worldUV(cap, 2.2)
      paintGrime(cap, {
        tint: 0xffffff,
        groundY: 0,
        grimeHeight: 0.01,
        grimeStrength: 0,
        wear: 0.18,
        wearRadius: 0.12,
        mottle: 0.22,
        seed: x * 5 + z * 23,
      })
      place(cap, cx, 2.005, cz)
      slabTop.push(cap)
    }
  }

  const slabGeo = mergeGeos([...slabSide, ...slabTop], 'slabs')
  if (slabGeo) {
    const slabs = new THREE.Mesh(slabGeo, kit.get('concrete', { density: 2.2, uvRepeat: 1, roughness: 0.9 }))
    slabs.name = 'world:slabs'
    slabs.castShadow = true
    slabs.receiveShadow = true
    slabs.matrixAutoUpdate = false
    group.add(slabs)
  }
  const rebarGeo = mergeGeos(rebar, 'rebar')
  if (rebarGeo) {
    const m = new THREE.Mesh(rebarGeo, kit.get('rust', { density: 3, uvRepeat: 3, metalness: 0.75, roughness: 0.85 }))
    m.name = 'world:rebar'
    m.castShadow = true
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    group.add(m)
  }

  return { group, ground, groundMat }
}

// ---------------------------------------------------------------------------
// 4-way splat material
// ---------------------------------------------------------------------------

function makeSplatMaterial(kit) {
  const sA = kit.surface('asphalt')
  const sC = kit.surface('concrete')
  const sD = kit.surface('dirt')
  const sG = kit.surface('gravel')

  const mat = new THREE.MeshStandardMaterial({
    map: sA?.map || null,
    normalMap: sA?.normalMap || null,
    roughnessMap: sA?.roughnessMap || null,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  })
  mat.name = 'world:groundSplat'

  if (!sA || !sC || !sD || !sG) return mat // degraded: single-layer, still valid

  const uni = {
    tAlb: { value: [sA.map, sC.map, sD.map, sG.map] },
    tNrm: { value: [sA.normalMap, sC.normalMap, sD.normalMap, sG.normalMap] },
    uScale: { value: new THREE.Vector4(1 / 3.1, 1 / 2.3, 1 / 2.7, 1 / 1.9) },
    uRough: { value: new THREE.Vector4(0.94, 0.83, 0.98, 0.9) },
  }
  mat.userData.splatUniforms = uni

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uni)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4 splat;
         varying vec4 vSplat;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSplat = splat;`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec4 vSplat;
         uniform sampler2D tAlb[4];
         uniform sampler2D tNrm[4];
         uniform vec4 uScale;
         uniform vec4 uRough;

         vec4 splatWeights() {
           vec4 w = max( vSplat, vec4( 0.0 ) );
           w = w * w * w;                 // sharpen so layers read as materials
           return w / max( dot( w, vec4( 1.0 ) ), 1e-4 );
         }`
      )
      .replace(
        '#include <map_fragment>',
        `vec4 sw = splatWeights();
         vec2 uv0 = vMapUv * uScale.x;
         vec2 uv1 = vMapUv * uScale.y;
         vec2 uv2 = vMapUv * uScale.z;
         vec2 uv3 = vMapUv * uScale.w;
         vec4 blendAlb =
             texture2D( tAlb[0], uv0 ) * sw.x
           + texture2D( tAlb[1], uv1 ) * sw.y
           + texture2D( tAlb[2], uv2 ) * sw.z
           + texture2D( tAlb[3], uv3 ) * sw.w;
         diffuseColor *= blendAlb;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = dot( uRough, sw );
         roughnessFactor *= 1.0 - 0.18 * ( dot( blendAlb.rgb, vec3( 0.333 ) ) - 0.25 );
         roughnessFactor = clamp( roughnessFactor, 0.05, 1.0 );`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN =
             texture2D( tNrm[0], uv0 ).xyz * sw.x
           + texture2D( tNrm[1], uv1 ).xyz * sw.y
           + texture2D( tNrm[2], uv2 ).xyz * sw.z
           + texture2D( tNrm[3], uv3 ).xyz * sw.w;
         mapN = mapN * 2.0 - 1.0;
         mapN.xy *= normalScale;
         normal = normalize( tbn * mapN );`
      )
  }
  mat.customProgramCacheKey = () => 'world-splat-v1'
  return mat
}
