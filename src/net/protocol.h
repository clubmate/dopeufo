#pragma once
// protocol.h — Network protocol definitions and command serialization.

#include "../core/command.h"
#include "../core/types.h"

#include <nlohmann/json.hpp>
#include <string>

namespace dope::net {

// Serialize a Command to JSON string (for network transmission)
std::string serialize_command(const core::Command& cmd);

// Deserialize a Command from JSON string
core::Command deserialize_command(const std::string& json_str);

// Packet header
struct PacketHeader {
    u8 version = 1;
    MessageType type;
    u32 sequence;
    u32 payload_size;
};

constexpr u32 PROTOCOL_VERSION = 1;
constexpr u16 DEFAULT_PORT = 12345;

} // namespace dope::net
