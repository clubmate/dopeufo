#include "input_manager.h"

namespace dope::input {

InputManager::InputManager() = default;

void InputManager::reset_frame_state() {
    m_actions.clear();
    m_mouse.left_clicked = false;
    m_mouse.right_clicked = false;
    m_mouse.scroll_delta = 0;
}

bool InputManager::poll_events(const render::Camera& camera, i32 view_z) {
    reset_frame_state();

    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        switch (event.type) {
            case SDL_QUIT:
                m_quit = true;
                m_actions[InputAction::Quit] = true;
                return false;

            case SDL_KEYDOWN:
                if (!event.key.repeat) {
                    handle_key_down(event.key.keysym.scancode);
                }
                break;

            case SDL_KEYUP:
                handle_key_up(event.key.keysym.scancode);
                break;

            case SDL_MOUSEBUTTONDOWN:
            case SDL_MOUSEBUTTONUP:
                handle_mouse_button(event.button);
                break;

            case SDL_MOUSEMOTION:
                handle_mouse_motion(event.motion);
                break;

            case SDL_MOUSEWHEEL:
                handle_mouse_wheel(event.wheel);
                break;
        }
    }

    // Convert screen mouse position to grid coordinates
    Vec2f screen_f{static_cast<f32>(m_mouse.screen_pos.x),
                   static_cast<f32>(m_mouse.screen_pos.y)};
    m_mouse.grid_pos = camera.screen_to_grid(screen_f, view_z);

    // Check held keys for continuous actions
    if (is_key_held(SDL_SCANCODE_LEFT) || is_key_held(SDL_SCANCODE_A)) {
        m_actions[InputAction::PanLeft] = true;
    }
    if (is_key_held(SDL_SCANCODE_RIGHT) || is_key_held(SDL_SCANCODE_D)) {
        m_actions[InputAction::PanRight] = true;
    }
    if (is_key_held(SDL_SCANCODE_UP) || is_key_held(SDL_SCANCODE_W)) {
        m_actions[InputAction::PanUp] = true;
    }
    if (is_key_held(SDL_SCANCODE_DOWN) || is_key_held(SDL_SCANCODE_S)) {
        m_actions[InputAction::PanDown] = true;
    }

    return !m_quit;
}

bool InputManager::is_action_pressed(InputAction action) const {
    auto it = m_actions.find(action);
    return it != m_actions.end() && it->second;
}

bool InputManager::is_key_held(SDL_Scancode key) const {
    auto it = m_keys_held.find(key);
    return it != m_keys_held.end() && it->second;
}

void InputManager::handle_key_down(SDL_Scancode key) {
    m_keys_held[key] = true;

    switch (key) {
        case SDL_SCANCODE_TAB:
        case SDL_SCANCODE_RETURN:
            m_actions[InputAction::EndTurn] = true;
            break;
        case SDL_SCANCODE_O:
            m_actions[InputAction::Overwatch] = true;
            break;
        case SDL_SCANCODE_R:
            m_actions[InputAction::Reload] = true;
            break;
        case SDL_SCANCODE_H:
            m_actions[InputAction::HunkerDown] = true;
            break;
        case SDL_SCANCODE_ESCAPE:
            m_actions[InputAction::CancelAction] = true;
            break;
        case SDL_SCANCODE_G:
            m_actions[InputAction::ToggleGrid] = true;
            break;
        case SDL_SCANCODE_PAGEUP:
        case SDL_SCANCODE_E:
            m_actions[InputAction::ZLevelUp] = true;
            break;
        case SDL_SCANCODE_PAGEDOWN:
        case SDL_SCANCODE_Q:
            m_actions[InputAction::ZLevelDown] = true;
            break;
        case SDL_SCANCODE_EQUALS:
        case SDL_SCANCODE_KP_PLUS:
            m_actions[InputAction::ZoomIn] = true;
            break;
        case SDL_SCANCODE_MINUS:
        case SDL_SCANCODE_KP_MINUS:
            m_actions[InputAction::ZoomOut] = true;
            break;
        default:
            break;
    }
}

void InputManager::handle_key_up(SDL_Scancode key) {
    m_keys_held[key] = false;
}

void InputManager::handle_mouse_button(const SDL_MouseButtonEvent& event) {
    bool pressed = (event.type == SDL_MOUSEBUTTONDOWN);

    switch (event.button) {
        case SDL_BUTTON_LEFT:
            m_mouse.left_pressed = pressed;
            if (pressed) {
                m_mouse.left_clicked = true;
                m_actions[InputAction::LeftClick] = true;
            }
            break;
        case SDL_BUTTON_RIGHT:
            m_mouse.right_pressed = pressed;
            if (pressed) {
                m_mouse.right_clicked = true;
                m_actions[InputAction::RightClick] = true;
            }
            break;
        case SDL_BUTTON_MIDDLE:
            m_mouse.middle_pressed = pressed;
            if (pressed) {
                m_panning = true;
                m_pan_start = m_mouse.screen_pos;
                m_actions[InputAction::MiddleClick] = true;
            } else {
                m_panning = false;
            }
            break;
    }
}

void InputManager::handle_mouse_motion(const SDL_MouseMotionEvent& event) {
    m_mouse.screen_pos = {event.x, event.y};
}

void InputManager::handle_mouse_wheel(const SDL_MouseWheelEvent& event) {
    m_mouse.scroll_delta = event.y;
    if (event.y > 0) {
        m_actions[InputAction::ZoomIn] = true;
    } else if (event.y < 0) {
        m_actions[InputAction::ZoomOut] = true;
    }
}

} // namespace dope::input
