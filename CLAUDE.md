# CLAUDE.md — AI Agent Context for dopeufo

## Project Identity
**dopeufo** is an isometric pixel-art turn-based PvP tactical combat engine
inspired by classic XCOM / OpenXcom. Two human players fight each other in
squad-based tactical combat. This is the **engine only** — no menus, campaign,
or geoscape.

## Tech Stack
- **Language:** C++17
- **Build:** CMake ≥ 3.20
- **Rendering:** SDL2 + SDL2_image
- **Audio:** SDL2_mixer
- **Networking:** SDL2_net (peer-to-peer)
- **JSON:** nlohmann/json (FetchContent)
- **Tests:** Catch2 v3 (FetchContent)

## Build & Run
```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
./build/dopeufo            # run engine
ctest --test-dir build     # run tests
```

## Architecture at a Glance
```
src/
  core/       → ECS, event bus, math, types, command pattern, game state FSM
  render/     → SDL2 renderer, isometric camera, sprite system
  map/        → Tile grid, multi-level heightmap, A* pathfinding, LoS/LoF
  combat/     → Actions (move/shoot/overwatch/etc), cover, damage, reactions
  unit/       → Unit components, stats, inventory, abilities
  turn/       → IGOUGO turn manager, fog of war
  net/        → P2P networking, protocol, serialization
  input/      → SDL event → engine command translation
  audio/      → Sound effect / music playback (stub)
  engine.h/cpp → Top-level engine orchestration
  main.cpp    → Entry point
```

## Key Design Decisions
| Area | Decision |
|------|----------|
| Turn model | IGOUGO — Player A moves all units, then Player B |
| Action economy | Two-action system (move+shoot, move+move, etc.) |
| Grid | Square isometric grid, uniform diagonal cost |
| Tile size | 128×64 px isometric diamond |
| Resolution | 1280×720 native |
| Height | Full multi-level (Z-layers, stairs, rooftops) |
| Cover | Directional half/full cover at tile edges |
| Fog of war | Full per-unit LoS-based fog |
| Reactions | Overwatch / opportunity fire |
| Destruction | Full destructible terrain |
| Squads | Fixed 4–6 units per player |
| Maps | Hybrid: data-driven JSON + procedural generation |
| Networking | Peer-to-peer, command-based sync |
| Win condition | Elimination + objectives |

## Coding Conventions
- Namespace: `dope::` with sub-namespaces (`dope::core`, `dope::map`, etc.)
- Header guards: `#pragma once`
- Use `snake_case` for variables/functions, `PascalCase` for types/classes
- Use `m_` prefix for member variables
- Use `constexpr` / `const` wherever possible
- Prefer `std::optional`, `std::variant`, `std::string_view` over raw pointers/C strings
- All game actions are **Command** objects (serializable for networking)
- ECS: Entity = u32 ID, Components = plain structs, Systems = free functions or classes
- Events: decouple systems via `EventBus` publish/subscribe

## File Naming
- Headers: `.h`, Sources: `.cpp`
- One class per file when practical
- Test files: `test_<module>.cpp`

## Data Format
- Maps, units, weapons: JSON files in `data/`
- Assets: `assets/` (sprites, audio — not yet populated)

## Important Invariants
- Game state must be **deterministic** given the same command sequence
- All mutations to game state go through the Command pipeline
- Network sync = replaying commands on both peers
- Fog of war is always per-player; never leak opponent info in PvP
