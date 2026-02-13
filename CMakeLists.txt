cmake_minimum_required(VERSION 3.20)
project(dopeufo
    VERSION 0.1.0
    DESCRIPTION "Isometric pixel-art turn-based PvP tactical combat engine"
    LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# --- Options --------------------------------------------------------------- #
option(DOPE_BUILD_TESTS   "Build unit tests"           ON)
option(DOPE_ASAN          "Enable AddressSanitizer"     OFF)

# --- Compiler flags -------------------------------------------------------- #
if(MSVC)
    add_compile_options(/W4 /permissive-)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
    if(DOPE_ASAN)
        add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
        add_link_options(-fsanitize=address)
    endif()
endif()

# --- Dependencies ---------------------------------------------------------- #
# SDL2
find_package(SDL2 REQUIRED)
find_package(SDL2_image QUIET)
find_package(SDL2_mixer QUIET)
find_package(SDL2_net   QUIET)

# nlohmann/json (header-only, fetched automatically)
include(FetchContent)
FetchContent_Declare(
    json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(json)

# --- Engine library -------------------------------------------------------- #
file(GLOB_RECURSE ENGINE_SOURCES CONFIGURE_DEPENDS
    src/core/*.cpp
    src/render/*.cpp
    src/map/*.cpp
    src/combat/*.cpp
    src/unit/*.cpp
    src/turn/*.cpp
    src/net/*.cpp
    src/input/*.cpp
    src/audio/*.cpp
    src/engine.cpp
)

add_library(dopeufo_engine STATIC ${ENGINE_SOURCES})

target_include_directories(dopeufo_engine PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(dopeufo_engine PUBLIC
    SDL2::SDL2
    nlohmann_json::nlohmann_json
)

if(TARGET SDL2_image::SDL2_image)
    target_link_libraries(dopeufo_engine PUBLIC SDL2_image::SDL2_image)
    target_compile_definitions(dopeufo_engine PUBLIC DOPE_HAS_SDL2_IMAGE)
endif()

if(TARGET SDL2_mixer::SDL2_mixer)
    target_link_libraries(dopeufo_engine PUBLIC SDL2_mixer::SDL2_mixer)
    target_compile_definitions(dopeufo_engine PUBLIC DOPE_HAS_SDL2_MIXER)
endif()

if(TARGET SDL2_net::SDL2_net)
    target_link_libraries(dopeufo_engine PUBLIC SDL2_net::SDL2_net)
    target_compile_definitions(dopeufo_engine PUBLIC DOPE_HAS_SDL2_NET)
endif()

# --- Main executable ------------------------------------------------------- #
add_executable(dopeufo src/main.cpp)
target_link_libraries(dopeufo PRIVATE dopeufo_engine SDL2::SDL2main)

# Copy data/ next to binary
add_custom_command(TARGET dopeufo POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        ${CMAKE_SOURCE_DIR}/data
        $<TARGET_FILE_DIR:dopeufo>/data
)

# --- Tests ----------------------------------------------------------------- #
if(DOPE_BUILD_TESTS)
    enable_testing()
    FetchContent_Declare(
        Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.5.2
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(Catch2)

    file(GLOB TEST_SOURCES CONFIGURE_DEPENDS tests/*.cpp)
    add_executable(dopeufo_tests ${TEST_SOURCES})
    target_link_libraries(dopeufo_tests PRIVATE
        dopeufo_engine
        Catch2::Catch2WithMain
    )
    include(Catch)
    catch_discover_tests(dopeufo_tests)
endif()
