#pragma once
// fog_of_war.h — Per-player fog of war system.
//
// Each player has a visibility map that tracks which tiles they can see.
// Visibility is recalculated based on all living units' LoS.
//
// Fog states:
//   - Unknown: never seen (black)
//   - Revealed: previously seen but not currently visible (greyed out)
//   - Visible: currently in LoS of at least one friendly unit (full visibility)

#include "../core/ecs.h"
#include "../core/math.h"
#include "../core/types.h"
#include "../map/line_of_sight.h"
#include "../map/map.h"
#include "../unit/unit.h"

#include <vector>

namespace dope::turn {

enum class FogState : u8 {
    Unknown = 0,
    Revealed = 1,
    Visible = 2,
};

class FogOfWar {
public:
    FogOfWar();

    // Initialize fog for a map (both players start with all Unknown)
    void init(i32 width, i32 height, i32 depth);

    // Recalculate visibility for a player based on unit positions
    void update(PlayerId player, const core::Registry& reg, const map::Map& game_map);

    // Get fog state for a specific tile and player
    FogState get_state(PlayerId player, const Vec3i& pos) const;

    // Is a tile currently visible to a player?
    bool is_visible(PlayerId player, const Vec3i& pos) const;

    // Is a tile at least revealed (previously seen)?
    bool is_revealed(PlayerId player, const Vec3i& pos) const;

    // Is an enemy entity visible to a player? (checks fog at entity position)
    bool is_entity_visible(PlayerId player, const Vec3i& entity_pos) const;

    // Get all currently visible tiles for a player
    std::vector<Vec3i> get_visible_tiles(PlayerId player) const;

    // Dimensions
    i32 width() const { return m_width; }
    i32 height() const { return m_height; }
    i32 depth() const { return m_depth; }

private:
    i32 index(const Vec3i& pos) const;
    std::vector<FogState>& fog_for(PlayerId player);
    const std::vector<FogState>& fog_for(PlayerId player) const;

    i32 m_width = 0;
    i32 m_height = 0;
    i32 m_depth = 0;

    std::vector<FogState> m_fog_p1;
    std::vector<FogState> m_fog_p2;
};

} // namespace dope::turn
