"""Passive Episode capture and reproducible fixed-rate training views."""

from collections import Counter
import gzip
import json
import math
from pathlib import Path
import shutil
import sqlite3
import struct
import threading
import time
from uuid import uuid4
from zipfile import ZipFile, ZIP_STORED

from . import kinematics
from .history import History

FPS = 5
MAX_SECONDS = 1200
MIN_FREE = 500 * 1024**2
# Give camera workers time to publish frames already stamped by the sampling tick.
PUBLISH_DELAY = .075
MEDIA = {"front": "jpg", "wrist": "jpg", "third": "jpg", "depth": "ndepth.gz"}
CORE = ("feedback", "front", "wrist")
DEFAULT_SKEW_MS = 45
DEFAULT_AGE_MS = 120
AXES = ["J1", "J2", "J3", "J4", "J5", "gripper"]
SCHEMA = "nexarm-multimodal/1"


def vector(pulses):
    angles = [round(kinematics.angle(i, p), 6) for i, p in enumerate(pulses[:5])]
    jaw = kinematics.JOINTS[5]
    opening = (jaw["max"] - pulses[5]) / (jaw["max"] - jaw["min"])
    return angles + [round(max(0, min(1, opening)), 6)]


def stats(rows, field):
    columns = list(zip(*(row[field] for row in rows)))
    means = [sum(column) / len(column) for column in columns]
    deviations = [max(.01, math.sqrt(sum((x - mean)**2 for x in column) / len(column)))
                  for column, mean in zip(columns, means)]
    return {"mean": means, "std": deviations, "count": len(rows)}


def valid_vector(value):
    return isinstance(value, list) and len(value) == len(AXES) and all(
        type(x) in (int, float) and math.isfinite(x) for x in value
    )


def sync_span(offsets, required):
    if not all(key in offsets for key in required):
        return None
    values = [offsets[key] for key in required]
    return round(max(values) - min(values), 2)


def align_sources(sources, previous, tick):
    """Find the shortest window covering fresh samples of every observation source."""
    eligible = {
        key: [sample for sample in frames
              if tick - DEFAULT_AGE_MS / 1000 <= sample[0] <= tick and sample[0] > previous.get(key, -math.inf)]
        for key, frames in sources.items()
    }
    if all(eligible.values()):
        best, score = None, (math.inf, math.inf)
        starts = sorted({sample[0] for frames in eligible.values() for sample in frames})
        for start in starts:
            group = {key: next((frame for frame in frames if frame[0] >= start), None)
                     for key, frames in eligible.items()}
            if not all(group.values()):
                break
            stamps = [frame[0] for frame in group.values()]
            candidate = (max(stamps) - min(stamps), tick - min(stamps))
            if candidate < score:
                best, score = group, candidate
        if best:
            return best
    # Retain available raw media for review when the complete window is unavailable.
    feedback = sources["feedback"][-1] if sources["feedback"] else None
    anchor = feedback[0] if feedback else tick
    return {key: min(reversed(frames), key=lambda frame: abs(frame[0] - anchor), default=None)
            for key, frames in sources.items()}


