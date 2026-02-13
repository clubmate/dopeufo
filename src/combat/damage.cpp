#include "damage.h"

#include <algorithm>
#include <cmath>

namespace dope::combat {

i32 calculate_range_modifier(i32 distance, i32 weapon_range) {
    if (distance <= 0) return 0;

    // Close range bonus (within 1/3 of weapon range)
    if (distance <= weapon_range / 3) {
        return 10;
    }
    // Optimal range (within weapon range) — no modifier
    if (distance <= weapon_range) {
        return 0;
    }
    // Beyond range — increasing penalty
    i32 over = distance - weapon_range;
    return -(over * 10);
}

i32 calculate_height_modifier(i32 shooter_z, i32 target_z) {
    i32 diff = shooter_z - target_z;
    if (diff > 0) {
        // Shooting down — height advantage
        return std::min(diff * 10, 20);
    } else if (diff < 0) {
        // Shooting up — height disadvantage
        return std::max(diff * 5, -10);
    }
    return 0;
}

ShotCalc calculate_shot(
    const map::Map& game_map,
    const Vec3i& shooter_pos,
    const Vec3i& target_pos,
    const unit::Stats& shooter_stats,
    const unit::Stats& target_stats,
    const unit::WeaponState& weapon,
    bool target_hunkered,
    bool is_overwatch) {
    ShotCalc calc;

    // Base accuracy
    calc.base_accuracy = shooter_stats.accuracy;

    // Range
    i32 distance = shooter_pos.chebyshev_distance_xy(target_pos) + std::abs(shooter_pos.z - target_pos.z);
    calc.range_modifier = calculate_range_modifier(distance, weapon.range);

    // Cover
    CoverInfo cover = calculate_cover(game_map, shooter_pos, target_pos);
    calc.cover_penalty = get_cover_aim_penalty(cover.level, target_hunkered);

    // Height
    calc.height_modifier = calculate_height_modifier(shooter_pos.z, target_pos.z);

    // Overwatch penalty
    calc.overwatch_penalty = is_overwatch ? constants::OVERWATCH_AIM_PENALTY : 0;

    // Final hit chance
    calc.final_hit_chance = calc.base_accuracy
                            + calc.range_modifier
                            - calc.cover_penalty
                            + calc.height_modifier
                            - calc.overwatch_penalty;

    // Subtract dodge
    calc.final_hit_chance -= target_stats.dodge;

    // Clamp to [5, 95] — always a chance to hit or miss
    calc.final_hit_chance = std::clamp(calc.final_hit_chance, 5, 95);

    return calc;
}

void resolve_shot(ShotCalc& calc, const unit::WeaponState& weapon, Rng& rng) {
    // Hit roll
    i32 roll = rng.range(1, 100);
    calc.hit = (roll <= calc.final_hit_chance);

    if (!calc.hit) {
        calc.damage = 0;
        calc.final_damage = 0;
        return;
    }

    // Critical check
    i32 crit_roll = rng.range(1, 100);
    calc.critical = (crit_roll <= weapon.crit_chance);

    // Damage roll
    calc.damage = rng.range(weapon.damage_min, weapon.damage_max);
    if (calc.critical) {
        calc.damage = static_cast<i32>(static_cast<f32>(calc.damage) * 1.5f);
    }

    // Armor reduction
    // (armor value will be applied by the caller, stored here for logging)
    calc.armor_reduction = 0;
    calc.final_damage = calc.damage;
}

} // namespace dope::combat
