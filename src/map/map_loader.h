#pragma once
// map_loader.h — Load maps from JSON data files.

#include "../core/types.h"
#include "map.h"

#include <string>

namespace dope::map {

// Load a Map from a JSON file.
// Returns a default-constructed Map on failure.
Map load_map_from_file(const std::string& filepath);

// Load a Map from a JSON string.
Map load_map_from_json(const std::string& json_string);

} // namespace dope::map
