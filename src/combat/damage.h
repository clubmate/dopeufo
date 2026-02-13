#pragma once
// damage.h — Damage calculation system.
//
// Shot resolution pipeline:
//   1. Calculate base hit chance (shooter accuracy)
//   2. Apply range modifier
//   3. Apply cover penalty
//   4. Apply height advantage/disadvantage
//   5. Clamp to [5, 95] (always a chance to hit/miss)
//   6. Roll against hit chance
//   7. If hit: roll damage, apply armor, apply critical
//   8. Apply damage to target HP

#include "../core/math.h"
#include "../core/types.h"
#include "../map/map.h"
#include "../unit/unit.h"
#include "cover.h"

namespace dope::combat {

struct ShotCalc {
    i32 base_accuracy = 0;
    i32 range_modifier = 0;
    i32 cover_penalty = 0;
    i32 height_modifier = 0;
    i32 overwatch_penalty = 0;
    i32 final_hit_chance = 0;

    // Result (after rolling)
    bool hit = false;
    bool critical = false;
    i32 damage = 0;
    i32 armor_reduction = 0;
    i32 final_damage = 0;
};

// Calculate hit chance for a shot (before rolling).
ShotCalc calculate_shot(
    const map::Map& game_map,
    const Vec3i& shooter_pos,
    const Vec3i& target_pos,
    const unit::Stats& shooter_stats,
    const unit::Stats& target_stats,
    const unit::WeaponState& weapon,
    bool target_hunkered = false,
    bool is_overwatch = false
);

// Resolve the shot using a deterministic RNG.
void resolve_shot(ShotCalc& calc, const unit::WeaponState& weapon, Rng& rng);

// Calculate effective range modifier.
// Closer = bonus, farther = penalty. Beyond weapon range = large penalty.
i32 calculate_range_modifier(i32 distance, i32 weapon_range);

// Height advantage: shooter above target = bonus, below = penalty
i32 calculate_height_modifier(i32 shooter_z, i32 target_z);

} // namespace dope::combat
