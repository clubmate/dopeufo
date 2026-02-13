#include "fog_of_war.h"

#include <algorithm>

namespace dope::turn {

FogOfWar::FogOfWar() = default;

void FogOfWar::init(i32 width, i32 height, i32 depth) {
    m_width = width;
    m_height = height;
    m_depth = depth;

    size_t total = static_cast<size_t>(width * height * depth);
    m_fog_p1.assign(total, FogState::Unknown);
    m_fog_p2.assign(total, FogState::Unknown);
}

void FogOfWar::update(PlayerId player, const core::Registry& reg, const map::Map& game_map) {
    auto& fog = fog_for(player);

    // Downgrade all Visible tiles to Revealed (they were visible last update)
    for (auto& state : fog) {
        if (state == FogState::Visible) {
            state = FogState::Revealed;
        }
    }

    // For each living unit of this player, mark tiles in their LoS as Visible
    reg.each<unit::Ownership>([&](EntityId id, const unit::Ownership& own) {
        if (own.player != player) return;

        auto* health = reg.try_get_component<unit::Health>(id);
        if (!health || !health->is_alive()) return;

        auto* pos = reg.try_get_component<unit::Position>(id);
        auto* stats = reg.try_get_component<unit::Stats>(id);
        if (!pos || !stats) return;

        // Get all tiles visible from this unit's position
        auto visible = map::get_visible_tiles(game_map, pos->pos, stats->sight_range);
        for (const auto& tile : visible) {
            i32 idx = index(tile);
            if (idx >= 0 && idx < static_cast<i32>(fog.size())) {
                fog[static_cast<size_t>(idx)] = FogState::Visible;
            }
        }
    });
}

FogState FogOfWar::get_state(PlayerId player, const Vec3i& pos) const {
    const auto& fog = fog_for(player);
    i32 idx = index(pos);
    if (idx < 0 || idx >= static_cast<i32>(fog.size())) return FogState::Unknown;
    return fog[static_cast<size_t>(idx)];
}

bool FogOfWar::is_visible(PlayerId player, const Vec3i& pos) const {
    return get_state(player, pos) == FogState::Visible;
}

bool FogOfWar::is_revealed(PlayerId player, const Vec3i& pos) const {
    auto state = get_state(player, pos);
    return state == FogState::Visible || state == FogState::Revealed;
}

bool FogOfWar::is_entity_visible(PlayerId player, const Vec3i& entity_pos) const {
    return is_visible(player, entity_pos);
}

std::vector<Vec3i> FogOfWar::get_visible_tiles(PlayerId player) const {
    std::vector<Vec3i> result;
    const auto& fog = fog_for(player);

    for (i32 z = 0; z < m_depth; z++) {
        for (i32 y = 0; y < m_height; y++) {
            for (i32 x = 0; x < m_width; x++) {
                Vec3i pos{x, y, z};
                i32 idx = index(pos);
                if (fog[static_cast<size_t>(idx)] == FogState::Visible) {
                    result.push_back(pos);
                }
            }
        }
    }
    return result;
}

i32 FogOfWar::index(const Vec3i& pos) const {
    if (pos.x < 0 || pos.x >= m_width || pos.y < 0 || pos.y >= m_height ||
        pos.z < 0 || pos.z >= m_depth) {
        return -1;
    }
    return pos.z * m_width * m_height + pos.y * m_width + pos.x;
}

std::vector<FogState>& FogOfWar::fog_for(PlayerId player) {
    return (player == PlayerId::Player1) ? m_fog_p1 : m_fog_p2;
}

const std::vector<FogState>& FogOfWar::fog_for(PlayerId player) const {
    return (player == PlayerId::Player1) ? m_fog_p1 : m_fog_p2;
}

} // namespace dope::turn
