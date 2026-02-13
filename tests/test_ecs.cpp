// test_ecs.cpp — Unit tests for the ECS registry.

#include <catch2/catch_test_macros.hpp>

#include "core/ecs.h"
#include "core/types.h"

using namespace dope;
using namespace dope::core;

namespace {
struct Position { int x = 0; int y = 0; };
struct Health   { int hp = 100; };
struct Name     { std::string value; };
} // namespace

TEST_CASE("Registry: create entities with incrementing IDs", "[ecs]") {
    Registry reg;
    EntityId a = reg.create_entity();
    EntityId b = reg.create_entity();
    EntityId c = reg.create_entity();

    REQUIRE(a != b);
    REQUIRE(b != c);
    REQUIRE(reg.is_alive(a));
    REQUIRE(reg.is_alive(b));
    REQUIRE(reg.is_alive(c));
}

TEST_CASE("Registry: destroy entity removes it", "[ecs]") {
    Registry reg;
    EntityId a = reg.create_entity();
    reg.add_component(a, Position{10, 20});

    REQUIRE(reg.is_alive(a));
    REQUIRE(reg.has_component<Position>(a));

    reg.destroy_entity(a);

    REQUIRE_FALSE(reg.is_alive(a));
    REQUIRE_FALSE(reg.has_component<Position>(a));
}

TEST_CASE("Registry: add and retrieve components", "[ecs]") {
    Registry reg;
    EntityId e = reg.create_entity();

    reg.add_component(e, Position{5, 10});
    reg.add_component(e, Health{75});

    REQUIRE(reg.has_component<Position>(e));
    REQUIRE(reg.has_component<Health>(e));
    REQUIRE_FALSE(reg.has_component<Name>(e));

    auto& pos = reg.get_component<Position>(e);
    REQUIRE(pos.x == 5);
    REQUIRE(pos.y == 10);

    auto& hp = reg.get_component<Health>(e);
    REQUIRE(hp.hp == 75);
}

TEST_CASE("Registry: try_get_component returns nullptr when missing", "[ecs]") {
    Registry reg;
    EntityId e = reg.create_entity();

    auto* p = reg.try_get_component<Position>(e);
    REQUIRE(p == nullptr);

    reg.add_component(e, Position{1, 2});
    p = reg.try_get_component<Position>(e);
    REQUIRE(p != nullptr);
    REQUIRE(p->x == 1);
}

TEST_CASE("Registry: remove_component", "[ecs]") {
    Registry reg;
    EntityId e = reg.create_entity();
    reg.add_component(e, Position{3, 4});

    REQUIRE(reg.has_component<Position>(e));
    reg.remove_component<Position>(e);
    REQUIRE_FALSE(reg.has_component<Position>(e));
}

TEST_CASE("Registry: view returns entities with all components", "[ecs]") {
    Registry reg;
    EntityId a = reg.create_entity();
    EntityId b = reg.create_entity();
    EntityId c = reg.create_entity();

    reg.add_component(a, Position{0, 0});
    reg.add_component(a, Health{100});

    reg.add_component(b, Position{1, 1});
    // b has no Health

    reg.add_component(c, Health{50});
    // c has no Position

    auto view = reg.view<Position, Health>();
    REQUIRE(view.size() == 1);
    REQUIRE(view[0] == a);
}

TEST_CASE("Registry: each iterates over component pool", "[ecs]") {
    Registry reg;
    for (int i = 0; i < 5; ++i) {
        EntityId e = reg.create_entity();
        reg.add_component(e, Health{10 * (i + 1)});
    }

    int total_hp = 0;
    reg.each<Health>([&](EntityId, Health& h) {
        total_hp += h.hp;
    });

    REQUIRE(total_hp == 150); // 10+20+30+40+50
}

TEST_CASE("Registry: mutate component through reference", "[ecs]") {
    Registry reg;
    EntityId e = reg.create_entity();
    reg.add_component(e, Health{100});

    reg.get_component<Health>(e).hp -= 30;
    REQUIRE(reg.get_component<Health>(e).hp == 70);
}
