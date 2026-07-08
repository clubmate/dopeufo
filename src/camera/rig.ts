import * as THREE from 'three';

const PITCH = THREE.MathUtils.degToRad(50); // elevated XCOM-2-style view
const FOV = 40;
// Camera distance per zoom step; with FOV 40° these roughly match the old ortho framing.
const ZOOM_LEVELS = [14, 20, 30, 44, 60];

/**
 * XCOM-2-style perspective camera rig: four 90° yaw stops with smooth slerp
 * between them, keyboard/edge panning in camera-relative directions, and
 * stepped zoom (smoothed, via camera distance). The rig looks at a target
 * point on the ground.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  private yawIndex = 0;
  private yawCurrent = Math.PI / 4;
  private zoomIndex = 2;
  private zoomCurrent = ZOOM_LEVELS[2];
  private bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(24, 4, 24));
  /** Over-the-shoulder targeting view (shooter → target, world coords); null = tactical view. */
  private cine: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private posCurrent = new THREE.Vector3();
  private lookCurrent = new THREE.Vector3();
  private initialized = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.5, 300);
    this.update(0);
  }

  setMapBounds(w: number, h: number): void {
    this.bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, 0, h));
    this.target.set(w / 2, 0, h / 2);
  }

  get yawTarget(): number {
    return Math.PI / 4 + (this.yawIndex * Math.PI) / 2;
  }

  /** Rotate one 90° stop. dir=+1 counter-clockwise. */
  rotate(dir: 1 | -1): void {
    this.yawIndex = (this.yawIndex + dir + 4) % 4;
    // Keep the interpolant within half a turn so we always take the short way.
    const t = this.yawTarget;
    while (this.yawCurrent - t > Math.PI) this.yawCurrent -= Math.PI * 2;
    while (t - this.yawCurrent > Math.PI) this.yawCurrent += Math.PI * 2;
  }

  zoom(dir: 1 | -1): void {
    this.zoomIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, this.zoomIndex + dir));
  }

  /** Pan in camera-relative screen directions (dx=right, dy=up on screen). */
  pan(dx: number, dy: number): void {
    const speed = this.zoomCurrent * 0.018;
    const yaw = this.yawCurrent;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.target.addScaledVector(right, dx * speed).addScaledVector(fwd, dy * speed);
    this.target.x = THREE.MathUtils.clamp(this.target.x, this.bounds.min.x, this.bounds.max.x);
    this.target.z = THREE.MathUtils.clamp(this.target.z, this.bounds.min.z, this.bounds.max.z);
  }

  /** Grab-the-world panning: the ground under the cursor follows a mouse drag of (dxPx, dyPx) pixels. */
  dragPan(dxPx: number, dyPx: number): void {
    // World units visible per vertical pixel at the target ≈ 2·dist·tan(FOV/2)/H;
    // pan() scales its input by dist·0.018, so the distance cancels out.
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / (0.018 * window.innerHeight);
    // Vertical screen motion maps to ground-forward motion foreshortened by sin(pitch).
    this.pan(-dxPx * k, (dyPx * k) / Math.sin(PITCH));
  }

  centerOn(p: THREE.Vector3): void {
    this.target.copy(p).setY(0);
  }

  /** Swing into the over-the-shoulder targeting view (positions in world coords, unit feet). */
  enterTargetView(from: THREE.Vector3, to: THREE.Vector3): void {
    this.cine = { from: from.clone(), to: to.clone() };
  }

  exitTargetView(): void {
    this.cine = null;
  }

  get inTargetView(): boolean {
    return this.cine !== null;
  }

  setAspect(aspect: number): void {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Advance smoothing and place the camera. Call once per frame. */
  update(dt: number): void {
    const lerp = 1 - Math.exp(-dt * 10);
    this.yawCurrent += (this.yawTarget - this.yawCurrent) * lerp;
    this.zoomCurrent += (ZOOM_LEVELS[this.zoomIndex] - this.zoomCurrent) * lerp;
    this.setAspect(window.innerWidth / window.innerHeight);

    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    let desiredFov: number;
    if (this.cine) {
      // Over the shooter's right shoulder, slightly above head height, aimed at the target's chest.
      const { from, to } = this.cine;
      const dir = to.clone().sub(from).setY(0).normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      desiredPos = from.clone().addScaledVector(dir, -1.4).addScaledVector(right, 0.55).add(new THREE.Vector3(0, 1.25, 0));
      desiredLook = to.clone().add(new THREE.Vector3(0, 0.7, 0));
      desiredFov = 30;
    } else {
      const yaw = this.yawCurrent;
      const offset = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(PITCH),
        Math.sin(PITCH),
        Math.cos(yaw) * Math.cos(PITCH),
      ).multiplyScalar(this.zoomCurrent);
      desiredPos = this.target.clone().add(offset);
      desiredLook = this.target.clone();
      desiredFov = FOV;
    }

    // Smooth position/look/fov so every view change (target view, selection jumps) glides.
    const glide = this.initialized ? 1 - Math.exp(-dt * 6) : 1;
    this.initialized = true;
    this.posCurrent.lerp(desiredPos, glide);
    this.lookCurrent.lerp(desiredLook, glide);
    if (Math.abs(desiredFov - this.camera.fov) > 0.01) {
      this.camera.fov += (desiredFov - this.camera.fov) * glide;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(this.posCurrent);
    this.camera.lookAt(this.lookCurrent);
  }
}
