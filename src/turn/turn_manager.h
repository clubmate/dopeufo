#pragma once
// turn_manager.h — IGOUGO turn manager and win condition checking.

#include "../combat/overwatch.h"
#include "../core/ecs.h"
#include "../core/event_bus.h"
#include "../core/types.h"
#include "../map/map.h"
#include "../unit/unit.h"

#include <optional>
#include <string>
#include <vector>

namespace dope::turn {

// Win condition result
struct WinCheck {
    bool game_over = false;
    PlayerId winner = PlayerId::None;
    std::string reason;
};

// Objective definition (for objective-based win conditions)
struct Objective {
    enum class Type : u8 {
        HoldPoint,    // Control a point for N turns
        Extraction,   // Move a unit to extraction zone
        Elimination,  // Kill all enemies (always active)
    };

    Type type = Type::Elimination;
    PlayerId owner = PlayerId::None;     // Which player needs to complete this
    Vec3i location;
    i32 turns_required = 3;              // For HoldPoint
    i32 turns_held = 0;
    bool completed = false;
};

class TurnManager {
public:
    TurnManager();

    // --- Turn flow ---
    void init(PlayerId starting_player = PlayerId::Player1);
    void start_turn(core::Registry& reg, core::EventBus& events);
    void end_turn(core::Registry& reg, core::EventBus& events);

    // --- Accessors ---
    PlayerId active_player() const { return m_active_player; }
    i32 turn_number() const { return m_turn_number; }
    i32 total_turns() const { return m_total_turns; }

    // --- Win condition ---
    WinCheck check_win_condition(const core::Registry& reg) const;

    // Check if all units of the active player have exhausted their actions
    bool all_units_done(const core::Registry& reg) const;

    // Get count of living units per player
    i32 count_alive_units(const core::Registry& reg, PlayerId player) const;

    // --- Unit selection ---
    // Get all units belonging to the active player that can still act
    std::vector<EntityId> get_actionable_units(const core::Registry& reg) const;

    // --- Objectives ---
    void add_objective(const Objective& obj);
    void update_objectives(const core::Registry& reg, const map::Map& game_map);
    const std::vector<Objective>& objectives() const { return m_objectives; }

    // --- Overwatch integration ---
    combat::OverwatchSystem& overwatch() { return m_overwatch; }
    const combat::OverwatchSystem& overwatch() const { return m_overwatch; }

private:
    PlayerId m_active_player = PlayerId::Player1;
    i32 m_turn_number = 1;    // Current turn (increments when both players have gone)
    i32 m_total_turns = 0;    // Total half-turns elapsed

    std::vector<Objective> m_objectives;
    combat::OverwatchSystem m_overwatch;
};

} // namespace dope::turn
