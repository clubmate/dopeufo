/**
 * Skeleton services layered on top of the baked clips:
 *
 *  - upper-body aim tracking: the torso and head rotate toward a world target
 *    independently of where the legs are pointing. This is the single cheapest
 *    thing that makes a tactical shooter feel expensive — a soldier who walks
 *    north while keeping his rifle on a target to the east.
 *  - foot grounding: after the mixer writes the pose, each ankle is probed
 *    against the terrain and the leg is re-solved analytically so nobody floats
 *    over a ledge or sinks into a slab.
 *
 * Everything here runs AFTER AnimationMixer.update and BEFORE the renderer
 * refreshes world matrices, so it behaves like a post-process animation layer.
 */
import * as THREE from 'three'

export const BONE = {
  root: 'root', pelvis: 'pelvis',
  spine1: 'spine_01', spine2: 'spine_02', chest: 'chest',
  neck: 'neck', head: 'head',
  handR: 'hand_R', handL: 'hand_L',
  weapon: 'weapon', muzzle: 'muzzle',
  thighR: 'thigh_R', calfR: 'calf_R', footR: 'foot_R', toeR: 'toe_R',
  thighL: 'thigh_L', calfL: 'calf_L', footL: 'foot_L', toeL: 'toe_L',
}

// Distribution of the aim yaw/pitch down the spine. Sums to 1 so the total
// rotation matches what the caller asked for.
const AIM_CHAIN = [
  { bone: BONE.spine1, yaw: 0.16, pitch: 0.14 },
  { bone: BONE.spine2, yaw: 0.24, pitch: 0.20 },
  { bone: BONE.chest, yaw: 0.36, pitch: 0.34 },
  { bone: BONE.head, yaw: 0.24, pitch: 0.32 },
]

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _up = new THREE.Vector3(0, 1, 0)

export function collectBones(root) {
  const map = Object.create(null)
  root.traverse((o) => {
    if (o.isBone) map[o.name] = o
  })
  return map
}

/** Cache the bind-pose local quaternions so aim offsets never accumulate. */
export function createAimLayer(bones) {
  const chain = []
  for (const link of AIM_CHAIN) {
    const b = bones[link.bone]
    if (b) chain.push({ bone: b, yaw: link.yaw, pitch: link.pitch })
  }
  return {
    chain,
    yaw: 0,
    pitch: 0,
    targetYaw: 0,
    targetPitch: 0,
    weight: 0,
    targetWeight: 0,
  }
}

/**
 * Feed the layer a world-space point to look at. `facing` is the unit's own
 * Y rotation, so the resulting yaw is the *difference* the torso must make up.
 */
export function aimAt(layer, originWorld, targetWorld, facing) {
  const dx = targetWorld.x - originWorld.x
  const dz = targetWorld.z - originWorld.z
  const dy = targetWorld.y - originWorld.y
  const flat = Math.hypot(dx, dz)
  // model forward is +Z after the 180deg wrapper, so atan2(x, z)
  let yaw = Math.atan2(dx, dz) - facing
  while (yaw > Math.PI) yaw -= Math.PI * 2
  while (yaw < -Math.PI) yaw += Math.PI * 2
  // torsos do not twist past ~70deg; beyond that the game layer should turn
  layer.targetYaw = THREE.MathUtils.clamp(yaw, -1.22, 1.22)
  layer.targetPitch = THREE.MathUtils.clamp(Math.atan2(dy, flat || 0.001), -0.55, 0.55)
  layer.targetWeight = 1
}

export function clearAim(layer) {
  layer.targetYaw = 0
  layer.targetPitch = 0
  layer.targetWeight = 0
}

export function updateAim(layer, dt) {
  const k = 1 - Math.exp(-dt * 9.0)
  layer.yaw += (layer.targetYaw - layer.yaw) * k
  layer.pitch += (layer.targetPitch - layer.pitch) * k
  layer.weight += (layer.targetWeight - layer.weight) * (1 - Math.exp(-dt * 6.0))
}

/**
 * Apply the accumulated aim as a world-axis rotation on each spine link. The
 * axis is converted into the parent's space so the offset composes correctly on
 * top of whatever the clip already did.
 */
export function applyAim(layer, modelRoot) {
  if (layer.weight < 0.001) return
  const wy = layer.yaw * layer.weight
  const wp = layer.pitch * layer.weight
  if (Math.abs(wy) < 1e-4 && Math.abs(wp) < 1e-4) return
  for (const link of layer.chain) {
    const b = link.bone
    const parent = b.parent
    if (parent) parent.getWorldQuaternion(_qi).invert()
    else _qi.identity()

    // yaw about the model's up axis
    if (Math.abs(wy) > 1e-5) {
      _axis.copy(_up).applyQuaternion(_qi).normalize()
      _q.setFromAxisAngle(_axis, wy * link.yaw)
      b.quaternion.premultiply(_q)
    }
    // pitch about the model-space right axis
    if (Math.abs(wp) > 1e-5) {
      _axis.set(1, 0, 0).applyQuaternion(modelRoot.quaternion).applyQuaternion(_qi).normalize()
      _q.setFromAxisAngle(_axis, -wp * link.pitch)
      b.quaternion.premultiply(_q)
    }
    b.updateMatrixWorld(true)
  }
}

