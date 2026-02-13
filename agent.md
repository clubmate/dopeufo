# agent.md — Instructions for AI Coding Agents

## Purpose
This file provides context and rules for any AI agent contributing to the
**dopeufo** project (an isometric turn-based PvP tactical combat engine).

## Before Writing Code
1. Read `CLAUDE.md` for project context and design decisions.
2. Read `ARCHITECTURE.md` for system-level understanding.
3. Check existing code for naming conventions and patterns before creating new files.
4. Run `cmake --build build` after changes to verify compilation.
5. Run `ctest --test-dir build` to verify no tests regress.

## Rules
- **Never break the build.** Every commit must compile cleanly with `-Wall -Wextra -Wpedantic`.
- **Never break existing tests.** If a change requires test updates, update them.
- **Determinism is sacred.** Game state must be reproducible from a command log. Do not introduce non-deterministic behavior (random without seeded RNG, unordered containers in gameplay code, etc.).
- **Fog of war is security.** Never expose opponent data to the wrong player. Treat this like a security boundary.
- **Commands are the API.** All game state mutations go through the Command system. Never mutate state directly from input handlers or network code.
- **No global mutable state.** Pass dependencies explicitly or through the Engine/ECS.
- **Prefer composition over inheritance.** The ECS is the primary object model.
- **Write tests for non-trivial logic** — especially pathfinding, LoS, cover, damage.

## File Organization
```
src/<module>/<name>.h      — Header
src/<module>/<name>.cpp    — Implementation
tests/test_<module>.cpp    — Tests
data/<category>/<file>.json — Data files
```

## Branch & Commit Style
- Branch: `feature/<name>`, `fix/<name>`, `refactor/<name>`
- Commits: imperative mood, 72 char subject line, e.g. `Add A* pathfinding with multi-level support`

## Common Tasks

### Add a new component
1. Define the struct in the relevant module header (e.g., `src/unit/stats.h`)
2. Register it in the ECS if needed
3. Create/update systems that operate on the component
4. Add tests

### Add a new command
1. Define the command struct in `src/core/command.h`
2. Add serialization support in `src/net/protocol.h`
3. Add handler in the appropriate system
4. Add tests

### Add a new map feature
1. Update `Tile` or `Map` in `src/map/`
2. Update pathfinding if movement cost changes
3. Update LoS if visibility rules change
4. Update map loader/generator
5. Add tests

## Performance Guidelines
- Pathfinding and LoS are hot paths — profile before optimizing but keep algorithmic complexity in mind.
- Avoid heap allocations in per-frame/per-tick loops.
- Use `reserve()` on vectors when size is known.
- The render loop should not touch game logic; read-only access to state.
