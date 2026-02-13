// test_los.cpp — Unit tests for line-of-sight calculations.

#include <catch2/catch_test_macros.hpp>

#include "core/types.h"
#include "core/math.h"
#include "map/map.h"
#include "map/tile.h"
#include "map/line_of_sight.h"

using namespace dope;
using namespace dope::map;

namespace {

Map make_open_map(i32 w = 10, i32 h = 10) {
    Map m(w, h, 1);
    for (i32 y = 0; y < h; ++y) {
        for (i32 x = 0; x < w; ++x) {
            m.at(x, y, 0) = Tile::make_floor();
        }
    }
    return m;
}

} // namespace

TEST_CASE("LoS: clear line of sight on open map", "[los]") {
    Map m = make_open_map();
    Vec3i from = {1, 1, 0};
    Vec3i to   = {8, 8, 0};

    auto result = check_los(m, from, to);
    REQUIRE(result.visible);
}

TEST_CASE("LoS: same tile always visible", "[los]") {
    Map m = make_open_map();
    Vec3i pos = {5, 5, 0};

    REQUIRE(has_los(m, pos, pos));
}

TEST_CASE("LoS: wall blocks line of sight", "[los]") {
    Map m = make_open_map();
    // Place a wall at (5, 5) between shooter and target
    m.at(5, 5, 0) = Tile::make_wall();

    Vec3i from = {3, 3, 0};
    Vec3i to   = {7, 7, 0};

    auto result = check_los(m, from, to);
    REQUIRE_FALSE(result.visible);
}

TEST_CASE("LoS: has_los convenience function works", "[los]") {
    Map m = make_open_map();
    REQUIRE(has_los(m, {0, 0, 0}, {9, 0, 0}));

    m.at(5, 0, 0) = Tile::make_wall();
    REQUIRE_FALSE(has_los(m, {0, 0, 0}, {9, 0, 0}));
}

TEST_CASE("LoS: get_visible_tiles returns tiles within range", "[los]") {
    Map m = make_open_map();
    Vec3i from = {5, 5, 0};
    i32 range = 3;

    auto tiles = get_visible_tiles(m, from, range);
    REQUIRE_FALSE(tiles.empty());

    // All visible tiles should be within range
    for (const auto& t : tiles) {
        i32 dist = std::max(std::abs(t.x - from.x), std::abs(t.y - from.y));
        REQUIRE(dist <= range);
    }
}

TEST_CASE("LoS: wall creates shadow area", "[los]") {
    Map m = make_open_map(20, 1);
    // Wall at x=5
    m.at(5, 0, 0) = Tile::make_wall();

    Vec3i from = {0, 0, 0};

    // Tiles before the wall are visible
    REQUIRE(has_los(m, from, {4, 0, 0}));

    // Tiles behind the wall are NOT visible (wall blocks)
    REQUIRE_FALSE(has_los(m, from, {6, 0, 0}));
    REQUIRE_FALSE(has_los(m, from, {10, 0, 0}));
}

TEST_CASE("LoS: get_visible_entities finds entities in range", "[los]") {
    Map m = make_open_map();
    Vec3i from = {5, 5, 0};
    i32 range = 10;

    std::vector<std::pair<EntityId, Vec3i>> entities = {
        {1, {7, 7, 0}},   // In range, no obstruction
        {2, {0, 0, 0}},   // In range (distance ~7)
    };

    auto visible = get_visible_entities(m, from, range, entities);
    REQUIRE(visible.size() == 2);
}

TEST_CASE("LoS: entity behind wall is not visible", "[los]") {
    Map m = make_open_map();
    m.at(5, 5, 0) = Tile::make_wall();

    Vec3i from = {3, 3, 0};
    i32 range = 15;

    std::vector<std::pair<EntityId, Vec3i>> entities = {
        {1, {7, 7, 0}}, // Behind wall
    };

    auto visible = get_visible_entities(m, from, range, entities);
    REQUIRE(visible.empty());
}
