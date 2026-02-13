#include "engine.h"

#include "map/line_of_sight.h"

#include <iostream>
#include <SDL.h>

namespace dope {

Engine::Engine() = default;

Engine::~Engine() {
    shutdown();
}

bool Engine::init() {
    std::cout << "[Engine] Initializing dopeufo engine...\n";

    if (!m_renderer.init("dopeufo — Tactical Combat Engine")) {
        return false;
    }

    m_audio.init(); // Non-fatal if it fails

    setup_event_handlers();

    std::cout << "[Engine] Initialization complete\n";
    return true;
}

void Engine::shutdown() {
    m_audio.shutdown();
    m_renderer.shutdown();
    std::cout << "[Engine] Shutdown complete\n";
}

void Engine::setup_event_handlers() {
    auto& events = m_game_state.events();

    events.subscribe<core::UnitDied>([this](const core::UnitDied& e) {
        std::cout << "[Event] Unit " << e.entity << " killed by " << e.killer << "\n";
        // Remove from map occupancy
        auto* pos = m_game_state.registry().try_get_component<unit::Position>(e.entity);
        if (pos) {
            m_map.clear_occupant(pos->pos);
        }
        // Deselect if selected
        if (m_selected_unit == e.entity) {
            deselect_unit();
        }
    });

    events.subscribe<core::UnitMoved>([this](const core::UnitMoved& e) {
        // Update map occupancy
        m_map.clear_occupant(e.from);
        m_map.set_occupant(e.to, e.entity);
        // Update fog of war after movement
        update_fog_of_war();
    });

    events.subscribe<core::ShotFired>([this](const core::ShotFired& e) {
        std::cout << "[Event] Shot: " << e.shooter << " → " << e.target
                  << (e.hit ? " HIT" : " MISS")
                  << " (chance: " << e.hit_chance << "%, dmg: " << e.damage << ")\n";
    });

    events.subscribe<core::TurnStarted>([this](const core::TurnStarted& e) {
        std::string player = (e.player == PlayerId::Player1) ? "Player 1" : "Player 2";
        std::cout << "[Turn] " << player << "'s turn (turn " << e.turn_number << ")\n";
        deselect_unit();
        update_fog_of_war();
    });

    events.subscribe<core::GameOver>([this](const core::GameOver& e) {
        std::string winner = (e.winner == PlayerId::Player1)  ? "Player 1"
                           : (e.winner == PlayerId::Player2) ? "Player 2"
                                                             : "Draw";
        std::cout << "[Game Over] " << winner << " wins! (" << e.reason << ")\n";
    });
}

void Engine::load_map(const std::string& filepath) {
    m_map = map::load_map_from_file(filepath);
    if (m_map.width() == 0) {
        std::cerr << "[Engine] Failed to load map, generating test map\n";
        generate_map();
    }
    m_fog.init(m_map.width(), m_map.height(), m_map.depth());

    // Center camera on map
    Vec3i center = {m_map.width() / 2, m_map.height() / 2, 0};
    m_camera.center_on(center, m_renderer.screen_width(), m_renderer.screen_height());
}

void Engine::generate_map(const map::MapGenParams& params) {
    m_map = map::generate_map(params);
    m_fog.init(m_map.width(), m_map.height(), m_map.depth());

    Vec3i center = {m_map.width() / 2, m_map.height() / 2, 0};
    m_camera.center_on(center, m_renderer.screen_width(), m_renderer.screen_height());

    std::cout << "[Engine] Generated map '" << m_map.name << "' ("
              << m_map.width() << "x" << m_map.height() << "x" << m_map.depth() << ")\n";
}

void Engine::spawn_unit(PlayerId player, const Vec3i& pos, const std::string& unit_type) {
    auto& reg = m_game_state.registry();
    EntityId id = reg.create_entity();

    reg.add_component(id, unit::Position{pos});
    reg.add_component(id, unit::Ownership{player});
    reg.add_component(id, unit::Health{100, 100});
    reg.add_component(id, unit::ActionState{constants::ACTIONS_PER_TURN, false, false, false});

    // Configure based on unit type
    unit::Stats stats;
    unit::WeaponState weapon;

    if (unit_type == "sniper") {
        stats.accuracy = 80;
        stats.mobility = 4;
        stats.sight_range = 18;
        stats.damage_min = 5;
        stats.damage_max = 8;
        weapon.weapon_name = "Sniper Rifle";
        weapon.ammo_max = 3;
        weapon.ammo_current = 3;
        weapon.range = 20;
        weapon.damage_min = 5;
        weapon.damage_max = 8;
        weapon.crit_chance = 25;
    } else if (unit_type == "heavy") {
        stats.accuracy = 55;
        stats.mobility = 4;
        stats.armor = 2;
        stats.sight_range = 10;
        stats.damage_min = 4;
        stats.damage_max = 7;
        weapon.weapon_name = "LMG";
        weapon.ammo_max = 6;
        weapon.ammo_current = 6;
        weapon.range = 12;
        weapon.damage_min = 4;
        weapon.damage_max = 7;
        weapon.crit_chance = 5;
    } else if (unit_type == "medic") {
        stats.accuracy = 60;
        stats.mobility = 7;
        stats.sight_range = 12;
        stats.damage_min = 2;
        stats.damage_max = 4;
        weapon.weapon_name = "SMG";
        weapon.ammo_max = 5;
        weapon.ammo_current = 5;
        weapon.range = 10;
        weapon.damage_min = 2;
        weapon.damage_max = 4;
        weapon.crit_chance = 8;
    } else {
        // Default: rifleman / soldier
        stats.accuracy = 65;
        stats.mobility = 6;
        stats.sight_range = 14;
        stats.damage_min = 3;
        stats.damage_max = 5;
        weapon.weapon_name = "Rifle";
        weapon.ammo_max = 4;
        weapon.ammo_current = 4;
        weapon.range = 15;
        weapon.damage_min = 3;
        weapon.damage_max = 5;
        weapon.crit_chance = 10;
    }

    reg.add_component(id, stats);
    reg.add_component(id, weapon);

    unit::UnitInfo info;
    info.unit_class = unit_type;
    info.name = unit_type + "_" + std::to_string(id);
    reg.add_component(id, info);

    // Place on map
    m_map.set_occupant(pos, id);

    std::cout << "[Engine] Spawned " << unit_type << " for "
              << ((player == PlayerId::Player1) ? "P1" : "P2")
              << " at (" << pos.x << "," << pos.y << "," << pos.z << ") id=" << id << "\n";
}

void Engine::start_game() {
    m_game_state.begin_game();
    m_turn_manager.init(PlayerId::Player1);
    m_turn_manager.start_turn(m_game_state.registry(), m_game_state.events());
    update_fog_of_war();
}

void Engine::run() {
    m_running = true;
    u32 last_time = SDL_GetTicks();

    while (m_running) {
        u32 current_time = SDL_GetTicks();
        f32 dt = static_cast<f32>(current_time - last_time) / 1000.0f;
        last_time = current_time;

        // Cap delta time
        if (dt > 0.1f) dt = 0.1f;

        handle_input();
        update(dt);
        render();

        // Frame rate limiting
        u32 frame_time = SDL_GetTicks() - current_time;
        u32 target_ms = static_cast<u32>(1000.0f / m_target_fps);
        if (frame_time < target_ms) {
            SDL_Delay(target_ms - frame_time);
        }
    }
}

void Engine::handle_input() {
    if (!m_input.poll_events(m_camera, m_camera.view_z())) {
        m_running = false;
        return;
    }

    process_camera_input();
    process_game_input();
}

void Engine::process_camera_input() {
    // Pan
    if (m_input.is_action_pressed(input::InputAction::PanLeft)) {
        m_camera.pan(-m_input.pan_speed, 0);
    }
    if (m_input.is_action_pressed(input::InputAction::PanRight)) {
        m_camera.pan(m_input.pan_speed, 0);
    }
    if (m_input.is_action_pressed(input::InputAction::PanUp)) {
        m_camera.pan(0, -m_input.pan_speed);
    }
    if (m_input.is_action_pressed(input::InputAction::PanDown)) {
        m_camera.pan(0, m_input.pan_speed);
    }

    // Zoom
    if (m_input.is_action_pressed(input::InputAction::ZoomIn)) {
        m_camera.zoom(1.0f + m_input.zoom_speed);
    }
    if (m_input.is_action_pressed(input::InputAction::ZoomOut)) {
        m_camera.zoom(1.0f - m_input.zoom_speed);
    }

    // Z-level
    if (m_input.is_action_pressed(input::InputAction::ZLevelUp)) {
        if (m_camera.view_z() < m_map.depth() - 1) {
            m_camera.view_z_up();
        }
    }
    if (m_input.is_action_pressed(input::InputAction::ZLevelDown)) {
        m_camera.view_z_down();
    }

    // Grid toggle
    if (m_input.is_action_pressed(input::InputAction::ToggleGrid)) {
        static bool grid = true;
        grid = !grid;
        m_iso_renderer.set_show_grid(grid);
    }

    // Update cursor highlight
    Vec2i grid = m_input.mouse().grid_pos;
    Vec3i grid3 = {grid.x, grid.y, m_camera.view_z()};
    if (m_map.in_bounds(grid3)) {
        m_iso_renderer.set_highlighted_tile(grid3);
    } else {
        m_iso_renderer.clear_highlight();
    }
}

void Engine::process_game_input() {
    if (m_game_state.phase() != GamePhase::Playing) return;

    PlayerId active = m_turn_manager.active_player();
    auto& reg = m_game_state.registry();

    // Left click: select unit or move
    if (m_input.is_action_pressed(input::InputAction::LeftClick)) {
        Vec2i grid = m_input.mouse().grid_pos;
        Vec3i grid3 = {grid.x, grid.y, m_camera.view_z()};

        if (!m_map.in_bounds(grid3)) return;

        if (m_selected_unit != INVALID_ENTITY) {
            // If we have a selected unit, try to move there
            auto result = combat::validate_move(
                reg, m_map, m_selected_unit, grid3, active);

            if (result == core::CommandResult::Success) {
                auto* pos = reg.try_get_component<unit::Position>(m_selected_unit);
                auto* stats = reg.try_get_component<unit::Stats>(m_selected_unit);
                if (pos && stats) {
                    auto path_result = map::find_path(
                        m_map, pos->pos, grid3, stats->mobility, m_selected_unit);

                    core::MoveCommand move_cmd;
                    move_cmd.entity = m_selected_unit;
                    move_cmd.target = grid3;
                    move_cmd.path = path_result.path;
                    submit_command(move_cmd);
                }
            } else {
                // Try selecting a different unit at clicked position
                select_unit_at(grid);
            }
        } else {
            // No unit selected, try to select one
            select_unit_at(grid);
        }
    }

    // Right click: shoot / context action
    if (m_input.is_action_pressed(input::InputAction::RightClick)) {
        if (m_selected_unit != INVALID_ENTITY) {
            Vec2i grid = m_input.mouse().grid_pos;
            Vec3i grid3 = {grid.x, grid.y, m_camera.view_z()};

            if (m_map.in_bounds(grid3)) {
                EntityId target = m_map.get_occupant(grid3);
                if (target != INVALID_ENTITY && target != m_selected_unit) {
                    auto result = combat::validate_shot(
                        reg, m_map, m_selected_unit, target, active);

                    if (result == core::CommandResult::Success) {
                        core::ShootCommand shoot_cmd;
                        shoot_cmd.shooter = m_selected_unit;
                        shoot_cmd.target = target;
                        shoot_cmd.rng_seed = m_game_state.rng().next();
                        submit_command(shoot_cmd);
                    }
                }
            }
        }
    }

    // Cancel / deselect
    if (m_input.is_action_pressed(input::InputAction::CancelAction)) {
        deselect_unit();
    }

    // Overwatch
    if (m_input.is_action_pressed(input::InputAction::Overwatch)) {
        if (m_selected_unit != INVALID_ENTITY) {
            auto result = combat::validate_overwatch(reg, m_selected_unit, active);
            if (result == core::CommandResult::Success) {
                submit_command(core::OverwatchCommand{m_selected_unit});
            }
        }
    }

    // Reload
    if (m_input.is_action_pressed(input::InputAction::Reload)) {
        if (m_selected_unit != INVALID_ENTITY) {
            submit_command(core::ReloadCommand{m_selected_unit});
        }
    }

    // Hunker down
    if (m_input.is_action_pressed(input::InputAction::HunkerDown)) {
        if (m_selected_unit != INVALID_ENTITY) {
            submit_command(core::HunkerDownCommand{m_selected_unit});
        }
    }

    // End turn
    if (m_input.is_action_pressed(input::InputAction::EndTurn)) {
        submit_command(core::EndTurnCommand{active});
    }
}

void Engine::select_unit_at(const Vec2i& grid_pos) {
    Vec3i pos3 = {grid_pos.x, grid_pos.y, m_camera.view_z()};
    if (!m_map.in_bounds(pos3)) return;

    EntityId entity = m_map.get_occupant(pos3);
    if (entity == INVALID_ENTITY) {
        deselect_unit();
        return;
    }

    // Only select own units
    auto* own = m_game_state.registry().try_get_component<unit::Ownership>(entity);
    if (!own || own->player != m_turn_manager.active_player()) {
        deselect_unit();
        return;
    }

    m_selected_unit = entity;
    m_iso_renderer.set_selected_unit(entity);

    // Show movement range
    auto* pos = m_game_state.registry().try_get_component<unit::Position>(entity);
    auto* stats = m_game_state.registry().try_get_component<unit::Stats>(entity);
    auto* actions = m_game_state.registry().try_get_component<unit::ActionState>(entity);

    if (pos && stats && actions && actions->can_move()) {
        auto reachable = map::get_reachable_tiles(m_map, pos->pos, stats->mobility, entity);
        std::vector<Vec3i> tiles;
        tiles.reserve(reachable.size());
        for (const auto& [tile, cost] : reachable) {
            tiles.push_back(tile);
        }
        m_iso_renderer.set_movement_range(tiles);
        m_iso_renderer.set_show_movement_range(true);
    } else {
        m_iso_renderer.set_show_movement_range(false);
    }

    std::cout << "[Select] Unit " << entity << " selected\n";
}

void Engine::deselect_unit() {
    m_selected_unit = INVALID_ENTITY;
    m_iso_renderer.clear_selected_unit();
    m_iso_renderer.set_show_movement_range(false);
    m_iso_renderer.clear_movement_range();
}

core::CommandResult Engine::submit_command(const core::Command& cmd) {
    core::CommandResult result = m_game_state.execute(cmd);

    if (result == core::CommandResult::Success) {
        // After successful command, update state
        check_win_condition();

        // Refresh selection (unit may have used actions)
        if (m_selected_unit != INVALID_ENTITY) {
            auto* actions = m_game_state.registry().try_get_component<unit::ActionState>(
                m_selected_unit);
            if (!actions || !actions->can_act()) {
                deselect_unit();
            } else {
                // Refresh movement range display
                select_unit_at(
                    m_game_state.registry()
                        .get_component<unit::Position>(m_selected_unit)
                        .pos.xy());
            }
        }

        // Send command to network peer
        if (m_network.is_connected()) {
            m_network.send_command(cmd);
        }
    }

    return result;
}

void Engine::update(f32 /*dt*/) {
    // Process queued events
    m_game_state.events().flush();

    // Poll network
    if (m_network.is_connected()) {
        auto messages = m_network.poll();
        // TODO: Process incoming network commands
    }
}

void Engine::render() {
    m_renderer.begin_frame();

    PlayerId viewing = m_turn_manager.active_player();
    m_iso_renderer.render(m_renderer, m_camera, m_map, m_game_state.registry(), m_fog, viewing);

    // HUD: display active player and turn info
    // (Simple colored bar at top — full HUD is Phase 2)
    render::Color bar_color = (m_turn_manager.active_player() == PlayerId::Player1)
                                   ? render::Color{60, 120, 220, 180}
                                   : render::Color{220, 60, 60, 180};
    m_renderer.fill_rect(0, 0, m_renderer.screen_width(), 4, bar_color);

    m_renderer.end_frame();
}

void Engine::update_fog_of_war() {
    m_fog.update(PlayerId::Player1, m_game_state.registry(), m_map);
    m_fog.update(PlayerId::Player2, m_game_state.registry(), m_map);
}

void Engine::check_win_condition() {
    auto win = m_turn_manager.check_win_condition(m_game_state.registry());
    if (win.game_over) {
        m_game_state.end_game(win.winner, win.reason);
    }
}

} // namespace dope
