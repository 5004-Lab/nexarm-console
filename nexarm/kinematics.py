"""NexArm base-frame kinematics and geometric screening for host motion."""

import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
JOINTS = json.loads((ROOT / "src/joints.json").read_text())
SETUP = json.loads((ROOT / "src/workcell.json").read_text())
JOINT_INDEX = {j["joint"]: i for i, j in enumerate(JOINTS)}
ZERO = np.array([j["zero"] for j in JOINTS])
SCALE = np.array([j["sign"] / j["ticks"] for j in JOINTS])
FLOOR = SETUP["floor_mm"]
TOOL = np.array(SETUP["tool_offset_mm"])
IDENTITY = np.eye(3)
KINEMATIC_TREE = []
for item in ET.parse(ROOT / "public/model/nexarm.urdf").findall("joint"):
    parent, child = (item.find(key).get("link") for key in ("parent", "child"))
    if parent == "world":
        continue
    origin = np.array(item.find("origin").get("xyz").split(), dtype=float) * 1000
    axis = np.array(item.find("axis").get("xyz").split(), dtype=float)
    if np.linalg.norm(axis):
        axis /= np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    mimic = item.find("mimic")
    index = JOINT_INDEX.get(item.get("name"))
    factor = 1
    if mimic is not None:
        index = JOINT_INDEX[mimic.get("joint")]
        factor = float(mimic.get("multiplier"))
        if item.get("type") == "prismatic":
            factor *= 1000
    KINEMATIC_TREE.append((parent, child, origin, axis, k, k @ k, index, factor, item.get("type")))


def transforms(pulses):
    angles = (np.asarray(pulses) - ZERO) * SCALE
    links = {"base_link": (np.zeros(3), IDENTITY)}
    for parent, child, origin, axis, skew, squared, index, factor, kind in KINEMATIC_TREE:
        point, basis = links[parent]
        rotation = basis
        location = point + basis @ origin
        if index is not None:
            value = angles[index] * factor
            if kind == "revolute":
                rotation = basis @ (IDENTITY + math.sin(value) * skew + (1 - math.cos(value)) * squared)
            elif kind == "prismatic":
                location = location + basis @ (axis * value)
        links[child] = location, rotation
    return links


def tool_position(links):
    point, basis = links["gripper_link"]
    return point + basis @ TOOL


def tcp(pulses):
    return [round(float(v), 1) for v in tool_position(transforms(pulses))]


def angle(index, position):
    return round(math.degrees((position - ZERO[index]) * SCALE[index]), 2)


def position_for_angle(index, degrees):
    if type(degrees) not in (int, float) or not -360 <= degrees <= 360:
        raise ValueError(f"J{index + 1} 需要有效的角度值")
    return round(float(ZERO[index]) + math.radians(degrees) / float(SCALE[index]))


# STL bounding envelopes in each link frame, in millimetres.
BOXES = {
    name: ((np.array(bounds[0]) + bounds[1]) / 2, (np.array(bounds[1]) - bounds[0]) / 2)
    for name, bounds in SETUP["link_boxes_mm"].items()
}
# Adjacent links share the joint volume. Non-adjacent links are tested independently.
COLLISION_PAIRS = SETUP["self_collision_pairs"]
OBSTACLES = [
    (item["name"], (np.array(item["min_mm"]) + item["max_mm"]) / 2, IDENTITY,
     (np.array(item["max_mm"]) - item["min_mm"]) / 2)
    for item in SETUP["obstacles"]
]


