# DopeUFO - Turn-Based Tactical Game

A browser-based JavaScript prototype of a turn-based tactical clone of UFO: Enemy Unknown (X-COM). Built from scratch with JavaScript and HTML5 Canvas featuring isometric rendering.

## Features

- **Isometric battlefield rendering** - Custom-built isometric tile system
- **Turn-based combat** - Classic X-COM style turn system
- **Action Points system** - Each soldier has 20 AP per turn
- **4 Player Soldiers** - Control Alpha, Bravo, Charlie, and Delta
- **Enemy AI** - 3 Sectoid aliens with basic tactical AI
- **Cover mechanics** - Gray cover blocks reduce enemy accuracy by 20%
- **Line of sight** - Distance-based accuracy calculations
- **Hit chance mechanics** - Accuracy decreases 5% per tile distance

## How to Play

1. Open `index.html` in a modern web browser
2. Click on a blue soldier to select them
3. Click "Move Mode" and then click an adjacent tile to move (costs 4 AP)
4. Click "Shoot Mode" and then click an enemy to attack (costs 8 AP)
5. Click "End Turn" when done to let enemies move
6. Eliminate all enemies to win!

## Game Mechanics

### Action Points
- Each unit starts with 20 AP per turn
- Movement costs 4 AP per tile
- Shooting costs 8 AP per shot

### Combat
- Base accuracy: 65%
- Accuracy penalty: 5% per tile distance
- Cover bonus: -20% to hit for targets near cover
- Damage: 20-40 per hit

### Terrain
- **Floor tiles** (checkerboard) - Normal movement
- **Cover blocks** (gray) - Provide defensive bonus to adjacent units

## Technical Details

Built entirely from scratch without game engines:
- Custom isometric rendering system
- HTML5 Canvas for graphics
- Vanilla JavaScript for game logic
- No external dependencies

## File Structure

- `index.html` - Main game page with UI
- `game.js` - Complete game engine (units, terrain, combat, AI, rendering)
- `demo.html` - Demo page with instructions

## Development

Simply open the files in a web browser. No build process required.

For local testing with a server:
```bash
python3 -m http.server 8000
# Then visit http://localhost:8000
```
