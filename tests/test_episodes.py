from collections import deque
import gzip
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from zipfile import ZipFile

import numpy as np

from nexarm.episodes import Episodes, align_sources, prepare, vector
from nexarm.camera_feed import CameraFeed


def sample(index, action=True, **fields):
    return {"frame_index": index, "observation.state": [float(index)] * 6,
            "action": [1.0] * 6 if action else None,
            "sync_ms": {key: -30 for key in ("feedback", "front", "wrist", "third", "depth")},
            "repeated": [], "depth_valid_percent": 10, **fields}


class EpisodeTests(unittest.TestCase):
    def test_camera_alignment_selects_near_feedback_without_using_future_frames(self):
        camera = CameraFeed(None)
        camera.state = "live"
        camera.frames.extend((stamp, bytes([index])) for index, stamp in enumerate((1.01, 1.06, 1.10)))
        self.assertEqual(camera.sample_at(1.09)[0], 1.06)
        self.assertEqual([frame[0] for frame in camera.samples_between(1, 1.09)], [1.01, 1.06])
        sources = {"feedback": [(1.02,), (1.08,)], "wrist": [(1.01,), (1.055,)],
                   "external": [(1.01,), (1.06,)], "d405": [(1.03,), (1.095,)]}
        matched = align_sources(sources, {}, 1.1)
        self.assertEqual({key: entry[0] for key, entry in matched.items()},
                         {"feedback": 1.02, "wrist": 1.01, "external": 1.01, "d405": 1.03})
        self.assertEqual(align_sources(sources, {"wrist": 1.01}, 1.1)["wrist"], (1.055,))

    def test_sync_threshold_distinguishes_span_from_age_and_manual_exclusions(self):
        rows = [sample(i) for i in range(8)]
        rows[1]["sync_ms"]["depth"] = -90
        rows[2]["sync_ms"] = dict.fromkeys(rows[2]["sync_ms"], -125)
        result = prepare(rows, {"first": 0, "last": 7, "max_skew_ms": 25, "max_age_ms": 120,
                                "min_frames": 2, "third": True, "depth": True},
                         exclusions=[{"first": 5, "last": 5}])
        self.assertEqual([(c["first"], c["last"]) for c in result["clips"]], [(3, 4), (6, 7)])
        self.assertEqual(result["decisions"][1]["reasons"], ["sensor_span"])
        self.assertIn("skew_depth", result["decisions"][2]["reasons"])
        self.assertEqual(result["decisions"][5]["reasons"], ["manual_exclude"])
        self.assertEqual(result["sync"]["p95_ms"], 60)

    def test_cleaning_splits_gaps_and_does_not_invent_actions_or_bridge_spikes(self):
        rows = [sample(i, action=i != 3) for i in (0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12)]
        rows[-3]["observation.state"] = [80.0] * 6
        rows[-1]["repeated"] = ["wrist"]
        result = prepare(rows, {"first": 0, "last": 12, "max_skew_ms": 100, "min_frames": 2,
                                "third": True, "depth": True})
        self.assertEqual([(c["first"], c["last"]) for c in result["clips"]], [(0, 2), (4, 6), (8, 9)])
        self.assertEqual(result["rejected_reasons"], {"no_action": 1, "feedback_spike": 1, "repeat_wrist": 1, "short_clip": 1})
        self.assertEqual(result["normalization"]["action"]["std"], [.01] * 6)
        self.assertIsNone(rows[3]["action"])

    def test_capture_archives_causal_commands_raw_depth_and_reviewed_task(self):
        class Arm:
            lock = threading.Lock()
            owner, owner_since, board = "operator", 0, None
            lease_end = time.monotonic() + 30
            history, commands = deque(), deque()

            def feedback_ok(self, now):
                return True

        class Feed:
            def __init__(self, depth=False, jpeg=b"jpeg placeholder"):
                self.depth = depth
                self.jpeg = jpeg

            def sample_at(self, stamp):
                frame = (stamp - .03, self.jpeg)
                pixels = np.array([[1, 256], [0, 1000]], dtype=np.uint16)
                return (*frame, pixels, dict(width=2, height=2, depth_scale_m=.0001,
                                             valid_percent=75, captured_at_ms=1000)) if self.depth else frame

            def samples_between(self, first, last):
                return [self.sample_at(last)]

        arm = Arm()
        with tempfile.TemporaryDirectory() as root:
            store = Episodes(arm, Feed(jpeg=b"wrist"), Feed(jpeg=b"third"), Feed(depth=True, jpeg=b"d405 rgb"), root)
            started = store.start("operator", {"task": "Move the cube"})
            identifier = started["active"]["id"]
            current = store.active
            origin = current["origin"]
            joints = [2048, 2048, 1198, 1200, 2048, 1800]
            arm.history.append((origin - .02, [(p, 0) for p in joints]))
            arm.commands.append((origin + .05, joints, None, None))
            store.capture(current, 0, origin)
            for index in range(1, 5):
                tick = origin + index / 5
                arm.history.append((tick - .02, [(p, 0) for p in joints]))
                store.capture(current, index, tick)
            self.assertEqual(store.status()["active"]["media_counts"], {"front": 5, "wrist": 5, "third": 5, "depth": 5})
            store.mark("operator", {"id": identifier, "label": "放置"})
            store.stop("operator", {"id": identifier, "result": "success"})
            detail = store.detail(identifier)
            self.assertIsNone(detail["frames"][0]["action"])
            self.assertEqual(detail["frames"][4]["action"], vector(joints))
            self.assertEqual(detail["frames"][4]["action"][-1], .5)
            self.assertEqual(detail["frames"][4]["sync_ms"]["front"], detail["frames"][4]["sync_ms"]["depth"])
            self.assertEqual(detail["metadata"]["camera_roles"],
                             {"front": "d405", "depth": "d405", "wrist": "wrist", "third": "external"})
            self.assertAlmostEqual(detail["frames"][4]["source_timestamps"]["action"], .05)
            self.assertEqual(detail["annotations"][0]["label"], "放置")
            report = store.review({"id": identifier, "task": "Place the cube", "result": "success",
                                   "first": 0, "last": 4, "max_skew_ms": 100, "min_frames": 2,
                                   "third": True, "depth": True})
            self.assertEqual(report["accepted"], 4)
            segment_data = {"id": identifier, "kind": "stage", "first": 1, "last": 3, "label": "接近"}
            saved = store.edit_segment(segment_data)
            segment = saved["segments"][0]
            self.assertEqual(segment["start_timestamp"], .2)
            self.assertEqual(segment["end_timestamp"], .6)
            with self.assertRaisesRegex(ValueError, "重叠"):
                store.edit_segment({**segment_data, "first": 3, "last": 4, "label": "夹取"})
            with self.assertRaisesRegex(ValueError, "已保存的帧"):
                store.edit_segment({**segment_data, "first": 4, "last": 9})
            store.edit_segment({**segment_data, "segment": segment["id"], "label": "搬运"})
            stream = io.BytesIO()
            store.archive(identifier, True, stream)
            with ZipFile(stream) as archive:
                rows = list(map(json.loads, archive.read("frames.jsonl").splitlines()))
                self.assertEqual([row["frame_index"] for row in rows], [1, 2, 3, 4])
                self.assertEqual(rows[0]["task"], "Place the cube")
                self.assertEqual([row["stage"] for row in rows], ["搬运", "搬运", "搬运", None])
                self.assertEqual(json.loads(archive.read("segments.jsonl"))["label"], "搬运")
                self.assertEqual(rows[0]["action.normalized"], [0] * 6)
                self.assertEqual([archive.read(rows[0][f"observation.images.{key}"]) for key in ("front", "wrist", "third")],
                                 [b"d405 rgb", b"wrist", b"third"])
                packet = gzip.decompress(archive.read(rows[0]["observation.depth"]))
                header = int.from_bytes(packet[:4], "little")
                self.assertEqual(json.loads(packet[4:4 + header])["version"], 1)
                self.assertEqual(packet[4 + header:], b"\x01\x00\x00\x01\x00\x00\xe8\x03")
            self.assertEqual(store.detail(identifier)["frames"][1]["task"], "Move the cube")
            restarted = Episodes(arm, Feed(), Feed(), Feed(depth=True), Path(root))
            self.assertEqual(restarted.library()["episodes"][0]["episode_index"], 0)
            self.assertEqual(restarted.detail(identifier)["segments"][0]["label"], "搬运")
            restarted.edit_segment({**segment_data, "kind": "exclude", "first": 2, "last": 2})
            self.assertIsNone(restarted.detail(identifier)["review"])
            with self.assertRaisesRegex(ValueError, "清洗片段"):
                restarted.archive(identifier, True, io.BytesIO())


if __name__ == "__main__":
    unittest.main()
