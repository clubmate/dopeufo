#include "camera.h"

#include <algorithm>

namespace dope::render {

Camera::Camera() = default;

Vec2f Camera::world_to_screen(const Vec2f& world) const {
    return Vec2f{
        (world.x - m_position.x) * m_zoom,
        (world.y - m_position.y) * m_zoom
    };
}

Vec2f Camera::screen_to_world(const Vec2f& screen) const {
    return Vec2f{
        screen.x / m_zoom + m_position.x,
        screen.y / m_zoom + m_position.y
    };
}

Vec2i Camera::screen_to_grid(const Vec2f& screen, i32 z) const {
    Vec2f world = screen_to_world(screen);
    return iso::screen_to_grid(world, z);
}

void Camera::pan(f32 dx, f32 dy) {
    m_position.x += dx / m_zoom;
    m_position.y += dy / m_zoom;
}

void Camera::set_position(f32 x, f32 y) {
    m_position = {x, y};
}

void Camera::center_on(const Vec3i& grid_pos, i32 screen_width, i32 screen_height) {
    Vec2f world = iso::grid_to_screen(grid_pos);
    m_position.x = world.x - static_cast<f32>(screen_width) / (2.0f * m_zoom);
    m_position.y = world.y - static_cast<f32>(screen_height) / (2.0f * m_zoom);
}

void Camera::zoom(f32 factor) {
    m_zoom = std::clamp(m_zoom * factor, MIN_ZOOM, MAX_ZOOM);
}

void Camera::set_zoom(f32 z) {
    m_zoom = std::clamp(z, MIN_ZOOM, MAX_ZOOM);
}

bool Camera::is_on_screen(const Vec2f& world_pos, i32 screen_width, i32 screen_height) const {
    Vec2f screen = world_to_screen(world_pos);
    f32 margin = static_cast<f32>(constants::TILE_WIDTH) * m_zoom;
    return screen.x > -margin && screen.x < static_cast<f32>(screen_width) + margin &&
           screen.y > -margin && screen.y < static_cast<f32>(screen_height) + margin;
}

} // namespace dope::render
