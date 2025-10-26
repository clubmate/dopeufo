// DopeUFO - Turn-Based Tactical Game
// Main game engine

// Constants
const TILE_WIDTH = 64;
const TILE_HEIGHT = 32;
const GRID_SIZE = 10;
const AP_COST_MOVE = 4;
const AP_COST_SHOOT = 8;
const MAX_AP = 20;
const BASE_ACCURACY = 65;

// Game state
const GameState = {
    PLAYER_TURN: 'PLAYER_TURN',
    ENEMY_TURN: 'ENEMY_TURN',
    GAME_OVER: 'GAME_OVER'
};

// Action modes
const ActionMode = {
    NONE: 'NONE',
    MOVE: 'MOVE',
    SHOOT: 'SHOOT'
};

// Unit types
const UnitType = {
    SOLDIER: 'SOLDIER',
    ALIEN: 'ALIEN'
};

// Terrain types
const TerrainType = {
    FLOOR: 'FLOOR',
    WALL: 'WALL',
    COVER: 'COVER'
};

class Unit {
    constructor(x, y, type, name) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.name = name;
        this.actionPoints = MAX_AP;
        this.maxHealth = 100;
        this.health = this.maxHealth;
        this.accuracy = BASE_ACCURACY;
        this.isAlive = true;
        this.team = type === UnitType.SOLDIER ? 'player' : 'enemy';
    }
    
    resetActionPoints() {
        this.actionPoints = MAX_AP;
    }
    
    canMove() {
        return this.isAlive && this.actionPoints >= AP_COST_MOVE;
    }
    
    canShoot() {
        return this.isAlive && this.actionPoints >= AP_COST_SHOOT;
    }
    
    move(newX, newY) {
        if (this.canMove()) {
            this.x = newX;
            this.y = newY;
            this.actionPoints -= AP_COST_MOVE;
            return true;
        }
        return false;
    }
    
    shoot(target) {
        if (this.canShoot() && target.isAlive) {
            this.actionPoints -= AP_COST_SHOOT;
            return true;
        }
        return false;
    }
    
    takeDamage(damage) {
        this.health -= damage;
        if (this.health <= 0) {
            this.health = 0;
            this.isAlive = false;
        }
    }
}

