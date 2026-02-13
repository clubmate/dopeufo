#pragma once
// renderer.h — SDL2 renderer wrapper.

#include "../core/math.h"
#include "../core/types.h"

#include <SDL.h>
#include <memory>
#include <string>

namespace dope::render {

// RGBA color
struct Color {
    u8 r = 255, g = 255, b = 255, a = 255;

    static constexpr Color white()   { return {255, 255, 255, 255}; }
    static constexpr Color black()   { return {0, 0, 0, 255}; }
    static constexpr Color red()     { return {255, 0, 0, 255}; }
    static constexpr Color green()   { return {0, 255, 0, 255}; }
    static constexpr Color blue()    { return {0, 0, 255, 255}; }
    static constexpr Color yellow()  { return {255, 255, 0, 255}; }
    static constexpr Color cyan()    { return {0, 255, 255, 255}; }
    static constexpr Color magenta() { return {255, 0, 255, 255}; }
    static constexpr Color gray()    { return {128, 128, 128, 255}; }

    // Semi-transparent versions
    static constexpr Color fog_dark()    { return {0, 0, 0, 200}; }
    static constexpr Color fog_light()   { return {0, 0, 0, 100}; }
    static constexpr Color highlight()   { return {255, 255, 0, 80}; }
    static constexpr Color move_range()  { return {0, 100, 255, 80}; }
};

class Renderer {
public:
    Renderer();
    ~Renderer();

    // Initialize SDL, create window and renderer
    bool init(const std::string& title, i32 width = constants::SCREEN_WIDTH,
              i32 height = constants::SCREEN_HEIGHT);
    void shutdown();

    // Frame management
    void begin_frame();
    void end_frame();

    // --- Drawing primitives ---
    void set_draw_color(const Color& c);
    void clear(const Color& c = Color::black());
    void draw_rect(i32 x, i32 y, i32 w, i32 h, const Color& c);
    void fill_rect(i32 x, i32 y, i32 w, i32 h, const Color& c);
    void draw_line(i32 x1, i32 y1, i32 x2, i32 y2, const Color& c);
    void draw_point(i32 x, i32 y, const Color& c);

    // Isometric diamond (filled)
    void fill_iso_tile(i32 screen_x, i32 screen_y, const Color& c);
    // Isometric diamond (outline)
    void draw_iso_tile(i32 screen_x, i32 screen_y, const Color& c);

    // --- Texture (SDL_Texture wrapper) ---
    SDL_Texture* load_texture(const std::string& filepath);
    void draw_texture(SDL_Texture* tex, i32 x, i32 y, i32 w, i32 h);
    void draw_texture_ex(SDL_Texture* tex, const SDL_Rect& src, const SDL_Rect& dst);

    // --- Accessors ---
    SDL_Renderer* sdl_renderer() const { return m_renderer; }
    SDL_Window* sdl_window() const { return m_window; }
    i32 screen_width() const { return m_width; }
    i32 screen_height() const { return m_height; }
    bool is_initialized() const { return m_initialized; }

private:
    SDL_Window* m_window = nullptr;
    SDL_Renderer* m_renderer = nullptr;
    i32 m_width = 0;
    i32 m_height = 0;
    bool m_initialized = false;
};

} // namespace dope::render
