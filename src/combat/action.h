#pragma once
// action.h — High-level action validation and execution helpers.
//
// Works with the Command system to validate and contextually resolve actions.

#include "../core/command.h"
#include "../core/ecs.h"
#include "../core/types.h"
#include "../map/map.h"
#include "../map/pathfinding.h"
#include "../unit/unit.h"

namespace dope::combat {

// Validate whether an entity can perform a move to the target position.
// Returns Success or an error code.
core::CommandResult validate_move(
    const core::Registry& reg,
    const map::Map& game_map,
    EntityId entity,
    const Vec3i& target,
    PlayerId active_player
);

// Validate whether an entity can shoot a target.
core::CommandResult validate_shot(
    const core::Registry& reg,
    const map::Map& game_map,
    EntityId shooter,
    EntityId target,
    PlayerId active_player
);

// Validate whether an entity can enter overwatch.
core::CommandResult validate_overwatch(
    const core::Registry& reg,
    EntityId entity,
    PlayerId active_player
);

// Get all valid action types for an entity.
struct AvailableActions {
    bool can_move = false;
    bool can_shoot = false;
    bool can_overwatch = false;
    bool can_reload = false;
    bool can_hunker = false;
    bool can_use_item = false;
};

AvailableActions get_available_actions(
    const core::Registry& reg,
    EntityId entity,
    PlayerId active_player
);

} // namespace dope::combat