def overlap(a, b):
    """Separating axis test for two oriented boxes, returning minimum overlap in mm."""
    p, A, u = a
    q, B, v = b
    r = A.T @ B
    t = A.T @ (q - p)
    ar = np.abs(r)
    margins = list(u + ar @ v - np.abs(t))
    margins.extend(ar.T @ u + v - np.abs(r.T @ t))
    if min(margins) <= 0:
        return 0
    for i in range(3):
        i1, i2 = (i + 1) % 3, (i + 2) % 3
        for j in range(3):
            j1, j2 = (j + 1) % 3, (j + 2) % 3
            norm = math.sqrt(max(0, 1 - r[i, j] ** 2))
            if norm < 1e-6:
                continue
            separation = abs(t[i2] * r[i1, j] - t[i1] * r[i2, j])
            extent = u[i1] * ar[i2, j] + u[i2] * ar[i1, j] + v[j1] * ar[i, j2] + v[j2] * ar[i, j1]
            if extent <= separation:
                return 0
            margins.append((extent - separation) / norm)
    return min(margins)


def contacts(links):
    shapes = {}
    collisions = {}
    for name, (local, half) in BOXES.items():
        p, basis = links[name]
        center = p + basis @ local
        shapes[name] = center, basis, half
        lower = center[2] - np.abs(basis[2]) @ half
        if name not in ("base_link", "link1") and lower < FLOOR:
            collisions[f"{name} 与工作台"] = FLOOR - lower
    for a, b in COLLISION_PAIRS:
        depth = overlap(shapes[a], shapes[b])
        if depth > 0.7:
            collisions[f"{a} 与 {b}"] = depth
    for label, center, basis, half in OBSTACLES:
        for name, shape in shapes.items():
            if name == "base_link":
                continue
            depth = overlap(shape, (center, basis, half))
            if depth > 0.7:
                collisions[f"{name} 与 {label}"] = depth
    return collisions


def joint_limits(pulses):
    return [[min(j["min"], p), max(j["max"], p)] for j, p in zip(JOINTS, pulses)]


def check_path(start, target, bounds):
    for i, (pulse, (lo, hi)) in enumerate(zip(target, bounds), 1):
        if not lo <= pulse <= hi:
            low, high = sorted((angle(i - 1, lo), angle(i - 1, hi)))
            raise ValueError(f"J{i} 角度超出范围（{low:.1f}° 至 {high:.1f}°）")
    delta = np.asarray(target) - start
    count = max(1, math.ceil(float(np.max(np.abs(delta))) / 16))
    initial = contacts(transforms(start))
    initial_depth = sum(initial.values())
    points = [tcp(start)]
    for step in range(1, count + 1):
        links = transforms(np.asarray(start) + delta * step / count)
        current = contacts(links)
        for pair, depth in current.items():
            # A folded real arm can already overlap conservative bounding boxes.
            # Allow it to retreat, with small local variation in that same overlap.
            if pair not in initial or depth > initial[pair] + (0.35 if "工作台" in pair else 3):
                raise ValueError(f"路径碰撞：{pair}")
        if sum(current.values()) > initial_depth + 3:
            largest = max(current, key=lambda pair: current[pair] - initial.get(pair, 0))
            raise ValueError(f"路径加深现有碰撞：{largest}")
        points.append([round(float(v), 1) for v in tool_position(links)])
    return points


