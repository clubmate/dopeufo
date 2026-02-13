#include "map.h"

#include <cassert>
#include <cmath>

namespace dope::map {

Map::Map() : Map(0, 0, 1) {}

Map::Map(i32 width, i32 height, i32 depth)
    : m_width(width), m_height(height), m_depth(depth),
      m_tiles(static_cast<size_t>(width * height * depth)) {}

bool Map::in_bounds(i32 x, i32 y, i32 z) const {
    return x >= 0 && x < m_width && y >= 0 && y < m_height && z >= 0 && z < m_depth;
}

bool Map::in_bounds(const Vec3i& pos) const {
    return in_bounds(pos.x, pos.y, pos.z);
}

bool Map::in_bounds_xy(i32 x, i32 y) const {
    return x >= 0 && x < m_width && y >= 0 && y < m_height;
}

Tile& Map::at(i32 x, i32 y, i32 z) {
    assert(in_bounds(x, y, z));
    return m_tiles[static_cast<size_t>(index(x, y, z))];
}

const Tile& Map::at(i32 x, i32 y, i32 z) const {
    assert(in_bounds(x, y, z));
    return m_tiles[static_cast<size_t>(index(x, y, z))];
}

Tile& Map::at(const Vec3i& pos) {
    return at(pos.x, pos.y, pos.z);
}

const Tile& Map::at(const Vec3i& pos) const {
    return at(pos.x, pos.y, pos.z);
}

void Map::set_occupant(const Vec3i& pos, EntityId id) {
    if (in_bounds(pos)) {
        at(pos).occupant = id;
    }
}

void Map::clear_occupant(const Vec3i& pos) {
    if (in_bounds(pos)) {
        at(pos).occupant = INVALID_ENTITY;
    }
}

EntityId Map::get_occupant(const Vec3i& pos) const {
    if (!in_bounds(pos)) return INVALID_ENTITY;
    return at(pos).occupant;
}

bool Map::is_occupied(const Vec3i& pos) const {
    return get_occupant(pos) != INVALID_ENTITY;
}

CoverLevel Map::get_cover_from_direction(const Vec3i& defender_pos, Direction attack_dir) const {
    if (!in_bounds(defender_pos)) return CoverLevel::None;
    return at(defender_pos).cover.get(attack_dir);
}

Direction Map::compute_attack_direction(const Vec3i& attacker, const Vec3i& defender) {
    i32 dx = attacker.x - defender.x;
    i32 dy = attacker.y - defender.y;

    // Determine primary direction of attack
    if (std::abs(dx) >= std::abs(dy)) {
        return (dx > 0) ? Direction::East : Direction::West;
    } else {
        return (dy > 0) ? Direction::South : Direction::North;
    }
}

bool Map::damage_tile(const Vec3i& pos, i32 damage) {
    if (!in_bounds(pos)) return false;

    Tile& tile = at(pos);
    if (!tile.destructible || tile.hp <= 0) return false;

    tile.hp -= damage;
    if (tile.hp <= 0) {
        // Convert to rubble
        tile.terrain = TerrainType::Rubble;
        tile.walkable = true;
        tile.blocks_los = false;
        tile.destructible = false;
        tile.hp = 0;
        tile.cover = TileCover{}; // Remove all cover
        return true; // Tile was destroyed
    }
    return false;
}

i32 Map::index(i32 x, i32 y, i32 z) const {
    return z * m_width * m_height + y * m_width + x;
}

} // namespace dope::map
