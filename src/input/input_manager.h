#pragma once
// input_manager.h — SDL input event handling and translation to engine actions.

#include "../core/math.h"
#include "../core/types.h"
#include "../render/camera.h"

#include <SDL.h>
#include <functional>
#include <unordered_map>

namespace dope::input {

// High-level input actions (abstracted from raw SDL events)
enum class InputAction : u8 {
    None,
    // Mouse
    LeftClick,
    RightClick,
    MiddleClick,
    // Camera
    PanLeft,
    PanRight,
    PanUp,
    PanDown,
    ZoomIn,
    ZoomOut,
    ZLevelUp,
    ZLevelDown,
    // Game actions
    EndTurn,
    Overwatch,
    Reload,
    HunkerDown,
    CancelAction,
    ToggleGrid,
    // System
    Quit,
};

// Mouse state
struct MouseState {
    Vec2i screen_pos = {0, 0};     // Raw screen position
    Vec2i grid_pos = {0, 0};       // Grid tile under cursor
    bool left_pressed = false;
    bool right_pressed = false;
    bool middle_pressed = false;
    i32 scroll_delta = 0;          // Mouse wheel delta this frame
    bool left_clicked = false;     // Left button clicked this frame
    bool right_clicked = false;    // Right button clicked this frame
};

class InputManager {
public:
    InputManager();

    // Process all pending SDL events. Returns false if quit was requested.
    bool poll_events(const render::Camera& camera, i32 view_z = 0);

    // Check if an action was triggered this frame
    bool is_action_pressed(InputAction action) const;

    // Mouse state this frame
    const MouseState& mouse() const { return m_mouse; }

    // Check if a key is currently held down
    bool is_key_held(SDL_Scancode key) const;

    // Camera pan speed (pixels per frame when holding pan keys)
    f32 pan_speed = 8.0f;
    f32 zoom_speed = 0.1f;

    // Was window close requested?
    bool quit_requested() const { return m_quit; }

private:
    void reset_frame_state();
    void handle_key_down(SDL_Scancode key);
    void handle_key_up(SDL_Scancode key);
    void handle_mouse_button(const SDL_MouseButtonEvent& event);
    void handle_mouse_motion(const SDL_MouseMotionEvent& event);
    void handle_mouse_wheel(const SDL_MouseWheelEvent& event);

    MouseState m_mouse;
    std::unordered_map<InputAction, bool> m_actions;
    std::unordered_map<SDL_Scancode, bool> m_keys_held;
    bool m_quit = false;

    // Camera panning with middle mouse drag
    bool m_panning = false;
    Vec2i m_pan_start = {0, 0};
};

} // namespace dope::input
