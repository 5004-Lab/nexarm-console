import json
import struct
import time
import unittest

import numpy as np

from nexarm.depth_feed import DepthFeed, depth_packet, clean_preview, preview_range


class DepthTest(unittest.TestCase):
    def test_preview_packet_preserves_raw_holes_and_depth_separately(self):
        raw = np.array([[0, 1234]], dtype=np.uint16)
        preview = np.array([[1200, 1240]], dtype=np.uint16)
        info, packet = depth_packet(raw, .0001, {}, preview=preview)
        length, = struct.unpack_from('<I', packet)
        self.assertEqual(info['version'], 2)
        self.assertEqual(struct.unpack('<4H', packet[4 + length:]), (0, 1234, 1200, 1240))
        self.assertEqual(raw.tolist(), [[0, 1234]])

    def test_isolated_noise_removed_but_surface_and_thin_line_survive(self):
        pixels = np.zeros((9, 9), dtype=np.uint16)
        pixels[2:5, 2:5] = 2000
        pixels[7, 1:6] = 1500
        pixels[0, 8] = 5000
        clean = clean_preview(pixels, .0001)
        self.assertEqual(clean[0, 8], 0)
        self.assertTrue(np.all(clean[2:5, 2:5] == 2000))
        self.assertEqual(clean[7, 3], 1500)
        self.assertEqual(pixels[0, 8], 5000)

    def test_auto_range_ignores_distant_background_and_invalid_pixels(self):
        pixels = np.full((64, 64), 3000, dtype=np.uint16)
        pixels[:16] = 35000
        pixels[-8:] = 0
        near, far = preview_range(pixels, .0001)
        self.assertLessEqual(near, 300)
        self.assertGreaterEqual(far, 300)
        self.assertLess(far, 1000)
    def test_packet_preserves_native_units_zero_and_metadata(self):
        info, packet = depth_packet(np.array([[0, 1234, 65535]], dtype=np.uint16), .0001, {"stamp": 42})
        length, = struct.unpack_from("<I", packet)
        meta = json.loads(packet[4:4 + length])
        self.assertEqual(meta, info)
        self.assertEqual(meta["depth_scale_m"], .0001)
        self.assertEqual(meta["valid_percent"], 66.7)
        self.assertEqual(struct.unpack("<3H", packet[4 + length:]), (0, 1234, 65535))
        self.assertEqual(meta["measurement"], "optical_axis_z")

    def test_all_invalid_frame_has_no_invented_distance(self):
        info, _ = depth_packet(np.zeros((2, 2), dtype=np.uint16), .0001, {})
        self.assertEqual(info["valid_percent"], 0)
        self.assertIsNone(info["median_mm"])

    def test_stale_and_unplugged_frames_are_never_served_as_live(self):
        feed = DepthFeed()
        feed.state = "live"
        feed.frames.append((time.monotonic() - 2, b"old"))
        self.assertEqual(feed.frame(), ("waiting", None))
        stamp = time.monotonic()
        feed.frames.append((stamp, b"new"))
        feed.color_frames.append((stamp, b"rgb-jpeg"))
        self.assertEqual(feed.frame(), ("live", (stamp, b"new")))
        self.assertEqual(feed.color_frame(), ("live", (stamp, b"rgb-jpeg")))
        self.assertEqual(feed.color_frame(stamp), ("live", None))
        self.assertEqual(feed.frame(stamp), ("live", None))
        feed.update_state("missing")
        self.assertEqual(feed.frame(), ("missing", None))
        self.assertEqual(feed.color_frame(), ("missing", None))
