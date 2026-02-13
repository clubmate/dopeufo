#include "audio_manager.h"

#include <iostream>

#ifdef DOPE_HAS_SDL2_MIXER
#include <SDL_mixer.h>
#endif

namespace dope::audio {

AudioManager::AudioManager() = default;

AudioManager::~AudioManager() {
    shutdown();
}

bool AudioManager::init() {
#ifdef DOPE_HAS_SDL2_MIXER
    if (Mix_OpenAudio(44100, MIX_DEFAULT_FORMAT, 2, 2048) < 0) {
        std::cerr << "[Audio] SDL_mixer init failed: " << Mix_GetError() << "\n";
        return false;
    }
    m_initialized = true;
    std::cout << "[Audio] Initialized\n";
    return true;
#else
    std::cout << "[Audio] SDL2_mixer not available (audio disabled)\n";
    m_initialized = false;
    return false;
#endif
}

void AudioManager::shutdown() {
#ifdef DOPE_HAS_SDL2_MIXER
    if (m_initialized) {
        Mix_CloseAudio();
        m_initialized = false;
    }
#endif
}

void AudioManager::load_sound(const std::string& name, const std::string& filepath) {
    (void)name;
    (void)filepath;
    // TODO: Load with Mix_LoadWAV
}

void AudioManager::play_sound(const std::string& name, i32 volume) {
    (void)name;
    (void)volume;
    // TODO: Play with Mix_PlayChannel
}

void AudioManager::load_music(const std::string& filepath) {
    (void)filepath;
    // TODO: Load with Mix_LoadMUS
}

void AudioManager::play_music(bool loop) {
    (void)loop;
    // TODO: Play with Mix_PlayMusic
}

void AudioManager::stop_music() {
    // TODO: Mix_HaltMusic
}

void AudioManager::set_music_volume(i32 volume) {
    (void)volume;
    // TODO: Mix_VolumeMusic
}

void AudioManager::set_master_volume(f32 volume) {
    m_master_volume = (volume < 0.0f) ? 0.0f : (volume > 1.0f) ? 1.0f : volume;
}

} // namespace dope::audio
