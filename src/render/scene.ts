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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151d);
  scene.fog = new THREE.Fog(0x11151d, 60, 140);

  const ambient = new THREE.AmbientLight(0x8899bb, 0.75);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(30, 45, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  return { renderer, scene, canvas };
}

/** Keeps the shadow camera centered on the map. */
export function centerLighting(ctx: SceneCtx, w: number, h: number): void {
  const sun = ctx.scene.children.find((c): c is THREE.DirectionalLight => c instanceof THREE.DirectionalLight);
  if (!sun) return;
  sun.target.position.set(w / 2, 0, h / 2);
  sun.position.set(w / 2 + 24, 40, h / 2 + 10);
}
