#include "renderer.h"

#include <iostream>

#ifdef DOPE_HAS_SDL2_IMAGE
#include <SDL_image.h>
#endif

namespace dope::render {

Renderer::Renderer() = default;

Renderer::~Renderer() {
    shutdown();
}

bool Renderer::init(const std::string& title, i32 width, i32 height) {
    if (m_initialized) return true;

    m_width = width;
    m_height = height;

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_TIMER) != 0) {
        std::cerr << "[Renderer] SDL_Init failed: " << SDL_GetError() << "\n";
        return false;
    }

    m_window = SDL_CreateWindow(
        title.c_str(),
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        width, height,
        SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE
    );

    if (!m_window) {
        std::cerr << "[Renderer] Window creation failed: " << SDL_GetError() << "\n";
        return false;
    }

    m_renderer = SDL_CreateRenderer(
        m_window, -1,
        SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC
    );

    if (!m_renderer) {
        std::cerr << "[Renderer] Renderer creation failed: " << SDL_GetError() << "\n";
        return false;
    }

    // Enable alpha blending
    SDL_SetRenderDrawBlendMode(m_renderer, SDL_BLENDMODE_BLEND);

#ifdef DOPE_HAS_SDL2_IMAGE
    int img_flags = IMG_INIT_PNG;
    if (!(IMG_Init(img_flags) & img_flags)) {
        std::cerr << "[Renderer] SDL_image init failed: " << IMG_GetError() << "\n";
    }
#endif

    m_initialized = true;
    std::cout << "[Renderer] Initialized " << width << "x" << height << "\n";
    return true;
}

void Renderer::shutdown() {
    if (!m_initialized) return;

#ifdef DOPE_HAS_SDL2_IMAGE
    IMG_Quit();
#endif

    if (m_renderer) {
        SDL_DestroyRenderer(m_renderer);
        m_renderer = nullptr;
    }
    if (m_window) {
        SDL_DestroyWindow(m_window);
        m_window = nullptr;
    }
    SDL_Quit();
    m_initialized = false;
}

void Renderer::begin_frame() {
    clear();
}

void Renderer::end_frame() {
    SDL_RenderPresent(m_renderer);
}

void Renderer::set_draw_color(const Color& c) {
    SDL_SetRenderDrawColor(m_renderer, c.r, c.g, c.b, c.a);
}

void Renderer::clear(const Color& c) {
    set_draw_color(c);
    SDL_RenderClear(m_renderer);
}

void Renderer::draw_rect(i32 x, i32 y, i32 w, i32 h, const Color& c) {
    set_draw_color(c);
    SDL_Rect rect = {x, y, w, h};
    SDL_RenderDrawRect(m_renderer, &rect);
}

void Renderer::fill_rect(i32 x, i32 y, i32 w, i32 h, const Color& c) {
    set_draw_color(c);
    SDL_Rect rect = {x, y, w, h};
    SDL_RenderFillRect(m_renderer, &rect);
}

void Renderer::draw_line(i32 x1, i32 y1, i32 x2, i32 y2, const Color& c) {
    set_draw_color(c);
    SDL_RenderDrawLine(m_renderer, x1, y1, x2, y2);
}

void Renderer::draw_point(i32 x, i32 y, const Color& c) {
    set_draw_color(c);
    SDL_RenderDrawPoint(m_renderer, x, y);
}

void Renderer::fill_iso_tile(i32 screen_x, i32 screen_y, const Color& c) {
    // Draw a filled isometric diamond
    set_draw_color(c);
    i32 hw = constants::TILE_WIDTH / 2;
    i32 hh = constants::TILE_HEIGHT / 2;
    i32 cx = screen_x + hw;
    i32 cy = screen_y + hh;

    // Fill using horizontal lines (scanline)
    for (i32 dy = -hh; dy <= hh; dy++) {
        f32 t = 1.0f - static_cast<f32>(std::abs(dy)) / static_cast<f32>(hh);
        i32 half_width = static_cast<i32>(static_cast<f32>(hw) * t);
        SDL_RenderDrawLine(m_renderer, cx - half_width, cy + dy, cx + half_width, cy + dy);
    }
}

void Renderer::draw_iso_tile(i32 screen_x, i32 screen_y, const Color& c) {
    // Draw isometric diamond outline
    set_draw_color(c);
    i32 hw = constants::TILE_WIDTH / 2;
    i32 hh = constants::TILE_HEIGHT / 2;
    i32 cx = screen_x + hw;
    i32 cy = screen_y + hh;

    // Diamond: top → right → bottom → left → top
    SDL_RenderDrawLine(m_renderer, cx, cy - hh, cx + hw, cy);     // top → right
    SDL_RenderDrawLine(m_renderer, cx + hw, cy, cx, cy + hh);     // right → bottom
    SDL_RenderDrawLine(m_renderer, cx, cy + hh, cx - hw, cy);     // bottom → left
    SDL_RenderDrawLine(m_renderer, cx - hw, cy, cx, cy - hh);     // left → top
}

SDL_Texture* Renderer::load_texture(const std::string& filepath) {
#ifdef DOPE_HAS_SDL2_IMAGE
    SDL_Texture* tex = IMG_LoadTexture(m_renderer, filepath.c_str());
    if (!tex) {
        std::cerr << "[Renderer] Failed to load texture: " << filepath
                  << " - " << IMG_GetError() << "\n";
    }
    return tex;
#else
    (void)filepath;
    std::cerr << "[Renderer] SDL2_image not available, cannot load textures\n";
    return nullptr;
#endif
}

void Renderer::draw_texture(SDL_Texture* tex, i32 x, i32 y, i32 w, i32 h) {
    if (!tex) return;
    SDL_Rect dst = {x, y, w, h};
    SDL_RenderCopy(m_renderer, tex, nullptr, &dst);
}

void Renderer::draw_texture_ex(SDL_Texture* tex, const SDL_Rect& src, const SDL_Rect& dst) {
    if (!tex) return;
    SDL_RenderCopy(m_renderer, tex, &src, &dst);
}

} // namespace dope::render
