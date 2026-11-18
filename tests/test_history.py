"""Exercise durable recording without invoking robot motion."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
from types import SimpleNamespace
import unittest
from zipfile import ZipFile

from nexarm.history import History


class HistoryTest(unittest.TestCase):
    def make(self, root, live=True):
        def snapshot(client):
            return {"connected": live, "revision": time.monotonic() - .02, "angles": [0] * 6,
                    "tcp": [100, 0, 200], "action_angles": None, "feedback": [[2048, 0]] * 6}
        controller = SimpleNamespace(snapshot=snapshot)
        camera = SimpleNamespace(frame=lambda after: ("live", (time.monotonic(), b"jpeg")),
                                 nearest=lambda stamp, after: (stamp, b"jpeg"))
        return History(controller, {"wrist": camera, "external": camera}, root)

    def test_history_survives_restarting_reader(self):
        with TemporaryDirectory() as root:
            history = self.make(root)
            identifier = history.active
            worker = threading.Thread(target=history.run); worker.start(); time.sleep(.35)
            history.closed.set(); worker.join(2)
            self.assertGreaterEqual(len(history.samples(identifier)["samples"]), 2)
            reopened = self.make(root)
            self.assertIn(identifier, [session["id"] for session in reopened.sessions()["sessions"]])
            self.assertGreaterEqual(len(reopened.samples(identifier)["samples"]), 2)

    def test_dual_view_observation_archive_and_events(self):
        with TemporaryDirectory() as root:
            history = self.make(root)
            identifier = history.start({"task": "pick a tool", "objects": "tool", "tools": "gripper"})["id"]
            history.annotate({"label": "接近物体"})
            worker = threading.Thread(target=history.run); worker.start(); time.sleep(.5)
            with self.assertRaises(ValueError): history.archive(identifier)
            history.stop(); history.closed.set(); worker.join(2)
            with ZipFile(history.archive(identifier)) as archive:
                names = archive.namelist()
                self.assertTrue(any(name.startswith("wrist/") for name in names))
                self.assertTrue(any(name.startswith("external/") for name in names))
                rows = [json.loads(line) for line in archive.read("samples.jsonl").splitlines()]
                self.assertTrue(all(not row["training_valid"] for row in rows))
                self.assertEqual(json.loads(archive.read("manifest.json"))["tools"], "gripper")
                self.assertIn("接近物体", archive.read("events.jsonl").decode())

    def test_invalid_identifiers_and_pagination_rejected(self):
        with TemporaryDirectory() as root:
            history = self.make(root)
            for identifier in ("../secret", "x" * 32, "", None):
                with self.assertRaises(ValueError): history.samples(identifier)
            with self.assertRaises(ValueError): history.samples(history.active, limit=100000)
            with self.assertRaises(ValueError): history.start({"task": ""})

    def test_missing_external_view_does_not_start_training_capture(self):
        with TemporaryDirectory() as root:
            history = self.make(root); history.cameras["external"] = None
            with self.assertRaises(ValueError): history.start({"task": "test"})
            self.assertFalse(history.recording)
