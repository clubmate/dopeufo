#include "protocol.h"

#include <iostream>

using json = nlohmann::json;

namespace dope::net {

namespace {

json vec3i_to_json(const Vec3i& v) {
    return {{"x", v.x}, {"y", v.y}, {"z", v.z}};
}

Vec3i vec3i_from_json(const json& j) {
    return {j.value("x", 0), j.value("y", 0), j.value("z", 0)};
}

} // anonymous namespace

std::string serialize_command(const core::Command& cmd) {
    json j;

    std::visit([&](const auto& c) {
        using T = std::decay_t<decltype(c)>;

        if constexpr (std::is_same_v<T, core::MoveCommand>) {
            j["type"] = "move";
            j["entity"] = c.entity;
            j["target"] = vec3i_to_json(c.target);
            json path_arr = json::array();
            for (const auto& p : c.path) {
                path_arr.push_back(vec3i_to_json(p));
            }
            j["path"] = path_arr;
        } else if constexpr (std::is_same_v<T, core::ShootCommand>) {
            j["type"] = "shoot";
            j["shooter"] = c.shooter;
            j["target"] = c.target;
            j["rng_seed"] = c.rng_seed;
        } else if constexpr (std::is_same_v<T, core::OverwatchCommand>) {
            j["type"] = "overwatch";
            j["entity"] = c.entity;
        } else if constexpr (std::is_same_v<T, core::ReloadCommand>) {
            j["type"] = "reload";
            j["entity"] = c.entity;
        } else if constexpr (std::is_same_v<T, core::HunkerDownCommand>) {
            j["type"] = "hunker";
            j["entity"] = c.entity;
        } else if constexpr (std::is_same_v<T, core::UseItemCommand>) {
            j["type"] = "use_item";
            j["entity"] = c.entity;
            j["item_slot"] = c.item_slot;
            j["target_tile"] = vec3i_to_json(c.target_tile);
        } else if constexpr (std::is_same_v<T, core::EndTurnCommand>) {
            j["type"] = "end_turn";
            j["player"] = static_cast<int>(c.player);
        } else if constexpr (std::is_same_v<T, core::SpawnUnitCommand>) {
            j["type"] = "spawn";
            j["owner"] = static_cast<int>(c.owner);
            j["position"] = vec3i_to_json(c.position);
            j["unit_type"] = c.unit_type;
        } else if constexpr (std::is_same_v<T, core::DestroyTileCommand>) {
            j["type"] = "destroy_tile";
            j["position"] = vec3i_to_json(c.position);
        }
    }, cmd);

    return j.dump();
}

core::Command deserialize_command(const std::string& json_str) {
    try {
        json j = json::parse(json_str);
        std::string type = j.value("type", "");

        if (type == "move") {
            core::MoveCommand cmd;
            cmd.entity = j.value("entity", 0u);
            cmd.target = vec3i_from_json(j["target"]);
            if (j.contains("path")) {
                for (const auto& p : j["path"]) {
                    cmd.path.push_back(vec3i_from_json(p));
                }
            }
            return cmd;
        } else if (type == "shoot") {
            core::ShootCommand cmd;
            cmd.shooter = j.value("shooter", 0u);
            cmd.target = j.value("target", 0u);
            cmd.rng_seed = j.value("rng_seed", 0u);
            return cmd;
        } else if (type == "overwatch") {
            return core::OverwatchCommand{j.value("entity", 0u)};
        } else if (type == "reload") {
            return core::ReloadCommand{j.value("entity", 0u)};
        } else if (type == "hunker") {
            return core::HunkerDownCommand{j.value("entity", 0u)};
        } else if (type == "use_item") {
            core::UseItemCommand cmd;
            cmd.entity = j.value("entity", 0u);
            cmd.item_slot = j.value("item_slot", 0u);
            cmd.target_tile = vec3i_from_json(j["target_tile"]);
            return cmd;
        } else if (type == "end_turn") {
            return core::EndTurnCommand{static_cast<PlayerId>(j.value("player", 0))};
        } else if (type == "spawn") {
            core::SpawnUnitCommand cmd;
            cmd.owner = static_cast<PlayerId>(j.value("owner", 0));
            cmd.position = vec3i_from_json(j["position"]);
            cmd.unit_type = j.value("unit_type", "soldier");
            return cmd;
        } else if (type == "destroy_tile") {
            return core::DestroyTileCommand{vec3i_from_json(j["position"])};
        }
    } catch (const json::exception& e) {
        std::cerr << "[Protocol] Deserialize error: " << e.what() << "\n";
    }

    // Default: end turn for Player1
    return core::EndTurnCommand{PlayerId::Player1};
}

} // namespace dope::net
