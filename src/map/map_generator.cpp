#include "map_generator.h"

#include <algorithm>

namespace dope::map {

namespace {

// Place a rectangular room with walls
void place_room(Map& map, i32 rx, i32 ry, i32 rw, i32 rh, i32 z) {
    for (i32 y = ry; y < ry + rh; y++) {
        for (i32 x = rx; x < rx + rw; x++) {
            if (!map.in_bounds(x, y, z)) continue;

            bool is_edge = (x == rx || x == rx + rw - 1 || y == ry || y == ry + rh - 1);
            if (is_edge) {
                map.at(x, y, z) = Tile::make_wall();
            } else {
                map.at(x, y, z) = Tile::make_floor(TerrainType::Open);
            }
        }
    }

    // Add a door on each side (center of each wall)
    auto place_door = [&](i32 x, i32 y) {
        if (!map.in_bounds(x, y, z)) return;
        Tile& t = map.at(x, y, z);
        t.terrain = TerrainType::Door;
        t.walkable = true;
        t.blocks_los = false;
        t.destructible = true;
        t.hp = 60;
    };

    i32 mx = rx + rw / 2;
    i32 my = ry + rh / 2;
    place_door(mx, ry);           // North door
    place_door(mx, ry + rh - 1);  // South door
    place_door(rx, my);            // West door
    place_door(rx + rw - 1, my);  // East door
}

// Scatter half/full cover objects on open tiles
void scatter_cover(Map& map, Rng& rng, i32 z, f32 density) {
    for (i32 y = 0; y < map.height(); y++) {
        for (i32 x = 0; x < map.width(); x++) {
            if (!map.in_bounds(x, y, z)) continue;
            Tile& tile = map.at(x, y, z);

            if (tile.terrain != TerrainType::Open && tile.terrain != TerrainType::Grass) continue;

            if (rng.unit_float() < density) {
                // Random cover direction and level
                Direction dir = static_cast<Direction>(rng.next(4));
                CoverLevel level = rng.chance(0.5f) ? CoverLevel::Half : CoverLevel::Full;
                tile.cover.set(dir, level);
                tile.destructible = true;
                tile.hp = (level == CoverLevel::Full) ? 80 : 50;
            }
        }
    }
}

} // anonymous namespace

Map generate_map(const MapGenParams& params) {
    Rng rng(params.seed ? params.seed : 42u);
    Map map(params.width, params.height, params.depth);
    map.name = params.name;

    // Fill ground level with open terrain
    for (i32 y = 0; y < params.height; y++) {
        for (i32 x = 0; x < params.width; x++) {
            map.at(x, y, 0) = Tile::make_floor(TerrainType::Grass);
        }
    }

    // Higher levels default to void
    for (i32 z = 1; z < params.depth; z++) {
        for (i32 y = 0; y < params.height; y++) {
            for (i32 x = 0; x < params.width; x++) {
                map.at(x, y, z) = Tile::make_void();
            }
        }
    }

    // Place buildings based on density
    i32 num_buildings = static_cast<i32>(
        static_cast<f32>(params.width * params.height) * params.building_density / 25.0f);
    num_buildings = std::max(1, num_buildings);

    for (i32 i = 0; i < num_buildings; i++) {
        i32 rw = rng.range(4, 7);
        i32 rh = rng.range(4, 7);
        i32 rx = rng.range(2, params.width - rw - 2);
        i32 ry = rng.range(2, params.height - rh - 2);

        place_room(map, rx, ry, rw, rh, 0);

        // For multi-level maps, add second story to some buildings
        if (params.depth > 1 && rng.chance(0.4f)) {
            // Add floor on Z=1
            for (i32 y = ry; y < ry + rh; y++) {
                for (i32 x = rx; x < rx + rw; x++) {
                    if (!map.in_bounds(x, y, 1)) continue;
                    bool is_edge = (x == rx || x == rx + rw - 1 || y == ry || y == ry + rh - 1);
                    if (is_edge) {
                        map.at(x, y, 1) = Tile::make_wall();
                    } else {
                        map.at(x, y, 1) = Tile::make_floor(TerrainType::Open);
                    }
                }
            }

            // Add stairs connecting levels
            i32 stair_x = rx + 1;
            i32 stair_y = ry + 1;
            if (map.in_bounds(stair_x, stair_y, 0)) {
                map.at(stair_x, stair_y, 0) = Tile::make_stairs(true, false);
            }
            if (map.in_bounds(stair_x, stair_y, 1)) {
                map.at(stair_x, stair_y, 1) = Tile::make_stairs(false, true);
            }
        }
    }

    // Scatter cover objects
    for (i32 z = 0; z < params.depth; z++) {
        scatter_cover(map, rng, z, params.cover_density);
    }

    // Set up spawn zones on opposite sides
    SpawnZone zone1;
    zone1.player = PlayerId::Player1;
    for (i32 y = 0; y < params.height; y++) {
        for (i32 x = 0; x < 3; x++) {
            if (map.in_bounds(x, y, 0) && map.at(x, y, 0).is_passable()) {
                zone1.tiles.push_back({x, y, 0});
            }
        }
    }

    SpawnZone zone2;
    zone2.player = PlayerId::Player2;
    for (i32 y = 0; y < params.height; y++) {
        for (i32 x = params.width - 3; x < params.width; x++) {
            if (map.in_bounds(x, y, 0) && map.at(x, y, 0).is_passable()) {
                zone2.tiles.push_back({x, y, 0});
            }
        }
    }

    map.spawn_zones.push_back(std::move(zone1));
    map.spawn_zones.push_back(std::move(zone2));

    return map;
}

Map generate_test_map() {
    MapGenParams params;
    params.width = 16;
    params.height = 16;
    params.depth = 2;
    params.seed = 12345;
    params.building_density = 0.2f;
    params.cover_density = 0.1f;
    params.name = "test_arena";
    return generate_map(params);
}

} // namespace dope::map
