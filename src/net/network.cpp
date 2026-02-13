#include "network.h"

#include <iostream>

namespace dope::net {

Network::Network() = default;

Network::~Network() {
    disconnect();
}

bool Network::host(u16 port) {
    // TODO: Implement with SDL_net
    std::cout << "[Network] Host on port " << port << " (stub)\n";
    m_role = NetworkRole::Host;
    m_state = ConnectionState::Disconnected; // Will be Connected when peer joins
    return true;
}

bool Network::connect(const std::string& address, u16 port) {
    // TODO: Implement with SDL_net
    std::cout << "[Network] Connect to " << address << ":" << port << " (stub)\n";
    m_role = NetworkRole::Client;
    m_state = ConnectionState::Connecting;
    return true;
}

void Network::disconnect() {
    // TODO: Implement with SDL_net
    m_state = ConnectionState::Disconnected;
    m_role = NetworkRole::None;
}

bool Network::send_command(const core::Command& /*cmd*/) {
    if (!is_connected()) return false;
    // TODO: Serialize command and send via SDL_net
    return true;
}

bool Network::send_state_hash(u32 /*turn_number*/, u32 /*hash*/) {
    if (!is_connected()) return false;
    // TODO: Send hash packet
    return true;
}

std::vector<NetworkMessage> Network::poll() {
    std::vector<NetworkMessage> messages;
    // TODO: Poll SDL_net socket for incoming messages
    return messages;
}

} // namespace dope::net
