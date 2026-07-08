import * as THREE from 'three';

/** World scale: one grid tile = 1 world unit, one height level = LEVEL_H. */
export const LEVEL_H = 1.0;

/** Grid position -> world-space center of a cell's floor. */
export function tileToWorld(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x + 0.5, z * LEVEL_H, y + 0.5);
}

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.Fog(0x0b0e14, 45, 120);

  createLights().forEach((l) => scene.add(l));

  return { renderer, scene, canvas };
}

/**
 * Night-mission lighting: cool hemisphere base, a warm moon/flood key light
 * with shadows, and a cold rim fill from the opposite side.
 */
export function createLights(): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(0x3d4c6e, 0x12141a, 1.2);

  const sun = new THREE.DirectionalLight(0xffe3c0, 2.4);
  sun.position.set(30, 45, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 3;

  const rim = new THREE.DirectionalLight(0x4a6a9a, 0.7);
  rim.position.set(-25, 30, -20);

  return [hemi, sun, sun.target, rim];
}

/** Keeps the shadow camera centered on the map. */
export function centerLighting(ctx: SceneCtx, w: number, h: number): void {
  const sun = ctx.scene.children.find((c): c is THREE.DirectionalLight => c instanceof THREE.DirectionalLight);
  if (!sun) return;
  sun.target.position.set(w / 2, 0, h / 2);
  sun.position.set(w / 2 + 24, 40, h / 2 + 10);
}
