#pragma once
// cover.h — Cover system: determine cover level between attacker and defender.

#include "../core/math.h"
#include "../core/types.h"
#include "../map/map.h"

namespace dope::combat {

struct CoverInfo {
    CoverLevel level = CoverLevel::None;
    Direction attack_direction = Direction::North;
    i32 aim_penalty = 0;
};

// Calculate the cover a defender has against an attacker.
// Considers directional cover on the defender's tile.
CoverInfo calculate_cover(const map::Map& game_map, const Vec3i& attacker_pos,
                          const Vec3i& defender_pos);

// Get the aim penalty for a given cover level (considering hunker bonus)
i32 get_cover_aim_penalty(CoverLevel level, bool is_hunkered = false);

// Check if a position is flanked from a given direction
// (flanked = no cover on the side the attack comes from)
bool is_flanked(const map::Map& game_map, const Vec3i& defender_pos,
                const Vec3i& attacker_pos);

} // namespace dope::combat
