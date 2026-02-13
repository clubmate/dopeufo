// test_game_state.cpp — Integration tests for GameState and command execution.

#include <catch2/catch_test_macros.hpp>

#include "core/game_state.h"
#include "core/command.h"
#include "core/types.h"
#include "core/math.h"
#include "map/map.h"
#include "map/tile.h"
#include "unit/unit.h"

using namespace dope;
using namespace dope::core;

namespace {

// Setup a minimal game environment
struct TestSetup {
    GameState state;
    dope::map::Map map{10, 10, 1};

    EntityId p1_unit;
    EntityId p2_unit;

    TestSetup() {
        // Open map
        for (i32 y = 0; y < 10; ++y)
            for (i32 x = 0; x < 10; ++x)
                map.at(x, y, 0) = dope::map::Tile::make_floor();

        state.begin_game();

        auto& reg = state.registry();

        // Player 1 unit
        p1_unit = reg.create_entity();
        reg.add_component(p1_unit, unit::Position{{2, 2, 0}});
        reg.add_component(p1_unit, unit::Ownership{PlayerId::Player1});
        reg.add_component(p1_unit, unit::Health{100, 100});
        reg.add_component(p1_unit, unit::ActionState{2, false, false, false});

        unit::Stats s1;
        s1.accuracy = 70;
        s1.mobility = 6;
        s1.sight_range = 14;
        s1.damage_min = 3;
        s1.damage_max = 5;
        reg.add_component(p1_unit, s1);

        unit::WeaponState w1;
        w1.weapon_name = "Rifle";
        w1.ammo_current = 4;
        w1.ammo_max = 4;
        w1.range = 15;
        w1.damage_min = 3;
        w1.damage_max = 5;
        w1.crit_chance = 10;
        reg.add_component(p1_unit, w1);

        map.set_occupant({2, 2, 0}, p1_unit);

        // Player 2 unit
        p2_unit = reg.create_entity();
        reg.add_component(p2_unit, unit::Position{{7, 7, 0}});
        reg.add_component(p2_unit, unit::Ownership{PlayerId::Player2});
        reg.add_component(p2_unit, unit::Health{100, 100});
        reg.add_component(p2_unit, unit::ActionState{2, false, false, false});

        unit::Stats s2;
        s2.accuracy = 65;
        s2.mobility = 6;
        s2.sight_range = 14;
        s2.damage_min = 3;
        s2.damage_max = 5;
        reg.add_component(p2_unit, s2);

        unit::WeaponState w2;
        w2.weapon_name = "Rifle";
        w2.ammo_current = 4;
        w2.ammo_max = 4;
        w2.range = 15;
        w2.damage_min = 3;
        w2.damage_max = 5;
        w2.crit_chance = 10;
        reg.add_component(p2_unit, w2);

        map.set_occupant({7, 7, 0}, p2_unit);
    }
};

} // namespace

TEST_CASE("GameState: spawn command creates entity", "[gamestate]") {
    GameState state;
    state.begin_game();

    SpawnUnitCommand cmd;
    cmd.player = PlayerId::Player1;
    cmd.pos = {3, 3, 0};

    auto result = state.execute(cmd);
    REQUIRE(result == CommandResult::Success);
}

TEST_CASE("GameState: deterministic RNG produces same sequence", "[gamestate]") {
    Rng rng1(42);
    Rng rng2(42);

    for (int i = 0; i < 100; ++i) {
        REQUIRE(rng1.next() == rng2.next());
    }
}

TEST_CASE("GameState: different seeds produce different sequences", "[gamestate]") {
    Rng rng1(100);
    Rng rng2(200);

    bool any_different = false;
    for (int i = 0; i < 10; ++i) {
        if (rng1.next() != rng2.next()) {
            any_different = true;
            break;
        }
    }
    REQUIRE(any_different);
}

TEST_CASE("GameState: reload restores ammo", "[gamestate]") {
    TestSetup setup;
    auto& reg = setup.state.registry();

    // Deplete some ammo
    reg.get_component<unit::WeaponState>(setup.p1_unit).ammo_current = 1;

    ReloadCommand cmd;
    cmd.entity = setup.p1_unit;

    auto result = setup.state.execute(cmd);
    REQUIRE(result == CommandResult::Success);

    auto& weapon = reg.get_component<unit::WeaponState>(setup.p1_unit);
    REQUIRE(weapon.ammo_current == weapon.ammo_max);

    // Should consume all actions
    auto& actions = reg.get_component<unit::ActionState>(setup.p1_unit);
    REQUIRE(actions.actions_remaining == 0);
}

TEST_CASE("GameState: hunker down sets flag", "[gamestate]") {
    TestSetup setup;
    auto& reg = setup.state.registry();

    HunkerDownCommand cmd;
    cmd.entity = setup.p1_unit;

    auto result = setup.state.execute(cmd);
    REQUIRE(result == CommandResult::Success);

    auto& actions = reg.get_component<unit::ActionState>(setup.p1_unit);
    REQUIRE(actions.is_hunkered);
    REQUIRE(actions.actions_remaining == 0);
}
