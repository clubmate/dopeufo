// main.cpp — Entry point for dopeufo tactical combat engine.

#include "engine.h"

#include <iostream>
#include <SDL.h>

int main(int /*argc*/, char* /*argv*/[]) {
    std::cout << "=== dopeufo — Tactical Combat Engine ===\n\n";

    dope::Engine engine;

    if (!engine.init()) {
        std::cerr << "Engine initialization failed!\n";
        return 1;
    }

    // Generate a test map
    dope::map::MapGenParams params;
    params.width = 20;
    params.height = 20;
    params.depth = 2;
    params.seed = 42;
    params.building_density = 0.25f;
    params.cover_density = 0.2f;
    params.name = "test_arena";
    engine.generate_map(params);

    // Spawn Player 1 squad
    engine.spawn_unit(dope::PlayerId::Player1, {1, 1, 0}, "soldier");
    engine.spawn_unit(dope::PlayerId::Player1, {2, 1, 0}, "sniper");
    engine.spawn_unit(dope::PlayerId::Player1, {1, 2, 0}, "heavy");
    engine.spawn_unit(dope::PlayerId::Player1, {2, 2, 0}, "medic");

    // Spawn Player 2 squad
    engine.spawn_unit(dope::PlayerId::Player2, {17, 17, 0}, "soldier");
    engine.spawn_unit(dope::PlayerId::Player2, {18, 17, 0}, "sniper");
    engine.spawn_unit(dope::PlayerId::Player2, {17, 18, 0}, "heavy");
    engine.spawn_unit(dope::PlayerId::Player2, {18, 18, 0}, "medic");

    // Start the game
    engine.start_game();

    std::cout << "\nControls:\n"
              << "  WASD / Arrows  — Pan camera\n"
              << "  +/-            — Zoom\n"
              << "  Q/E            — Z-level up/down\n"
              << "  G              — Toggle grid\n"
              << "  Left Click     — Select unit / Move\n"
              << "  Right Click    — Shoot target\n"
              << "  O              — Overwatch\n"
              << "  R              — Reload\n"
              << "  H              — Hunker Down\n"
              << "  Tab / Enter    — End Turn\n"
              << "  Escape         — Cancel / Deselect\n\n";

    engine.run();
    engine.shutdown();

    std::cout << "Goodbye!\n";
    return 0;
}
