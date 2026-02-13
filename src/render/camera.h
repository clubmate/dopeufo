#pragma once
// camera.h — Isometric camera with pan and zoom.

#include "../core/math.h"
#include "../core/types.h"

namespace dope::render {

class Camera {
public:
    Camera();

    // --- Transform ---
    // Convert world (screen-space from grid_to_screen) to actual screen coordinates
    Vec2f world_to_screen(const Vec2f& world) const;

    // Convert actual screen coordinates to world coordinates
    Vec2f screen_to_world(const Vec2f& screen) const;

    // Convert screen mouse position to grid tile (at given Z-level)
    Vec2i screen_to_grid(const Vec2f& screen, i32 z = 0) const;

    // --- Pan ---
    void pan(f32 dx, f32 dy);
    void set_position(f32 x, f32 y);
    Vec2f position() const { return m_position; }

    // Center camera on a grid tile
    void center_on(const Vec3i& grid_pos, i32 screen_width, i32 screen_height);

    // --- Zoom ---
    void zoom(f32 factor);  // Multiply current zoom
    void set_zoom(f32 z);
    f32 zoom_level() const { return m_zoom; }

    // --- Z-level display ---
    void set_view_z(i32 z) { m_view_z = z; }
    i32 view_z() const { return m_view_z; }
    void view_z_up() { m_view_z++; }
    void view_z_down() { if (m_view_z > 0) m_view_z--; }

    // --- Viewport ---
    bool is_on_screen(const Vec2f& world_pos, i32 screen_width, i32 screen_height) const;

private:
    Vec2f m_position = {0.0f, 0.0f};   // Camera offset in world space
    f32 m_zoom = 1.0f;
    i32 m_view_z = 0;                   // Currently viewed Z-level

    static constexpr f32 MIN_ZOOM = 0.25f;
    static constexpr f32 MAX_ZOOM = 4.0f;
};

} // namespace dope::render
