#include "pathfinding.h"

#include <algorithm>
#include <queue>
#include <unordered_map>
#include <unordered_set>

namespace dope::map {

namespace {

struct Node {
    Vec3i pos;
    i32 g_cost;     // Cost from start
    i32 f_cost;     // g + heuristic
    Vec3i parent;

    bool operator>(const Node& other) const { return f_cost > other.f_cost; }
};

i32 heuristic(const Vec3i& a, const Vec3i& b) {
    // Chebyshev distance on XY plane (uniform diagonal cost) + Z difference
    return a.chebyshev_distance_xy(b) + std::abs(a.z - b.z);
}

// Get valid neighbors of a tile, including stair connections
std::vector<Vec3i> get_neighbors(const Map& map, const Vec3i& pos) {
    std::vector<Vec3i> neighbors;
    neighbors.reserve(10); // 8 cardinal/diagonal + 2 stair connections max

    // 8-directional movement on same Z-level
    for (const auto& offset : NEIGHBOR_OFFSETS_8) {
        Vec3i next = {pos.x + offset.x, pos.y + offset.y, pos.z};
        if (map.in_bounds(next) && map.at(next).is_passable()) {
            neighbors.push_back(next);
        }
    }

    // Stair connections
    const Tile& current = map.at(pos);
    if (current.has_stairs_up && pos.z + 1 < map.depth()) {
        Vec3i up = {pos.x, pos.y, pos.z + 1};
        if (map.in_bounds(up) && map.at(up).is_passable()) {
            neighbors.push_back(up);
        }
    }
    if (current.has_stairs_down && pos.z - 1 >= 0) {
        Vec3i down = {pos.x, pos.y, pos.z - 1};
        if (map.in_bounds(down) && map.at(down).is_passable()) {
            neighbors.push_back(down);
        }
    }

    return neighbors;
}

} // anonymous namespace

PathResult find_path(const Map& map, const Vec3i& start, const Vec3i& goal, i32 max_cost,
                     EntityId ignore_entity) {
    PathResult result;

    if (!map.in_bounds(start) || !map.in_bounds(goal)) return result;
    if (!map.at(goal).is_passable()) return result;
    if (start == goal) {
        result.path.push_back(start);
        result.cost = 0;
        result.found = true;
        return result;
    }

    // A* search
    std::priority_queue<Node, std::vector<Node>, std::greater<Node>> open;
    std::unordered_map<Vec3i, i32> g_costs;
    std::unordered_map<Vec3i, Vec3i> came_from;
    std::unordered_set<Vec3i> closed;

    open.push({start, 0, heuristic(start, goal), start});
    g_costs[start] = 0;

    while (!open.empty()) {
        Node current = open.top();
        open.pop();

        if (current.pos == goal) {
            // Reconstruct path
            result.cost = current.g_cost;
            result.found = true;

            Vec3i trace = goal;
            while (trace != start) {
                result.path.push_back(trace);
                trace = came_from[trace];
            }
            result.path.push_back(start);
            std::reverse(result.path.begin(), result.path.end());
            return result;
        }

        if (closed.count(current.pos)) continue;
        closed.insert(current.pos);

        for (const Vec3i& next : get_neighbors(map, current.pos)) {
            if (closed.count(next)) continue;

            // Check occupancy (skip tiles occupied by other entities)
            EntityId occupant = map.get_occupant(next);
            if (occupant != INVALID_ENTITY && occupant != ignore_entity && next != goal) {
                continue;
            }

            // Uniform movement cost: 1 per tile (diagonal = cardinal)
            i32 move_cost = 1;
            i32 new_g = current.g_cost + move_cost;

            if (new_g > max_cost) continue;

            auto it = g_costs.find(next);
            if (it == g_costs.end() || new_g < it->second) {
                g_costs[next] = new_g;
                came_from[next] = current.pos;
                i32 f = new_g + heuristic(next, goal);
                open.push({next, new_g, f, current.pos});
            }
        }
    }

    return result; // No path found
}

std::vector<std::pair<Vec3i, i32>> get_reachable_tiles(const Map& map, const Vec3i& start,
                                                        i32 max_cost, EntityId ignore_entity) {
    std::vector<std::pair<Vec3i, i32>> reachable;

    if (!map.in_bounds(start)) return reachable;

    // Dijkstra's algorithm (A* without goal, just flood fill)
    std::priority_queue<Node, std::vector<Node>, std::greater<Node>> open;
    std::unordered_map<Vec3i, i32> g_costs;

    open.push({start, 0, 0, start});
    g_costs[start] = 0;

    while (!open.empty()) {
        Node current = open.top();
        open.pop();

        if (current.g_cost > g_costs[current.pos]) continue;

        reachable.push_back({current.pos, current.g_cost});

        for (const Vec3i& next : get_neighbors(map, current.pos)) {
            EntityId occupant = map.get_occupant(next);
            if (occupant != INVALID_ENTITY && occupant != ignore_entity) {
                continue;
            }

            i32 new_g = current.g_cost + 1;
            if (new_g > max_cost) continue;

            auto it = g_costs.find(next);
            if (it == g_costs.end() || new_g < it->second) {
                g_costs[next] = new_g;
                open.push({next, new_g, new_g, current.pos});
            }
        }
    }

    return reachable;
}

} // namespace dope::map
