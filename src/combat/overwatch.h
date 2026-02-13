#pragma once
// overwatch.h — Overwatch / reaction fire system.
//
// Units in overwatch state will fire at enemies that move within their LoS
// during the opponent's turn. Each overwatching unit fires once per turn.

#include "../core/ecs.h"
#include "../core/event_bus.h"
#include "../core/math.h"
#include "../core/types.h"
#include "../map/line_of_sight.h"
#include "../map/map.h"
#include "../unit/unit.h"

#include <vector>

namespace dope::combat {

struct OverwatchEntry {
    EntityId watcher;
    Vec3i watcher_pos;
    i32 sight_range;
    bool has_fired = false;  // Each unit fires once per overwatch
};

class OverwatchSystem {
public:
    // Register a unit for overwatch
    void add_watcher(EntityId entity, const Vec3i& pos, i32 sight_range);

    // Remove a unit from overwatch (e.g., when their turn starts)
    void remove_watcher(EntityId entity);

    // Clear all watchers for a player (called at start of their turn)
    void clear_player_watchers(const core::Registry& reg, PlayerId player);

    // Check if a moving unit triggers any overwatch reactions.
    // Returns list of watchers that will fire.
    std::vector<EntityId> check_movement(
        const map::Map& game_map,
        EntityId mover,
        const Vec3i& mover_pos,
        PlayerId mover_owner
    ) const;

    // Mark a watcher as having fired
    void mark_fired(EntityId watcher);

    // Get all current watchers
    const std::vector<OverwatchEntry>& watchers() const { return m_watchers; }

    bool is_watching(EntityId entity) const;

private:
    std::vector<OverwatchEntry> m_watchers;
};

} // namespace dope::combat
