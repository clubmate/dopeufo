# UFO — Tactical PvP

A browser-based, two-player hotseat tactical game engine in the spirit of modern XCOM:
isometric multi-level voxel maps, a 2-action economy, cover and flanking, overwatch,
destructible terrain, and per-player fog of war. Built with three.js + TypeScript + Vite.

## Run it

```bash
npm install
npm run dev      # play at http://localhost:5173
npm test         # headless core test suite (determinism, LoS, pathfinding, combat)
npm run build    # typecheck + production bundle
```

## Controls

| Input | Action |
| --- | --- |
| Left click | Select unit / move / confirm target |
| Right click / Esc | Cancel targeting |
| Tab / Shift+Tab | Next / previous soldier |
| Q / E | Rotate camera 90° |
| WASD / arrows | Pan |
| Mouse wheel | Zoom |
| PageUp / PageDown | Manual floor cutaway |
| 1 / 2 / 3 | Snap / Aimed / Auto fire |
| F | Melee (Ranger) |
| 4–6 | Items (grenades, smoke, medkit) |
| R / Y / H | Reload / Overwatch / Hunker |
| Enter | End turn |

Clicking a door adjacent to the selected soldier toggles it (first toggle per turn is free).
Clicking a visible enemy starts targeting; click again to fire.

## Rules in brief

- **2 AP per soldier per turn.** Blue zone = 1 AP move, yellow = dash (2 AP).
  Snap shot = 1 AP and doesn't end the turn; aimed/auto = 2 AP and do.
- **Cover**: low objects give half cover (-20 aim), walls/closed doors full (-40).
  Cover only counts against shots from the covered side — flank for full damage and bonus crit. Hunker doubles cover.
- **Overwatch** (1 AP, ends turn): fire once, with an aim penalty, at the first enemy
  that moves through your line of sight on their turn.
- **Explosions** (frags, grenade launcher) damage by radius falloff and destroy terrain:
  wooden cover and doors break easily, brick and concrete resist. Unsupported floors collapse;
  soldiers fall and take fall damage.
- **Fog of war** is per player; enemies leave a gray "last seen" ghost when they break contact.
  The hotseat handoff screen is opaque so nothing leaks to your opponent.
- Squad size (4–8) and every stat live in JSON under `data/` — classes, weapons, items,
  ruleset constants, and hand-authored maps (ASCII layers + legend).

## Architecture

```
src/core/     Deterministic simulation. No three.js. Mutates only through
              Commands (plain JSON), emits typed SimEvents, all randomness
              through one seeded RNG => a game is fully reproducible from
              (map, ruleset, seed, command list). Tested headlessly.
  math/       seeded RNG, integer grid math
  map/        voxel grid (solid/half/floor/stairs/door), JSON map loader
  los/        Amanatides–Woo 3D DDA raycast with fixed tie-breaking,
              sight + corner peeking, cover derivation
  path/       Dijkstra reachable set with exact AP costs, drops, stairs
  combat/     hit chance (range curves, cover, height, smoke), damage,
              explosions + structural collapse
  fog/        per-player visible tiles, spotted units, last-seen ghosts
  turn/       turn switching, overwatch queue, win condition
  actions/    command validation and execution (the sim's only entry point)
src/render/   three.js presentation: per-level merged voxel meshes (rebuilt on
              destruction, hidden for floor cutaway), procedural soldiers,
              tactical overlays, event-stream animator (tweens, tracers, blasts)
src/camera/   orthographic isometric rig: 4x90° smooth rotation, pan, zoom steps
src/input/    mouse picking (units, tiles, doors)
src/ui/       DOM HUD (action bar, roster, tooltips), menu/handoff/victory screens
src/game/     controller gluing input -> commands -> events -> animation
data/         rulesets, classes, weapons, items, maps
tests/        vitest suite incl. full-game replay determinism hash
```

The strict core/presentation split means networked play only needs to ship the
command stream plus the seed; both clients replay identical sims.
