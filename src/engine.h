#pragma once
// engine.h — Top-level engine class that ties all systems together.

#include "audio/audio_manager.h"
#include "combat/action.h"
#include "combat/cover.h"
#include "combat/damage.h"
#include "combat/overwatch.h"
#include "core/command.h"
#include "core/ecs.h"
#include "core/event_bus.h"
#include "core/game_state.h"
#include "core/math.h"
#include "core/types.h"
#include "input/input_manager.h"
#include "map/map.h"
#include "map/map_generator.h"
#include "map/map_loader.h"
#include "map/pathfinding.h"
#include "net/network.h"
#include "render/camera.h"
#include "render/iso_renderer.h"
#include "render/renderer.h"
#include "turn/fog_of_war.h"
#include "turn/turn_manager.h"
#include "unit/unit.h"

#include <string>

namespace dope {

class Engine {
public:
    Engine();
    ~Engine();

    // --- Lifecycle ---
    bool init();
    void run();      // Main game loop
    void shutdown();

    // --- Setup ---
    void load_map(const std::string& filepath);
    void generate_map(const map::MapGenParams& params = {});
    void spawn_unit(PlayerId player, const Vec3i& pos, const std::string& unit_type = "soldier");
    void start_game();

    // --- Game loop steps ---
    void handle_input();
    void update(f32 dt);
    void render();

    // --- Command interface ---
    core::CommandResult submit_command(const core::Command& cmd);

private:
    void setup_event_handlers();
    void process_camera_input();
    void process_game_input();
    void update_fog_of_war();
    void check_win_condition();

    // Select a unit at the given grid position
    void select_unit_at(const Vec2i& grid_pos);
    void deselect_unit();

    // Systems
    render::Renderer m_renderer;
    render::Camera m_camera;
    render::IsoRenderer m_iso_renderer;
    input::InputManager m_input;
    audio::AudioManager m_audio;
    net::Network m_network;

    // Game state
    core::GameState m_game_state;
    turn::TurnManager m_turn_manager;
    turn::FogOfWar m_fog;
    map::Map m_map;

    // Selection
    EntityId m_selected_unit = INVALID_ENTITY;
    bool m_showing_move_range = false;

    // Loop control
    bool m_running = false;
    f32 m_target_fps = 60.0f;
};

} // namespace dope
