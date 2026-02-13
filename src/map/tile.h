#pragma once
// tile.h — Tile definition for the map grid.

#include "../core/types.h"

namespace dope::map {

// Cover values per tile edge (N, E, S, W).
// A unit standing in a tile receives cover from the edge facing the attacker.
struct TileCover {
    CoverLevel north = CoverLevel::None;
    CoverLevel east  = CoverLevel::None;
    CoverLevel south = CoverLevel::None;
    CoverLevel west  = CoverLevel::None;

    CoverLevel get(Direction dir) const {
        switch (dir) {
            case Direction::North: return north;
            case Direction::East:  return east;
            case Direction::South: return south;
            case Direction::West:  return west;
        }
        return CoverLevel::None;
    }

    void set(Direction dir, CoverLevel level) {
        switch (dir) {
            case Direction::North: north = level; break;
            case Direction::East:  east = level; break;
            case Direction::South: south = level; break;
            case Direction::West:  west = level; break;
        }
    }
};

struct Tile {
    TerrainType terrain = TerrainType::Void;
    TileCover cover;

    i32 height = 0;          // Height within Z-level (for visual elevation, 0-3)
    bool walkable = false;
    bool blocks_los = false; // Blocks line of sight
    bool destructible = false;
    i32 hp = 0;              // Destructible tile HP (0 = indestructible or already destroyed)

    // Connection to other Z-levels
    bool has_stairs_up = false;
    bool has_stairs_down = false;

    // Occupant tracking
    EntityId occupant = INVALID_ENTITY;

    // --- Helper methods ---
    bool is_passable() const { return walkable && terrain != TerrainType::Void; }

    static Tile make_floor(TerrainType type = TerrainType::Open) {
        Tile t;
        t.terrain = type;
        t.walkable = true;
        t.blocks_los = false;
        return t;
    }

    static Tile make_wall() {
        Tile t;
        t.terrain = TerrainType::Wall;
        t.walkable = false;
        t.blocks_los = true;
        t.destructible = true;
        t.hp = 100;
        return t;
    }

    static Tile make_half_cover(Direction facing) {
        Tile t = make_floor();
        t.cover.set(facing, CoverLevel::Half);
        t.destructible = true;
        t.hp = 50;
        return t;
    }

    static Tile make_full_cover(Direction facing) {
        Tile t = make_floor();
        t.cover.set(facing, CoverLevel::Full);
        t.destructible = true;
        t.hp = 80;
        return t;
    }

    static Tile make_stairs(bool up, bool down) {
        Tile t = make_floor(TerrainType::Stairs);
        t.has_stairs_up = up;
        t.has_stairs_down = down;
        return t;
    }

    static Tile make_void() {
        Tile t;
        t.terrain = TerrainType::Void;
        t.walkable = false;
        t.blocks_los = false;
        return t;
    }
};

} // namespace dope::map
