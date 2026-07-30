# DOPE UFO — Architecture Contract

**Isometric turn-based PvP tactical game, 2-player hotseat. Three.js. AAA visual target.**

This file is the integration contract. Every module owner MUST follow it exactly.
Do not change shared signatures without updating this file.

---

## Hard rules for all module owners

1. **Own only your files.** Never edit files outside your assigned list. Never edit
   `src/main.js`, `src/core/*`, or this file unless you own them.
2. **ES modules only.** `import * as THREE from 'three'`. No CommonJS, no globals.
3. **No new npm dependencies.** Only `three` (0.169) + its `examples/jsm/*` addons.
4. **Every module exports an init function** taking `ctx` and returning an API object.
5. **Never block the frame.** Heavy work goes in generators/chunked loops.
6. **Everything must dispose.** Provide `dispose()` on returned APIs.
7. **Fail soft.** Wrap risky init in try/catch; a broken subsystem must not blank the screen.
8. **Units are metres.** Soldier ≈ 1.8. Tile = 2.0. Elevation step = 2.0.

---

## Coordinate system

- Right-handed, **Y is up**. Horizontal plane is **X / Z**.
- Grid coords are integers `(x, z)`, `x ∈ [0, W)`, `z ∈ [0, H)`.
- Conversion (canonical — use `ctx.grid.toWorld` / `ctx.grid.toGrid`, never re-derive):

```js
TILE = 2.0
ELEV_STEP = 2.0
worldX = (x - W / 2 + 0.5) * TILE
worldZ = (z - H / 2 + 0.5) * TILE
worldY = elevation * ELEV_STEP
```

- Facing is a Y-axis rotation in radians. 0 = +Z, increasing counter-clockwise.

---

## The context object (`ctx`)

Created by `src/core/engine.js`, passed to every module init. Single source of truth.

```js
ctx = {
  THREE,                    // the three namespace
  scene, camera, renderer,  // THREE.Scene / PerspectiveCamera / WebGLRenderer
  composer,                 // EffectComposer (may be null on low quality)
  clock,                    // THREE.Clock
  dt, time,                 // per-frame delta + elapsed seconds (updated by engine)
  bus,                      // EventBus (see below)
  grid,                     // { W, H, TILE, ELEV_STEP, toWorld(x,z,e), toGrid(v3) }
  state,                    // GameState (owned by game/)
  world,                    // level API (owned by world/)
  units,                    // unit rendering API (owned by units/)
  fx,                       // VFX API (owned by fx/)
  audio,                    // audio API (owned by audio/)
  ui,                       // HUD API (owned by ui/)
  cameraRig,                // camera controller (owned by input/)
  materials,                // shared material library (owned by render/)
  quality,                  // 'ultra' | 'high' | 'medium' | 'low'
  register(name, api),      // attach your API to ctx under `name`
  onUpdate(fn),             // register a per-frame callback fn(dt, time)
}
```

`ctx.register('fx', api)` sets `ctx.fx`. Call it at the end of your init.

---

## Event bus

`ctx.bus.on(event, fn)`, `ctx.bus.off(event, fn)`, `ctx.bus.emit(event, payload)`.

**Emitted by `game/` — consumed by fx/audio/ui/units/camera:**

| Event | Payload |
|---|---|
| `turn:start` | `{ team, turn }` |
| `turn:end` | `{ team }` |
| `unit:selected` | `{ unitId }` |
| `unit:deselected` | `{}` |
| `unit:moveStart` | `{ unitId, path }` — path = `[{x,z,elevation}, ...]` |
| `unit:moveStep` | `{ unitId, tile }` |
| `unit:moveEnd` | `{ unitId }` |
| `unit:aim` | `{ shooterId, targetId }` |
| `unit:shoot` | `{ shooterId, targetId, shots, hit, dmg, crit, killed, from, to }` |
| `unit:damaged` | `{ unitId, dmg, crit, sourceId }` |
| `unit:died` | `{ unitId }` |
| `unit:overwatch` | `{ unitId }` |
| `unit:hunker` | `{ unitId }` |
| `unit:reload` | `{ unitId }` |
| `grenade:thrown` | `{ unitId, from, to }` |
| `explosion` | `{ position, radius }` |
| `game:over` | `{ winner }` |

**Emitted by `input/` — consumed by game:**

| Event | Payload |
|---|---|
| `tile:hover` | `{ x, z }` or `null` |
| `tile:click` | `{ x, z, button }` |
| `unit:hover` | `{ unitId }` or `null` |
| `unit:click` | `{ unitId, button }` |

**Emitted by `ui/` — consumed by game:**

| Event | Payload |
|---|---|
| `ui:ability` | `{ ability }` — `'move'\|'fire'\|'overwatch'\|'hunker'\|'reload'\|'grenade'\|'endturn'` |
| `ui:cancel` | `{}` |
| `ui:endTurn` | `{}` |

**Emitted by anyone — consumed by `input/`:**