class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Game state
        this.state = GameState.PLAYER_TURN;
        this.actionMode = ActionMode.NONE;
        this.selectedUnit = null;
        this.hoveredTile = null;
        this.units = [];
        this.terrain = [];
        
        // Camera offset for centering
        this.cameraX = 0;
        this.cameraY = 0;
        
        // Message log
        this.messages = [];
        
        // Set canvas size and initialize camera position
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Initialize game
        this.initTerrain();
        this.initUnits();
        this.setupEventListeners();
        this.updateUI();
        
        // Start game loop
        this.gameLoop();
    }
    
    resizeCanvas() {
        const container = document.getElementById('canvas-container');
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        // Center camera
        this.cameraX = this.canvas.width / 2 - (GRID_SIZE * TILE_WIDTH) / 4;
        this.cameraY = 100;
    }
    
    initTerrain() {
        // Initialize basic floor with some cover
        for (let y = 0; y < GRID_SIZE; y++) {
            this.terrain[y] = [];
            for (let x = 0; x < GRID_SIZE; x++) {
                // Add some random cover pieces
                if (Math.random() < 0.15 && (x > 1 && x < GRID_SIZE - 2) && (y > 1 && y < GRID_SIZE - 2)) {
                    this.terrain[y][x] = TerrainType.COVER;
                } else {
                    this.terrain[y][x] = TerrainType.FLOOR;
                }
            }
        }
    }
    
    initUnits() {
        // Create 4 player soldiers
        this.units.push(new Unit(1, 1, UnitType.SOLDIER, 'Alpha'));
        this.units.push(new Unit(2, 1, UnitType.SOLDIER, 'Bravo'));
        this.units.push(new Unit(1, 2, UnitType.SOLDIER, 'Charlie'));
        this.units.push(new Unit(2, 2, UnitType.SOLDIER, 'Delta'));
        
        // Create 3 enemy aliens
        this.units.push(new Unit(7, 7, UnitType.ALIEN, 'Sectoid-1'));
        this.units.push(new Unit(8, 7, UnitType.ALIEN, 'Sectoid-2'));
        this.units.push(new Unit(7, 8, UnitType.ALIEN, 'Sectoid-3'));
    }
    
    setupEventListeners() {
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('click', (e) => this.handleClick(e));
        
        document.getElementById('btn-move').addEventListener('click', () => this.setActionMode(ActionMode.MOVE));
        document.getElementById('btn-shoot').addEventListener('click', () => this.setActionMode(ActionMode.SHOOT));
        document.getElementById('btn-end-turn').addEventListener('click', () => this.endTurn());
    }
    
    setActionMode(mode) {
        if (this.state !== GameState.PLAYER_TURN) return;
        
        this.actionMode = mode;
        this.updateUI();
    }
    
    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // Convert screen coordinates to grid coordinates
        this.hoveredTile = this.screenToGrid(mouseX, mouseY);
    }
    
    handleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const gridPos = this.screenToGrid(mouseX, mouseY);
        
        if (!gridPos || this.state !== GameState.PLAYER_TURN) return;
        
        const clickedUnit = this.getUnitAt(gridPos.x, gridPos.y);
        
        // Handle unit selection
        if (clickedUnit && clickedUnit.team === 'player') {
            this.selectedUnit = clickedUnit;
            this.actionMode = ActionMode.NONE;
            this.addMessage(`Selected ${clickedUnit.name}`, 'system');
            this.updateUI();
            return;
        }
        
        // Handle actions
        if (this.selectedUnit && this.selectedUnit.isAlive) {
            if (this.actionMode === ActionMode.MOVE) {
                this.handleMove(gridPos);
            } else if (this.actionMode === ActionMode.SHOOT && clickedUnit) {
                this.handleShoot(clickedUnit);
            }
        }
    }
    
    handleMove(gridPos) {
        if (!this.isTileWalkable(gridPos.x, gridPos.y)) {
            this.addMessage('Cannot move there!', 'system');
            return;
        }
        
        const unit = this.getUnitAt(gridPos.x, gridPos.y);
        if (unit) {
            this.addMessage('Tile occupied!', 'system');
            return;
        }
        
        // Check if adjacent (simple movement for now)
        const dx = Math.abs(this.selectedUnit.x - gridPos.x);
        const dy = Math.abs(this.selectedUnit.y - gridPos.y);
        
        if (dx + dy !== 1) {
            this.addMessage('Can only move to adjacent tiles!', 'system');
            return;
        }
        
        if (this.selectedUnit.move(gridPos.x, gridPos.y)) {
            this.addMessage(`${this.selectedUnit.name} moved to (${gridPos.x}, ${gridPos.y})`, 'movement');
            this.actionMode = ActionMode.NONE;
            this.updateUI();
        } else {
            this.addMessage('Not enough Action Points!', 'system');
        }
    }
    
    handleShoot(target) {
        if (target.team === this.selectedUnit.team) {
            this.addMessage('Cannot shoot allies!', 'system');
            return;
        }
        
        if (!this.selectedUnit.shoot(target)) {
            this.addMessage('Cannot shoot!', 'system');
            return;
        }
        
        // Calculate hit chance
        const distance = this.getDistance(this.selectedUnit, target);
        const coverBonus = this.hasCover(target) ? 20 : 0;
        const hitChance = Math.max(10, this.selectedUnit.accuracy - (distance * 5) - coverBonus);
        
        const roll = Math.random() * 100;
        
        if (roll < hitChance) {
            const damage = 20 + Math.floor(Math.random() * 20);
            target.takeDamage(damage);
            this.addMessage(`${this.selectedUnit.name} hit ${target.name} for ${damage} damage! (${Math.floor(hitChance)}% chance)`, 'combat');
            
            if (!target.isAlive) {
                this.addMessage(`${target.name} eliminated!`, 'combat');
                this.checkGameOver();
            }
        } else {
            this.addMessage(`${this.selectedUnit.name} missed ${target.name}! (${Math.floor(hitChance)}% chance)`, 'combat');
        }
        
        this.actionMode = ActionMode.NONE;
        this.updateUI();
    }
    
    getDistance(unit1, unit2) {
        const dx = unit1.x - unit2.x;
        const dy = unit1.y - unit2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    hasCover(unit) {
        // Check adjacent tiles for cover
        const adjacentTiles = [
            [unit.x - 1, unit.y],
            [unit.x + 1, unit.y],
            [unit.x, unit.y - 1],
            [unit.x, unit.y + 1]
        ];
        
        for (const [x, y] of adjacentTiles) {
            if (this.isValidTile(x, y) && this.terrain[y][x] === TerrainType.COVER) {
                return true;
            }
        }
        return false;
    }
    
    hasLineOfSight(from, to) {
        // Simple line of sight - check if path is not blocked
        // For simplicity, just check distance
        return this.getDistance(from, to) <= 10;
    }
    
    endTurn() {
        if (this.state === GameState.PLAYER_TURN) {
            this.state = GameState.ENEMY_TURN;
            this.selectedUnit = null;
            this.actionMode = ActionMode.NONE;
            this.addMessage('Enemy turn...', 'system');
            this.updateUI();
            
            // Execute enemy turn after a delay
            setTimeout(() => this.executeEnemyTurn(), 1000);
        }
    }
    
    executeEnemyTurn() {
        const enemies = this.units.filter(u => u.team === 'enemy' && u.isAlive);
        const soldiers = this.units.filter(u => u.team === 'player' && u.isAlive);
        
        for (const enemy of enemies) {
            enemy.resetActionPoints();
            
            // Simple AI: shoot at nearest soldier if in range
            let nearestSoldier = null;
            let minDistance = Infinity;
            
            for (const soldier of soldiers) {
                const dist = this.getDistance(enemy, soldier);
                if (dist < minDistance) {
                    minDistance = dist;
                    nearestSoldier = soldier;
                }
            }
            
            if (nearestSoldier && minDistance <= 6 && enemy.canShoot()) {
                // Shoot at soldier
                const hitChance = Math.max(10, enemy.accuracy - (minDistance * 5));
                const roll = Math.random() * 100;
                
                if (roll < hitChance) {
                    const damage = 15 + Math.floor(Math.random() * 15);
                    nearestSoldier.takeDamage(damage);
                    this.addMessage(`${enemy.name} hit ${nearestSoldier.name} for ${damage} damage!`, 'combat');
                    
                    if (!nearestSoldier.isAlive) {
                        this.addMessage(`${nearestSoldier.name} killed!`, 'combat');
                        this.checkGameOver();
                    }
                } else {
                    this.addMessage(`${enemy.name} missed ${nearestSoldier.name}!`, 'combat');
                }
            } else if (nearestSoldier && minDistance > 2) {
                // Try to move closer
                const dx = nearestSoldier.x - enemy.x;
                const dy = nearestSoldier.y - enemy.y;
                
                let newX = enemy.x;
                let newY = enemy.y;
                
                if (Math.abs(dx) > Math.abs(dy)) {
                    newX = enemy.x + (dx > 0 ? 1 : -1);
                } else {
                    newY = enemy.y + (dy > 0 ? 1 : -1);
                }
                
                if (this.isTileWalkable(newX, newY) && !this.getUnitAt(newX, newY)) {
                    enemy.move(newX, newY);
                    this.addMessage(`${enemy.name} moved`, 'movement');
                }
            }
        }
        
        // Start player turn
        setTimeout(() => {
            this.state = GameState.PLAYER_TURN;
            this.addMessage('Your turn!', 'system');
            
            // Reset player unit action points
            for (const unit of this.units) {
                if (unit.team === 'player' && unit.isAlive) {
                    unit.resetActionPoints();
                }
            }
            
            this.updateUI();
        }, 500);
    }
    
    checkGameOver() {
        const aliveSoldiers = this.units.filter(u => u.team === 'player' && u.isAlive).length;
        const aliveEnemies = this.units.filter(u => u.team === 'enemy' && u.isAlive).length;
        
        if (aliveSoldiers === 0) {
            this.state = GameState.GAME_OVER;
            this.addMessage('MISSION FAILED - All soldiers eliminated!', 'combat');
            this.updateUI();
        } else if (aliveEnemies === 0) {
            this.state = GameState.GAME_OVER;
            this.addMessage('MISSION SUCCESS - All enemies eliminated!', 'combat');
            this.updateUI();
        }
    }
    
    getUnitAt(x, y) {
        return this.units.find(u => u.x === x && u.y === y && u.isAlive);
    }
    
    isTileWalkable(x, y) {
        if (!this.isValidTile(x, y)) return false;
        return this.terrain[y][x] !== TerrainType.WALL;
    }
    
    isValidTile(x, y) {
        return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
    }
    
    screenToGrid(screenX, screenY) {
        // Convert screen coordinates to isometric grid coordinates
        const x = screenX - this.cameraX;
        const y = screenY - this.cameraY;
        
        // Isometric coordinate conversion
        const gridX = Math.round((x / TILE_WIDTH + y / TILE_HEIGHT) / 2);
        const gridY = Math.round((y / TILE_HEIGHT - x / TILE_WIDTH) / 2);
        
        if (this.isValidTile(gridX, gridY)) {
            return { x: gridX, y: gridY };
        }
        return null;
    }
    
    gridToScreen(gridX, gridY) {
        // Convert grid coordinates to screen coordinates (isometric)
        // Returns the center of the tile for better click detection
        const x = (gridX - gridY) * (TILE_WIDTH / 2);
        const y = (gridX + gridY) * (TILE_HEIGHT / 2) + TILE_HEIGHT / 2; // Add half tile height to center
        
        return {
            x: x + this.cameraX,
            y: y + this.cameraY
        };
    }
    
    addMessage(text, type = 'system') {
        this.messages.push({ text, type, time: Date.now() });
        if (this.messages.length > 50) {
            this.messages.shift();
        }
        
        // Update message log
        const logEl = document.getElementById('message-log');
        const msgEl = document.createElement('div');
        msgEl.className = `message ${type}`;
        msgEl.textContent = text;
        logEl.appendChild(msgEl);
        logEl.scrollTop = logEl.scrollHeight;
        
        // Keep only last 20 messages in DOM
        while (logEl.children.length > 20) {
            logEl.removeChild(logEl.firstChild);
        }
    }
    
    updateUI() {
        // Update turn indicator
        const turnEl = document.getElementById('turn-indicator');
        if (this.state === GameState.PLAYER_TURN) {
            turnEl.textContent = 'PLAYER TURN';
            turnEl.style.background = '#533483';
        } else if (this.state === GameState.ENEMY_TURN) {
            turnEl.textContent = 'ENEMY TURN';
            turnEl.style.background = '#c23616';
        } else {
            turnEl.textContent = 'GAME OVER';
            turnEl.style.background = '#2c3e50';
        }
        
        // Update selected unit info
        if (this.selectedUnit && this.selectedUnit.isAlive) {
            document.getElementById('unit-name').textContent = this.selectedUnit.name;
            document.getElementById('unit-ap').textContent = `${this.selectedUnit.actionPoints}/${MAX_AP}`;
            document.getElementById('unit-health').textContent = `${this.selectedUnit.health}/${this.selectedUnit.maxHealth}`;
            document.getElementById('unit-accuracy').textContent = `${this.selectedUnit.accuracy}%`;
        } else {
            document.getElementById('unit-name').textContent = 'None';
            document.getElementById('unit-ap').textContent = '-';
            document.getElementById('unit-health').textContent = '-';
            document.getElementById('unit-accuracy').textContent = '-';
        }
        
        // Update action buttons
        const moveBtn = document.getElementById('btn-move');
        const shootBtn = document.getElementById('btn-shoot');
        const endTurnBtn = document.getElementById('btn-end-turn');
        
        const canAct = this.state === GameState.PLAYER_TURN && this.selectedUnit && this.selectedUnit.isAlive;
        
        moveBtn.disabled = !canAct || !this.selectedUnit?.canMove();
        shootBtn.disabled = !canAct || !this.selectedUnit?.canShoot();
        endTurnBtn.disabled = this.state !== GameState.PLAYER_TURN;
        
        moveBtn.classList.toggle('active', this.actionMode === ActionMode.MOVE);
        shootBtn.classList.toggle('active', this.actionMode === ActionMode.SHOOT);
    }
    
    // Rendering
    gameLoop() {
        this.render();
        requestAnimationFrame(() => this.gameLoop());
    }
    
    render() {
        // Clear canvas
        this.ctx.fillStyle = '#0f0f1e';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Render in isometric order (back to front)
        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                this.renderTile(x, y);
                
                // Render unit on this tile
                const unit = this.getUnitAt(x, y);
                if (unit) {
                    this.renderUnit(unit);
                }
            }
        }
        
        // Render hover highlight
        if (this.hoveredTile && this.isValidTile(this.hoveredTile.x, this.hoveredTile.y)) {
            this.renderTileHighlight(this.hoveredTile.x, this.hoveredTile.y, 'rgba(255, 255, 255, 0.3)');
        }
        
        // Render selection highlight
        if (this.selectedUnit && this.selectedUnit.isAlive) {
            this.renderTileHighlight(this.selectedUnit.x, this.selectedUnit.y, 'rgba(0, 212, 255, 0.5)');
        }
    }
    
    renderTile(gridX, gridY) {
        const pos = this.gridToScreen(gridX, gridY);
        const terrain = this.terrain[gridY][gridX];
        
        // Draw tile base
        this.ctx.save();
        this.ctx.translate(pos.x, pos.y);
        
        // Draw isometric tile
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(TILE_WIDTH / 2, TILE_HEIGHT / 2);
        this.ctx.lineTo(0, TILE_HEIGHT);
        this.ctx.lineTo(-TILE_WIDTH / 2, TILE_HEIGHT / 2);
        this.ctx.closePath();
        
        // Set color based on terrain
        if (terrain === TerrainType.COVER) {
            this.ctx.fillStyle = '#7f8c8d';
        } else if (terrain === TerrainType.WALL) {
            this.ctx.fillStyle = '#34495e';
        } else {
            // Checkerboard pattern
            this.ctx.fillStyle = (gridX + gridY) % 2 === 0 ? '#2c3e50' : '#273240';
        }
        
        this.ctx.fill();
        this.ctx.strokeStyle = '#1a252f';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
        
        // Draw cover indicator
        if (terrain === TerrainType.COVER) {
            this.ctx.fillStyle = '#95a5a6';
            this.ctx.fillRect(-TILE_WIDTH / 4, -10, TILE_WIDTH / 2, 20);
            this.ctx.strokeStyle = '#34495e';
            this.ctx.strokeRect(-TILE_WIDTH / 4, -10, TILE_WIDTH / 2, 20);
        }
        
        this.ctx.restore();
    }
    
    renderTileHighlight(gridX, gridY, color) {
        const pos = this.gridToScreen(gridX, gridY);
        
        this.ctx.save();
        this.ctx.translate(pos.x, pos.y);
        
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(TILE_WIDTH / 2, TILE_HEIGHT / 2);
        this.ctx.lineTo(0, TILE_HEIGHT);
        this.ctx.lineTo(-TILE_WIDTH / 2, TILE_HEIGHT / 2);
        this.ctx.closePath();
        
        this.ctx.fillStyle = color;
        this.ctx.fill();
        
        this.ctx.restore();
    }
    
    renderUnit(unit) {
        const pos = this.gridToScreen(unit.x, unit.y);
        
        this.ctx.save();
        this.ctx.translate(pos.x, pos.y - 20);
        
        // Draw unit as a simple shape
        if (unit.type === UnitType.SOLDIER) {
            // Draw soldier (blue)
            this.ctx.fillStyle = '#3498db';
            this.ctx.strokeStyle = '#2980b9';
        } else {
            // Draw alien (red)
            this.ctx.fillStyle = '#e74c3c';
            this.ctx.strokeStyle = '#c0392b';
        }
        
        this.ctx.lineWidth = 2;
        
        // Body
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 12, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        
        // Head
        this.ctx.beginPath();
        this.ctx.arc(0, -15, 8, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        
        // Health bar
        const healthPercent = unit.health / unit.maxHealth;
        const barWidth = 24;
        const barHeight = 4;
        
        this.ctx.fillStyle = '#2c3e50';
        this.ctx.fillRect(-barWidth / 2, 20, barWidth, barHeight);
        
        this.ctx.fillStyle = healthPercent > 0.5 ? '#2ecc71' : healthPercent > 0.25 ? '#f39c12' : '#e74c3c';
        this.ctx.fillRect(-barWidth / 2, 20, barWidth * healthPercent, barHeight);
        
        // Name label
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(unit.name, 0, 32);
        
        // AP indicator (for player units)
        if (unit.team === 'player') {
            this.ctx.fillStyle = unit.actionPoints > 0 ? '#00d4ff' : '#666';
            this.ctx.font = 'bold 8px monospace';
            this.ctx.fillText(`AP:${unit.actionPoints}`, 0, -28);
        }
        
        this.ctx.restore();
    }
}

// Initialize game when page loads
window.addEventListener('load', () => {
    window.game = new Game();
});
