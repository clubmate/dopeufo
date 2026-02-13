#include "turn_manager.h"

#include <algorithm>

namespace dope::turn {

TurnManager::TurnManager() = default;

void TurnManager::init(PlayerId starting_player) {
    m_active_player = starting_player;
    m_turn_number = 1;
    m_total_turns = 0;
}

void TurnManager::start_turn(core::Registry& reg, core::EventBus& events) {
    // Reset actions for all units belonging to the active player
    reg.each<unit::Ownership>([&](EntityId id, const unit::Ownership& own) {
        if (own.player != m_active_player) return;

        auto* actions = reg.try_get_component<unit::ActionState>(id);
        if (actions) {
            actions->actions_remaining = constants::ACTIONS_PER_TURN;
            actions->has_moved = false;
            actions->is_overwatching = false;
            actions->is_hunkered = false;
        }
    });

    // Clear overwatch entries for the active player (they get to set up new ones)
    m_overwatch.clear_player_watchers(reg, m_active_player);

    events.publish(core::TurnStarted{m_active_player, m_turn_number});
}

void TurnManager::end_turn(core::Registry& reg, core::EventBus& events) {
    m_total_turns++;

    // Register overwatch for units that chose overwatch this turn
    reg.each<unit::ActionState>([&](EntityId id, const unit::ActionState& actions) {
        if (!actions.is_overwatching) return;

        auto* own = reg.try_get_component<unit::Ownership>(id);
        if (!own || own->player != m_active_player) return;

        auto* pos = reg.try_get_component<unit::Position>(id);
        auto* stats = reg.try_get_component<unit::Stats>(id);
        if (pos && stats) {
            m_overwatch.add_watcher(id, pos->pos, stats->sight_range);
        }
    });

    events.publish(core::TurnEnded{m_active_player, m_turn_number});

    // Switch player
    if (m_active_player == PlayerId::Player1) {
        m_active_player = PlayerId::Player2;
    } else {
        m_active_player = PlayerId::Player1;
        m_turn_number++;
    }
}

WinCheck TurnManager::check_win_condition(const core::Registry& reg) const {
    WinCheck result;

    i32 p1_alive = count_alive_units(reg, PlayerId::Player1);
    i32 p2_alive = count_alive_units(reg, PlayerId::Player2);

    // Elimination check
    if (p1_alive == 0 && p2_alive == 0) {
        result.game_over = true;
        result.winner = PlayerId::None;
        result.reason = "mutual_elimination";
        return result;
    }
    if (p1_alive == 0) {
        result.game_over = true;
        result.winner = PlayerId::Player2;
        result.reason = "elimination";
        return result;
    }
    if (p2_alive == 0) {
        result.game_over = true;
        result.winner = PlayerId::Player1;
        result.reason = "elimination";
        return result;
    }

    // Objective check
    for (const auto& obj : m_objectives) {
        if (obj.completed) {
            result.game_over = true;
            result.winner = obj.owner;
            result.reason = "objective";
            return result;
        }
    }

    return result;
}

bool TurnManager::all_units_done(const core::Registry& reg) const {
    bool all_done = true;
    reg.each<unit::Ownership>([&](EntityId id, const unit::Ownership& own) {
        if (own.player != m_active_player) return;

        auto* health = reg.try_get_component<unit::Health>(id);
        if (!health || !health->is_alive()) return;

        auto* actions = reg.try_get_component<unit::ActionState>(id);
        if (actions && actions->can_act()) {
            all_done = false;
        }
    });
    return all_done;
}

i32 TurnManager::count_alive_units(const core::Registry& reg, PlayerId player) const {
    i32 count = 0;
    reg.each<unit::Ownership>([&](EntityId id, const unit::Ownership& own) {
        if (own.player != player) return;
        auto* health = reg.try_get_component<unit::Health>(id);
        if (health && health->is_alive()) {
            count++;
        }
    });
    return count;
}

std::vector<EntityId> TurnManager::get_actionable_units(const core::Registry& reg) const {
    std::vector<EntityId> result;
    reg.each<unit::Ownership>([&](EntityId id, const unit::Ownership& own) {
        if (own.player != m_active_player) return;

        auto* health = reg.try_get_component<unit::Health>(id);
        if (!health || !health->is_alive()) return;

        auto* actions = reg.try_get_component<unit::ActionState>(id);
        if (actions && actions->can_act()) {
            result.push_back(id);
        }
    });
    return result;
}

void TurnManager::add_objective(const Objective& obj) {
    m_objectives.push_back(obj);
}

void TurnManager::update_objectives(const core::Registry& reg, const map::Map& game_map) {
    for (auto& obj : m_objectives) {
        if (obj.completed) continue;

        switch (obj.type) {
            case Objective::Type::HoldPoint: {
                // Check if the owning player has a unit on the objective
                EntityId occupant = game_map.get_occupant(obj.location);
                if (occupant != INVALID_ENTITY) {
                    auto* own = reg.try_get_component<unit::Ownership>(occupant);
                    if (own && own->player == obj.owner) {
                        obj.turns_held++;
                        if (obj.turns_held >= obj.turns_required) {
                            obj.completed = true;
                        }
                    } else {
                        obj.turns_held = 0; // Reset if enemy is on point
                    }
                }
                break;
            }
            case Objective::Type::Extraction: {
                // Check if any unit of the owning player is on the extraction point
                EntityId occupant = game_map.get_occupant(obj.location);
                if (occupant != INVALID_ENTITY) {
                    auto* own = reg.try_get_component<unit::Ownership>(occupant);
                    if (own && own->player == obj.owner) {
                        obj.completed = true;
                    }
                }
                break;
            }
            case Objective::Type::Elimination:
                // Handled by check_win_condition
                break;
        }
    }
}

} // namespace dope::turn