def prepare(rows, settings, exclusions=()):
    """Filter without modifying source rows or joining samples across gaps."""
    required = set(CORE)
    required.update(key for key in ("third", "depth") if settings[key])
    tolerance = settings["max_skew_ms"]
    max_age = settings.get("max_age_ms", tolerance)
    excluded = {i for segment in exclusions for i in range(segment["first"], segment["last"] + 1)}
    reasons, runs, run, previous = Counter(), [], [], None
    decisions, spans = [], []
    for i, row in enumerate(rows):
        index = row["frame_index"]
        offsets = row["sync_ms"]
        bad = []
        if not settings["first"] <= index <= settings["last"]:
            bad.append("trim")
        if index in excluded:
            bad.append("manual_exclude")
        if row["action"] is None:
            bad.append("no_action")
        elif not valid_vector(row["action"]):
            bad.append("invalid_action")
        if "feedback" in offsets and not valid_vector(row["observation.state"]):
            bad.append("invalid_feedback")
        if 0 < i < len(rows) - 1:
            before, after = rows[i - 1], rows[i + 1]
            if before["frame_index"] + 1 == index == after["frame_index"] - 1:
                values = [sample["observation.state"] for sample in (before, row, after)]
                if all(valid_vector(value) for value in values) and any(
                    abs(a - c) < 5 and min(abs(a - b), abs(b - c)) > 20
                    for a, b, c in zip(*(value[:5] for value in values))
                ):
                    bad.append("feedback_spike")
        for key in sorted(required):
            if key not in offsets:
                bad.append("missing_" + key)
            elif offsets[key] > .01 or abs(offsets[key]) > max_age:
                bad.append("skew_" + key)
            elif key in row["repeated"]:
                bad.append("repeat_" + key)
        if settings["depth"] and "depth" in offsets and (row.get("depth_valid_percent") or 0) < settings.get("min_depth_percent", 1):
            bad.append("empty_depth")
        span = sync_span(offsets, required)
        if span is not None and span > tolerance:
            bad.append("sensor_span")
        if span is not None and "trim" not in bad:
            spans.append(span)
        if run and (bad or index != previous + 1):
            runs.append(run)
            run = []
        if not bad:
            run.append(row)
        previous = index
        decisions.append({"frame_index": index, "reasons": bad, "span_ms": span})
        reasons.update(bad)
    if run:
        runs.append(run)
    clips = []
    for run in runs:
        if len(run) < settings["min_frames"]:
            reasons["short_clip"] += len(run)
            continue
        clips.append({"first": run[0]["frame_index"], "last": run[-1]["frame_index"], "frames": len(run)})
    accepted = [row for run in runs if len(run) >= settings["min_frames"] for row in run]
    accepted_ids = {row["frame_index"] for row in accepted}
    for decision in decisions:
        if not decision["reasons"] and decision["frame_index"] not in accepted_ids:
            decision["reasons"].append("short_clip")
    summary = {"settings": settings, "clips": clips, "accepted": len(accepted), "total": len(rows),
               "rejected_reasons": dict(reasons), "decisions": decisions,
               "skipped_ticks": sum(max(0, b["frame_index"] - a["frame_index"] - 1) for a, b in zip(rows, rows[1:])),
               "normalization": {key: stats(accepted, key) for key in ("observation.state", "action")} if accepted else None}
    if spans:
        spans.sort()
        summary["sync"] = {"p50_ms": spans[math.ceil(len(spans) * .5) - 1],
                           "p95_ms": spans[math.ceil(len(spans) * .95) - 1], "max_ms": spans[-1]}
    return summary


