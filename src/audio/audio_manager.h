#pragma once
// audio_manager.h — Audio system stub (SDL2_mixer).

#include "../core/types.h"

#include <string>
#include <unordered_map>

namespace dope::audio {

class AudioManager {
public:
    AudioManager();
    ~AudioManager();

    bool init();
    void shutdown();

    // --- Sound effects ---
    void load_sound(const std::string& name, const std::string& filepath);
    void play_sound(const std::string& name, i32 volume = 128);

    // --- Music ---
    void load_music(const std::string& filepath);
    void play_music(bool loop = true);
    void stop_music();
    void set_music_volume(i32 volume);

    // --- Master ---
    void set_master_volume(f32 volume); // 0.0 to 1.0
    f32 master_volume() const { return m_master_volume; }

    bool is_initialized() const { return m_initialized; }

private:
    bool m_initialized = false;
    f32 m_master_volume = 1.0f;

    // Sound/music handles would go here when SDL2_mixer is available
};

} // namespace dope::audio
