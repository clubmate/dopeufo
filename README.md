# dopeufo

Isometric pixel-art turn-based PvP tactical combat engine inspired by classic
XCOM / OpenXcom. Two human players control squads of soldiers and fight on
destructible multi-level maps with fog of war, directional cover, and overwatch.

**Engine only** — no menus, campaigns, or geoscape. Designed for future online
multiplayer from day one.

## Features (Engine)
- Square isometric grid with full multi-level height support
- IGOUGO turn model with two-action economy (move+shoot, move+move, etc.)
- Directional half/full cover system
- Full per-unit line-of-sight fog of war
- Overwatch / opportunity fire reactions
- Fully destructible environment
- A* pathfinding across multiple Z-levels
- Command-pattern game logic (deterministic, replayable, network-ready)
- Data-driven maps (JSON) + procedural generation
- Peer-to-peer networking architecture

## Tech
- C++17, SDL2, CMake
- nlohmann/json for data files
- Catch2 for testing

## Build

### Prerequisites
- CMake ≥ 3.20
- C++17 compiler (MSVC 2019+, GCC 9+, Clang 10+)
- SDL2 development libraries (`SDL2`, `SDL2_image`, `SDL2_mixer`, `SDL2_net`)

### Compile
```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

### Run
```bash
./build/dopeufo
```

### Test
```bash
ctest --test-dir build
```

## Project Structure
```
src/
  core/       ECS, events, math, commands, game state
  render/     SDL2 rendering, isometric camera, sprites
  map/        Tile grid, pathfinding, line of sight
  combat/     Actions, cover, damage, overwatch
  unit/       Unit stats, inventory, abilities
  turn/       Turn manager, fog of war
  net/        Peer-to-peer networking
  input/      Input handling
  audio/      Audio playback (stub)
data/         JSON data files (maps, units, weapons)
assets/       Sprites, sounds (not yet populated)
tests/        Catch2 unit tests
```

## License
TBD
