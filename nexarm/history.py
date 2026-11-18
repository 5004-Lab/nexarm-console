"""Durable passive telemetry and dual-view demonstration recording."""
import json
from pathlib import Path
import shutil
import sqlite3
import threading
import time
from uuid import uuid4
from zipfile import ZipFile, ZIP_STORED


class History:
    def __init__(self, controller, cameras, root):
        self.controller, self.cameras, self.root = controller, cameras, Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "history.sqlite3"
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.active = None
        self.error = None
        self.last_images = {}
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, created REAL, metadata TEXT, recording INTEGER, ended REAL);
                CREATE TABLE IF NOT EXISTS samples(seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, stamp REAL, payload TEXT);
                CREATE INDEX IF NOT EXISTS sample_session ON samples(session, seq);
                CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, stamp REAL, payload TEXT);
                CREATE INDEX IF NOT EXISTS event_session ON events(session, seq);''')
            db.execute("UPDATE sessions SET ended=? WHERE ended IS NULL", (time.time(),))
        self.new_session({"task": "操作记录", "mode": "telemetry"}, False)

    def connect(self):
        return sqlite3.connect(self.database, timeout=5)

    @staticmethod
    def identifier(value):
        if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("记录编号无效")
        return value

    def new_session(self, metadata, recording):
        identifier = uuid4().hex
        metadata = {**metadata, "clock": {"host_monotonic_s": time.monotonic(), "unix_s": time.time()},
                    "camera_profiles": {name: {"resolution": getattr(camera, "resolution", None), "format": getattr(camera, "input_format", None)} for name, camera in self.cameras.items() if camera}}
        with self.lock, self.connect() as db:
            if self.active:
                db.execute("UPDATE sessions SET ended=? WHERE id=?", (time.time(), self.active))
            db.execute("INSERT INTO sessions VALUES(?,?,?,?,NULL)", (identifier, time.time(), json.dumps(metadata, ensure_ascii=False), int(recording)))
            self.active, self.metadata, self.recording = identifier, metadata, recording
            self.started, self.last_images = time.monotonic(), {}
        return identifier

    def start(self, data):
        task = data.get("task", "").strip() if isinstance(data.get("task"), str) else ""
        if not 1 <= len(task) <= 240:
            raise ValueError("请填写任务指令")
        with self.lock:
            if self.recording:
                raise ValueError("已有示教记录正在采集")
            if shutil.disk_usage(self.root).free < 500 * 1024**2:
                raise ValueError("可用空间不足 500 MB")
            required = [name for name, camera in self.cameras.items() if camera is not None]
            if len(required) != 2 or any(self.cameras[name].frame(0)[1] is None for name in required):
                raise ValueError("双视角示教需要两台相机均在线")
            metadata = {key: str(data.get(key, ""))[:240] for key in ("task", "objects", "tools", "scene", "calibration")}
            metadata.update(mode="demonstration", fps=5, cameras=required, image_timestamp="host_receive_monotonic", action_semantics="last transmitted command; null when none has been sent")
            self.new_session(metadata, True)
            self.error = None
        return self.status()

    def stop(self):
        with self.lock:
            if self.recording:
                self.annotate({"label": "采集结束"})
                self.new_session({"task": "操作记录", "mode": "telemetry"}, False)
        return self.status()

    def annotate(self, data):
        label = data.get("label")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120:
            raise ValueError("标注须为 1–120 字符")
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO events(session,stamp,payload) VALUES(?,?,?)", (self.active, time.monotonic(), json.dumps({"label": label.strip()}, ensure_ascii=False)))
        return {"ok": True}

    def status(self):
        with self.lock:
            return {"id": self.active, "recording": self.recording, "metadata": self.metadata, "error": self.error}

    def sessions(self):
        with self.connect() as db:
            rows = db.execute("SELECT s.id,s.created,s.metadata,s.recording,s.ended,COUNT(p.seq),MIN(p.stamp),MAX(p.stamp) FROM sessions s LEFT JOIN samples p ON p.session=s.id GROUP BY s.id ORDER BY s.created DESC LIMIT 100").fetchall()
        return {"active": self.status(), "sessions": [{"id": r[0], "created": r[1], "metadata": json.loads(r[2]), "images": bool(r[3]), "ended": r[4], "samples": r[5], "first": r[6], "last": r[7]} for r in rows]}

    def samples(self, identifier, after=0, limit=2000):
        self.identifier(identifier)
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 5000:
            raise ValueError("分页参数无效")
        with self.connect() as db:
            rows = db.execute("SELECT seq,stamp,payload FROM samples WHERE session=? AND seq>? ORDER BY seq LIMIT ?", (identifier, after, limit)).fetchall()
            events = db.execute("SELECT stamp,payload FROM events WHERE session=? ORDER BY seq", (identifier,)).fetchall()
        return {"samples": [{"seq": r[0], "stamp": r[1], **json.loads(r[2])} for r in rows], "events": [{"stamp": r[0], **json.loads(r[1])} for r in events], "cursor": rows[-1][0] if rows else after, "more": len(rows) == limit}

    def run(self):
        revision = None
        last_result = None
        while not self.closed.wait(0.1):
            try:
                state = self.controller.snapshot(None)
                now = time.monotonic()
                with self.lock:
                    identifier = self.active
                    recording = self.recording
                    if recording and (now - self.started > 1200 or shutil.disk_usage(self.root).free < 500 * 1024**2):
                        self.error = "采集已停止：达到 20 分钟或磁盘空间不足"
                        self.stop()
                        continue
                    if state.get("result") and state["result"] != last_result:
                        self.annotate({"label": state["result"][:120]})
                        last_result = state["result"]
                    if revision == (identifier, state.get("revision")) and state.get("connected"):
                        continue
                    if recording and now - getattr(self, "last_record", 0) < 0.19:
                        continue
                    revision = (identifier, state.get("revision"))
                    payload = {key: state.get(key) for key in ("connected", "feedback", "angles", "velocity", "acceleration", "tcp", "action_angles", "voltage", "hz", "moving", "motion_phase", "result")}
                    if hasattr(self.controller, "lock"):
                        with self.controller.lock:
                            command = self.controller.commands[-1] if self.controller.commands else None
                            payload["last_command_stamp"] = command[0] if command else None
                            payload["last_command_encoder_targets"] = command[1] if command else None
                    payload["feedback_stamp"] = state.get("revision")
                    payload["images"] = {}
                    if recording:
                        self.last_record = now
                        directory = self.root / identifier
                        for name, camera in self.cameras.items():
                            frame = camera.nearest(now - 0.05, self.last_images.get(name, 0)) if camera else None
                            if not frame or abs(frame[0] - now) > 0.25:
                                payload["images"][name] = {"missing": True}
                                continue
                            image_path = Path(name) / f"{int(frame[0] * 1_000_000)}.jpg"
                            (directory / name).mkdir(parents=True, exist_ok=True)
                            (directory / image_path).write_bytes(frame[1])
                            self.last_images[name] = frame[0]
                            skew = abs(frame[0] - state.get("revision", 0)) * 1000 if state.get("connected") else None
                            payload["images"][name] = {"path": str(image_path), "stamp": frame[0], "pose_skew_ms": round(skew, 2) if skew is not None else None}
                        payload["training_valid"] = bool(state.get("connected") and state.get("action_angles") is not None and len(payload["images"]) == 2 and all(not image.get("missing") and image.get("pose_skew_ms", 1e6) <= 65 for image in payload["images"].values()))
                    with self.connect() as db:
                        db.execute("INSERT INTO samples(session,stamp,payload) VALUES(?,?,?)", (identifier, now, json.dumps(payload, ensure_ascii=False)))
            except (OSError, ValueError, sqlite3.Error) as error:
                self.error = str(error)

    def archive(self, identifier):
        self.identifier(identifier)
        with self.lock:
            if self.recording and self.active == identifier:
                raise ValueError("请先结束示教记录，再导出完整文件")
        with self.connect() as db:
            row = db.execute("SELECT created,metadata FROM sessions WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise ValueError("记录不存在")
            target = self.root / (identifier + ".zip")
            with ZipFile(target.with_suffix(".tmp"), "w", compression=ZIP_STORED) as output:
                output.writestr("manifest.json", json.dumps({"schema": "nexarm-observations/1", "created": row[0], **json.loads(row[1])}, ensure_ascii=False, indent=2))
                with output.open("samples.jsonl", "w", force_zip64=True) as stream:
                    for seq, stamp, payload in db.execute("SELECT seq,stamp,payload FROM samples WHERE session=? ORDER BY seq", (identifier,)):
                        stream.write((json.dumps({"seq": seq, "stamp": stamp, **json.loads(payload)}, ensure_ascii=False) + "\n").encode())
                output.writestr("events.jsonl", "\n".join(json.dumps({"stamp": stamp, **json.loads(payload)}, ensure_ascii=False) for stamp, payload in db.execute("SELECT stamp,payload FROM events WHERE session=? ORDER BY seq", (identifier,))))
                for image in (self.root / identifier).rglob("*.jpg"):
                    output.write(image, image.relative_to(self.root / identifier))
            target.with_suffix(".tmp").replace(target)
        return target
