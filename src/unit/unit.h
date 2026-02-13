#pragma once
// unit.h — Unit components and related types.
//
// Units are ECS entities with these components:
//   Position, Ownership, Health, Stats, ActionState, WeaponState, Inventory

#include "../core/math.h"
#include "../core/types.h"

#include <string>
#include <vector>

namespace dope::unit {

// --- Position component ---
struct Position {
    dope::Vec3i pos;
};

// --- Ownership component ---
struct Ownership {
    dope::PlayerId player = dope::PlayerId::None;
};

// --- Health component ---
struct Health {
    dope::i32 hp = 100;
    dope::i32 hp_max = 100;

    bool is_alive() const { return hp > 0; }
    float ratio() const { return static_cast<float>(hp) / static_cast<float>(hp_max); }
};

// --- Stats component ---
struct Stats {
    dope::i32 accuracy = 65;       // Base aim percentage (0-100)
    dope::i32 mobility = 6;       // Movement range in tiles
    dope::i32 armor = 0;          // Flat damage reduction
    dope::i32 dodge = 0;          // Dodge chance (0-100)
    dope::i32 will = 50;          // Willpower (for future morale system)
    dope::i32 sight_range = 12;   // Fog of war vision range in tiles
    dope::i32 damage_min = 3;     // Min weapon damage
    dope::i32 damage_max = 5;     // Max weapon damage
};

// --- Action state component (per-turn state) ---
struct ActionState {
    dope::i32 actions_remaining = dope::constants::ACTIONS_PER_TURN;
    bool has_moved = false;
    bool is_overwatching = false;
    bool is_hunkered = false;

    bool can_act() const { return actions_remaining > 0; }
    bool can_shoot() const { return actions_remaining > 0; }
    bool can_move() const { return actions_remaining > 0; }
};

// --- Weapon state component ---
struct WeaponState {
    std::string weapon_name = "Rifle";
    dope::i32 ammo_current = 4;
    dope::i32 ammo_max = 4;
    dope::i32 range = 15;         // Effective range in tiles
    dope::i32 damage_min = 3;
    dope::i32 damage_max = 5;
    dope::i32 crit_chance = 10;   // Critical hit chance (0-100)
    bool needs_reload() const { return ammo_current <= 0; }
};

// --- Inventory component ---
struct InventorySlot {
    std::string item_name;
    dope::i32 uses_remaining = 1;
};

struct Inventory {
    std::vector<InventorySlot> slots;
    static constexpr int MAX_SLOTS = 4;
};

// --- Visual component (for rendering) ---
struct Visual {
    std::string sprite_sheet;
    dope::i32 sprite_index = 0;
    dope::Direction facing = dope::Direction::South;
};

// --- Unit info (display name, class, etc.) ---
struct UnitInfo {
    std::string name;
    std::string unit_class;  // "rifleman", "sniper", "heavy", "medic"
};

} // namespace dope::unit
