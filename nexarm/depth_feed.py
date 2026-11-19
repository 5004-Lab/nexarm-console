"""Optional RealSense depth capture. No robot commands or synthetic depth values."""

from collections import deque
import gzip
from io import BytesIO
import json
import struct
import threading
import time

import numpy as np


def depth_packet(depth, scale_m, metadata):
    """NDEPTH v1: uint32 LE JSON length, UTF-8 JSON, native uint16 LE Z16."""
    pixels = np.asarray(depth, dtype="<u2")
    if pixels.ndim != 2 or not pixels.size or not np.isfinite(scale_m) or scale_m <= 0:
        raise ValueError("Invalid depth frame or depth scale")
    values = pixels[pixels > 0].astype(float) * scale_m * 1000
    info = dict(metadata, version=1, encoding="z16-le", width=pixels.shape[1],
                height=pixels.shape[0], depth_scale_m=float(scale_m),
                valid_percent=round(100 * values.size / pixels.size, 1),
                median_mm=round(float(np.median(values)), 1) if values.size else None,
                coordinate_frame="camera_optical", measurement="optical_axis_z",
                timestamp_source="host_receipt")
    header = json.dumps(info, separators=(",", ":"), allow_nan=False).encode()
    return info, struct.pack("<I", len(header)) + header + pixels.tobytes()


class DepthFeed:
    def __init__(self, serial="auto", width=640, height=480, fps=15):
        self.serial = serial
        self.width, self.height, self.fps = width, height, fps
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.frames = deque(maxlen=2)
        self.color_frames = deque(maxlen=2)
        self.state = "searching"
        self.error = ""
        self.details = {}

    def update_state(self, state, error=""):
        with self.lock:
            self.state, self.error = state, error
            if state != "live":
                self.frames.clear()
                self.color_frames.clear()

    def color_frame(self, after=0):
        with self.lock:
            if self.state != "live":
                return self.state, None
            if not self.color_frames:
                return "waiting", None
            stamp, jpeg = self.color_frames[-1]
            if time.monotonic() - stamp > 1:
                return "waiting", None
            return "live", (stamp, jpeg) if stamp > after else None

    def color_info(self):
        status, _ = self.color_frame()
        return {"status": status, "configured_resolution": f"{self.width}x{self.height}",
                "requested_fps": self.fps, "format": "rgb8-jpeg"}

    def frame(self, after=0):
        with self.lock:
            if self.state != "live" or not self.frames:
                return self.state, None
            stamp, payload = self.frames[-1]
            if time.monotonic() - stamp > 1:
                return "waiting", None
            return "live", (stamp, payload) if stamp > after else None

    def info(self):
        status, _ = self.frame()
        with self.lock:
            return dict(self.details, status=status, error=self.error,
                        configured_resolution=f"{self.width}x{self.height}",
                        requested_fps=self.fps, format="z16")

    def run(self):
        try:
            import pyrealsense2 as rs
            from PIL import Image
        except (ImportError, OSError) as exc:
            self.update_state("unsupported", str(exc))
            return
        while not self.closed.is_set():
            pipeline = None
            started = False
            try:
                context = rs.context()
                devices = [d for d in context.query_devices()
                           if ((self.serial == "auto" and "D405" in d.get_info(rs.camera_info.name))
                               or d.get_info(rs.camera_info.serial_number) == self.serial)]
                if not devices:
                    self.update_state("missing")
                    self.closed.wait(3)
                    continue
                device = devices[0]
                serial = device.get_info(rs.camera_info.serial_number)
                scale = device.first_depth_sensor().get_depth_scale()
                pipeline = rs.pipeline(context)
                config = rs.config()
                config.enable_device(serial)
                config.enable_stream(rs.stream.depth, self.width, self.height, rs.format.z16, self.fps)
                config.enable_stream(rs.stream.color, self.width, self.height, rs.format.rgb8, self.fps)
                profile = pipeline.start(config)
                started = True
                intrinsics = profile.get_stream(rs.stream.depth).as_video_stream_profile().get_intrinsics()
                base = {"model": device.get_info(rs.camera_info.name), "serial": serial,
                        "intrinsics": {"fx": intrinsics.fx, "fy": intrinsics.fy,
                                       "ppx": intrinsics.ppx, "ppy": intrinsics.ppy,
                                       "model": str(intrinsics.model), "coeffs": list(intrinsics.coeffs)}}
                while not self.closed.is_set():
                    frames = pipeline.wait_for_frames(3000)
                    frame = frames.get_depth_frame()
                    color = frames.get_color_frame()
                    if not frame or not color:
                        continue
                    stamp = time.monotonic()
                    pixels = np.asanyarray(frame.get_data()).copy()
                    info, packet = depth_packet(pixels, scale, dict(
                        base, stamp=stamp, captured_at_ms=round(time.time() * 1000),
                        frame_number=frame.get_frame_number(), device_timestamp_ms=frame.get_timestamp(),
                        color_frame_number=color.get_frame_number(), color_device_timestamp_ms=color.get_timestamp()))
                    payload = gzip.compress(packet, compresslevel=1)
                    output = BytesIO()
                    Image.fromarray(np.asanyarray(color.get_data())).save(output, format="JPEG", quality=90)
                    jpeg = output.getvalue()
                    with self.lock:
                        self.details = info
                        self.frames.append((stamp, payload))
                        self.color_frames.append((stamp, jpeg))
                        self.state, self.error = "live", ""
            except Exception as exc:
                self.update_state("unavailable", str(exc)[:300])
            finally:
                if pipeline is not None and started:
                    try:
                        pipeline.stop()
                    except RuntimeError:
                        pass
            self.closed.wait(3)
