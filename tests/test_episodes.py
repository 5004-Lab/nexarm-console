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

from nexarm.episodes import Episodes, prepare, vector


def sample(index, action=True, **fields):
    return {"frame_index": index, "observation.state": [float(index)] * 6,
            "action": [1.0] * 6 if action else None,
            "sync_ms": {key: -30 for key in ("feedback", "front", "wrist", "third", "depth")},
            "repeated": [], "depth_valid_percent": 10, **fields}


class EpisodeTests(unittest.TestCase):
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
            def __init__(self, depth=False):
                self.depth = depth

            def sample_at(self, stamp):
                frame = (stamp - .03, b"jpeg placeholder")
                pixels = np.array([[1, 256], [0, 1000]], dtype=np.uint16)
                return (*frame, pixels, dict(width=2, height=2, depth_scale_m=.0001,
                                             valid_percent=75, captured_at_ms=1000)) if self.depth else frame

        arm = Arm()
        with tempfile.TemporaryDirectory() as root:
            store = Episodes(arm, Feed(), Feed(), Feed(depth=True), root)
            started = store.start("operator", {"task": "Move the cube", "front": "external"})
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
            store.mark("operator", {"id": identifier, "label": "放置"})
            store.stop("operator", {"id": identifier, "result": "success"})
            detail = store.detail(identifier)
            self.assertIsNone(detail["frames"][0]["action"])
            self.assertEqual(detail["frames"][4]["action"], vector(joints))
            self.assertEqual(detail["frames"][4]["action"][-1], .5)
            self.assertEqual(detail["frames"][4]["sync_ms"]["third"], detail["frames"][4]["sync_ms"]["depth"])
            self.assertAlmostEqual(detail["frames"][4]["source_timestamps"]["action"], .05)
            self.assertEqual(detail["annotations"][0]["label"], "放置")
            report = store.review({"id": identifier, "task": "Place the cube", "result": "success",
                                   "first": 0, "last": 4, "max_skew_ms": 100, "min_frames": 2,
                                   "third": True, "depth": True})
            self.assertEqual(report["accepted"], 4)
            stream = io.BytesIO()
            store.archive(identifier, True, stream)
            with ZipFile(stream) as archive:
                rows = list(map(json.loads, archive.read("frames.jsonl").splitlines()))
                self.assertEqual([row["frame_index"] for row in rows], [1, 2, 3, 4])
                self.assertEqual(rows[0]["task"], "Place the cube")
                self.assertEqual(rows[0]["action.normalized"], [0] * 6)
                packet = gzip.decompress(archive.read(rows[0]["observation.depth"]))
                header = int.from_bytes(packet[:4], "little")
                self.assertEqual(json.loads(packet[4:4 + header])["version"], 1)
                self.assertEqual(packet[4 + header:], b"\x01\x00\x00\x01\x00\x00\xe8\x03")
            self.assertEqual(store.detail(identifier)["frames"][1]["task"], "Move the cube")
            restarted = Episodes(arm, Feed(), Feed(), Feed(depth=True), Path(root))
            self.assertEqual(restarted.library()["episodes"][0]["episode_index"], 0)


if __name__ == "__main__":
    unittest.main()