def joint_solutions(start, xyz, bounds):
    target = np.asarray(xyz, dtype=float)
    if target[2] <= FLOOR + 5 or float(np.linalg.norm(target)) > SETUP["max_reach_mm"]:
        raise ValueError("目标不可达：超出工作空间")
    lower, upper = np.array(bounds, dtype=float).T
    current = np.array(start, dtype=float)
    reference = transforms(current)["gripper_link"][1]
    adjustable = np.flatnonzero(upper[:5] > lower[:5])
    middle = (lower + upper) / 2
    seeds = [(current, 6.0), (current, 0.0), (ZERO, 0.0), (middle, 0.0)]
    for shoulder, elbow, wrist in ((0.20, 0.22, 0.70), (0.75, 0.38, 0.30), (0.24, 0.75, 0.30),
                                  (0.68, 0.82, 0.72), (0.42, 0.55, 0.14), (0.48, 0.16, 0.82)):
        seeds.append((lower + (upper - lower) * [0.5, shoulder, elbow, wrist, 0.5, 0.5], 0.0))
    yielded = set()
    for seed, orientation_weight in seeds:
        q = np.clip(seed, lower, upper)
        # XYZ cannot specify a gripper opening. Preserve the measured J6.
        q[5] = current[5]
        for _ in range(72):
            links = transforms(q)
            position = tool_position(links)
            error = target - position
            if np.linalg.norm(error) <= 1.25:
                goal = np.rint(q).astype(int).tolist()
                if tuple(goal) not in yielded and math.dist(tcp(goal), xyz) <= 1.6:
                    yielded.add(tuple(goal))
                    yield goal
                break
            basis = links["gripper_link"][1]
            if not len(adjustable):
                break
            offsets = [transforms(q + IDENTITY6[i] * 2) for i in adjustable]
            position_jac = np.column_stack([(tool_position(sample) - position) / 2 for sample in offsets])
            orientation_jac = np.column_stack([
                (sample["gripper_link"][1] - basis).ravel() * (orientation_weight / 2) for sample in offsets
            ])
            matrix = np.vstack((position_jac, orientation_jac, 0.014 * np.eye(len(adjustable))))
            desired = np.r_[error, (reference - basis).ravel() * orientation_weight, 0.004 * (current[adjustable] - q[adjustable])]
            delta = np.linalg.lstsq(matrix, desired, rcond=None)[0]
            q[adjustable] = np.clip(q[adjustable] + np.clip(delta, -95, 95), lower[adjustable], upper[adjustable])


def plan(start, xyz, bounds, validate_path=True):
    error = None
    for goal in joint_solutions(start, xyz, bounds):
        try:
            points = check_path(start, goal, bounds) if validate_path else [tcp(goal)]
            return {"positions": goal, "path": points, "tcp": points[-1]}
        except ValueError as exc:
            error = exc
    raise error or ValueError("目标不可达：当前六轴行程内未找到关节解")


IDENTITY6 = np.eye(6)


def lock_axes(bounds, pulse_values):
    return [[pulse_values[i], pulse_values[i]] if i in pulse_values else list(b) for i, b in enumerate(bounds)]


def stage_path(start, sequence, bounds):
    phases = []
    points = [tcp(start)]
    previous = start
    for name, goal in sequence:
        if goal == previous:
            continue
        points.extend(check_path(previous, goal, bounds)[1:])
        phases.append({"name": name, "positions": goal, "angles": [angle(i, p) for i, p in enumerate(goal)], "tcp": points[-1]})
        previous = goal
    return {"positions": previous, "angles": [angle(i, p) for i, p in enumerate(previous)],
            "path": points, "tcp": points[-1], "phases": phases}


def plan_park(start, bounds):
    goal = SETUP["park_positions"]
    if contacts(transforms(goal)):
        raise ValueError("配置的复位姿态与工位发生碰撞")
    align = [start[0], *goal[1:]]
    yaw = [goal[0], *start[1:]]
    lift = [start[0], goal[1], goal[2], start[3], start[4], start[5]]
    candidates = [
        [("复位", goal)],
        [("肩肘腕收拢", align), ("底座回正", goal)],
        [("先抬升", lift), ("收拢", align), ("底座回正", goal)],
        [("底座回正", yaw), ("复位", goal)],
    ]
    for sequence in candidates:
        try:
            return stage_path(start, sequence, bounds)
        except ValueError:
            continue
    raise ValueError("从当前姿态未找到可校验的复位路径")


