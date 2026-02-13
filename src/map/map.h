#pragma once
// map.h — Map grid storing tiles across multiple Z-levels.

#include "../core/math.h"
#include "../core/types.h"
#include "tile.h"

#include <string>
#include <vector>

namespace dope::map {

// Spawn zone for a player
struct SpawnZone {
    PlayerId player = PlayerId::None;
    std::vector<Vec3i> tiles;
};

class Map {
public:
    Map();
    Map(i32 width, i32 height, i32 depth);

    // --- Dimensions ---
    i32 width() const { return m_width; }
    i32 height() const { return m_height; }
    i32 depth() const { return m_depth; }

    // --- Tile access ---
    bool in_bounds(i32 x, i32 y, i32 z) const;
    bool in_bounds(const Vec3i& pos) const;
    bool in_bounds_xy(i32 x, i32 y) const;

    Tile& at(i32 x, i32 y, i32 z);
    const Tile& at(i32 x, i32 y, i32 z) const;
    Tile& at(const Vec3i& pos);
    const Tile& at(const Vec3i& pos) const;

    // --- Occupancy ---
    void set_occupant(const Vec3i& pos, EntityId id);
    void clear_occupant(const Vec3i& pos);
    EntityId get_occupant(const Vec3i& pos) const;
    bool is_occupied(const Vec3i& pos) const;

    // --- Cover queries ---
    // Get the cover a unit at `defender_pos` has against fire from `attacker_direction`
    CoverLevel get_cover_from_direction(const Vec3i& defender_pos, Direction attack_dir) const;

    // Compute the direction from attacker to defender
    static Direction compute_attack_direction(const Vec3i& attacker, const Vec3i& defender);

    // --- Destruction ---
    // Damage a tile, potentially destroying it (converting to rubble)
    bool damage_tile(const Vec3i& pos, i32 damage);

    // --- Map info ---
    std::string name;
    std::vector<SpawnZone> spawn_zones;

    // --- Raw data access (for serialization) ---
    const std::vector<Tile>& raw_tiles() const { return m_tiles; }

private:
    i32 index(i32 x, i32 y, i32 z) const;

    i32 m_width = 0;
    i32 m_height = 0;
    i32 m_depth = 1;
    std::vector<Tile> m_tiles;
};

} // namespace dope::map
