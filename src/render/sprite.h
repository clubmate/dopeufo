#pragma once
// sprite.h — Sprite sheet and animation system (placeholder for future art).

#include "../core/types.h"

#include <SDL.h>
#include <string>
#include <unordered_map>
#include <vector>

namespace dope::render {

struct SpriteFrame {
    i32 x, y, w, h;     // Source rect in sprite sheet
    i32 offset_x = 0;   // Draw offset from tile center
    i32 offset_y = 0;
};

struct Animation {
    std::string name;
    std::vector<SpriteFrame> frames;
    f32 frame_duration = 0.1f;  // Seconds per frame
    bool looping = true;
};

class SpriteSheet {
public:
    SpriteSheet() = default;

    // Load sprite sheet texture (requires Renderer for texture creation)
    bool load(SDL_Renderer* renderer, const std::string& filepath,
              i32 frame_w, i32 frame_h);

    // Add a named animation
    void add_animation(const std::string& name, const Animation& anim);

    // Get animation by name
    const Animation* get_animation(const std::string& name) const;

    // Get current frame based on time
    const SpriteFrame* get_frame(const std::string& anim_name, f32 time) const;

    SDL_Texture* texture() const { return m_texture; }

private:
    SDL_Texture* m_texture = nullptr;
    i32 m_frame_w = 0;
    i32 m_frame_h = 0;
    std::unordered_map<std::string, Animation> m_animations;
};

// Sprite instance (attached to an entity as a component or used standalone)
struct SpriteInstance {
    std::string sheet_name;
    std::string current_anim;
    f32 anim_time = 0.0f;
    bool playing = true;
    bool flip_h = false;

    void update(f32 dt) {
        if (playing) {
            anim_time += dt;
        }
    }

    void play(const std::string& anim) {
        if (current_anim != anim) {
            current_anim = anim;
            anim_time = 0.0f;
            playing = true;
        }
    }
};

} // namespace dope::render
