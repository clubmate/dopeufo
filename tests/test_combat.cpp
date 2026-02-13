// test_combat.cpp — Unit tests for cover, damage, and combat validation.

#include <catch2/catch_test_macros.hpp>

#include "core/ecs.h"
#include "core/math.h"
#include "core/types.h"
#include "combat/cover.h"
#include "combat/damage.h"
#include "combat/action.h"
#include "map/map.h"
#include "map/tile.h"
#include "unit/unit.h"

using namespace dope;
using namespace dope::core;

namespace {

// Build a simple 10x10 open map
dope::map::Map make_open_map() {
    dope::map::Map m(10, 10, 1);
    for (i32 y = 0; y < 10; ++y)
        for (i32 x = 0; x < 10; ++x)
            m.at(x, y, 0) = dope::map::Tile::make_floor();
    return m;
}

// Create a unit with all combat-relevant components
EntityId setup_unit(Registry& reg, PlayerId player, Vec3i pos, i32 accuracy = 65) {
    EntityId e = reg.create_entity();
    reg.add_component(e, dope::unit::Position{pos});
    reg.add_component(e, dope::unit::Ownership{player});
    reg.add_component(e, dope::unit::Health{100, 100});
    reg.add_component(e, dope::unit::ActionState{2, false, false, false});

    dope::unit::Stats stats;
    stats.accuracy = accuracy;
    stats.mobility = 6;
    stats.sight_range = 14;
    stats.damage_min = 3;
    stats.damage_max = 5;
    reg.add_component(e, stats);

    dope::unit::WeaponState weapon;
    weapon.weapon_name = "Rifle";
    weapon.ammo_current = 4;
    weapon.ammo_max = 4;
    weapon.range = 15;
    weapon.damage_min = 3;
    weapon.damage_max = 5;
    weapon.crit_chance = 10;
    reg.add_component(e, weapon);

    return e;
}

} // namespace

TEST_CASE("Cover: no cover on open tile", "[combat][cover]") {
    auto map = make_open_map();
    Vec3i attacker_pos = {2, 2, 0};
    Vec3i target_pos   = {5, 5, 0};

    auto info = dope::combat::calculate_cover(map, attacker_pos, target_pos);
    REQUIRE(info.level == CoverLevel::None);
    REQUIRE(info.aim_penalty == 0);
}

TEST_CASE("Cover: half cover gives penalty", "[combat][cover]") {
    auto map = make_open_map();
    // Add half cover on south edge of the defender's tile
    map.at(5, 5, 0).cover.south = CoverLevel::Half;

    // Attack from south (attacker at 5,8 → target at 5,5)
    Vec3i attacker_pos = {5, 8, 0};
    Vec3i target_pos   = {5, 5, 0};

    auto info = dope::combat::calculate_cover(map, attacker_pos, target_pos);
    REQUIRE(info.level == CoverLevel::Half);
    REQUIRE(info.aim_penalty == constants::HALF_COVER_PENALTY);
}

TEST_CASE("Damage: shot calculation produces valid results", "[combat][damage]") {
    Registry reg;
    auto map = make_open_map();

    EntityId shooter = setup_unit(reg, PlayerId::Player1, {2, 2, 0}, 70);
    EntityId target  = setup_unit(reg, PlayerId::Player2, {5, 5, 0});

    auto calc = dope::combat::calculate_shot(reg, map, shooter, target);

    REQUIRE(calc.base_accuracy > 0);
    REQUIRE(calc.final_hit_chance >= 5);
    REQUIRE(calc.final_hit_chance <= 95);
}

TEST_CASE("Damage: hit chance clamped to 5-95", "[combat][damage]") {
    Registry reg;
    auto map = make_open_map();

    // Very accurate shooter
    EntityId shooter = setup_unit(reg, PlayerId::Player1, {2, 2, 0}, 100);
    EntityId target  = setup_unit(reg, PlayerId::Player2, {3, 3, 0});

    auto calc = dope::combat::calculate_shot(reg, map, shooter, target);
    REQUIRE(calc.final_hit_chance <= 95);
}

TEST_CASE("Action validation: move validates correctly", "[combat][action]") {
    Registry reg;
    auto map = make_open_map();

    EntityId e = setup_unit(reg, PlayerId::Player1, {2, 2, 0});
    map.set_occupant({2, 2, 0}, e);

    // Valid move within range
    auto result = dope::combat::validate_move(reg, map, e, {5, 5, 0}, PlayerId::Player1);
    REQUIRE(result == CommandResult::Success);

    // Invalid: wrong player
    result = dope::combat::validate_move(reg, map, e, {5, 5, 0}, PlayerId::Player2);
    REQUIRE(result != CommandResult::Success);
}

TEST_CASE("Action validation: shooting requires ammo and LoS", "[combat][action]") {
    Registry reg;
    auto map = make_open_map();

    EntityId shooter = setup_unit(reg, PlayerId::Player1, {2, 2, 0});
    EntityId target  = setup_unit(reg, PlayerId::Player2, {5, 5, 0});
    map.set_occupant({2, 2, 0}, shooter);
    map.set_occupant({5, 5, 0}, target);

    // Valid shot
    auto result = dope::combat::validate_shot(reg, map, shooter, target, PlayerId::Player1);
    REQUIRE(result == CommandResult::Success);

    // Deplete ammo
    reg.get_component<dope::unit::WeaponState>(shooter).ammo_current = 0;
    result = dope::combat::validate_shot(reg, map, shooter, target, PlayerId::Player1);
    REQUIRE(result == CommandResult::NoAmmo);
}