// ------------------------------------------------------------- foot ground ---
const LEGS = [
  { thigh: BONE.thighR, calf: BONE.calfR, foot: BONE.footR },
  { thigh: BONE.thighL, calf: BONE.calfL, foot: BONE.footL },
]

export function createFootLayer(bones) {
  const legs = []
  for (const L of LEGS) {
    const thigh = bones[L.thigh]
    const calf = bones[L.calf]
    const foot = bones[L.foot]
    if (!thigh || !calf || !foot) continue
    legs.push({
      thigh, calf, foot,
      l1: calf.position.length(),
      l2: foot.position.length(),
      offset: 0,
      target: 0,
    })
  }
  return { legs, enabled: legs.length === 2 }
}

const _hip = new THREE.Vector3()
const _ankle = new THREE.Vector3()
const _goal = new THREE.Vector3()
const _knee = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _pole = new THREE.Vector3()
const _perp = new THREE.Vector3()
const _footQ = new THREE.Quaternion()

/**
 * Two-bone analytic IK. `probe(x, z)` returns the terrain height under a world
 * point (or null when the world module has not published one yet), in which
 * case this is a no-op and the baked animation is trusted.
 */
export function groundFeet(layer, modelRoot, probe, baseY, dt) {
  if (!layer.enabled || typeof probe !== 'function') return
  for (const leg of layer.legs) {
    leg.foot.getWorldPosition(_ankle)
    const g = probe(_ankle.x, _ankle.z)
    const want = g == null ? 0 : THREE.MathUtils.clamp(g - baseY, -0.75, 0.75)
    // never pull a foot below the surface, only lift it onto higher ground
    leg.target = want
    const k = 1 - Math.exp(-dt * 14.0)
    leg.offset += (leg.target - leg.offset) * k
    if (Math.abs(leg.offset) < 0.004) continue

    leg.thigh.getWorldPosition(_hip)
    _goal.copy(_ankle)
    _goal.y += leg.offset

    // keep the animated foot orientation, solve the chain to the lifted goal
    leg.foot.getWorldQuaternion(_footQ)
    leg.calf.getWorldPosition(_knee)
    _pole.copy(_knee).sub(_hip)
    solveTwoBone(leg, _hip, _goal, _pole, modelRoot)
    // restore the ankle's world orientation after the chain moved
    leg.foot.parent.getWorldQuaternion(_q).invert()
    leg.foot.quaternion.copy(_q).multiply(_footQ)
    leg.foot.updateMatrixWorld(true)
  }
}

function solveTwoBone(leg, hip, goal, poleHint, modelRoot) {
  const l1 = leg.l1 * getScale(modelRoot)
  const l2 = leg.l2 * getScale(modelRoot)
  _dir.copy(goal).sub(hip)
  let dist = _dir.length()
  const lo = Math.abs(l1 - l2) + 1e-4
  const hi = l1 + l2 - 1e-4
  if (dist < 1e-5) return
  dist = THREE.MathUtils.clamp(dist, lo, hi)
  _dir.normalize()

  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1)
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
  _perp.copy(poleHint)
  _perp.addScaledVector(_dir, -_perp.dot(_dir))
  if (_perp.lengthSq() < 1e-8) _perp.set(0, 0, 1).addScaledVector(_dir, -_dir.z)
  _perp.normalize()

  _knee.copy(hip).addScaledVector(_dir, cosA * l1).addScaledVector(_perp, sinA * l1)
  pointBone(leg.thigh, hip, _knee)
  pointBone(leg.calf, _knee, _v2.copy(hip).addScaledVector(_dir, dist))
}

const _look = new THREE.Matrix4()
const _pq = new THREE.Quaternion()
const _tmp = new THREE.Vector3()

/** Rotate `bone` so its local +Y axis (glTF bone convention) spans a -> b. */
function pointBone(bone, a, b) {
  _tmp.copy(b).sub(a)
  if (_tmp.lengthSq() < 1e-9) return
  _tmp.normalize()
  // build a world quaternion whose Y axis is _tmp, then bring it into parent space
  const upRef = Math.abs(_tmp.y) > 0.98 ? _v.set(0, 0, 1) : _v.set(0, 1, 0)
  const z = _v2.crossVectors(_tmp, upRef)
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1)
  z.normalize()
  const x = _pole.crossVectors(_tmp, z).normalize()
  _look.makeBasis(x, _tmp, z)
  _q.setFromRotationMatrix(_look)
  bone.parent.getWorldQuaternion(_pq).invert()
  bone.quaternion.copy(_pq).multiply(_q)
  bone.updateMatrixWorld(true)
}

function getScale(o) {
  return o.scale?.x || 1
}

// ------------------------------------------------------------------ muzzle ---
export function worldFromLocal(obj, local, out) {
  if (!obj) return out.set(0, 1.4, 0)
  out.copy(local)
  obj.updateWorldMatrix(true, false)
  return out.applyMatrix4(obj.matrixWorld)
}

export function forwardOf(obj, out) {
  if (!obj) return out.set(0, 0, 1)
  obj.updateWorldMatrix(true, false)
  _m.extractRotation(obj.matrixWorld)
  return out.set(0, 0, -1).applyMatrix4(_m).normalize()
}
