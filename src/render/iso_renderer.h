#pragma once
// iso_renderer.h — Isometric map and entity renderer.
//
// Handles depth-sorted rendering of tiles and units in isometric view.
// Currently renders colored shapes as placeholders (no sprite art yet).

#include "../core/ecs.h"
#include "../core/types.h"
#include "../map/map.h"
#include "../turn/fog_of_war.h"
#include "../unit/unit.h"
#include "camera.h"
#include "renderer.h"

#include <vector>

namespace dope::render {

class IsoRenderer {
public:
    IsoRenderer();

    // Render the full scene: map tiles + units + overlays
    void render(
        Renderer& renderer,
        const Camera& camera,
        const map::Map& game_map,
        const core::Registry& reg,
        const turn::FogOfWar& fog,
        PlayerId viewing_player
    );

    // --- Overlay toggles ---
    void set_show_grid(bool show) { m_show_grid = show; }
    void set_show_movement_range(bool show) { m_show_movement_range = show; }
    void set_movement_range(const std::vector<Vec3i>& tiles) { m_movement_tiles = tiles; }
    void clear_movement_range() { m_movement_tiles.clear(); }

    // Highlight a specific tile (cursor hover, selected unit, etc.)
    void set_highlighted_tile(const Vec3i& pos) { m_highlighted_tile = pos; m_has_highlight = true; }
    void clear_highlight() { m_has_highlight = false; }

    // Set the selected unit (for rendering selection indicator)
    void set_selected_unit(EntityId id) { m_selected_unit = id; }
    void clear_selected_unit() { m_selected_unit = INVALID_ENTITY; }

private:
    void render_tile(Renderer& renderer, const Camera& camera,
                     const map::Tile& tile, const Vec3i& pos,
                     turn::FogState fog_state);

    void render_unit(Renderer& renderer, const Camera& camera,
                     EntityId id, const unit::Position& pos,
                     const unit::Ownership& own,
                     const unit::Health* health,
                     bool is_selected);

    void render_overlays(Renderer& renderer, const Camera& camera);
    void render_cursor(Renderer& renderer, const Camera& camera);

    Color terrain_color(TerrainType terrain) const;
    Color player_color(PlayerId player) const;

    bool m_show_grid = true;
    bool m_show_movement_range = false;
    bool m_has_highlight = false;

    Vec3i m_highlighted_tile;
    EntityId m_selected_unit = INVALID_ENTITY;
    std::vector<Vec3i> m_movement_tiles;
};

} // namespace dope::render
