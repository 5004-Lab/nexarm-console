"""NexArm USB controller and HTTP service for the browser console."""

import argparse
import base64
from collections import deque
import glob
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import signal
import struct
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

import serial

from . import kinematics
from .camera_feed import CameraFeed
from .depth_feed import DepthFeed
from .linux_serial import initialize_generic_ch340
from .recording import Recorder
from .history import History
from .episodes import Episodes

ROOT = Path(__file__).resolve().parents[1]
JOINTS = kinematics.JOINTS
PREFIX = b"\xff\xff"
VERSION, VOLTAGE, JOINT_FEEDBACK = 1, 2, 65
GROUP_RUN, GROUP_STOP, GROUP_DOWNLOAD, GROUP_ERASE = 3, 4, 5, 23
TORQUE, CALIBRATE, SERVO_WRITE = 61, 88, 3
BRIDGE_MODE, BRIDGE_PARAMS, BRIDGE_READ, BRIDGE_WRITE, BRIDGE_TORQUE = 68, 56, 96, 97, 98
ANGLE_PER_TICK = (0.87890625, 0.87890625, 0.87890625, -0.87890625, 0.87890625, 0.87890625)
POLL_INTERVAL, FEEDBACK_TIMEOUT, LEASE_TIMEOUT = 0.085, 0.55, 1.8


def packet(command, payload=b"", device=255):
    body = bytes([device, len(payload) + 2, command]) + payload
    return PREFIX + body + bytes([~sum(body) & 0xFF])


class Frames:
    def __init__(self):
        self.pending = bytearray()

    def feed(self, data):
        self.pending.extend(data)
        while self.pending:
            start = self.pending.find(PREFIX)
            if start < 0:
                self.pending[:] = b"\xff" if self.pending[-1] == 255 else b""
                return
            del self.pending[:start]
            if len(self.pending) < 6:
                return
            length = self.pending[3]
            if not 2 <= length <= 252:
                del self.pending[0]
                continue
            end = length + 4
            if len(self.pending) < end:
                return
            frame = bytes(self.pending[:end])
            if sum(frame[2:]) & 0xFF != 0xFF:
                del self.pending[0]
                continue
            del self.pending[:end]
            yield frame


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label}须为 {low}–{high} 的整数")
    return value


def time_speed(start, target, duration):
    return max(10, min(3400, int(abs(target - start) * 1200 / duration)))


def bridge_move(positions):
    return packet(BRIDGE_WRITE, struct.pack("<6h", *positions))


def download_frame(group, total, index, frame, actual):
    servos = frame["servos"]
    duration = frame["time"]
    data = struct.pack("<BBBBH", group, total, index, 6, duration)
    for device, (servo, start) in enumerate(zip(servos, actual), 1):
        pos = servo["pos"]
        data += struct.pack("<BHBH", device, pos, servo["acc"], time_speed(start, pos, duration))
    return packet(GROUP_DOWNLOAD, data)


