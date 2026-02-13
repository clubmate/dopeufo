#include "line_of_sight.h"

#include <algorithm>
#include <cmath>

namespace dope::map {

namespace {

// 3D Bresenham line algorithm
std::vector<Vec3i> bresenham_3d(const Vec3i& from, const Vec3i& to) {
    std::vector<Vec3i> points;

    i32 dx = std::abs(to.x - from.x);
    i32 dy = std::abs(to.y - from.y);
    i32 dz = std::abs(to.z - from.z);

    i32 sx = (from.x < to.x) ? 1 : -1;
    i32 sy = (from.y < to.y) ? 1 : -1;
    i32 sz = (from.z < to.z) ? 1 : -1;

    // Determine the driving axis
    i32 max_d = std::max({dx, dy, dz});
    if (max_d == 0) {
        points.push_back(from);
        return points;
    }

    points.reserve(static_cast<size_t>(max_d + 1));

    if (dx >= dy && dx >= dz) {
        // X-dominant
        i32 ey = 2 * dy - dx;
        i32 ez = 2 * dz - dx;
        i32 x = from.x, y = from.y, z = from.z;

        for (i32 i = 0; i <= dx; i++) {
            points.push_back({x, y, z});
            if (ey >= 0) {
                y += sy;
                ey -= 2 * dx;
            }
            if (ez >= 0) {
                z += sz;
                ez -= 2 * dx;
            }
            x += sx;
            ey += 2 * dy;
            ez += 2 * dz;
        }
    } else if (dy >= dx && dy >= dz) {
        // Y-dominant
        i32 ex = 2 * dx - dy;
        i32 ez = 2 * dz - dy;
        i32 x = from.x, y = from.y, z = from.z;

        for (i32 i = 0; i <= dy; i++) {
            points.push_back({x, y, z});
            if (ex >= 0) {
                x += sx;
                ex -= 2 * dy;
            }
            if (ez >= 0) {
                z += sz;
                ez -= 2 * dy;
            }
            y += sy;
            ex += 2 * dx;
            ez += 2 * dz;
        }
    } else {
        // Z-dominant
        i32 ex = 2 * dx - dz;
        i32 ey = 2 * dy - dz;
        i32 x = from.x, y = from.y, z = from.z;

        for (i32 i = 0; i <= dz; i++) {
            points.push_back({x, y, z});
            if (ex >= 0) {
                x += sx;
                ex -= 2 * dz;
            }
            if (ey >= 0) {
                y += sy;
                ey -= 2 * dz;
            }
            z += sz;
            ex += 2 * dx;
            ey += 2 * dy;
        }
    }

    return points;
}

} // anonymous namespace

LosResult check_los(const Map& map, const Vec3i& from, const Vec3i& to) {
    LosResult result;
    result.ray_path = bresenham_3d(from, to);

    // Check each tile along the ray (skip the starting tile)
    for (size_t i = 1; i < result.ray_path.size(); i++) {
        const Vec3i& pos = result.ray_path[i];

        // If out of bounds, LoS is blocked
        if (!map.in_bounds(pos)) {
            result.visible = false;
            result.blocking_tile = pos;
            return result;
        }

        // If this is the target tile, we can see it
        if (pos == to) {
            result.visible = true;
            return result;
        }

        // Check if this tile blocks LoS
        const Tile& tile = map.at(pos);
        if (tile.blocks_los) {
            result.visible = false;
            result.blocking_tile = pos;
            return result;
        }

        // Check if there's a floor above blocking the view
        // (e.g., shooting through a multi-story building)
        if (pos.z < from.z || pos.z < to.z) {
            // Ray is passing through a lower Z-level; check if there's a floor above
            i32 check_z = pos.z + 1;
            if (map.in_bounds(pos.x, pos.y, check_z)) {
                const Tile& above = map.at(pos.x, pos.y, check_z);
                if (above.terrain != TerrainType::Void && above.walkable) {
                    // There's a floor above — LoS might be blocked depending on ray angle
                    // Simplified: only block if ray needs to pass through the floor
                    // (this is a simplified check; a full implementation would trace the ray
                    //  through the floor plane)
                }
            }
        }
    }

    result.visible = true;
    return result;
}

bool has_los(const Map& map, const Vec3i& from, const Vec3i& to) {
    return check_los(map, from, to).visible;
}

std::vector<Vec3i> get_visible_tiles(const Map& map, const Vec3i& from, i32 range) {
    std::vector<Vec3i> visible;

    // Check all tiles within range
    for (i32 z = 0; z < map.depth(); z++) {
        for (i32 y = 0; y < map.height(); y++) {
            for (i32 x = 0; x < map.width(); x++) {
                Vec3i pos = {x, y, z};
                if (pos == from) {
                    visible.push_back(pos);
                    continue;
                }

                // Distance check (Chebyshev on XY + Z difference)
                i32 dist = from.chebyshev_distance_xy(pos) + std::abs(from.z - pos.z);
                if (dist > range) continue;

                // Skip void tiles
                if (map.at(pos).terrain == TerrainType::Void) continue;

                if (has_los(map, from, pos)) {
                    visible.push_back(pos);
                }
            }
        }
    }

    return visible;
}

std::vector<EntityId> get_visible_entities(
    const Map& map,
    const Vec3i& from,
    i32 range,
    const std::vector<std::pair<EntityId, Vec3i>>& entity_positions) {
    std::vector<EntityId> visible;

    for (const auto& [id, pos] : entity_positions) {
        i32 dist = from.chebyshev_distance_xy(pos) + std::abs(from.z - pos.z);
        if (dist > range) continue;

        if (has_los(map, from, pos)) {
            visible.push_back(id);
        }
    }

    return visible;
}

} // namespace dope::map
