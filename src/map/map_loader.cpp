#include "map_loader.h"

#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace dope::map {

namespace {

TerrainType terrain_from_string(const std::string& s) {
    if (s == "open")    return TerrainType::Open;
    if (s == "grass")   return TerrainType::Grass;
    if (s == "dirt")    return TerrainType::Dirt;
    if (s == "road")    return TerrainType::Road;
    if (s == "wall")    return TerrainType::Wall;
    if (s == "window")  return TerrainType::Window;
    if (s == "door")    return TerrainType::Door;
    if (s == "water")   return TerrainType::Water;
    if (s == "stairs")  return TerrainType::Stairs;
    if (s == "ladder")  return TerrainType::Ladder;
    if (s == "rubble")  return TerrainType::Rubble;
    return TerrainType::Void;
}

CoverLevel cover_from_string(const std::string& s) {
    if (s == "half") return CoverLevel::Half;
    if (s == "full") return CoverLevel::Full;
    return CoverLevel::None;
}

PlayerId player_from_int(int p) {
    if (p == 0) return PlayerId::Player1;
    if (p == 1) return PlayerId::Player2;
    return PlayerId::None;
}

} // anonymous namespace

Map load_map_from_json(const std::string& json_string) {
    try {
        json j = json::parse(json_string);

        i32 width  = j.value("width", 0);
        i32 height = j.value("height", 0);
        i32 depth  = j.value("depth", 1);

        if (width <= 0 || height <= 0 || depth <= 0) {
            std::cerr << "[MapLoader] Invalid map dimensions\n";
            return Map();
        }

        Map map(width, height, depth);
        map.name = j.value("name", "unnamed");

        // Parse layers (one per Z-level)
        if (j.contains("layers") && j["layers"].is_array()) {
            const auto& layers = j["layers"];
            for (i32 z = 0; z < depth && z < static_cast<i32>(layers.size()); z++) {
                const auto& layer = layers[static_cast<size_t>(z)];

                if (layer.contains("tiles") && layer["tiles"].is_array()) {
                    const auto& rows = layer["tiles"];
                    for (i32 y = 0; y < height && y < static_cast<i32>(rows.size()); y++) {
                        const auto& row = rows[static_cast<size_t>(y)];
                        for (i32 x = 0; x < width && x < static_cast<i32>(row.size()); x++) {
                            const auto& td = row[static_cast<size_t>(x)];
                            Tile& tile = map.at(x, y, z);

                            if (td.is_string()) {
                                // Simple format: just terrain type
                                std::string terrain_str = td.get<std::string>();
                                tile.terrain = terrain_from_string(terrain_str);
                                tile.walkable = (tile.terrain != TerrainType::Wall &&
                                                 tile.terrain != TerrainType::Water &&
                                                 tile.terrain != TerrainType::Void);
                                tile.blocks_los = (tile.terrain == TerrainType::Wall);
                            } else if (td.is_object()) {
                                // Detailed format
                                tile.terrain =
                                    terrain_from_string(td.value("terrain", "void"));
                                tile.walkable = td.value("walkable", false);
                                tile.blocks_los = td.value("blocks_los", false);
                                tile.destructible = td.value("destructible", false);
                                tile.hp = td.value("hp", 0);
                                tile.has_stairs_up = td.value("stairs_up", false);
                                tile.has_stairs_down = td.value("stairs_down", false);

                                if (td.contains("cover")) {
                                    const auto& cov = td["cover"];
                                    tile.cover.north =
                                        cover_from_string(cov.value("north", "none"));
                                    tile.cover.east =
                                        cover_from_string(cov.value("east", "none"));
                                    tile.cover.south =
                                        cover_from_string(cov.value("south", "none"));
                                    tile.cover.west =
                                        cover_from_string(cov.value("west", "none"));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Parse spawn zones
        if (j.contains("spawn_zones") && j["spawn_zones"].is_array()) {
            for (const auto& sz : j["spawn_zones"]) {
                SpawnZone zone;
                zone.player = player_from_int(sz.value("player", -1));

                if (sz.contains("tiles") && sz["tiles"].is_array()) {
                    for (const auto& t : sz["tiles"]) {
                        i32 x = t.value("x", 0);
                        i32 y = t.value("y", 0);
                        i32 z = t.value("z", 0);
                        zone.tiles.push_back({x, y, z});
                    }
                }

                map.spawn_zones.push_back(std::move(zone));
            }
        }

        return map;

    } catch (const json::exception& e) {
        std::cerr << "[MapLoader] JSON parse error: " << e.what() << "\n";
        return Map();
    }
}

Map load_map_from_file(const std::string& filepath) {
    std::ifstream file(filepath);
    if (!file.is_open()) {
        std::cerr << "[MapLoader] Could not open file: " << filepath << "\n";
        return Map();
    }

    std::string content((std::istreambuf_iterator<char>(file)),
                         std::istreambuf_iterator<char>());
    return load_map_from_json(content);
}

} // namespace dope::map
