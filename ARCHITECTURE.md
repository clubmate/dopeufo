# Architecture — dopeufo Engine

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                        Engine                           │
│  ┌──────┐ ┌────────┐ ┌──────┐ ┌───────┐ ┌───────────┐  │
│  │Input │→│Command │→│ Game │→│Render │→│  Window   │  │
│  │Mgr   │ │Pipeline│ │State │ │System │ │ (SDL2)    │  │
│  └──────┘ └────┬───┘ └──┬───┘ └───────┘ └───────────┘  │
│               │        │                               │
│          ┌────▼───┐    │    ┌─────────┐                │
│          │Network │◄───┘    │  Audio  │                │
│          │  (P2P) │         │  (SDL2) │                │
│          └────────┘         └─────────┘                │
└─────────────────────────────────────────────────────────┘
```

## Core Principles

### 1. Command-Driven State
All game state mutations happen through **Command** objects:
```
Input → Command → Validate → Apply → Broadcast (network)
```
Commands are serializable, enabling:
- Deterministic replay
- Network sync (send commands to peer)
- Undo (future)

### 2. Entity-Component-System (ECS)
Lightweight ECS for game objects:
- **Entity**: uint32 ID
- **Component**: plain data struct (Position, Health, Inventory, etc.)
- **System**: logic that operates on entities with specific components

### 3. Event Bus
Decoupled communication between systems:
```
CombatSystem → publish(UnitDied{id}) → FogOfWar (recalculate)
                                      → TurnManager (check win)
                                      → AudioSystem (play sound)
```

## Module Dependency Graph

```
         ┌──────┐
         │ core │  (types, math, ECS, events, commands)
         └──┬───┘
    ┌───────┼───────┬───────────┐
    ▼       ▼       ▼           ▼
┌──────┐ ┌─────┐ ┌──────┐  ┌───────┐
│ map  │ │unit │ │ turn │  │  net  │
└──┬───┘ └──┬──┘ └──┬───┘  └───┬───┘
   │        │       │           │
   ▼        ▼       ▼           │
┌────────────────────────┐      │
│       combat           │◄─────┘
└────────┬───────────────┘
         │
    ┌────▼─────┐  ┌───────┐  ┌───────┐
    │  render  │  │ input │  │ audio │
    └──────────┘  └───────┘  └───────┘
```

## Systems Detail

### Map System (`src/map/`)
- **Tile**: terrain type, cover values (N/E/S/W), height, destructible flag
- **Map**: 3D grid `[x][y][z]` of tiles, spawn zones
- **Pathfinding**: A* with multi-level support (stairs/ladders), uniform diagonal cost
- **Line of Sight**: Bresenham-based ray casting with height consideration
- **Map Loader**: JSON → Map deserialization
- **Map Generator**: Procedural map creation from parameters

### Unit System (`src/unit/`)
- **Unit**: ECS entity with Position, Health, Stats, Inventory components
- **Stats**: accuracy, movement range, HP, armor, etc.
- **Inventory**: weapon slots, grenade slots, equipment
- **Abilities**: special actions (future extension point)

### Combat System (`src/combat/`)
- **Action**: move, shoot, overwatch, reload, use item, hunker down
- **Two-Action Economy**: each unit gets 2 actions per turn
  - Move = 1 action (can move twice, but shooting after second move is restricted)
  - Shoot = ends turn (uses remaining actions)
  - Overwatch = ends turn
  - Reload = 1 action
  - Hunker Down = ends turn (double cover bonus)
- **Cover**: per-tile-edge cover values, half cover (−20 aim) / full cover (−40 aim)
- **Damage**: hit roll → damage roll → armor reduction → HP loss
- **Overwatch**: units in overwatch fire at enemies that move in their LoS

### Turn System (`src/turn/`)
- **TurnManager**: controls turn flow (Player A → Player B → ...)
- **Fog of War**: per-player visibility map, updated on unit move/death/destruction
- **Win Condition**: elimination check + objective tracking

### Render System (`src/render/`)
- **Renderer**: SDL2 wrapper, virtual 1280×720 framebuffer
- **Camera**: isometric projection, pan/zoom, Z-level visibility
- **IsoRenderer**: depth-sorted tile + entity rendering
- **Sprite**: sprite sheet animation system

### Network System (`src/net/`)
- **P2P Architecture**: one player hosts, other connects
- **Protocol**: command serialization, turn sync, state hash verification
- **Security**: fog of war enforced — host only sends visible enemy positions

### Input System (`src/input/`)
- **InputManager**: SDL events → engine commands
- Maps mouse clicks to tile coordinates (screen → iso → grid)
- Keyboard shortcuts for actions

### Audio System (`src/audio/`)
- **AudioManager**: SDL2_mixer wrapper for SFX and music
- Event-driven: subscribes to combat events, plays appropriate sounds

## Game State Machine

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  SETUP   │───→│  PLAYING │───→│ GAME_OVER│
│(load map,│    │(turns    │    │(show     │
│ spawn    │    │ cycle)   │    │ result)  │
│ units)   │    │          │    │          │
└──────────┘    └──────────┘    └──────────┘
                     │
              ┌──────┴──────┐
              │  Per-Turn:  │
              │ START_TURN  │
              │ UNIT_ACTION │
              │ RESOLVE     │
              │ END_TURN    │
              └─────────────┘
```

## Data Pipeline

```
JSON files (data/)
    │
    ▼
Map/Unit/Weapon Loaders
    │
    ▼
ECS Components (runtime)
    │
    ▼
Systems operate on components
    │
    ▼
Commands mutate state
    │
    ▼
Renderer reads state (read-only)
```

## Threading Model
Single-threaded game loop. Network I/O is non-blocking (polled).
Future: render on main thread, network polling on separate thread.

## Memory Model
- ECS component pools use contiguous arrays (cache-friendly)
- Map tiles in a flat `vector<Tile>` indexed as `[z * W * H + y * W + x]`
- No shared_ptr in hot paths; raw pointers or indices for references
