"""Receive host camera frames without blocking the serial controller."""

from collections import deque
import math
from pathlib import Path
import selectors
import shutil
import sys
import struct
import subprocess
import threading
import time

CAPTURE = Path(__file__).resolve().parents[1] / ".camera/NexArmCamera.app/Contents/MacOS/NexArmCamera"
STATUS = {20: "missing", 21: "permission", 22: "unavailable"}
HEADER = struct.Struct(">dI")


class CameraFeed:
    def __init__(self, device, input_format="mjpeg", resolution="640x480", fps=15):
        self.device = device
        if input_format not in ("mjpeg", "yuyv422"):
            raise ValueError("Unsupported camera input format")
        self.input_format = input_format
        import re
        if not re.fullmatch(r"[1-9][0-9]{1,3}x[1-9][0-9]{1,3}", resolution) or not 1 <= fps <= 60:
            raise ValueError("Invalid camera resolution or frame rate")
        self.resolution, self.fps = resolution, fps
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.frames = deque(maxlen=12)
        self.state = "searching"

    def frame(self, after):
        now = time.monotonic()
        with self.lock:
            if self.state != "live":
                return self.state, None
            for stamp, jpeg in reversed(self.frames):
                if stamp <= now - 0.045:
                    if now - stamp > 0.55:
                        return "waiting", None
                    return "live", (stamp, jpeg) if stamp > after else None
            return "waiting", None

    def nearest(self, stamp, after):
        with self.lock:
            if self.state != "live":
                return None
            return min((frame for frame in self.frames if frame[0] > after),
                       key=lambda frame: abs(frame[0] - stamp), default=None)

    def samples_between(self, first, last):
        with self.lock:
            if self.state != "live":
                return []
            return [frame for frame in self.frames if first <= frame[0] <= last]

    def sample_at(self, stamp):
        frames = self.samples_between(stamp - .35, stamp)
        return frames[-1] if frames else None

    def update_state(self, state):
        with self.lock:
            self.state = state
            if state != "live":
                self.frames.clear()

    def read(self, process):
        buffer = bytearray()
        last_packet = time.monotonic()
        has_frames = False
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while not self.closed.is_set():
                events = selector.select(0.25)
                if not events:
                    if process.poll() is not None or time.monotonic() - last_packet > (3 if has_frames else 60):
                        break
                    continue
                chunk = process.stdout.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                while len(buffer) >= HEADER.size:
                    stamp, size = HEADER.unpack_from(buffer)
                    if not 32 <= size <= 2_000_000:
                        return
                    end = HEADER.size + size
                    if len(buffer) < end:
                        break
                    jpeg = bytes(buffer[HEADER.size:end])
                    del buffer[:end]
                    now = time.monotonic()
                    if not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
                        continue
                    if not math.isfinite(stamp) or not now - 1 < stamp < now + 0.02:
                        stamp = now
                    with self.lock:
                        self.frames.append((stamp, jpeg))
                        self.state = "live"
                    has_frames = True
                    last_packet = now

    def read_mjpeg(self, process):
        """Timestamp Linux frames on host receipt using the controller clock."""
        buffer = bytearray()
        last_packet = time.monotonic()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while not self.closed.is_set():
                if not selector.select(0.25):
                    if process.poll() is not None or time.monotonic() - last_packet > 5:
                        break
                    continue
                chunk = process.stdout.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                if len(buffer) > 2_000_000:
                    return
                while True:
                    start = buffer.find(b"\xff\xd8")
                    if start < 0:
                        buffer[:] = buffer[-1:]
                        break
                    if start:
                        del buffer[:start]
                    end = buffer.find(b"\xff\xd9", 2)
                    if end < 0:
                        break
                    jpeg = bytes(buffer[:end + 2])
                    del buffer[:end + 2]
                    stamp = time.monotonic()
                    with self.lock:
                        self.frames.append((stamp, jpeg))
                        self.state = "live"
                    last_packet = stamp

    def run(self):
        while not self.closed.is_set():
            linux = sys.platform.startswith("linux")
            if linux:
                ffmpeg = shutil.which("ffmpeg")
                if not ffmpeg:
                    self.update_state("unsupported")
                    self.closed.wait(3)
                    continue
                devices = sorted(Path("/dev/v4l/by-id").glob("*-video-index0"))
                device = self.device or (str(devices[0]) if len(devices) == 1 else None)
                if not device or not Path(device).exists():
                    self.update_state("missing")
                    self.closed.wait(3)
                    continue
                command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                           "-f", "v4l2", "-input_format", self.input_format, "-framerate", str(self.fps), "-video_size", self.resolution,
                           "-i", device, "-an"]
                if self.input_format == "mjpeg":
                    command += ["-c:v", "copy"]
                else:
                    command += ["-c:v", "mjpeg", "-q:v", "2", "-threads", "1"]
                command += ["-f", "mjpeg", "pipe:1"]
            else:
                if not CAPTURE.is_file():
                    self.update_state("unsupported")
                    self.closed.wait(3)
                    continue
                command = [str(CAPTURE)]
                if self.device:
                    command.append(self.device)
            try:
                with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0) as process:
                    try:
                        (self.read_mjpeg if linux else self.read)(process)
                    finally:
                        if process.poll() is None:
                            try:
                                process.wait(timeout=0.2)
                            except subprocess.TimeoutExpired:
                                process.terminate()
                                try:
                                    process.wait(timeout=1)
                                except subprocess.TimeoutExpired:
                                    process.kill()
                                    process.wait()
                    self.update_state(STATUS.get(process.returncode, "unavailable"))
            except OSError:
                self.update_state("unavailable")
            self.closed.wait(3)
