#pragma once
// line_of_sight.h — Line-of-sight and line-of-fire calculations.
//
// Uses 3D Bresenham ray casting with height consideration.
// LoS is blocked by:
//   - Wall tiles (blocks_los = true)
//   - Terrain height differences
//   - Floor tiles at Z-levels that obstruct the ray

#include "../core/math.h"
#include "../core/types.h"
#include "map.h"

#include <vector>

namespace dope::map {

// Result of a LoS check
struct LosResult {
    bool visible = false;
    std::vector<Vec3i> ray_path; // All tiles the ray passes through
    Vec3i blocking_tile;         // First tile that blocks LoS (if !visible)
};

// Check line of sight between two 3D positions
LosResult check_los(const Map& map, const Vec3i& from, const Vec3i& to);

// Check if `from` can see `to` (simple boolean)
bool has_los(const Map& map, const Vec3i& from, const Vec3i& to);

// Get all tiles visible from a position within a given range
std::vector<Vec3i> get_visible_tiles(const Map& map, const Vec3i& from, i32 range);

// Get all entities visible from a position (checks LoS to each)
std::vector<EntityId> get_visible_entities(
    const Map& map,
    const Vec3i& from,
    i32 range,
    const std::vector<std::pair<EntityId, Vec3i>>& entity_positions
);

} // namespace dope::map
