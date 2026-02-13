#include "overwatch.h"

#include <algorithm>

namespace dope::combat {

void OverwatchSystem::add_watcher(EntityId entity, const Vec3i& pos, i32 sight_range) {
    // Don't add duplicates
    for (const auto& w : m_watchers) {
        if (w.watcher == entity) return;
    }
    m_watchers.push_back({entity, pos, sight_range, false});
}

void OverwatchSystem::remove_watcher(EntityId entity) {
    m_watchers.erase(
        std::remove_if(m_watchers.begin(), m_watchers.end(),
                       [entity](const OverwatchEntry& w) { return w.watcher == entity; }),
        m_watchers.end());
}

void OverwatchSystem::clear_player_watchers(const core::Registry& reg, PlayerId player) {
    m_watchers.erase(
        std::remove_if(m_watchers.begin(), m_watchers.end(),
                       [&](const OverwatchEntry& w) {
                           auto* own = reg.try_get_component<unit::Ownership>(w.watcher);
                           return own && own->player == player;
                       }),
        m_watchers.end());
}

std::vector<EntityId> OverwatchSystem::check_movement(
    const map::Map& game_map,
    EntityId mover,
    const Vec3i& mover_pos,
    PlayerId mover_owner) const {

    std::vector<EntityId> triggered;

    for (const auto& entry : m_watchers) {
        if (entry.has_fired) continue;

        // Don't fire at own units (need to check ownership)
        // This check is done by caller since we don't have full ownership info here
        // For now, just skip same entity
        if (entry.watcher == mover) continue;

        // Range check
        i32 dist = entry.watcher_pos.chebyshev_distance_xy(mover_pos);
        if (dist > entry.sight_range) continue;

        // LoS check
        if (map::has_los(game_map, entry.watcher_pos, mover_pos)) {
            triggered.push_back(entry.watcher);
        }
    }

    return triggered;
}

void OverwatchSystem::mark_fired(EntityId watcher) {
    for (auto& entry : m_watchers) {
        if (entry.watcher == watcher) {
            entry.has_fired = true;
            return;
        }
    }
}

bool OverwatchSystem::is_watching(EntityId entity) const {
    for (const auto& w : m_watchers) {
        if (w.watcher == entity) return true;
    }
    return false;
}

} // namespace dope::combat
