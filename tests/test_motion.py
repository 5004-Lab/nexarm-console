"""Reproduce trajectory-following failures without opening a serial port."""

import math
import struct
import time
import unittest

from nexarm import kinematics
from nexarm.server import BRIDGE_WRITE, Controller


class Plant:
    """A bridge with a slower elbow and an independently stalled-axis option."""

    def __init__(self, positions, stalled=None):
        self.positions = list(positions)
        self.command = list(positions)
        self.stalled = stalled
        self.sent = []

    def write(self, frame):
        if frame[4] == BRIDGE_WRITE:
            self.command = list(struct.unpack("<6h", frame[5:-1]))
            self.sent.append((self.now, self.command))

    def update(self, controller, now):
        self.now = now
        for i, target in enumerate(self.command):
            step = 6 if i == 2 else 13
            if i != self.stalled:
                self.positions[i] += max(-step, min(step, target - self.positions[i]))
        controller.update_feedback([(p, 0) for p in self.positions], now)


class MotionTest(unittest.TestCase):
    start = [2044, 2210, 1829, 1592, 2053, 1806]

    def controller(self, stalled=None):
        controller = Controller(None)
        controller.port = "test"
        controller.bridge_started = True
        controller.bridge_ready = True
        controller.torque[:] = [True] * 6
        plant = Plant(self.start, stalled)
        now = time.monotonic()
        plant.update(controller, now)
        return controller, plant, now

    def run_motion(self, controller, plant, start_time):
        for i in range(1, 290):
            now = start_time + i * 0.085
            plant.update(controller, now)
            controller.tick_motion(plant, now)
            if controller.motion is None:
                return

    def test_reported_target_has_a_valid_six_axis_path(self):
        target = [86.9, -65.9, 372.7]
        bounds = kinematics.joint_limits(self.start)
        result = kinematics.plan_cartesian(self.start, target, bounds)
        self.assertLess(math.dist(result["tcp"], target), 1.6)
        self.assertEqual(result["positions"][5], self.start[5])
        prior = self.start
        for phase in result["phases"]:
            kinematics.check_path(prior, phase["positions"], bounds)
            prior = phase["positions"]
        controller, plant, now = self.controller()
        controller.begin_motion(result["positions"], 0, "测试坐标", target, result["phases"])
        self.run_motion(controller, plant, now)
        self.assertIsNone(controller.motion)
        self.assertIn("完成", controller.result)
        self.assertLessEqual(math.dist(kinematics.tcp(plant.positions), target), 3)
        self.assertGreater(len(plant.sent), 15)
        first = plant.sent[:8]
        self.assertLess(max(b[0] - a[0] for a, b in zip(first, first[1:])), 0.26)

    def test_stalled_joint_does_not_report_success(self):
        controller, plant, now = self.controller(stalled=2)
        goal = self.start.copy()
        goal[2] += 150
        controller.begin_motion(goal, 0, "测试关节")
        self.run_motion(controller, plant, now)
        self.assertIsNone(controller.motion)
        self.assertIn("J3 跟踪偏差", controller.result)
        self.assertEqual(plant.positions[2], self.start[2])
        self.assertNotIn("完成", controller.result)


if __name__ == "__main__":
    unittest.main()
