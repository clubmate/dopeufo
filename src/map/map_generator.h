#pragma once
// map_generator.h — Procedural map generation.

#include "../core/math.h"
#include "../core/types.h"
#include "map.h"

#include <string>

namespace dope::map {

// Parameters for procedural map generation
struct MapGenParams {
    i32 width = 20;
    i32 height = 20;
    i32 depth = 1;          // Number of Z-levels
    u32 seed = 0;           // RNG seed (0 = random)

    // Building density (0.0 to 1.0)
    f32 building_density = 0.3f;

    // Cover object density (additional scattered cover)
    f32 cover_density = 0.15f;

    // Name for the generated map
    std::string name = "generated";
};

// Generate a procedural map from parameters.
Map generate_map(const MapGenParams& params);

// Generate a simple test map for development.
Map generate_test_map();

} // namespace dope::map
