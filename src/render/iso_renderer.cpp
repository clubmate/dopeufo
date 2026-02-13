#include "iso_renderer.h"

#include <algorithm>

namespace dope::render {

IsoRenderer::IsoRenderer() = default;

Color IsoRenderer::terrain_color(TerrainType terrain) const {
    switch (terrain) {
        case TerrainType::Open:   return {180, 180, 160, 255};
        case TerrainType::Grass:  return {80, 140, 60, 255};
        case TerrainType::Dirt:   return {160, 130, 80, 255};
        case TerrainType::Road:   return {120, 120, 120, 255};
        case TerrainType::Wall:   return {100, 80, 70, 255};
        case TerrainType::Window: return {120, 160, 200, 255};
        case TerrainType::Door:   return {140, 100, 60, 255};
        case TerrainType::Water:  return {40, 80, 180, 255};
        case TerrainType::Stairs: return {150, 150, 100, 255};
        case TerrainType::Ladder: return {170, 130, 80, 255};
        case TerrainType::Rubble: return {110, 100, 90, 255};
        case TerrainType::Void:   return {0, 0, 0, 0};
    }
    return {255, 0, 255, 255}; // Magenta = unknown
}

Color IsoRenderer::player_color(PlayerId player) const {
    switch (player) {
        case PlayerId::Player1: return {60, 120, 220, 255};  // Blue
        case PlayerId::Player2: return {220, 60, 60, 255};   // Red
        default:                return {200, 200, 200, 255};
    }
}

void IsoRenderer::render_tile(Renderer& renderer, const Camera& camera,
                               const map::Tile& tile, const Vec3i& pos,
                               turn::FogState fog_state) {
    if (tile.terrain == TerrainType::Void) return;
    if (fog_state == turn::FogState::Unknown) return;

    Vec2f world = iso::grid_to_screen(pos);
    Vec2f screen = camera.world_to_screen(world);

    i32 sx = static_cast<i32>(screen.x);
    i32 sy = static_cast<i32>(screen.y);

    // Base tile color
    Color col = terrain_color(tile.terrain);

    // Apply fog dimming
    if (fog_state == turn::FogState::Revealed) {
        col.r = static_cast<u8>(col.r / 2);
        col.g = static_cast<u8>(col.g / 2);
        col.b = static_cast<u8>(col.b / 2);
    }

    // Draw filled isometric tile
    renderer.fill_iso_tile(sx, sy, col);

    // Draw grid outline
    if (m_show_grid) {
        Color grid_col = {static_cast<u8>(col.r / 2), static_cast<u8>(col.g / 2),
                          static_cast<u8>(col.b / 2), 100};
        renderer.draw_iso_tile(sx, sy, grid_col);
    }

    // Draw wall height indicator (simple 3D effect for walls)
    if (tile.terrain == TerrainType::Wall) {
        i32 wall_h = constants::TILE_DEPTH;
        Color wall_side = {static_cast<u8>(col.r * 3 / 4), static_cast<u8>(col.g * 3 / 4),
                           static_cast<u8>(col.b * 3 / 4), 255};

        // Left side
        i32 hw = constants::TILE_WIDTH / 2;
        i32 hh = constants::TILE_HEIGHT / 2;
        // Bottom-left edge of diamond to bottom-left edge raised
        renderer.fill_rect(sx, sy + hh - wall_h, hw, wall_h, wall_side);
    }

    // Draw cover indicators
    auto draw_cover = [&](CoverLevel level, Direction dir) {
        if (level == CoverLevel::None) return;
        Color cov_col = (level == CoverLevel::Full)
                            ? Color{200, 200, 0, 180}   // Yellow for full
                            : Color{200, 200, 0, 100};  // Dim yellow for half

        i32 hw = constants::TILE_WIDTH / 2;
        i32 hh = constants::TILE_HEIGHT / 2;
        i32 cx = sx + hw;
        i32 cy = sy + hh;
        i32 th = 3; // Cover indicator thickness

        switch (dir) {
            case Direction::North:
                renderer.draw_line(cx - hw / 2, cy - hh / 2, cx, cy - hh, cov_col);
                break;
            case Direction::East:
                renderer.draw_line(cx + hw / 2, cy - hh / 2, cx + hw, cy, cov_col);
                break;
            case Direction::South:
                renderer.draw_line(cx, cy + hh, cx + hw / 2, cy + hh / 2, cov_col);
                break;
            case Direction::West:
                renderer.draw_line(cx - hw, cy, cx - hw / 2, cy + hh / 2, cov_col);
                break;
        }
        (void)th;
    };

    if (fog_state == turn::FogState::Visible) {
        draw_cover(tile.cover.north, Direction::North);
        draw_cover(tile.cover.east, Direction::East);
        draw_cover(tile.cover.south, Direction::South);
        draw_cover(tile.cover.west, Direction::West);
    }
}

void IsoRenderer::render_unit(Renderer& renderer, const Camera& camera,
                               EntityId id, const unit::Position& pos,
                               const unit::Ownership& own,
                               const unit::Health* health,
                               bool is_selected) {
    Vec2f world = iso::grid_to_screen(pos.pos);
    Vec2f screen = camera.world_to_screen(world);

    i32 sx = static_cast<i32>(screen.x);
    i32 sy = static_cast<i32>(screen.y);

    // Unit size (centered in tile)
    i32 unit_w = 24;
    i32 unit_h = 32;
    i32 ux = sx + constants::TILE_WIDTH / 2 - unit_w / 2;
    i32 uy = sy + constants::TILE_HEIGHT / 2 - unit_h;

    // Draw unit body (colored rectangle as placeholder)
    Color col = player_color(own.player);
    renderer.fill_rect(ux, uy, unit_w, unit_h, col);

    // Selection indicator
    if (is_selected) {
        Color sel_col = Color::yellow();
        renderer.draw_rect(ux - 2, uy - 2, unit_w + 4, unit_h + 4, sel_col);
    }

    // Health bar
    if (health) {
        i32 bar_w = unit_w;
        i32 bar_h = 3;
        i32 bar_x = ux;
        i32 bar_y = uy - 5;

        // Background
        renderer.fill_rect(bar_x, bar_y, bar_w, bar_h, Color::black());

        // Health fill
        i32 fill_w = static_cast<i32>(static_cast<f32>(bar_w) * health->ratio());
        Color hp_col = (health->ratio() > 0.5f) ? Color::green()
                     : (health->ratio() > 0.25f) ? Color::yellow()
                                                  : Color::red();
        renderer.fill_rect(bar_x, bar_y, fill_w, bar_h, hp_col);
    }

    (void)id;
}

void IsoRenderer::render_overlays(Renderer& renderer, const Camera& camera) {
    // Movement range overlay
    if (m_show_movement_range) {
        for (const auto& tile_pos : m_movement_tiles) {
            Vec2f world = iso::grid_to_screen(tile_pos);
            Vec2f screen = camera.world_to_screen(world);
            i32 sx = static_cast<i32>(screen.x);
            i32 sy = static_cast<i32>(screen.y);
            renderer.fill_iso_tile(sx, sy, Color::move_range());
        }
    }

    // Highlighted tile
    if (m_has_highlight) {
        Vec2f world = iso::grid_to_screen(m_highlighted_tile);
        Vec2f screen = camera.world_to_screen(world);
        i32 sx = static_cast<i32>(screen.x);
        i32 sy = static_cast<i32>(screen.y);
        renderer.draw_iso_tile(sx, sy, Color::white());
    }
}

void IsoRenderer::render(
    Renderer& renderer,
    const Camera& camera,
    const map::Map& game_map,
    const core::Registry& reg,
    const turn::FogOfWar& fog,
    PlayerId viewing_player) {

    i32 view_z = camera.view_z();

    // --- Render tiles (depth sorted: back to front) ---
    // In isometric view, tiles with lower (x+y) are further from camera
    for (i32 z = 0; z <= view_z && z < game_map.depth(); z++) {
        for (i32 y = 0; y < game_map.height(); y++) {
            for (i32 x = 0; x < game_map.width(); x++) {
                Vec3i pos{x, y, z};
                const auto& tile = game_map.at(pos);
                turn::FogState fog_state = fog.get_state(viewing_player, pos);
                render_tile(renderer, camera, tile, pos, fog_state);
            }
        }
    }

    // --- Render overlays (movement range, cursor) ---
    render_overlays(renderer, camera);

    // --- Render units (depth sorted) ---
    // Collect visible units and sort by depth
    struct UnitDraw {
        EntityId id;
        unit::Position pos;
        unit::Ownership own;
        const unit::Health* health;
        i32 depth_key;
    };
    std::vector<UnitDraw> units_to_draw;

    reg.each<unit::Position>([&](EntityId id, const unit::Position& pos) {
        // Only draw units on visible Z-levels
        if (pos.pos.z > view_z) return;

        auto* own = reg.try_get_component<unit::Ownership>(id);
        if (!own) return;

        auto* health = reg.try_get_component<unit::Health>(id);
        if (health && !health->is_alive()) return;

        // Fog check: only show enemy units in visible tiles
        if (own->player != viewing_player) {
            if (!fog.is_entity_visible(viewing_player, pos.pos)) return;
        }

        i32 depth = pos.pos.x + pos.pos.y + pos.pos.z * 100;
        units_to_draw.push_back({id, pos, *own, health, depth});
    });

    // Sort by depth (painter's algorithm)
    std::sort(units_to_draw.begin(), units_to_draw.end(),
              [](const UnitDraw& a, const UnitDraw& b) { return a.depth_key < b.depth_key; });

    for (const auto& ud : units_to_draw) {
        bool selected = (ud.id == m_selected_unit);
        render_unit(renderer, camera, ud.id, ud.pos, ud.own, ud.health, selected);
    }
}

} // namespace dope::render
