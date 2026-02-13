// test_pathfinding.cpp — Unit tests for A* pathfinding.

#include <catch2/catch_test_macros.hpp>

#include "core/types.h"
#include "core/math.h"
#include "map/map.h"
#include "map/tile.h"
#include "map/pathfinding.h"

using namespace dope;
using namespace dope::map;

namespace {

// Create a simple open 10x10 map
Map make_open_map(i32 w = 10, i32 h = 10) {
    Map m(w, h, 1);
    for (i32 y = 0; y < h; ++y) {
        for (i32 x = 0; x < w; ++x) {
            m.at(x, y, 0) = Tile::make_floor();
        }
    }
    return m;
}

// Create a map with a wall across the middle
Map make_walled_map() {
    Map m = make_open_map(10, 10);
    // Wall from x=0..8 at y=5 (leave x=9 open as gap)
    for (i32 x = 0; x <= 8; ++x) {
        m.at(x, 5, 0) = Tile::make_wall();
    }
    return m;
}

} // namespace

TEST_CASE("Pathfinding: trivial path (same tile)", "[pathfinding]") {
    Map m = make_open_map();
    Vec3i start = {3, 3, 0};
    auto result = find_path(m, start, start);

    REQUIRE(result.found);
    // Path should be just the start tile or empty depending on impl
    REQUIRE(result.cost == 0);
}

TEST_CASE("Pathfinding: straight line on open map", "[pathfinding]") {
    Map m = make_open_map();
    Vec3i start = {0, 0, 0};
    Vec3i goal  = {5, 0, 0};
    auto result = find_path(m, start, goal);

    REQUIRE(result.found);
    REQUIRE(result.path.back() == goal);
    REQUIRE(result.path.front() == start);
    REQUIRE(result.cost == 5); // 5 tiles away cardinally
}

TEST_CASE("Pathfinding: diagonal movement", "[pathfinding]") {
    Map m = make_open_map();
    Vec3i start = {0, 0, 0};
    Vec3i goal  = {3, 3, 0};
    auto result = find_path(m, start, goal);

    REQUIRE(result.found);
    // With uniform cost diagonals (Chebyshev), cost = max(dx,dy) = 3
    REQUIRE(result.cost == 3);
}

TEST_CASE("Pathfinding: path around wall", "[pathfinding]") {
    Map m = make_walled_map();
    Vec3i start = {0, 0, 0};
    Vec3i goal  = {0, 9, 0};
    auto result = find_path(m, start, goal);

    REQUIRE(result.found);
    // Must go around the wall through the gap at x=9
    REQUIRE(result.cost > 9); // Longer than straight line
}

TEST_CASE("Pathfinding: blocked (no path)", "[pathfinding]") {
    Map m = make_open_map(10, 10);
    // Complete wall across y=5
    for (i32 x = 0; x < 10; ++x) {
        m.at(x, 5, 0) = Tile::make_wall();
    }

    Vec3i start = {5, 0, 0};
    Vec3i goal  = {5, 9, 0};
    auto result = find_path(m, start, goal);

    REQUIRE_FALSE(result.found);
}

TEST_CASE("Pathfinding: respects max_cost", "[pathfinding]") {
    Map m = make_open_map();
    Vec3i start = {0, 0, 0};
    Vec3i goal  = {9, 9, 0};
    auto result = find_path(m, start, goal, 5); // Only 5 movement

    // Max diagonal distance is 9, which exceeds max_cost=5
    REQUIRE_FALSE(result.found);
}

TEST_CASE("Pathfinding: get_reachable_tiles returns correct count", "[pathfinding]") {
    Map m = make_open_map();
    Vec3i start = {5, 5, 0};
    auto reachable = get_reachable_tiles(m, start, 2);

    // With uniform cost diagonals and range 2, reachable tiles form a diamond/square
    REQUIRE_FALSE(reachable.empty());

    // All returned tiles should have cost <= 2
    for (const auto& [pos, cost] : reachable) {
        REQUIRE(cost <= 2);
    }
}

TEST_CASE("Pathfinding: occupied tile blocks passage", "[pathfinding]") {
    Map m = make_open_map(5, 1);
    // Place an occupant at (2,0,0)
    m.set_occupant({2, 0, 0}, 999);

    Vec3i start = {0, 0, 0};
    Vec3i goal  = {4, 0, 0};
    auto result = find_path(m, start, goal);

    // On a 1-row map, the occupant blocks passage (can't go around)
    REQUIRE_FALSE(result.found);
}
