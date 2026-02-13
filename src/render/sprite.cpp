#include "sprite.h"

#include <iostream>

#ifdef DOPE_HAS_SDL2_IMAGE
#include <SDL_image.h>
#endif

namespace dope::render {

bool SpriteSheet::load(SDL_Renderer* renderer, const std::string& filepath,
                       i32 frame_w, i32 frame_h) {
#ifdef DOPE_HAS_SDL2_IMAGE
    m_texture = IMG_LoadTexture(renderer, filepath.c_str());
    if (!m_texture) {
        std::cerr << "[SpriteSheet] Failed to load: " << filepath << "\n";
        return false;
    }
    m_frame_w = frame_w;
    m_frame_h = frame_h;
    return true;
#else
    (void)renderer;
    (void)filepath;
    (void)frame_w;
    (void)frame_h;
    std::cerr << "[SpriteSheet] SDL2_image not available\n";
    return false;
#endif
}

void SpriteSheet::add_animation(const std::string& name, const Animation& anim) {
    m_animations[name] = anim;
}

const Animation* SpriteSheet::get_animation(const std::string& name) const {
    auto it = m_animations.find(name);
    return (it != m_animations.end()) ? &it->second : nullptr;
}

const SpriteFrame* SpriteSheet::get_frame(const std::string& anim_name, f32 time) const {
    const Animation* anim = get_animation(anim_name);
    if (!anim || anim->frames.empty()) return nullptr;

    f32 total_duration = anim->frame_duration * static_cast<f32>(anim->frames.size());
    f32 t = time;

    if (anim->looping) {
        t = std::fmod(t, total_duration);
        if (t < 0) t += total_duration;
    } else {
        t = std::min(t, total_duration - 0.001f);
    }

    i32 frame_idx = static_cast<i32>(t / anim->frame_duration);
    frame_idx = std::clamp(frame_idx, 0, static_cast<i32>(anim->frames.size()) - 1);

    return &anim->frames[static_cast<size_t>(frame_idx)];
}

} // namespace dope::render
