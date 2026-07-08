import * as THREE from 'three';
import { newGame, MAPS } from './core/setup';
import { updateVision } from './core/fog/visibility';
import { createScene, centerLighting, SceneCtx } from './render/scene';
import { TerrainRenderer } from './render/terrain';
import { UnitRenderer } from './render/units';
import { OverlayRenderer } from './render/overlays';
import { Animator } from './render/animation';
import { CameraRig } from './camera/rig';
import { Picker } from './input/picker';
import { Hud } from './ui/hud';
import { showMenu } from './ui/screens';
import { Controller } from './game/controller';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const labelsRoot = document.getElementById('labels')!;
const overlayRoot = document.getElementById('overlay')!;

let ctx: SceneCtx | null = null;
let teardown: (() => void) | null = null;

function mainMenu(): void {
  showMenu(
    overlayRoot,
    Object.entries(MAPS).map(([id, m]) => ({ id, name: m.name })),
    (choice) => startGame(choice.mapId, choice.squadSize),
  );
}

function startGame(mapId: string, squadSize: number): void {
  teardown?.();

  const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const state = newGame(mapId, seed, squadSize);

  ctx = ctx ?? createScene(canvas);
  const scene = ctx.scene;
  scene.clear();
  // Re-add lights (scene.clear removed them).
  const fresh = createSceneLights();
  fresh.forEach((l) => scene.add(l));
  centerLighting(ctx, state.map.w, state.map.h);

  const rig = new CameraRig(window.innerWidth / window.innerHeight);
  rig.setMapBounds(state.map.w, state.map.h);

  const terrain = new TerrainRenderer(state);
  const units = new UnitRenderer(state);
  const overlays = new OverlayRenderer(state);
  scene.add(terrain.root, units.root, overlays.root);

  let controller: Controller;
  const shake = { t: 0, strength: 0 };

  const animator = new Animator(state, units, terrain, scene, {
    floater: (world, text, color) => {
      const s = project(world.x, world.y, world.z);
      if (s) hud.floater(s.x, s.y, text, color);
    },
    onVisibility: () => controller.onVisibilityEvent(),
    onTurnEnded: () => controller.onTurnEndedEvent(),
    onGameOver: (w) => controller.onGameOverEvent(w),
    onSmoke: () => controller.onSmokeEvent(),
    centerCamera: (world) => rig.centerOn(world),
    shake: (strength) => {
      shake.t = 0.4;
      shake.strength = strength;
    },
  });

  const hud = new Hud(hudRoot, labelsRoot, {
    onAction: (id) => controller.onAction(id),
    onSelectUnit: (id) => controller.select(id),
    onEndTurn: () => controller.endTurn(),
  });

  controller = new Controller(state, units, terrain, overlays, animator, hud, rig, overlayRoot, () => {
    teardown?.();
    mainMenu();
  });
  overlays.syncFog(controller.viewer);

  // Dev/test hook (harmless in production; the sim still validates all commands).
  (window as unknown as Record<string, unknown>).__game = { state, controller, updateVision };

  const picker = new Picker(state, rig.camera);

  function project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z).project(rig.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  // ---------------- input ----------------
  const keys = new Set<string>();
  let mouse = { x: 0, y: 0 };
  // Left button: drag pans the camera; a click without movement selects.
  let leftDrag: { lastX: number; lastY: number; startX: number; startY: number; moved: boolean } | null = null;

  const onMouseMove = (e: MouseEvent): void => {
    mouse = { x: e.clientX, y: e.clientY };
    if (leftDrag && e.buttons & 1) {
      const dx = e.clientX - leftDrag.lastX;
      const dy = e.clientY - leftDrag.lastY;
      leftDrag.lastX = e.clientX;
      leftDrag.lastY = e.clientY;
      if (Math.abs(e.clientX - leftDrag.startX) + Math.abs(e.clientY - leftDrag.startY) > 4) leftDrag.moved = true;
      if (leftDrag.moved) {
        rig.dragPan(dx, dy);
        return;
      }
    }
    controller.onHover(picker.pick(e.clientX, e.clientY, units.pickables(), terrain.root), e.clientX, e.clientY);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      leftDrag = { lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    } else if (e.button === 2) {
      controller.onCommand(picker.pick(e.clientX, e.clientY, units.pickables(), terrain.root));
    }
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0 || !leftDrag) return;
    const wasDrag = leftDrag.moved;
    leftDrag = null;
    if (!wasDrag) controller.onSelect(picker.pick(e.clientX, e.clientY, units.pickables(), terrain.root));
  };
  const onContext = (e: MouseEvent): void => {
    e.preventDefault();
  };
  const onWheel = (e: WheelEvent): void => {
    rig.zoom(e.deltaY > 0 ? 1 : -1);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      keys.add(e.key.toLowerCase());
      return;
    }
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'q') rig.rotate(1);
    else if (k === 'e') rig.rotate(-1);
    else if (k === 'tab') {
      e.preventDefault();
      controller.cycleUnit(e.shiftKey ? -1 : 1);
    } else if (k === 'enter') controller.endTurn();
    else if (k === 'escape') controller.cancelMode();
    else if (k === 'pageup') controller.adjustLevelCap(1);
    else if (k === 'pagedown') controller.adjustLevelCap(-1);
    else controller.hotkey(k);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.key.toLowerCase());
  };
  const onResize = (): void => {
    ctx!.renderer.setSize(window.innerWidth, window.innerHeight);
    rig.setAspect(window.innerWidth / window.innerHeight);
  };

  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);

  // ---------------- frame loop ----------------
  let last = performance.now();
  let raf = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Keyboard panning.
    const panX = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const panY = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    if (panX !== 0 || panY !== 0) rig.pan(panX * dt * 22, panY * dt * 22);

    rig.update(dt);
    if (shake.t > 0) {
      shake.t -= dt;
      const s = shake.strength * (shake.t / 0.4) * 0.15;
      rig.camera.position.x += (Math.random() - 0.5) * s;
      rig.camera.position.y += (Math.random() - 0.5) * s;
    }

    animator.update(dt);
    animator.updateEffects(dt);
    hud.updateLabels(state, controller.viewer, project);

    ctx!.renderer.render(scene, rig.camera);

    // Re-pick under cursor while animating so the hover marker stays honest.
    void mouse;
  };
  raf = requestAnimationFrame(loop);

  teardown = () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);
    hudRoot.innerHTML = '';
    labelsRoot.innerHTML = '';
    scene.clear();
    teardown = null;
  };
}

function createSceneLights(): THREE.Object3D[] {
  const ambient = new THREE.AmbientLight(0x8899bb, 0.75);
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
  return [ambient, sun, sun.target];
}

mainMenu();
