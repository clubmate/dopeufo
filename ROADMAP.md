# Roadmap — dopeufo Engine

## Phase 1: Foundation (current)
- [x] Project structure (CMake, docs, agent files)
- [x] Core types, math utilities
- [x] ECS (Entity-Component-System)
- [x] Event bus
- [x] Command pattern infrastructure
- [x] Game state machine
- [x] Tile / Map data structures
- [x] A* pathfinding (multi-level)
- [x] Line-of-sight calculation
- [x] Unit system (stats, components)
- [x] Combat: two-action economy, cover, damage
- [x] Overwatch / reaction fire
- [x] Turn manager (IGOUGO)
- [x] Fog of war
- [x] SDL2 renderer + isometric camera
- [x] Input manager (mouse → tile, keyboard)
- [x] Map loader (JSON)
- [x] Main game loop
- [x] Unit tests for core systems

## Phase 2: Playable Local Match
- [ ] Placeholder sprite rendering (colored shapes per unit)
- [ ] Full two-player hot-seat mode
- [ ] HUD: selected unit info, action buttons, turn indicator
- [ ] Visual: movement range overlay, LoS cones, cover indicators
- [ ] Shooting animation + hit/miss feedback
- [ ] Death/removal of units
- [ ] Win condition check + game over screen
- [ ] Map: destructible terrain in action
- [ ] Sound effects (placeholder)

## Phase 3: Networking
- [ ] P2P connection (host/join via IP)
- [ ] Command serialization over network
- [ ] Turn synchronization protocol
- [ ] State hash verification (desync detection)
- [ ] Fog of war network security (don't leak enemy data)
- [ ] Latency handling + timeout

## Phase 4: Content & Polish
- [ ] Map editor (external tool or in-engine)
- [ ] Procedural map generator
- [ ] Multiple unit classes (rifleman, sniper, heavy, medic)
- [ ] Full weapon/item system
- [ ] Objective-based win conditions (VIP, control point, extraction)
- [ ] Squad loadout / customization screen
- [ ] Proper pixel art sprites + animations
- [ ] Music + sound design

## Phase 5: Competitive Features
- [ ] Match replay system (command log playback)
- [ ] Lobby / matchmaking (requires server component)
- [ ] ELO / ranking system
- [ ] Anti-cheat hardening
- [ ] Spectator mode
