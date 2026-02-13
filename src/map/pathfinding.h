#pragma once
// pathfinding.h — A* pathfinding across a multi-level isometric grid.
//
// Features:
//   - 8-directional movement on each Z-level
//   - Uniform cost for cardinal and diagonal movement
//   - Multi-level via stairs/ladders
//   - Respects walkability and occupancy
//   - Returns path as vector of Vec3i

#include "../core/math.h"
#include "../core/types.h"
#include "map.h"

#include <optional>
#include <vector>

namespace dope::map {

struct PathResult {
    std::vector<Vec3i> path;       // Ordered waypoints from start to goal (inclusive)
    i32 cost = 0;                  // Total movement cost
    bool found = false;            // Whether a path was found

    bool empty() const { return path.empty(); }
    i32 length() const { return static_cast<i32>(path.size()); }
};

// Find shortest path from start to goal on the map.
// max_cost limits search to tiles within movement range.
// ignore_entity: entity whose occupied tile should be treated as passable (self).
PathResult find_path(
    const Map& map,
    const Vec3i& start,
    const Vec3i& goal,
    i32 max_cost = 999,
    EntityId ignore_entity = INVALID_ENTITY
);

// Get all reachable tiles within a given movement range from start.
// Returns a map of position → cost.
std::vector<std::pair<Vec3i, i32>> get_reachable_tiles(
    const Map& map,
    const Vec3i& start,
    i32 max_cost,
    EntityId ignore_entity = INVALID_ENTITY
);

} // namespace dope::map