def plan_cartesian(start, xyz, bounds):
    """Solve joint configurations first, then find a collision-checked route."""
    folded = start[2] < JOINTS[2]["zero"] - 70 and np.linalg.norm(tcp(start)[:2]) < 90
    options = [lock_axes(bounds, {2: start[2]}), bounds] if folded and bounds[2][0] != bounds[2][1] else [bounds]
    rejected = []
    for limits in options:
        held = {i: lo for i, (lo, hi) in enumerate(limits[:5]) if lo == hi}
        for goal in joint_solutions(start, xyz, limits):
            try:
                result = stage_path(start, [("六轴协调", goal)], limits)
                return dict(result, held_axes=held)
            except ValueError:
                rejected.append((goal, limits))
    if not rejected:
        raise ValueError("目标不可达：当前六轴行程内未找到关节解")
    for goal, limits in rejected[:4]:
        try:
            return phased_path(start, xyz, limits, goal)
        except ValueError:
            continue
    for goal, limits in rejected[:4]:
        for alternative in joint_detours(start, goal, limits):
            try:
                result = stage_path(start, [("绕障协调", alternative), ("末端到位", goal)], limits)
                return dict(result, held_axes={i: lo for i, (lo, hi) in enumerate(limits[:5]) if lo == hi})
            except ValueError:
                continue
    raise ValueError("六轴有目标解，但未找到通过限位和碰撞检查的路径")


def joint_detours(start, goal, bounds):
    low, high = np.array(bounds).T
    direction = np.subtract(goal, start)
    rng = np.random.default_rng(74)
    for fraction in (0.30, 0.55, 0.75):
        centre = start + direction * fraction
        for offsets in rng.uniform(-0.21, 0.21, (8, 6)):
            offsets[5] = 0
            yield np.clip(np.rint(centre + (high - low) * offsets), low, high).astype(int).tolist()


def phased_path(start, xyz, bounds, goal):
    origin = np.asarray(tcp(start))
    target = np.asarray(xyz)
    coordinated = "肩腕" if bounds[2][0] == bounds[2][1] else "肩肘腕"
    held = {i: lo for i, (lo, hi) in enumerate(bounds[:5]) if lo == hi}

    def path(sequence):
        result = stage_path(start, sequence, bounds)
        result["held_axes"] = held
        return result
    # Keep the gripper aperture throughout. Rotate only after shape clearance.
    arm = transforms(start)
    outward = arm["link1"][1][:2, 0].copy()
    if float(outward @ origin[:2]) < 0:
        outward *= -1
    lift_base = {0: start[0], 4: start[4]}
    # Try clearing the folded elbow without commanding it first.
    lift_options = ((38, 22, True), (36, 0, True), (52, 27, True), (35, 24, False), (41, 0, False))
    last_error = None
    for rise, shift, hold_elbow in lift_options:
        lift_axes = dict(lift_base)
        if hold_elbow:
            lift_axes[2] = start[2]
        lift_xyz = np.r_[origin[:2] + outward * shift, origin[2] + rise]
        try:
            lift = plan(start, lift_xyz, lock_axes(bounds, lift_axes))["positions"]
        except ValueError as exc:
            last_error = exc
            continue
        rotated = [goal[0], *lift[1:]]
        prefix = [("抬升清障", lift), ("底座转向", rotated)]
        for approach_z in (max(lift_xyz[2], target[2] + 25), target[2] + 22, target[2] + 12):
            try:
                above = plan(goal, [*target[:2], approach_z], lock_axes(bounds, {0: goal[0]}),
                             validate_path=False)["positions"]
                return path(prefix + [(f"{coordinated}协调接近", above), ("下降到位", goal)])
            except ValueError as exc:
                last_error = exc
    # A different joint-space shape can clear obstacles even where a high approach cannot.
    # Check it explicitly and make the alternative visible in the preview.
    try:
        # Unfold the arm in the direction of the final shape before yawing.
        unfolded = [start[0], goal[1], goal[2], goal[3], start[4], start[5]]
        if tcp(unfolded)[2] >= min(origin[2], target[2]) - 3:
            turned = [goal[0], *unfolded[1:]]
            return path([
                (f"{coordinated}展开", unfolded), ("底座转向", turned), ("末端姿态到位", goal)
            ])
    except ValueError as exc:
        last_error = exc
    label = f"（{last_error}）" if last_error else ""
    raise ValueError(f"找不到通过检查的分段路径{label}")