class Controller:
    def __init__(self, requested_port):
        self.requested_port = requested_port
        self.lock = threading.Lock()
        self.closing = threading.Event()
        self.port = None
        self.feedback = None
        self.last_feedback = 0
        self.frame_times = deque(maxlen=20)
        self.history = deque(maxlen=30)
        self.commands = deque(maxlen=160)
        self.capture_completed = None
        self.velocity = self.acceleration = None
        self.board_stop_pending = False
        self.read_pending = False
        self.voltage = None
        self.last_voltage = 0
        self.zero_readings = 0
        self.version = None
        self.owner = None
        self.owner_since = 0
        self.lease_end = 0
        self.limits = None
        self.torque = [None] * 6
        self.pending = deque()
        self.next_packet = 0
        self.motion = None
        self.bridge_started = None
        self.bridge_reference = None
        self.bridge_ready = False
        self.moving = set()
        self.in_flight_until = 0
        self.task = None
        self.board = None
        self.group_times = {}
        self.group_frames = {}
        self.result = None
        self.log_id = 0
        self.logs = deque(maxlen=1800)
        self.connection_message = "正在查找 NexArm USB 串口"

    def log(self, channel, text):
        self.log_id += 1
        self.logs.append([self.log_id, channel, time.strftime("%H:%M:%S"), text])

    def message(self, text):
        self.result = text
        self.log("text", text)

    def read_logs(self, after):
        with self.lock:
            if after > self.log_id:
                after = 0
            return {"cursor": self.log_id, "entries": [entry for entry in self.logs if entry[0] > after]}

    def match_feedback(self, stamp):
        with self.lock:
            if not self.history or not self.feedback_ok(time.monotonic()):
                return None
            recorded, angles = min(self.history, key=lambda item: abs(item[0] - stamp))
            skew = round(abs(recorded - stamp) * 1000)
            return (skew, angles) if skew <= 140 else None

    def feedback_ok(self, now):
        return self.port is not None and self.feedback is not None and now - self.last_feedback < FEEDBACK_TIMEOUT

    def power_ok(self, now):
        return self.voltage is not None and 9 <= self.voltage <= 12.6 and (
            self.bridge_started is not None or now - self.last_voltage < 5
        )

    def snapshot(self, client):
        with self.lock:
            now = time.monotonic()
            task = self.task
            motion = self.motion
            return {
                "connected": self.feedback_ok(now),
                "port": self.port,
                "message": self.connection_message,
                "firmware": self.version,
                "voltage": self.voltage,
                "bridge": self.bridge_started is not None,
                "power_ok": self.power_ok(now),
                "feedback": self.feedback,
                "angles": [kinematics.angle(i, p) for i, p in enumerate(self.positions())] if self.feedback else None,
                "velocity": self.velocity if self.feedback_ok(now) else None,
                "acceleration": self.acceleration if self.feedback_ok(now) else None,
                "action_angles": [kinematics.angle(i, p) for i, p in enumerate(self.commands[-1][1])]
                    if self.commands and self.feedback_ok(now) else None,
                "tcp": kinematics.tcp(self.positions()) if self.feedback else None,
                "revision": self.last_feedback,
                "hz": sum(now - t < 1 for t in self.frame_times),
                "armed": self.owner == client and client is not None,
                "operator_busy": self.owner is not None and self.owner != client,
                "limits": self.limits,
                "torque": self.torque[:],
                "board": None if self.board is None else self.board["group"],
                "task": None if task is None else {
                    "mode": task["mode"], "index": task["index"], "total": len(task["frames"]),
                    "loop": task["loop"],
                },
                "settling": now < self.in_flight_until,
                "moving": motion is not None or now < self.in_flight_until,
                "motion_phase": None if motion is None or motion["xyz"] is None else {
                    "name": "按实测位置重新规划" if motion["replan"] else motion["phases"][motion["phase_index"]]["name"],
                    "index": motion["phase_index"] + 1,
                    "total": len(motion["phases"]),
                },
                "result": self.result,
            }

    def positions(self):
        return [item[0] for item in self.feedback]

    def plan_target(self, data):
        xyz = data.get("xyz")
        if not isinstance(xyz, list) or len(xyz) != 3 or any(
            type(v) not in (int, float) or not -600 <= v <= 600 for v in xyz
        ):
            raise ValueError("请输入有效的 X、Y、Z（毫米）")
        with self.lock:
            if not self.feedback_ok(time.monotonic()):
                raise ValueError("请先连接机械臂，读取当前姿态")
            position = self.positions()
        return position, kinematics.plan_cartesian(position, xyz, kinematics.joint_limits(position))

    def hold(self, now):
        self.pending.clear()
        if self.moving and self.bridge_ready and self.feedback_ok(now):
            self.pending.append((bridge_move(self.positions()), 0, None, None))
        self.moving.clear()
        self.motion = None
        self.task = None
        self.in_flight_until = 0

    def stop(self, now, lock, text):
        self.hold(now)
        if lock:
            self.owner = self.limits = None
        self.message(text)

    def frame(self, frame, bounds=None):
        if not isinstance(frame, dict):
            raise ValueError("动作帧格式无效")
        duration = integer(frame.get("time"), 10, 10000, "本帧时间")
        servos = frame.get("servos")
        if not isinstance(servos, list) or len(servos) != 6:
            raise ValueError("每帧需要六轴舵机位置")
        return {"time": duration, "servos": [self.axis(i, servo, bounds) for i, servo in enumerate(servos)]}

    def axis(self, index, servo, bounds=None):
        if not isinstance(servo, dict):
            raise ValueError("舵机参数格式无效")
        low, high = (bounds if bounds is not None else self.limits)[index]
        return {
            "pos": integer(servo.get("pos"), low, high, f"ID {index + 1} 位置"),
            "acc": integer(servo.get("acc"), 0, 255, f"ID {index + 1} Acc"),
        }

    def set_phases(self, motion, start, phases):
        motion.update(phases=phases, phase_index=0)
        self.set_motion_leg(motion, start, phases[0]["positions"])

    def set_motion_leg(self, motion, start, target):
        motion.update(target=target, origin=start, cursor=0.0, command=None,
                      sent_at=None, phase_started=None, sampled_feedback=None)

    def begin_motion(self, target, duration, label, xyz=None, phases=None):
        start = self.positions()
        bounds = kinematics.joint_limits(start)
        stages = phases or [{"name": label, "positions": target}]
        kinematics.check_path(start, stages[0]["positions"], bounds)
        self.motion = {
            "label": label, "bounds": bounds, "torque_ready_at": None,
            "xyz": xyz, "replan": None, "replans": 0,
            "preferred_speed": max(abs(a - b) for a, b in zip(start, target)) * 1000 / duration if duration else None,
        }
        self.set_phases(self.motion, start, stages)
        if xyz is not None:
            self.log("text", f"第 1/{len(stages)} 段：{stages[0]['name']}")

    def act(self, action, client, data):
        if action in ("preview-target", "move-target"):
            start, candidate = self.plan_target(data)
            if action == "preview-target":
                return candidate
        if action == "park":
            with self.lock:
                if self.owner != client or not self.feedback_ok(time.monotonic()):
                    raise ValueError("请先启用控制并等待读取当前位置")
                park_start = self.positions()
            park = kinematics.plan_park(park_start, kinematics.joint_limits(park_start))
        if action in ("download", "board-run"):
            with self.lock:
                if self.owner != client or not self.feedback_ok(time.monotonic()):
                    raise ValueError("请先启用控制并等待读取当前位置")
                group = integer(data.get("group"), 0, 255, "组 ID")
                start = self.positions()
                source = data.get("frames") if action == "download" else self.group_frames.get(group)
            if not isinstance(source, list) or not 1 <= len(source) <= 255:
                raise ValueError("缺少可检查的动作组，请编辑并下载")
            bounds = kinematics.joint_limits(start)
            group_plan = [self.frame(frame, bounds) for frame in source]
            self.check_group(start, group_plan)
        with self.lock:
            now = time.monotonic()
            if action == "read":
                if self.port is None:
                    raise ValueError("USB 串口未连接")
                self.read_pending = True
                self.log("text", "读取六个舵机的实际位置")
                return {"revision": self.last_feedback}
            if action == "board-stop":
                if self.port is None:
                    raise ValueError("USB 串口未连接")
                if self.bridge_started is not None:
                    raise ValueError("当前在电脑控制模式，请使用主界面停止")
                self.board_stop_pending = True
                self.board = None
                self.message("已请求停止板载动作")
                return {}
            if action in ("stop", "disarm"):
                if self.owner not in (None, client):
                    raise ValueError("另一个页面正在控制机械臂")
                self.stop(now, True, "已停止电脑端动作，控制已锁定")
                return {}
            if action == "arm":
                if self.owner not in (None, client):
                    raise ValueError("另一个页面正在控制机械臂")
                if not self.feedback_ok(now) or not self.power_ok(now):
                    raise ValueError("请等待关节反馈和供电就绪")
                if self.owner != client:
                    self.owner_since = now
                self.owner = client
                self.lease_end = now + LEASE_TIMEOUT
                self.limits = kinematics.joint_limits(self.positions())
                self.message("实时控制已启用")
                return {}
            if self.owner != client or now >= self.lease_end:
                raise ValueError("请先启用控制")
            if action == "heartbeat":
                self.lease_end = now + LEASE_TIMEOUT
                return {}
            if not self.feedback_ok(now) or not self.power_ok(now):
                raise ValueError("反馈或电压不可用")
            if self.task or self.board is not None or self.pending or self.motion:
                raise ValueError("请等待当前操作完成，或按停止")
            self.limits = kinematics.joint_limits(self.positions())
            if action == "move-target":
                if max(abs(a - b) for a, b in zip(start, self.positions())) > 16:
                    raise ValueError("当前姿态已变化，请重新检查目标")
                self.begin_motion(candidate["positions"], 0, "坐标运动", data["xyz"], candidate["phases"])
                self.message("坐标路径检查通过，开始运动")
                return candidate
            if action == "park":
                if max(abs(a - b) for a, b in zip(park_start, self.positions())) > 8:
                    raise ValueError("当前姿态已变化，请重新复位")
                self.begin_motion(park["positions"], 0, "复位", phases=park["phases"])
                self.message("复位路径检查通过")
                return park
            if action == "jog":
                device = integer(data.get("device"), 1, 6, "舵机 ID")
                requested = kinematics.position_for_angle(device - 1, data.get("angle"))
                speed = integer(data.get("speed"), 0, 3400, "速度设置")
                target = self.positions()
                target[device - 1] = requested
                duration = max(350, min(10000, int(abs(target[device - 1] - self.feedback[device - 1][0]) * 1000 / max(60, speed))))
                self.begin_motion(target, duration, f"J{device} 单轴运动")
                self.message(f"J{device} 已通过轨迹检查")
                return {}
            if action == "move-joints":
                angles = data.get("angles")
                if not isinstance(angles, list) or len(angles) != 6:
                    raise ValueError("请提供六轴目标角度")
                target = self.positions()
                for i, value in enumerate(angles):
                    if value is not None:
                        target[i] = kinematics.position_for_angle(i, value)
                self.begin_motion(target, 0, "关节运动")
                self.message("关节路径检查通过，开始运动")
                return {}
            if action == "torque":
                device = data.get("device")
                enabled = data.get("enabled")
                if type(enabled) is not bool:
                    raise ValueError("无效的扭矩状态")
                self.hold(now)
                self.pending.clear()
                if self.bridge_started is not None and device is not None:
                    raise ValueError("桥接模式支持全部上电或全部掉电")
                if device is None:
                    command = packet(BRIDGE_TORQUE if self.bridge_ready else TORQUE, bytes([enabled]))
                else:
                    integer(device, 1, 6, "舵机 ID")
                    command = packet(SERVO_WRITE, bytes([40, enabled]), device)
                self.pending.append((command, 0, device, enabled))
                self.message(f"{'全部舵机' if device is None else f'舵机 {device}'}{'上电' if enabled else '掉电'}请求")
                return {}
            if action == "calibrate":
                if self.bridge_started is not None:
                    raise ValueError("请重启控制台，恢复板载模式后校准")
                if now < self.in_flight_until:
                    raise ValueError("舵机仍在移动")
                for device in range(1, 5):
                    self.pending.append((packet(CALIBRATE, bytes([device])), 0.15, None, None))
                self.message("已排队发送 ID 1–4 中位校准指令")
                return {}
            if action not in ("run", "download", "board-run", "erase"):
                raise ValueError("未知操作")
            if self.bridge_started is not None and action != "run":
                raise ValueError("请重启控制台，恢复板载模式后操作")
            if action in ("download", "board-run") and max(abs(a - b) for a, b in zip(start, self.positions())) > 16:
                raise ValueError("当前位置已变化，请重新检查动作组")
            if now < self.in_flight_until:
                raise ValueError("请等舵机到位后再运行")
            if action != "run":
                group = integer(data.get("group"), 0, 255, "组 ID")
                if action in ("board-run", "erase"):
                    command = GROUP_RUN if action == "board-run" else GROUP_ERASE
                    if action == "board-run":
                        if self.group_frames.get(group) is not source:
                            raise ValueError("板载组已变化，请重新检查")
                        seconds = self.group_times.get(group)
                        self.board = {"group": group, "until": now + seconds + 0.5 if seconds is not None else None}
                        self.message(f"已请求板载运行，组 ID {group}")
                    else:
                        self.group_times.pop(group, None)
                        self.group_frames.pop(group, None)
                        self.message(f"已请求擦除板载组 ID {group}")
                    self.pending.append((packet(command, bytes([group])), 0, None, None))
                    return {}
            frames = data.get("frames")
            if not isinstance(frames, list) or not 1 <= len(frames) <= 255:
                raise ValueError("动作组需要 1–255 帧")
            validated = group_plan if action == "download" else [self.frame(frame) for frame in frames]
            loops = integer(data.get("loops"), 0, 9999, "循环次数") if action == "run" else 1
            self.task = {
                "mode": action, "frames": validated, "index": 0, "loop": 1, "loops": loops,
                "next_at": now, "group": group if action == "download" else None,
                "previous": [p[0] for p in self.feedback],
                "capture": data.get("capture_id") if action == "run" else None,
                "capture_ready": False,
            }
            if action == "download":
                self.group_times.pop(group, None)
                self.group_frames.pop(group, None)
            self.message(f"{'电脑在线运行' if action == 'run' else f'下载至组 ID {group}'} · {len(validated)} 帧")
            return {}

    def check_group(self, actual, frames):
        bounds = kinematics.joint_limits(actual)
        for frame in frames:
            target = [s["pos"] for s in frame["servos"]]
            kinematics.check_path(actual, target, bounds)
            actual = target

    def transmit(self, link, frame):
        link.write(frame)
        if frame[4] == BRIDGE_WRITE and len(frame) == 18:
            task = self.task or {}
            recording = task.get("capture") if task.get("capture_ready") else None
            self.commands.append((time.monotonic(), struct.unpack("<6h", frame[5:-1]), recording, task.get("loop")))
        self.log("hex", f"[TX] {frame.hex(' ').upper()}")

    def update_feedback(self, joints, now):
        if not all(0 <= p <= 4095 for p, _ in joints) or not any(p for p, _ in joints):
            return False
        if not self.feedback_ok(now):
            self.log("text", "收到 NexArm 六轴实际位置")
        dt = now - self.last_feedback
        if self.feedback is not None and 0.025 <= dt <= 0.40:
            speed = [math.degrees((p - old) * kinematics.SCALE[i]) / dt
                     for i, ((p, _), (old, _)) in enumerate(zip(joints, self.feedback))]
            previous = self.velocity
            weight = 1 - math.exp(-dt / 0.15)
            self.velocity = speed if previous is None else [
                old + weight * (value - old) for value, old in zip(speed, previous)
            ]
            if previous is not None:
                acceleration = [(value - old) / dt for value, old in zip(self.velocity, previous)]
                self.acceleration = acceleration if self.acceleration is None else [
                    old + weight * (value - old) for value, old in zip(acceleration, self.acceleration)
                ]
        elif dt > 0.40:
            self.velocity = self.acceleration = None
        self.feedback = joints
        self.last_feedback = now
        self.frame_times.append(now)
        self.history.append((now, joints))
        self.connection_message = "已收到实际关节反馈"
        return True

    def receive(self, frame, now):
        self.log("hex", f"[RX] {frame.hex(' ').upper()}")
        device, command, payload = frame[2], frame[4], frame[5:-1]
        if device not in (255, 0x5A):
            self.log("text", f"[CB] id=0x{device:02X} status=0x{command:02X} len={len(payload)}")
            return
        if command == JOINT_FEEDBACK and len(payload) >= 24:
            if self.bridge_started is None:
                self.update_feedback(list(struct.iter_unpack("<hh", payload[:24])), now)
        elif command == BRIDGE_READ and self.bridge_reference and len(payload) == 12:
            raw = struct.unpack("<6h", payload)
            joints = [
                (p, round(angle + (p - initial) * scale))
                for p, (initial, angle), scale in zip(raw, self.bridge_reference, ANGLE_PER_TICK)
            ]
            if self.update_feedback(joints, now) and not self.bridge_ready:
                self.bridge_ready = True
                self.log("text", "已验证桥接模式下的六轴编码器反馈")
        elif command == VOLTAGE and len(payload) >= 2:
            voltage = struct.unpack_from("<H", payload)[0]
            self.zero_readings = self.zero_readings + 1 if voltage == 0 else 0
            if self.zero_readings != 1 or self.voltage is None:
                self.voltage = voltage / 1000
                self.last_voltage = now
        elif command == VERSION and len(payload) >= 3:
            self.version = {
                "esp": ".".join(map(str, payload[:3])),
                "at32": ".".join(map(str, payload[3:6])),
            }
            self.log("text", f"ESP32 {self.version['esp']} · AT32 {self.version['at32']}")
        elif command != 11:
            self.log("text", f"[CB] id=0x{device:02X} cmd={command} len={len(payload)}")

    def request_replan(self, link, motion, actual, now, axis, reason):
        if motion["xyz"] is None or motion["replans"] >= 2:
            self.stop(now, True, reason + "，已停止")
            return
        if self.bridge_ready and self.moving:
            self.transmit(link, bridge_move(actual))
        motion["replans"] += 1
        motion["replan"] = {"axis": axis, "settle": now + 0.22, "deadline": now + 7}
        self.log("text", reason + "，从实测姿态搜索备用路径")

    def tick_replan(self, motion, actual, now):
        replan = motion["replan"]
        if now >= replan["deadline"]:
            self.stop(now, True, "实测姿态重规划超时，已停止")
            return
        if now < replan["settle"]:
            return
        if "start" not in replan:
            replan["start"] = actual
            axis = replan["axis"]
            bounds = kinematics.joint_limits(actual)

            def compute():
                try:
                    constrained = kinematics.lock_axes(bounds, {axis: actual[axis]}) if axis is not None else bounds
                    try:
                        solution = kinematics.plan_cartesian(actual, motion["xyz"], constrained)
                    except ValueError:
                        if axis is None or motion["replans"] > 1:
                            raise
                        solution = kinematics.plan_cartesian(actual, motion["xyz"], bounds)
                    answer = (solution, None)
                except ValueError as exc:
                    answer = (None, str(exc))
                with self.lock:
                    if self.motion is motion:
                        replan["answer"] = answer

            threading.Thread(target=compute, daemon=True).start()
        if "answer" not in replan:
            return
        solution, error = replan["answer"]
        if error or max(abs(a - b) for a, b in zip(actual, replan["start"])) > 10:
            self.stop(now, True, f"备用路径未通过（{error or '起始姿态仍在变化'}），已停止")
            return
        phases = solution["phases"] or [{"name": "末端复核", "positions": solution["positions"]}]
        motion["bounds"] = kinematics.joint_limits(actual)
        self.set_phases(motion, actual, phases)
        motion["replan"] = None
        self.log("text", f"新的六轴路径已校验，共 {len(phases)} 段")

    def tick_motion(self, link, now):
        motion = self.motion
        actual = self.positions()
        if motion["replan"]:
            self.tick_replan(motion, actual, now)
            return
        if motion["sampled_feedback"] == self.last_feedback:
            return
        xyz, goal = motion["xyz"], motion["target"]
        next_index = motion["phase_index"] + 1
        final = next_index == len(motion["phases"])
        remaining = [abs(a - b) for a, b in zip(actual, goal)]
        largest = max(remaining)
        settled = not self.velocity or max(map(abs, self.velocity)) <= 3.0
        tcp_error = math.dist(kinematics.tcp(actual), xyz) if xyz is not None and final else None
        reached = largest <= 5 if tcp_error is None else tcp_error <= 3.0 and largest <= 12
        if final and reached and (motion["command"] is None or (motion["command"] == goal and settled)):
            if motion["command"] is not None and largest > 5:
                self.transmit(link, bridge_move(actual))
            self.motion = None
            self.in_flight_until = now
            self.moving.clear()
            self.message(f"{motion['label']}完成，末端误差 {tcp_error:.1f} mm" if tcp_error is not None
                         else f"{motion['label']}完成，已收到实机反馈")
            return
        if not final and (largest <= 5 or (motion["command"] == goal and largest <= 32)):
            phase = motion["phases"][next_index]
            next_goal = phase["positions"]
            if phase["name"] == "底座转向":
                next_goal = [next_goal[0], *actual[1:]]
            try:
                kinematics.check_path(actual, next_goal, motion["bounds"])
            except ValueError as exc:
                self.request_replan(link, motion, actual, now, None, f"按实测姿态复查后续路径：{exc}")
                return
            motion["phase_index"] = next_index
            self.set_motion_leg(motion, actual, next_goal)
            self.log("text", f"第 {next_index + 1}/{len(motion['phases'])} 段：{phase['name']}")
            return
        if self.bridge_started is None:
            self.transmit(link, packet(BRIDGE_MODE, b"\x01"))
            self.bridge_started = now
            self.bridge_reference = self.feedback[:]
            self.log("text", "切换到 LeRobot 桥接模式")
            return
        if not self.bridge_ready:
            return
        if motion["torque_ready_at"] is None:
            if any(value is not True for value in self.torque):
                self.transmit(link, packet(BRIDGE_TORQUE, b"\x01"))
                self.torque[:] = [True] * 6
                motion["torque_ready_at"] = now + 0.05
                return
            motion["torque_ready_at"] = now
        if now < motion["torque_ready_at"]:
            return

        motion["sampled_feedback"] = self.last_feedback
        start = motion["origin"]
        deltas = [b - a for a, b in zip(start, goal)]
        span = max(map(abs, deltas))
        speed = max(75, min(210, round(motion["preferred_speed"] or (125 if xyz is not None else 165))))
        if motion["phase_started"] is None:
            motion.update(phase_started=now, best=remaining[:], progress_at=[now] * 6)
        for i, error in enumerate(remaining):
            if error <= motion["best"][i] - 3:
                motion["best"][i] = error
                motion["progress_at"][i] = now

        old_command = motion["command"]
        if old_command is not None:
            outstanding = [abs(a - b) for a, b in zip(actual, old_command)]
            stalled = [i for i, error in enumerate(outstanding)
                       if error > (12 if final and old_command == goal else 23)
                       and now - motion["progress_at"][i] > 1.45]
            final_residual = old_command == goal and now - motion["sent_at"] > 1.45 and settled
            timed_out = now - motion["phase_started"] > max(4.5, 3 + 2.8 * span / speed)
            if stalled or final_residual or timed_out:
                axis = max(stalled, key=outstanding.__getitem__) if stalled else remaining.index(largest)
                observed, expected = (kinematics.angle(axis, pos) for pos in (actual[axis], goal[axis]))
                description = f"J{axis + 1} 跟踪偏差（实测 {observed:.1f}°，目标 {expected:.1f}°）"
                if tcp_error is not None:
                    description += f"，末端误差 {tcp_error:.1f} mm"
                self.request_replan(link, motion, actual, now, axis if largest > 9 else None, description)
                return

        # Advance a common trajectory cursor from fresh encoder samples. Each
        # axis bounds how far the lookahead can get ahead of its actual position.
        lead = 55
        ceiling = min((travel + lead) / abs(delta)
                      for a, origin, delta in zip(actual, start, deltas) if abs(delta) > lead
                      for travel in [(a - origin) * (1 if delta > 0 else -1)]) if span > lead else 1
        step = speed * min(0.16, now - motion["sent_at"]) if old_command is not None else lead
        cursor = min(span, ceiling * span, motion["cursor"] + step)
        if old_command is not None and cursor < motion["cursor"] + 2 and cursor < span:
            return
        goal_fraction = max(0, cursor) / span if span else 1
        command = [round(origin + goal_fraction * delta) for origin, delta in zip(start, deltas)]
        if command == old_command:
            return
        try:
            kinematics.check_path(actual, command, motion["bounds"])
        except ValueError as exc:
            self.request_replan(link, motion, actual, now, None, f"实测路径校验失败：{exc}")
            return
        if motion.get("sent_speed") != speed:
            self.transmit(link, packet(BRIDGE_PARAMS, struct.pack("<BH", 75, speed)))
            motion["sent_speed"] = speed
        self.transmit(link, bridge_move(command))
        motion.update(command=command, cursor=cursor, sent_at=now)
        self.in_flight_until = now + 0.25
        self.moving.update(i + 1 for i, (a, b) in enumerate(zip(actual, command)) if a != b)

    def tick(self, link, now):
        if self.board_stop_pending:
            self.transmit(link, packet(GROUP_STOP))
            self.board_stop_pending = False
        entering = self.bridge_started is not None and not self.bridge_ready
        if entering and now - self.bridge_started > 1.8:
            raise serial.SerialException("控制器没有返回桥接编码器读数")
        if self.owner is not None and (
            now >= self.lease_end or (not entering and not self.feedback_ok(now)) or not self.power_ok(now)
        ):
            self.stop(now, True, "控制已锁定。页面心跳、关节反馈或供电中断")
        if self.board and self.board["until"] is not None and now >= self.board["until"]:
            self.board = None
            self.log("text", "板载组的预计运行时间已结束")
        if self.pending and now >= self.next_packet:
            frame, delay, device, torque = self.pending.popleft()
            self.transmit(link, frame)
            self.next_packet = now + delay
            if torque is not None:
                if device is None:
                    self.torque[:] = [torque] * 6
                else:
                    self.torque[device - 1] = torque
        if self.pending or self.owner is None:
            return
        if self.motion:
            self.tick_motion(link, now)
            return
        task = self.task
        if task is None or now < task["next_at"]:
            return
        if task["capture"] and not task["capture_ready"]:
            # Every recorded repetition starts at the same taught pose.
            start = [servo["pos"] for servo in task["frames"][0]["servos"]]
            if task["index"] == 0:
                try:
                    self.begin_motion(start, 0, f"采集第 {task['loop']} 回合 · 准备起点")
                except ValueError as exc:
                    self.stop(now, True, f"采集起点路径不可用（{exc}）")
                    return
                task["index"] = 1
                return
            task["capture_ready"] = True
        if task["index"] == len(task["frames"]):
            if task["capture"]:
                self.capture_completed = (task["capture"], task["loop"], now)
            if task["mode"] == "download":
                self.group_times[task["group"]] = sum(f["time"] for f in task["frames"]) / 1000
                self.group_frames[task["group"]] = task["frames"]
                self.message(f"组 ID {task['group']} 的 {task['index']} 帧已发送。可在 HEX 日志核对通讯")
            elif task["loops"] == 0 or task["loop"] < task["loops"]:
                task["loop"] += 1
                task["index"] = 0
                task["capture_ready"] = False
                return
            else:
                self.message("电脑在线运行结束")
            self.task = None
            return
        frame = task["frames"][task["index"]]
        task["index"] += 1
        if task["mode"] == "download":
            self.transmit(link, download_frame(task["group"], len(task["frames"]), task["index"], frame, task["previous"]))
            task["previous"] = [s["pos"] for s in frame["servos"]]
            task["next_at"] = now + 0.15
            return
        goal = [s["pos"] for s in frame["servos"]]
        try:
            self.begin_motion(goal, frame["time"], f"在线第 {task['loop']} 轮 · 第 {task['index']} 帧")
        except ValueError as exc:
            self.stop(now, True, f"{exc}，已停止在线运动")
            return
        task["next_at"] = now + frame["time"] / 1000

    def run_link(self, path):
        if initialize_generic_ch340(path):
            print(f"USB: initialized generic CH340 at 1000000 baud: {path}", flush=True)
        link = serial.Serial(baudrate=1_000_000, timeout=0.015, write_timeout=0.25, exclusive=True)
        link.port = path
        link.dtr = False
        link.rts = False
        with link:
            print(f"USB: {path}", flush=True)
            with self.lock:
                self.port = path
                self.connection_message = "等待控制器启动及关节反馈"
                self.log("text", f"USB 串口已打开 · {path} @ 1000000")
                self.voltage = self.version = None
                self.zero_readings = 0
                self.last_feedback = self.next_packet = 0
                self.torque[:] = [None] * 6
                self.frame_times.clear()
                self.history.clear()
                self.commands.clear()
                self.velocity = self.acceleration = None
                self.read_pending = False
                self.bridge_started = self.bridge_reference = None
                self.bridge_ready = False
            parser = Frames()
            start = time.monotonic() + 6
            next_joint = next_voltage = next_version = start
            while not self.closing.is_set():
                frames = list(parser.feed(link.read(link.in_waiting or 1)))
                now = time.monotonic()
                with self.lock:
                    for frame in frames:
                        self.receive(frame, now)
                    self.tick(link, now)
                    if now >= next_joint or self.read_pending:
                        self.read_pending = False
                        read_command = JOINT_FEEDBACK if self.bridge_started is None else BRIDGE_READ
                        self.transmit(link, packet(read_command))
                        next_joint = now + POLL_INTERVAL
                    if self.bridge_started is None and now >= next_voltage:
                        self.transmit(link, packet(VOLTAGE))
                        next_voltage = now + 0.8
                    if self.bridge_started is None and now >= next_version and self.version is None:
                        self.transmit(link, packet(VERSION))
                        next_version = now + 1.2
            if self.bridge_started is not None:
                self.transmit(link, packet(BRIDGE_MODE, b"\x00"))

    def run(self):
        while not self.closing.is_set():
            paths = glob.glob("/dev/cu.usbserial-*") + glob.glob("/dev/cu.wchusbserial*")
            paths += glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")
            path = self.requested_port or (paths[0] if len(paths) == 1 else None)
            if path is None:
                with self.lock:
                    self.connection_message = "请指定串口（检测到多个 USB 串口）" if paths else "等待 NexArm USB 串口"
            elif Path(path).exists():
                try:
                    self.run_link(path)
                except (OSError, serial.SerialException) as exc:
                    print(f"USB: {exc}", flush=True)
                    with self.lock:
                        self.port = None
                        self.voltage = self.version = None
                        self.connection_message = "串口中断或被占用，正在重连"
                        self.stop(time.monotonic(), True, "USB 通信中断，控制已锁定")
            self.closing.wait(1.5)


class ConsoleHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64


def application(controller, origin, camera, view_password=None, recorder=None, external_camera=None, history=None, depth_camera=None, episodes=None):
    key = secrets.token_urlsafe(32)
    viewing = view_password is not None
    authorization = "Basic " + base64.b64encode(f"nexarm:{view_password}".encode()).decode() if viewing else ""

    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        disable_nagle_algorithm = True

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / "dist"), **kwargs)

        def allowed_host(self):
            return self.headers.get("Host") == origin.split("//")[1]

        def allow_view(self):
            if not self.allowed_host():
                self.send_error(403)
                return False
            if viewing and not secrets.compare_digest(self.headers.get("Authorization", "").encode(), authorization.encode()):
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="NexArm LAN"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
            return True

        def client(self):
            value = self.headers.get("X-Operator", "")
            return value if len(value) == 36 else None

        def response(self, value, code=200):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def camera_frame(self, feed, with_pose=True, color=False):
            if feed is None:
                self.send_error(404)
                return
            values = parse_qs(urlsplit(self.path).query)
            try:
                after = float(values.get("after", ["0"])[0])
            except ValueError:
                after = 0
            status, frame = feed.color_frame(after) if color else feed.frame(after)
            self.send_response(200 if frame else 204)
            self.send_header("X-Camera-State", status)
            self.send_header("Cache-Control", "no-store")
            if frame:
                stamp, jpeg = frame
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpeg)))
                self.send_header("X-Camera-Time", str(stamp))
                sample = controller.match_feedback(stamp) if with_pose else None
                if sample:
                    skew, joints = sample
                    self.send_header("X-Pose-Skew", str(skew))
                    self.send_header("X-Camera-Pose", json.dumps(joints, separators=(",", ":")))
            self.end_headers()
            if frame:
                try:
                    self.wfile.write(jpeg)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def do_GET(self):
            if not self.allow_view():
                return
            path = urlsplit(self.path).path
            if path.startswith("/api/episodes/") and episodes and not viewing:
                self.episode_get(path)
            elif path == "/api/history/sessions" and history:
                self.response(history.sessions())
            elif path in ("/api/history/samples", "/api/history/archive") and history:
                try:
                    params = parse_qs(urlsplit(self.path).query)
                    identifier = params.get("id", [""])[0]
                    if path.endswith("samples"):
                        self.response(history.samples(identifier, int(params.get("after", ["0"])[0]), int(params.get("limit", ["2000"])[0])))
                    else:
                        archive = history.archive(identifier)
                        with archive.open("rb") as stream:
                            self.send_response(200)
                            self.send_header("Content-Type", "application/zip")
                            self.send_header("Content-Length", str(archive.stat().st_size))
                            self.send_header("Content-Disposition", f'attachment; filename="nexarm-{identifier}.zip"')
                            self.end_headers()
                            shutil.copyfileobj(stream, self.wfile)
                except (ValueError, OSError) as exc:
                    self.response({"error": str(exc)}, 400)
            elif path == "/api/depth-info":
                self.response(depth_camera.info() if depth_camera else {"status": "disabled"})
            elif path == "/api/depth":
                try:
                    after = float(parse_qs(urlsplit(self.path).query).get("after", ["0"])[0])
                    if not math.isfinite(after):
                        raise ValueError()
                except ValueError:
                    self.response({"error": "Invalid depth timestamp"}, 400)
                    return
                status, frame = depth_camera.frame(after) if depth_camera else ("disabled", None)
                self.send_response(200 if frame else 204)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Camera-State", status)
                if frame:
                    stamp, payload = frame
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("X-Camera-Time", str(stamp))
                    self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if frame:
                    try:
                        self.wfile.write(payload)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            elif path == "/api/camera-info":
                info = {name: {"configured_resolution": feed.resolution, "requested_fps": feed.fps, "format": feed.input_format, "status": feed.frame(0)[0]} for name, feed in (("wrist", camera), ("external", external_camera)) if feed is not None and hasattr(feed, "resolution")}
                if depth_camera:
                    info["depth"] = depth_camera.info()
                    info["realsense_rgb"] = depth_camera.color_info()
                self.response(info)
            elif path == "/api/capture-state" and recorder and not viewing:
                self.response(recorder.snapshot())
            elif path == "/api/capture-library" and recorder and not viewing:
                self.response(recorder.library())
            elif path == "/api/capture-file" and recorder and not viewing:
                params = parse_qs(urlsplit(self.path).query)
                identifier = params.get("id", [""])[0]
                variant = params.get("format", [""])[0]
                if (len(identifier) != 32 or any(letter not in "0123456789abcdef" for letter in identifier)
                        or variant not in ("raw", "lerobot")):
                    self.send_error(404)
                    return
                name = identifier + ("-lerobot" if variant == "lerobot" else "") + ".zip"
                try:
                    archive = (recorder.root / name).open("rb")
                except FileNotFoundError:
                    self.send_error(404)
                    return
                with archive:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(os.fstat(archive.fileno()).st_size))
                    self.send_header("Content-Disposition", f'attachment; filename="nexarm-{name}"')
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    try:
                        shutil.copyfileobj(archive, self.wfile, 256 * 1024)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            elif path == "/api/camera":
                self.camera_frame(camera)
            elif path == "/api/camera/external":
                self.camera_frame(external_camera, with_pose=False)
            elif path == "/api/camera/realsense":
                self.camera_frame(depth_camera, with_pose=False, color=True)
            elif self.path == "/api/state":
                state = controller.snapshot(None if viewing else self.client())
                if viewing:
                    state["remote_view"] = True
                self.response(state)
            elif urlsplit(self.path).path == "/api/logs":
                values = parse_qs(urlsplit(self.path).query).get("after", ["0"])
                after = int(values[0]) if values[0].isascii() and values[0].isdigit() and len(values[0]) <= 12 else 0
                self.response(controller.read_logs(after))
            elif self.path == "/api/session" and not viewing:
                self.response({"key": key})
            elif self.path.startswith("/api/"):
                self.send_error(404)
            else:
                super().do_GET()

        def do_HEAD(self):
            if self.allow_view():
                super().do_HEAD()

        def episode_get(self, path):
            params = parse_qs(urlsplit(self.path).query)
            identifier = params.get("id", [""])[0]

            def send(stream, content_type, name=None, encoding=None):
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
                self.send_header("Cache-Control", "no-store")
                if name:
                    self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                if encoding:
                    self.send_header("Content-Encoding", encoding)
                self.end_headers()
                try:
                    shutil.copyfileobj(stream, self.wfile, 256 * 1024)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            try:
                if path == "/api/episodes/library":
                    self.response(episodes.library())
                elif path == "/api/episodes/detail":
                    self.response(episodes.detail(identifier))
                elif path == "/api/episodes/media":
                    channel = params.get("channel", [""])[0]
                    file = episodes.media(identifier, int(params.get("frame", ["-1"])[0]), channel)
                    with file.open("rb") as stream:
                        send(stream, "application/octet-stream" if channel == "depth" else "image/jpeg",
                             encoding="gzip" if channel == "depth" else None)
                elif path == "/api/episodes/archive":
                    variant = params.get("format", [""])[0]
                    if variant not in ("raw", "training"):
                        raise ValueError("无效的导出格式")
                    with tempfile.TemporaryFile(dir=episodes.root) as stream:
                        episodes.archive(identifier, variant == "training", stream)
                        stream.seek(0)
                        send(stream, "application/zip", f"nexarm-episode-{identifier}-{variant}.zip")
                else:
                    self.send_error(404)
            except (ValueError, OSError) as exc:
                self.response({"error": str(exc)}, 404 if isinstance(exc, FileNotFoundError) else 409)

        def do_POST(self):
            if viewing:
                self.close_connection = True
                self.response({"error": "局域网页面仅供查看"}, 403)
                return
            client = self.client()
            if (not self.allowed_host() or self.headers.get("Origin") != origin or client is None
                    or not secrets.compare_digest(self.headers.get("X-Control-Key", ""), key)):
                self.response({"error": "请在本机控制台操作"}, 403)
                return
            action = self.path.removeprefix("/api/")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536:
                    raise ValueError("请求大小无效")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError("请求格式无效")
                if action == "episode-start" and episodes:
                    result = episodes.start(client, data)
                elif action == "episode-stop" and episodes:
                    result = episodes.stop(client, data)
                elif action == "episode-mark" and episodes:
                    result = episodes.mark(client, data)
                elif action == "episode-segment" and episodes:
                    result = episodes.edit_segment(data)
                elif action == "episode-review" and episodes:
                    result = episodes.review(data)
                elif action == "observation-start" and history:
                    result = history.start(data)
                elif action == "observation-stop" and history:
                    result = history.stop()
                elif action == "observation-mark" and history:
                    result = history.annotate(data)
                elif action == "capture-start" and recorder:
                    result = recorder.start(client, data)
                elif action == "capture-export" and recorder:
                    recorder.export(data.get("id"))
                    result = {}
                else:
                    result = controller.act(action, client, data)
            except (ValueError, UnicodeError, OSError) as exc:
                self.response({"error": str(exc)}, 409)
            else:
                self.response(result)

        def log_message(self, format, *args):
            if not self.path.startswith("/api/"):
                super().log_message(format, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765, help="loopback HTTP port")
    parser.add_argument("--device", help="NexArm serial device when more than one is present")
    parser.add_argument("--camera-device", help="Name or UID of the robot arm USB camera")
    parser.add_argument("--camera-format", choices=("mjpeg", "yuyv422"), default="mjpeg")
    parser.add_argument("--camera-resolution", default="640x480")
    parser.add_argument("--external-camera-device", help="Third-person USB camera device")
    parser.add_argument("--external-camera-format", choices=("mjpeg", "yuyv422"), default="mjpeg")
    parser.add_argument("--external-camera-resolution", default="640x480")
    parser.add_argument("--depth-camera", nargs="?", const="auto", help="Enable RealSense D405 depth; optionally specify its serial")
    parser.add_argument("--lan-host", help="IPv4 address for password-protected LAN viewing")
    parser.add_argument("--lerobot-python", default=os.environ.get("NEXARM_LEROBOT_PYTHON"),
                        help="Python executable in an optional LeRobot export environment")
    args = parser.parse_args()
    lan_password = os.environ.get("NEXARM_LAN_PASSWORD") if args.lan_host else None
    if args.lan_host and (args.lan_host == "0.0.0.0" or not lan_password or len(lan_password) < 12):
        parser.error("LAN viewing requires a specific interface address and NEXARM_LAN_PASSWORD (at least 12 characters)")
    if not (ROOT / "dist/index.html").is_file():
        parser.error("Build the browser app first with npm run build")
    controller = Controller(args.device)
    camera = CameraFeed(args.camera_device, args.camera_format, args.camera_resolution)
    external_camera = CameraFeed(args.external_camera_device, args.external_camera_format, args.external_camera_resolution) if args.external_camera_device else None
    depth_camera = DepthFeed(args.depth_camera) if args.depth_camera else None
    history = History(controller, {"wrist": camera, "external": external_camera}, ROOT / ".data" / "observations")
    history_worker = threading.Thread(target=history.run, daemon=True)
    history_worker.start()
    export_path = Path(args.lerobot_python).expanduser().absolute() if args.lerobot_python else ROOT / ".lerobot/bin/python"
    exporter = str(export_path) if os.access(export_path, os.X_OK) else None
    recorder = Recorder(controller, camera, ROOT / ".data" / "captures", exporter)
    episodes = Episodes(controller, camera, external_camera, depth_camera, ROOT / ".data" / "episodes")
    episode_worker = threading.Thread(target=episodes.run, daemon=True)
    episode_worker.start()
    origin = f"http://127.0.0.1:{args.port}"
    server = ConsoleHTTPServer(("127.0.0.1", args.port), application(controller, origin, camera, recorder=recorder, external_camera=external_camera, history=history, depth_camera=depth_camera, episodes=episodes))
    lan_thread = None
    if args.lan_host:
        lan_origin = f"http://{args.lan_host}:{args.port}"
        lan = ConsoleHTTPServer((args.lan_host, args.port), application(controller, lan_origin, camera, lan_password, external_camera=external_camera, history=history, depth_camera=depth_camera))
        lan_thread = threading.Thread(target=lan.serve_forever, daemon=True)
        lan_thread.start()
        print(f"NexArm LAN view: {lan_origin}", flush=True)
    worker = threading.Thread(target=controller.run, daemon=True)
    camera_worker = threading.Thread(target=camera.run, daemon=True)
    worker.start()
    camera_worker.start()
    depth_worker = None
    if depth_camera:
        depth_worker = threading.Thread(target=depth_camera.run, daemon=True)
        depth_worker.start()
    external_worker = None
    if external_camera:
        external_worker = threading.Thread(target=external_camera.run, daemon=True)
        external_worker.start()
    print(f"NexArm Console: {origin}", flush=True)
    def interrupt_service(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt_service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        controller.closing.set()
        episodes.closed.set()
        episode_worker.join(3)
        history.closed.set()
        history_worker.join(3)
        if lan_thread is not None:
            lan.shutdown()
            lan.server_close()
        camera.closed.set()
        camera_worker.join(2)
        if depth_camera:
            depth_camera.closed.set()
            depth_worker.join(4)
        if external_camera:
            external_camera.closed.set()
            external_worker.join(2)
        worker.join(2)
        server.server_close()


if __name__ == "__main__":
    main()
