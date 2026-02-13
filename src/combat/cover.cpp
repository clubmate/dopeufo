#include "cover.h"

namespace dope::combat {

i32 get_cover_aim_penalty(CoverLevel level, bool is_hunkered) {
    i32 base = 0;
    switch (level) {
        case CoverLevel::None: base = 0; break;
        case CoverLevel::Half: base = constants::HALF_COVER_AIM_PENALTY; break;
        case CoverLevel::Full: base = constants::FULL_COVER_AIM_PENALTY; break;
    }
    if (is_hunkered && level != CoverLevel::None) {
        base *= constants::HUNKER_COVER_BONUS;
    }
    return base;
}

CoverInfo calculate_cover(const map::Map& game_map, const Vec3i& attacker_pos,
                          const Vec3i& defender_pos) {
    CoverInfo info;
    info.attack_direction = map::Map::compute_attack_direction(attacker_pos, defender_pos);
    info.level = game_map.get_cover_from_direction(defender_pos, info.attack_direction);
    info.aim_penalty = get_cover_aim_penalty(info.level);
    return info;
}

bool is_flanked(const map::Map& game_map, const Vec3i& defender_pos,
                const Vec3i& attacker_pos) {
    Direction attack_dir = map::Map::compute_attack_direction(attacker_pos, defender_pos);
    CoverLevel cover = game_map.get_cover_from_direction(defender_pos, attack_dir);
    return cover == CoverLevel::None;
}

} // namespace dope::combat
