#pragma once
// network.h — Peer-to-peer networking interface.
//
// Architecture:
//   - One player hosts (server), other connects (client)
//   - Both run the same game logic
//   - Commands are serialized and sent to the peer
//   - State hash verification for desync detection
//
// This is a stub interface — full implementation requires SDL_net.

#include "../core/command.h"
#include "../core/types.h"

#include <functional>
#include <string>
#include <vector>

namespace dope::net {

enum class NetworkRole : u8 {
    None,       // Local only (hot-seat)
    Host,       // Hosting the game
    Client,     // Connected to a host
};

enum class ConnectionState : u8 {
    Disconnected,
    Connecting,
    Connected,
    Error,
};

// Network message types
enum class MessageType : u8 {
    Command,        // Game command
    StateHash,      // State hash for sync verification
    TurnSync,       // Turn transition signal
    Ping,           // Latency measurement
    Pong,
    Chat,           // Future: in-game chat
};

struct NetworkMessage {
    MessageType type;
    std::vector<u8> data;
};

class Network {
public:
    Network();
    ~Network();

    // --- Connection ---
    bool host(u16 port = 12345);
    bool connect(const std::string& address, u16 port = 12345);
    void disconnect();

    // --- State ---
    NetworkRole role() const { return m_role; }
    ConnectionState state() const { return m_state; }
    bool is_connected() const { return m_state == ConnectionState::Connected; }
    bool is_local() const { return m_role == NetworkRole::None; }

    // --- Messaging ---
    // Send a command to the peer
    bool send_command(const core::Command& cmd);

    // Send a state hash for desync detection
    bool send_state_hash(u32 turn_number, u32 hash);

    // Poll for incoming messages (non-blocking)
    std::vector<NetworkMessage> poll();

    // --- Callbacks ---
    using CommandCallback = std::function<void(const core::Command&)>;
    void on_command_received(CommandCallback callback) { m_on_command = std::move(callback); }

    using DesyncCallback = std::function<void(u32 turn, u32 local_hash, u32 remote_hash)>;
    void on_desync(DesyncCallback callback) { m_on_desync = std::move(callback); }

    // --- Latency ---
    f32 ping_ms() const { return m_ping_ms; }

private:
    NetworkRole m_role = NetworkRole::None;
    ConnectionState m_state = ConnectionState::Disconnected;
    f32 m_ping_ms = 0.0f;

    CommandCallback m_on_command;
    DesyncCallback m_on_desync;
};

} // namespace dope::net