class Episodes:
    def __init__(self, controller, wrist, external, depth, root):
        self.controller, self.wrist, self.external, self.depth = controller, wrist, external, depth
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "episodes.sqlite3"
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.active = None
        self.error = None
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS episodes (
                    idx INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    created REAL, metadata TEXT, result TEXT, ended REAL, review TEXT);
                CREATE TABLE IF NOT EXISTS frames (
                    id TEXT, frame INTEGER, payload TEXT, PRIMARY KEY(id,frame));
                CREATE TABLE IF NOT EXISTS annotations (
                    id TEXT, timestamp REAL, label TEXT);
                CREATE TABLE IF NOT EXISTS segments (
                    id TEXT NOT NULL, episode TEXT NOT NULL, kind TEXT NOT NULL,
                    first INTEGER NOT NULL, last INTEGER NOT NULL, label TEXT NOT NULL,
                    PRIMARY KEY(episode,id));
            """)
            db.execute("UPDATE episodes SET ended=?, result='interrupted' WHERE ended IS NULL", (time.time(),))

    def connect(self):
        return sqlite3.connect(self.database, timeout=5)

    @staticmethod
    def dump(value):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    @staticmethod
    def annotation(value, maximum, required=False):
        value = value.strip() if isinstance(value, str) else ""
        if len(value) > maximum or (required and not value):
            raise ValueError(f"请检查标注内容（最长 {maximum} 字）")
        return value

    def start(self, client, data):
        task = self.annotation(data.get("task"), 240, True)
        front = data.get("front", "d405")
        if front not in ("external", "d405"):
            raise ValueError("无效的 Front 相机")
        with self.lock:
            if self.active:
                raise ValueError("已有 Episode 正在采集")
            if shutil.disk_usage(self.root).free < MIN_FREE:
                raise ValueError("可用空间不足 500 MB")
            now = time.monotonic()
            with self.controller.lock:
                if self.controller.owner not in (None, client) or self.controller.board is not None:
                    raise ValueError("请在当前示教控制页开始记录")
                if not self.controller.feedback_ok(now):
                    raise ValueError("请等待机械臂关节反馈")
            ready = [feed.sample_at(now) if feed else None for feed in (self.wrist, self.external, self.depth)]
            if not all(frame and now - frame[0] <= .25 for frame in ready):
                raise ValueError("请等待腕部、第三人称和 D405 三台相机")
            identifier = uuid4().hex
            metadata = {key: self.annotation(data.get(key), 240) for key in ("objects", "scene", "calibration")}
            roles = {"front": front, "third": "external" if front == "d405" else "d405",
                     "wrist": "wrist", "depth": "d405"}
            devices = {"wrist": getattr(self.wrist, "device", None), "external": getattr(self.external, "device", None),
                       "d405": ready[2][3].get("serial")}
            labels = {"wrist": "腕部相机", "external": "第三人称相机", "d405": "D405"}
            metadata.update(task=task, camera_roles=roles,
                            camera_devices={key: devices[role] for key, role in roles.items()},
                            camera_labels={key: labels[role] for key, role in roles.items()})
            with self.connect() as db:
                idx = db.execute("INSERT INTO episodes(id,created,metadata,result) VALUES(?,?,?,?)",
                                 (identifier, time.time(), self.dump(metadata), "recording")).lastrowid - 1
            self.active = {"id": identifier, "episode_index": idx, "client": client, "origin": now,
                           "started": now, "next": 0, "samples": 0, "valid": 0,
                           "last_sources": {}, "metadata": metadata}
            self.error = None
        return self.status()

    def status(self):
        with self.lock:
            active = self.active
            return {"active": {key: active[key] for key in ("id", "episode_index", "samples", "valid", "metadata")}
                    if active else None, "error": self.error}

    def owned(self, client, identifier):
        if not self.active or self.active["client"] != client or self.active["id"] != identifier:
            raise ValueError("当前页面没有这个 Episode 的采集权")
        return self.active

    def mark(self, client, data):
        label = self.annotation(data.get("label"), 120, True)
        with self.lock, self.connect() as db:
            active = self.owned(client, data.get("id"))
            db.execute("INSERT INTO annotations VALUES(?,?,?)",
                       (active["id"], time.monotonic() - active["origin"], label))
        return {"ok": True}

    def end(self, result):
        identifier = self.active["id"]
        with self.connect() as db:
            db.execute("UPDATE episodes SET ended=?,result=? WHERE id=?", (time.time(), result, identifier))
        self.active = None
        return identifier

    def stop(self, client, data):
        result = data.get("result", "unrated")
        if result not in ("unrated", "success", "failure"):
            raise ValueError("无效的 Episode 结果")
        with self.lock:
            if not self.active or self.active["id"] != data.get("id"):
                raise ValueError("此 Episode 已结束或不存在")
            with self.controller.lock:
                if self.active["client"] != client and self.controller.owner not in (None, client):
                    raise ValueError("另一个页面正在示教")
            return {"id": self.end(result)}

    def controller_sample(self, active, stamp):
        arm = self.controller
        with arm.lock:
            feedback = []
            if arm.feedback_ok(time.monotonic()):
                feedback = [item for item in arm.history if stamp - .35 <= item[0] <= stamp]
            command = None
            if (arm.owner == active["client"] and arm.owner_since <= stamp <= arm.lease_end
                    and arm.board is None and arm.feedback_ok(time.monotonic())):
                since = max(active["origin"], arm.owner_since)
                command = next((item for item in reversed(arm.commands) if since <= item[0] <= stamp), None)
        return feedback, command

    def capture(self, active, index, stamp):
        feedback_frames, command = self.controller_sample(active, stamp)
        roles = active["metadata"]["camera_roles"]
        external_role = "front" if roles["front"] == "external" else "third"
        last = active["last_sources"]
        previous = {**last, "external": last.get(external_role, -math.inf), "d405": last.get("depth", -math.inf)}
        lookback = stamp - .35
        candidates = {"feedback": feedback_frames, "wrist": self.wrist.samples_between(lookback, stamp),
                      "external": self.external.samples_between(lookback, stamp),
                      "d405": self.depth.samples_between(lookback, stamp)}
        sensors = align_sources(candidates, previous, stamp)
        feedback, d405 = sensors["feedback"], sensors["d405"]
        row = {"episode_index": active["episode_index"], "frame_index": index, "timestamp": index / FPS,
               "task": active["metadata"]["task"], "observation.state": None, "action": None,
               "feedback_encoder": None, "command_encoder": None, "source_timestamps": {}, "sync_ms": {},
               "repeated": []}
        directory = self.root / active["id"]

        def track(key, measured):
            row["source_timestamps"][key] = round(measured - active["origin"], 6)
            if key == "action":
                return
            row["sync_ms"][key] = round((measured - stamp) * 1000, 2)
            if measured <= active["last_sources"].get(key, -math.inf):
                row["repeated"].append(key)
            else:
                active["last_sources"][key] = measured

        if feedback and stamp - feedback[0] <= .35:
            track("feedback", feedback[0])
            row["feedback_encoder"] = [item[0] for item in feedback[1]]
            row["observation.state"] = vector(row["feedback_encoder"])
        if command:
            track("action", command[0])
            row["command_encoder"] = list(command[1])
            row["action"] = vector(command[1])

        def save(key, field, source, payload):
            track(key, source[0])
            path = Path("media") / f"{index:06d}-{key}.{MEDIA[key]}"
            (directory / path).write_bytes(payload)
            row[field] = path.as_posix()

        (directory / "media").mkdir(parents=True, exist_ok=True)
        for name in ("front", "wrist", "third"):
            source = sensors[roles[name]]
            row[f"observation.images.{name}"] = None
            if source and stamp - source[0] <= .35:
                save(name, f"observation.images.{name}", source, source[1])
        row["observation.depth"] = None
        if d405 and stamp - d405[0] <= .35:
            _, _, pixels, info = d405
            meta = dict(info, version=1, encoding="z16-le", planes=["raw"])
            header = self.dump(meta).encode()
            raw = struct.pack("<I", len(header)) + header + pixels.astype("<u2", copy=False).tobytes()
            save("depth", "observation.depth", d405, gzip.compress(raw, compresslevel=1))
            row["depth_valid_percent"] = info["valid_percent"]
        with self.connect() as db:
            db.execute("INSERT INTO frames VALUES(?,?,?)", (active["id"], index, self.dump(row)))
        active["samples"] += 1
        span = sync_span(row["sync_ms"], CORE)
        if command and span is not None and span <= DEFAULT_SKEW_MS and all(
            abs(row["sync_ms"][key]) <= DEFAULT_AGE_MS and key not in row["repeated"] for key in CORE
        ):
            active["valid"] += 1

    def run(self):
        # Hold the capture lock only while appending one frame, so stop waits for its commit.
        while not self.closed.wait(.02):
            with self.lock:
                if not self.active:
                    continue
                active = self.active
                now = time.monotonic()
                try:
                    if now - active["started"] >= MAX_SECONDS or (active["next"] % FPS == 0 and shutil.disk_usage(self.root).free < MIN_FREE):
                        self.error = "达到采集时间上限或剩余磁盘不足"
                        self.end("interrupted")
                        continue
                    due = math.floor((now - active["origin"] - PUBLISH_DELAY) * FPS)
                    if due < active["next"]:
                        continue
                    self.capture(active, due, active["origin"] + due / FPS)
                    active["next"] = due + 1
                except (OSError, ValueError, sqlite3.Error) as error:
                    self.error = f"采集已暂停：{error}"
                    try:
                        self.end("interrupted")
                    except sqlite3.Error:
                        self.active = None
        with self.lock:
            if self.active:
                self.end("interrupted")

    def library(self):
        with self.connect() as db:
            rows = db.execute("""SELECT e.id,e.idx,e.created,e.metadata,e.result,e.ended,COUNT(f.frame)
                                 FROM episodes e LEFT JOIN frames f ON e.id=f.id
                                 GROUP BY e.id ORDER BY e.idx DESC""").fetchall()
        return {**self.status(), "episodes": [self.summary(row) for row in rows]}

    @staticmethod
    def summary(row):
        return {"id": row[0], "episode_index": row[1] - 1, "created": row[2],
                "metadata": json.loads(row[3]), "result": row[4], "ended": row[5], "samples": row[6]}

    def detail(self, identifier):
        History.identifier(identifier)
        with self.connect() as db:
            db.execute("BEGIN")
            entry = db.execute("SELECT id,idx,created,metadata,result,ended,0,review FROM episodes WHERE id=?",
                               (identifier,)).fetchone()
            if not entry:
                raise ValueError("Episode 不存在")
            rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM frames WHERE id=? ORDER BY frame", (identifier,))]
            events = [{"timestamp": t, "label": label} for t, label in db.execute(
                "SELECT timestamp,label FROM annotations WHERE id=? ORDER BY timestamp", (identifier,))]
            segments = self.segments(db, identifier)
        return {**self.summary(entry), "samples": len(rows), "fps": FPS,
                "frames": rows, "annotations": events, "segments": segments,
                "review": json.loads(entry[7]) if entry[7] else None}

    @staticmethod
    def segments(db, identifier):
        rows = db.execute("""SELECT s.id,s.kind,s.first,s.last,s.label,a.payload,b.payload FROM segments s
                             JOIN frames a ON a.id=s.episode AND a.frame=s.first
                             JOIN frames b ON b.id=s.episode AND b.frame=s.last
                             WHERE s.episode=? ORDER BY s.first,s.last,s.id""", (identifier,))
        return [dict(id=key, kind=kind, first=first, last=last, label=label,
                     start_timestamp=json.loads(a)["timestamp"], end_timestamp=json.loads(b)["timestamp"])
                for key, kind, first, last, label, a, b in rows]

    def edit_segment(self, data):
        identifier = History.identifier(data.get("id"))
        segment = data.get("segment")
        if segment is not None:
            History.identifier(segment)
        with self.lock, self.connect() as db:
            entry = db.execute("SELECT ended,review FROM episodes WHERE id=?", (identifier,)).fetchone()
            if not entry or not entry[0]:
                raise ValueError("请先结束采集")
            old = db.execute("SELECT kind FROM segments WHERE episode=? AND id=?", (identifier, segment)).fetchone()
            if segment is not None and not old:
                raise ValueError("片段不存在")
            changed_exclusions = bool(old and old[0] == "exclude")
            if data.get("remove") is True:
                if not old:
                    raise ValueError("请选择要删除的片段")
                db.execute("DELETE FROM segments WHERE episode=? AND id=?", (identifier, segment))
            else:
                first, last = data.get("first"), data.get("last")
                label = self.annotation(data.get("label"), 120, True)
                kind = data.get("kind")
                if kind not in ("stage", "exclude") or type(first) is not int or type(last) is not int or first > last:
                    raise ValueError("请选择有效的起点和终点")
                bounds = db.execute("SELECT COUNT(*) FROM frames WHERE id=? AND frame IN (?,?)",
                                    (identifier, first, last)).fetchone()[0]
                if bounds != len({first, last}):
                    raise ValueError("起点和终点必须对应已保存的帧")
                overlaps = db.execute("""SELECT label FROM segments WHERE episode=? AND kind=? AND id<>?
                                         AND first<=? AND last>=? LIMIT 1""",
                                      (identifier, kind, segment or "", last, first)).fetchone()
                if overlaps:
                    raise ValueError(f"与「{overlaps[0]}」重叠，请调整起止帧")
                db.execute("INSERT OR REPLACE INTO segments VALUES(?,?,?,?,?,?)",
                           (segment or uuid4().hex, identifier, kind, first, last, label))
                changed_exclusions |= kind == "exclude"
            if changed_exclusions:
                db.execute("UPDATE episodes SET review=NULL WHERE id=?", (identifier,))
            return {"segments": self.segments(db, identifier),
                    "review": json.loads(entry[1]) if entry[1] and not changed_exclusions else None}

    def review(self, data):
        detail = self.detail(data.get("id"))
        if not detail["ended"]:
            raise ValueError("请先结束采集")
        task = self.annotation(data.get("task"), 240, True)
        result = data.get("result")
        if result not in ("unrated", "success", "failure", "interrupted"):
            raise ValueError("无效的 Episode 结果")
        first, last = data.get("first"), data.get("last")
        tolerance, minimum = data.get("max_skew_ms"), data.get("min_frames")
        max_age = data.get("max_age_ms", tolerance)
        depth_floor = data.get("min_depth_percent", 1)
        if (not detail["frames"] or any(type(x) is not int for x in (first, last, tolerance, minimum, max_age, depth_floor))
                or not 0 <= first <= last <= detail["frames"][-1]["frame_index"]
                or not 5 <= tolerance <= 350 or not 10 <= max_age <= 350
                or not 1 <= depth_floor <= 100 or not 2 <= minimum <= 300):
            raise ValueError("请检查裁剪、时差、源帧时效、深度覆盖率和最短片段")
        settings = {"first": first, "last": last, "max_skew_ms": tolerance, "min_frames": minimum,
                    "max_age_ms": max_age, "min_depth_percent": depth_floor,
                    "third": data.get("third") is True, "depth": data.get("depth") is True}
        metadata = {**detail["metadata"], "reviewed_task": task}
        with self.lock, self.connect() as db:
            exclusions = [s for s in self.segments(db, detail["id"]) if s["kind"] == "exclude"]
            review = prepare(detail["frames"], settings, exclusions)
            db.execute("UPDATE episodes SET metadata=?,result=?,review=? WHERE id=?",
                       (self.dump(metadata), result, self.dump(review), detail["id"]))
        return review

    def media(self, identifier, frame, channel):
        History.identifier(identifier)
        if channel not in MEDIA or not 0 <= frame < MAX_SECONDS * FPS:
            raise ValueError("无效的帧编号或通道")
        return self.root / identifier / "media" / f"{frame:06d}-{channel}.{MEDIA[channel]}"

    def archive(self, identifier, training, target):
        detail = self.detail(identifier)
        if not detail["ended"]:
            raise ValueError("请先结束采集")
        review = detail["review"]
        if training and (not review or not review["accepted"] or detail["result"] != "success"):
            raise ValueError("训练包需要成功标注和已保存的有效清洗片段")
        directory = self.root / identifier
        metadata = detail["metadata"]
        manifest = {key: detail[key] for key in ("id", "episode_index", "created", "result", "fps", "metadata", "review")}
        manifest.update(schema=SCHEMA, variant="training" if training else "raw",
                        axes=AXES, units=["degree"] * 5 + ["open_fraction"],
                        clock="host_monotonic_receive", timestamp_unit="seconds_since_episode_start",
                        action_semantics="last owner bridge target sent at or before tick; held until next target or lock",
                        spatial_alignment="native camera planes; RGB/depth pixel registration not implied")
        if training:
            selected = {d["frame_index"] for d in review["decisions"] if not d["reasons"]}
            rows = [row for row in detail["frames"] if row["frame_index"] in selected]
        else:
            rows = detail["frames"]
        normal = review["normalization"] if training else None
        media = {row[key] for row in rows for key in
                 ("observation.images.front", "observation.images.wrist", "observation.images.third", "observation.depth")
                 if row[key]}
        if shutil.disk_usage(self.root).free < sum((directory / name).stat().st_size for name in media) + MIN_FREE:
            raise ValueError("磁盘空间不足以生成安全的下载副本")
        with ZipFile(target, "w", compression=ZIP_STORED) as output:
            output.writestr("manifest.json", self.dump(manifest))
            output.writestr("events.jsonl", "".join(self.dump(event) + "\n" for event in detail["annotations"]))
            output.writestr("segments.jsonl", "".join(self.dump(segment) + "\n" for segment in detail["segments"]))
            stage_by_frame = {index: s["label"] for s in detail["segments"] if s["kind"] == "stage"
                              for index in range(s["first"], s["last"] + 1)}
            with output.open("frames.jsonl", "w", force_zip64=True) as stream:
                for row in rows:
                    row = dict(row, stage=stage_by_frame.get(row["frame_index"]))
                    if normal:
                        row = dict(row, task=metadata.get("reviewed_task", row["task"]))
                        for key in ("observation.state", "action"):
                            summary = normal[key]
                            row[key + ".normalized"] = [(v - m) / s for v, m, s in zip(row[key], summary["mean"], summary["std"])]
                    stream.write((self.dump(row) + "\n").encode())
            for name in sorted(media):
                output.write(directory / name, name)
