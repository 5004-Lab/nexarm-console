"""Exercise Linux MJPEG framing without requiring camera hardware."""
import subprocess
import sys
import unittest
from nexarm.camera_feed import CameraFeed


class LinuxCameraTest(unittest.TestCase):
    def read_stream(self, chunks):
        code = "import sys,time\n" + "\n".join(
            f"sys.stdout.buffer.write({chunk!r}); sys.stdout.buffer.flush(); time.sleep(0.03)"
            for chunk in chunks)
        feed = CameraFeed("/dev/test-camera")
        with subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, bufsize=0) as process:
            feed.read_mjpeg(process)
            process.wait(timeout=2)
        return feed

    def test_fragmented_and_consecutive_frames(self):
        feed = self.read_stream([b"noise\xff", b"\xd8first\xff", b"\xd9\xff\xd8second\xff\xd9"])
        self.assertEqual([frame[1] for frame in feed.frames],
                         [b"\xff\xd8first\xff\xd9", b"\xff\xd8second\xff\xd9"])
        self.assertEqual(feed.state, "live")
        self.assertLess(feed.frames[0][0], feed.frames[1][0])

    def test_incomplete_frame_is_not_published(self):
        feed = self.read_stream([b"\xff\xd8truncated"])
        self.assertEqual(list(feed.frames), [])

    def test_garbage_before_frame_is_discarded(self):
        feed = self.read_stream([b"garbage", b"\xff\xd8valid\xff\xd9"])
        self.assertEqual(feed.frames[0][1], b"\xff\xd8valid\xff\xd9")


if __name__ == "__main__":
    unittest.main()
