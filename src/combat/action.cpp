#include "action.h"

#include "../map/line_of_sight.h"

namespace dope::combat {

core::CommandResult validate_move(
    const core::Registry& reg,
    const map::Map& game_map,
    EntityId entity,
    const Vec3i& target,
    PlayerId active_player) {

    if (!reg.is_alive(entity)) return core::CommandResult::InvalidEntity;

    auto* own = reg.try_get_component<unit::Ownership>(entity);
    if (!own || own->player != active_player) return core::CommandResult::NotYourTurn;

    auto* actions = reg.try_get_component<unit::ActionState>(entity);
    if (!actions || !actions->can_move()) return core::CommandResult::NotEnoughActions;

    auto* pos = reg.try_get_component<unit::Position>(entity);
    auto* stats = reg.try_get_component<unit::Stats>(entity);
    if (!pos || !stats) return core::CommandResult::InvalidEntity;

    // Check target is valid
    if (!game_map.in_bounds(target)) return core::CommandResult::InvalidTarget;
    if (!game_map.at(target).is_passable()) return core::CommandResult::InvalidTarget;
    if (game_map.is_occupied(target)) return core::CommandResult::InvalidTarget;

    // Pathfinding check
    auto path = map::find_path(game_map, pos->pos, target, stats->mobility, entity);
    if (!path.found) return core::CommandResult::PathBlocked;

    return core::CommandResult::Success;
}

core::CommandResult validate_shot(
    const core::Registry& reg,
    const map::Map& game_map,
    EntityId shooter,
    EntityId target,
    PlayerId active_player) {

    if (!reg.is_alive(shooter)) return core::CommandResult::InvalidEntity;
    if (!reg.is_alive(target)) return core::CommandResult::InvalidTarget;

    auto* own = reg.try_get_component<unit::Ownership>(shooter);
    if (!own || own->player != active_player) return core::CommandResult::NotYourTurn;

    auto* actions = reg.try_get_component<unit::ActionState>(shooter);
    if (!actions || !actions->can_shoot()) return core::CommandResult::NotEnoughActions;

    auto* weapon = reg.try_get_component<unit::WeaponState>(shooter);
    if (weapon && weapon->needs_reload()) return core::CommandResult::NoAmmo;

    auto* shooter_pos = reg.try_get_component<unit::Position>(shooter);
    auto* target_pos = reg.try_get_component<unit::Position>(target);
    if (!shooter_pos || !target_pos) return core::CommandResult::InvalidEntity;

    // LoS check
    if (!map::has_los(game_map, shooter_pos->pos, target_pos->pos)) {
        return core::CommandResult::InvalidTarget;
    }

    // Don't shoot your own units
    auto* target_own = reg.try_get_component<unit::Ownership>(target);
    if (target_own && target_own->player == active_player) {
        return core::CommandResult::InvalidTarget;
    }

    return core::CommandResult::Success;
}

core::CommandResult validate_overwatch(
    const core::Registry& reg,
    EntityId entity,
    PlayerId active_player) {

    if (!reg.is_alive(entity)) return core::CommandResult::InvalidEntity;

    auto* own = reg.try_get_component<unit::Ownership>(entity);
    if (!own || own->player != active_player) return core::CommandResult::NotYourTurn;

    auto* actions = reg.try_get_component<unit::ActionState>(entity);
    if (!actions || !actions->can_act()) return core::CommandResult::NotEnoughActions;

    auto* weapon = reg.try_get_component<unit::WeaponState>(entity);
    if (weapon && weapon->needs_reload()) return core::CommandResult::NoAmmo;

    return core::CommandResult::Success;
}

AvailableActions get_available_actions(
    const core::Registry& reg,
    EntityId entity,
    PlayerId active_player) {

    AvailableActions aa;

    if (!reg.is_alive(entity)) return aa;

    auto* own = reg.try_get_component<unit::Ownership>(entity);
    if (!own || own->player != active_player) return aa;

    auto* actions = reg.try_get_component<unit::ActionState>(entity);
    if (!actions) return aa;

    if (!actions->can_act()) return aa;

    aa.can_move = actions->can_move();
    aa.can_hunker = actions->can_act();

    auto* weapon = reg.try_get_component<unit::WeaponState>(entity);
    if (weapon) {
        aa.can_shoot = actions->can_shoot() && !weapon->needs_reload();
        aa.can_overwatch = actions->can_act() && !weapon->needs_reload();
        aa.can_reload = weapon->ammo_current < weapon->ammo_max;
    }

    auto* inv = reg.try_get_component<unit::Inventory>(entity);
    if (inv && !inv->slots.empty()) {
        aa.can_use_item = true;
    }

    return aa;
}

} // namespace dope::combat
