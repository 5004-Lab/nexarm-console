"""Record aligned joint feedback, transmitted actions and RGB images to disk."""

import json
from pathlib import Path
import shutil
import subprocess
import threading
import time
from uuid import uuid4
from zipfile import ZipFile

from . import kinematics as arm

MAX_SECONDS = 1200
MAX_SKEW = 0.065


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def package(directory, target):
    with ZipFile(target.with_suffix(".tmp"), "w") as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                archive.write(path, Path(directory.name) / path.relative_to(directory))
    target.with_suffix(".tmp").replace(target)


class Recorder:
    def __init__(self, controller, camera, root, exporter=None):
        self.controller = controller
        self.camera = camera
        self.root = root
        self.exporter = exporter
        self.lock = threading.Lock()
        self.status = {"phase": "idle"}

    def update(self, **fields):
        with self.lock:
            self.status.update(fields)

    def snapshot(self):
        with self.lock:
            return {**self.status, "lerobot_available": bool(self.exporter)}

    def library(self):
        runs = []
        for path in sorted(self.root.glob("*/manifest.json"), key=lambda item: item.stat().st_mtime, reverse=True)[:30]:
            identifier = path.parent.name
            if not (self.root / f"{identifier}.zip").is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            runs.append({
                "id": identifier, "task": data["task"], "fps": data["fps"], "episodes": len(data["episodes"]),
                "archive": f"/api/capture-file?id={identifier}&format=raw",
                "lerobot": f"/api/capture-file?id={identifier}&format=lerobot"
                if (self.root / f"{identifier}-lerobot.zip").is_file() else None,
            })
        return {"runs": runs}

    def start(self, client, data):
        prompt, fps, repeats = (data.get(key) for key in ("prompt", "fps", "loops"))
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 240:
            raise ValueError("请输入 1–240 字符的任务指令")
        if type(fps) is not int or fps not in (5, 8, 10) or type(repeats) is not int or not 1 <= repeats <= 50:
            raise ValueError("采样率为 5、8 或 10 Hz，重复次数为 1–50")
        if self.camera.frame(0)[1] is None:
            raise ValueError("等待腕部相机彩图后再开始采集")
        source = data.get("frames")
        if not isinstance(source, list) or not 2 <= len(source) <= 255:
            raise ValueError("采集需要至少两个动作帧，首帧为每回合的起始姿态")
        with self.controller.lock:
            if self.controller.owner != client or not self.controller.feedback_ok(time.monotonic()):
                raise ValueError("请先启用控制并等待读取当前位置")
            actual = self.controller.positions()
        frames = [self.controller.frame(frame, arm.joint_limits(actual)) for frame in source]
        self.controller.check_group(actual, frames)
        if repeats > 1:
            last = [servo["pos"] for servo in frames[-1]["servos"]]
            first = [servo["pos"] for servo in frames[0]["servos"]]
            arm.check_path(last, first, arm.joint_limits(last))
        with self.lock:
            if self.status["phase"] in ("recording", "packing", "exporting"):
                raise ValueError("已有采集或导出作业")
            self.root.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.root).free < 300 * 1024**2:
                raise ValueError("磁盘可用空间不足 300 MB")
            identifier = uuid4().hex
            directory = self.root / identifier
            directory.mkdir()
            try:
                self.controller.act("run", client, {
                    "frames": source, "loops": repeats, "capture_id": identifier,
                })
            except ValueError:
                directory.rmdir()
                raise
            self.status = {
                "id": identifier, "phase": "recording", "prompt": prompt.strip(), "fps": fps,
                "requested": repeats, "episode": 1, "saved": 0, "frames": 0, "dropped": 0,
            }
        export_v3 = data.get("export_v3") is True and self.exporter is not None
        threading.Thread(target=self.record, args=(directory, fps, repeats, prompt.strip(), export_v3), daemon=True).start()
        return self.snapshot()

    def record(self, directory, fps, repeats, prompt, export_v3=False):
        controller = self.controller
        identifier = directory.name
        started = time.monotonic()
        accepted = []
        episode, frame_count, dropped_count = 1, 0, 0
        next_tick, last_image, last_pose = None, 0.0, None
        first_tick = None
        rows = []
        rejects = 0
        episode_dir = directory / f"episode_{episode:04}"
        try:
            while True:
                now = time.monotonic()
                with controller.lock:
                    active = controller.task and controller.task.get("capture") == identifier
                    current = controller.task["loop"] if active else None
                    completed = controller.capture_completed
                    commands = [command for command in controller.commands if command[2:] == (identifier, episode)]
                    feedback = list(controller.history)
                    if active and (now - started > MAX_SECONDS or controller.closing.is_set()):
                        controller.stop(now, True, "采集超时或服务退出，运动已停止")
                        active = False
                if next_tick is None and commands:
                    first_tick = next_tick = commands[0][0] + 0.055
                finished = completed is not None and completed[:2] == (identifier, episode)
                has_tick = next_tick is not None and (
                    next_tick <= completed[2] if finished else current == episode
                )
                if has_tick and now >= next_tick + 0.10:
                    image = self.camera.nearest(next_tick, last_image)
                    pose = min(feedback, key=lambda item: abs(item[0] - image[0]), default=None) if image else None
                    command = next((item for item in reversed(commands) if image and item[0] <= image[0]), None)
                    if image and pose and command and abs(image[0] - next_tick) <= MAX_SKEW and abs(pose[0] - image[0]) <= MAX_SKEW:
                        image_name = f"{len(rows):06}.jpg"
                        episode_dir.mkdir(exist_ok=True)
                        (episode_dir / image_name).write_bytes(image[1])
                        angles = [arm.angle(i, p) for i, (p, _) in enumerate(pose[1])]
                        velocity = None
                        if last_pose and pose[0] - last_pose[0] > 0.025:
                            velocity = [(a - b) / (pose[0] - last_pose[0]) for a, b in zip(angles, last_pose[1])]
                        rows.append({
                            "timestamp": round(next_tick - first_tick, 6), "observation.image": image_name,
                            "observation.state": angles, "action": [arm.angle(i, p) for i, p in enumerate(command[1])],
                            "observation.tcp_mm": arm.tcp([p for p, _ in pose[1]]),
                            "observation.velocity_deg_s": velocity,
                            "clock_s": {"camera": image[0], "feedback": pose[0], "action": command[0]},
                            "pose_skew_ms": round(abs(pose[0] - image[0]) * 1000, 2), "task": prompt,
                        })
                        last_image = image[0]
                        last_pose = (pose[0], angles)
                        frame_count += 1
                        self.update(frames=frame_count, skew=rows[-1]["pose_skew_ms"])
                    else:
                        rejects += 1
                        dropped_count += 1
                        self.update(dropped=dropped_count)
                    next_tick += 1 / fps
                    if finished:
                        continue
                if finished and has_tick:
                    time.sleep(0.018)
                    continue
                if finished or not active:
                    if finished and len(rows) >= 2 and not rejects:
                        with (episode_dir / "frames.jsonl").open("w", encoding="utf-8") as stream:
                            for row in rows:
                                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                        accepted.append({"directory": episode_dir.name, "samples": len(rows), "repeat": episode})
                    elif episode_dir.exists():
                        shutil.rmtree(episode_dir)
                    self.update(saved=len(accepted))
                    if not active or episode >= repeats:
                        break
                    episode += 1
                    episode_dir = directory / f"episode_{episode:04}"
                    first_tick = next_tick = last_pose = None
                    rows, rejects = [], 0
                    self.update(episode=episode)
                time.sleep(0.018)
            if not accepted:
                self.update(phase="error", message="未生成完整回合。检查画面同步、采样率和动作组实际执行情况")
                return
            self.update(phase="packing")
            write_json(directory / "manifest.json", {
                "schema": "nexarm-episodes/1", "fps": fps, "task": prompt, "episodes": accepted,
                "requested": repeats, "dropped_samples": dropped_count, "max_skew_ms": MAX_SKEW * 1000,
                "joint_order": [f"J{i}" for i in range(1, 7)], "joint_unit": "degrees",
                "action_semantics": "last transmitted six-axis absolute setpoint at image time",
            })
            package(directory, self.root / f"{identifier}.zip")
            self.update(phase="exporting" if export_v3 else "ready", archive=f"/api/capture-file?id={identifier}&format=raw",
                        message=f"已保存 {len(accepted)}/{repeats} 个完整回合")
            if export_v3:
                self.run_export(identifier)
        except (OSError, ValueError) as error:
            with controller.lock:
                if controller.task and controller.task.get("capture") == identifier:
                    controller.stop(time.monotonic(), True, "采集写入失败，已停止")
            self.update(phase="error", message=f"采集失败：{error}")

    def export(self, identifier):
        with self.lock:
            if not self.exporter:
                raise ValueError("请配置 LeRobot 导出环境，参见 README")
            if self.status["phase"] != "ready" or self.status.get("id") != identifier:
                raise ValueError("只可导出当前已打包的采集")
            self.status.update(phase="exporting", export_error=None)
        threading.Thread(target=self.run_export, args=(identifier,), daemon=True).start()

    def run_export(self, identifier):
        output = self.root / f"{identifier}-lerobot"
        script = arm.ROOT / "scripts" / "export-lerobot.py"
        try:
            if output.exists():
                shutil.rmtree(output)
            with (self.root / f"{identifier}-export.log").open("w") as log:
                subprocess.run([self.exporter, str(script), str(self.root / identifier), str(output)],
                               stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800)
            package(output, output.with_suffix(".zip"))
            self.update(phase="ready", lerobot=f"/api/capture-file?id={identifier}&format=lerobot")
        except (OSError, subprocess.SubprocessError) as error:
            self.update(phase="ready", export_error=f"LeRobot 导出失败，请查看本机采集日志（{type(error).__name__}）")