| Event | Payload |
|---|---|
| `camera:focus` | `{ position, immediate }` |
| `camera:shake` | `{ intensity, duration }` |
| `camera:cinematic` | `{ from, to, duration }` |

---

## Data shapes

### Tile
```js
{
  x, z,
  elevation,          // integer level, 0 = ground
  walkable,           // bool
  cost,               // movement cost multiplier, default 1
  occupantId,         // unit id or null
  cover: { n: 0, e: 0, s: 0, w: 0 },   // 0 none, 1 half, 2 full
  destructible,       // bool — cover can be destroyed
  hazard,             // null | 'fire' | 'smoke' | 'acid'
}
```

### Unit
```js
{
  id,                 // 'u_0'
  team,               // 0 | 1
  name, className,    // 'Ranger' | 'Sharpshooter' | 'Grenadier' | 'Specialist'
  x, z, elevation, facing,
  hp, hpMax, armor,
  aim, defense, mobility, crit, dodge, will,
  ap, apMax,          // action points, 2 per turn
  weapon: {
    name, dmgMin, dmgMax, critBonus, range, ammo, ammoMax,
    spread, shots,    // shots per burst
  },
  abilities: [],      // string ids
  statuses: [],       // [{ type, turns }]
  alive, overwatch, hunkered, flanked,
}
```

### GameState
```js
{
  turn, activeTeam,
  phase,              // 'select' | 'moving' | 'targeting' | 'animating' | 'over'
  units: [],
  selectedUnitId,
  targetUnitId,
  pendingAction,      // null | 'move' | 'fire' | 'grenade' | ...
  winner,
}
```

---

## Combat rules (owned by `game/`)

XCOM-2-like, deterministic per roll, fully readable to the player.

- **Hit chance** = `aim + rangeMod − targetDefense − coverBonus + flankBonus + heightBonus`
  - cover: half = −20, full = −40, hunkered doubles it
  - flank (attacker not blocked by target's cover toward attacker) = cover ignored, +30 crit
  - height advantage (attacker elevation > target) = +20 aim
  - clamped to `[1, 100]`
- **Crit** = `crit + flankBonus`, rolled after a hit. Crit damage = `+50%`, rounded up.
- **Dodge** converts a hit into a graze (−50% damage) on `dodge%`.
- **Armor** subtracts flat damage, min 1 through armor.
- **Overwatch**: reaction shot at `−15 aim` on first enemy movement through LOS.
- **Line of sight**: 3D Bresenham + ray checks against full-cover blockers at eye height.

---

## Module ownership

| Path | Owner agent | Responsibility |
|---|---|---|
| `src/core/*`, `src/main.js`, `index.html` | **lead (me)** | engine, loop, ctx, bootstrap |
| `src/render/*` | **render** | lighting, sky/atmosphere, post-processing, material library |
| `src/world/*` | **world** | level generation, terrain, buildings, cover props, decals |
| `src/units/*` | **units** | soldier meshes, rigs, skinning, animation state machine |
| `src/game/*` | **rules** | state, turn flow, pathfinding, LOS, cover, combat, abilities, AI-free hotseat |
| `src/ui/*` | **ui** | HUD, ability bar, hit-chance panel, health bars, turn banners, CSS |
| `src/fx/*` | **vfx** | muzzle flash, tracers, impacts, blood, smoke, explosions, decals |
| `src/audio/*` | **audio** | procedural weapon/impact/ambient audio, music bed, mixer |
| `src/input/*` | **input** | isometric camera rig, orbit/pan/zoom, raycast picking, cinematic cam |

Each owner writes an `index.js` in their folder exporting:

```js
export async function init(ctx) {
  // ... build things ...
  const api = { /* ... */, dispose() {} }
  ctx.register('<name>', api)
  return api
}
```

`src/main.js` imports each folder's `index.js` in a fixed order:
`render → world → units → fx → audio → game → input → ui`

---

## Quality bar (non-negotiable)

Every subsystem is judged by a hostile art-director agent comparing screenshots
against XCOM 2. Baseline expectations:

- **Nothing untextured.** No flat Lambert/Basic colours. PBR with roughness/normal/AO maps everywhere.
- **Nothing perfectly sharp or perfectly clean.** Edge wear, grime, colour variation, bevels.
- **Real lighting.** Shadow-casting key light, sky ambient (IBL), bounce fill, no ambient-only.
- **Post stack.** AgX tonemapping, bloom, GTAO, SMAA, subtle vignette + grain, DoF on cinematics.
  > Tonemap deviation, accepted deliberately: this said ACES originally. three's ACES is the
  > Narkowicz/Hill fit, whose shoulder is hue-skewed — warm highlights roll toward orange rather
  > than white, so under a warm key every material converges on the same rust. AgX desaturates as
  > it clips and keeps material identity separable. Override with `?tonemap=aces|neutral|cineon`.
- **Silhouette reads at iso distance.** Detail that vanishes at gameplay zoom is wasted.
- **Every action has feedback.** Anim + VFX + audio + camera response. No instant teleports.
- **60 fps at 1440p** on an M-series Mac. Budget: < 300 draw calls, < 2M tris.
