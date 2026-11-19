"""Optional RealSense depth capture. No robot commands or synthetic depth values."""

from collections import deque
import gzip
from io import BytesIO
import json
import struct
import threading
import time

import numpy as np


def clean_preview(depth, scale_m):
    """Remove isolated flying pixels from the preview, retaining thin supported edges."""
    pixels = np.asarray(depth, dtype=np.uint16)
    center = pixels.astype(np.int32)
    padded = np.pad(center, 1)
    support = np.zeros(pixels.shape, dtype=np.uint8)
    tolerance = np.maximum(5 / (scale_m * 1000), center * .015)
    for dy, dx in ((-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)):
        neighbor = padded[1 + dy:1 + dy + pixels.shape[0], 1 + dx:1 + dx + pixels.shape[1]]
        support += ((neighbor > 0) & (np.abs(neighbor - center) <= tolerance))
    return np.where(support >= 2, pixels, 0).astype(np.uint16)


def preview_range(depth, scale_m):
    """Foreground-only contrast estimate; this does not change metric depth."""
    mm = np.asarray(depth)[::4, ::4].astype(float) * scale_m * 1000
    values = mm[(mm >= 50) & (mm <= 1000)]
    if values.size < 32:
        return [50, 1000]
    near, far = np.percentile(values, [3, 97])
    near = max(50, np.floor((near - 10) / 10) * 10)
    far = min(1000, max(near + 80, np.ceil((far + 10) / 10) * 10))
    return [int(near), int(far)]


def depth_packet(depth, scale_m, metadata, preview=None):
    """NDEPTH: JSON header + raw Z16; v2 appends a separate filtered Z16 preview."""
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
    extra = b""
    if preview is not None:
        preview = np.asarray(preview, dtype="<u2")
        if preview.shape != pixels.shape:
            raise ValueError("Preview dimensions must match native depth")
        info.update(version=2, encoding="z16-le-pair", planes=["raw", "filtered_preview"],
                    preview_valid_percent=round(100 * np.count_nonzero(preview) / preview.size, 1),
                    suggested_range_mm=preview_range(preview, scale_m))
        extra = preview.tobytes()
    header = json.dumps(info, separators=(",", ":"), allow_nan=False).encode()
    return info, struct.pack("<I", len(header)) + header + pixels.tobytes() + extra


class DepthFeed:
    def __init__(self, serial="auto", width=640, height=480, fps=15):
        self.serial = serial
        self.width, self.height, self.fps = width, height, fps
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.frames = deque(maxlen=2)
        self.color_frames = deque(maxlen=2)
        self.record_frames = deque(maxlen=8)
        self.state = "searching"
        self.error = ""
        self.details = {}

    def update_state(self, state, error=""):
        with self.lock:
            self.state, self.error = state, error
            if state != "live":
                self.frames.clear()
                self.color_frames.clear()
                self.record_frames.clear()

    def samples_between(self, first, last):
        with self.lock:
            return [frame for frame in self.record_frames if first <= frame[0] <= last]

    def sample_at(self, stamp):
        frames = self.samples_between(stamp - .35, stamp)
        return frames[-1] if frames else None

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
                to_disparity, to_depth = rs.disparity_transform(True), rs.disparity_transform(False)
                spatial, temporal = rs.spatial_filter(), rs.temporal_filter()
                spatial.set_option(rs.option.filter_magnitude, 2)
                spatial.set_option(rs.option.filter_smooth_alpha, .55)
                spatial.set_option(rs.option.filter_smooth_delta, 20)
                spatial.set_option(rs.option.holes_fill, 1)  # limited 2-pixel preview hole filling
                temporal.set_option(rs.option.filter_smooth_alpha, .6)
                temporal.set_option(rs.option.filter_smooth_delta, 20)
                temporal.set_option(rs.option.holes_fill, 0)  # no stale-depth persistence
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
                    processing_start = time.perf_counter()
                    filtered = to_depth.process(temporal.process(spatial.process(to_disparity.process(frame))))
                    preview = clean_preview(np.asanyarray(filtered.get_data()), scale)
                    processing_ms = round((time.perf_counter() - processing_start) * 1000, 1)
                    info, packet = depth_packet(pixels, scale, dict(
                        base, stamp=stamp, captured_at_ms=round(time.time() * 1000),
                        frame_number=frame.get_frame_number(), device_timestamp_ms=frame.get_timestamp(),
                        color_frame_number=color.get_frame_number(), color_device_timestamp_ms=color.get_timestamp(),
                        preview_filters={"spatial_iterations": 2, "spatial_alpha": .55, "spatial_delta": 20,
                                         "spatial_hole_fill_pixels": 2, "temporal_alpha": .6,
                                         "temporal_delta": 20, "temporal_persistence": 0,
                                         "minimum_neighbor_support": 2, "processing_ms": processing_ms}), preview=preview)
                    payload = gzip.compress(packet, compresslevel=1)
                    output = BytesIO()
                    Image.fromarray(np.asanyarray(color.get_data())).save(output, format="JPEG", quality=90)
                    jpeg = output.getvalue()
                    with self.lock:
                        self.details = info
                        self.frames.append((stamp, payload))
                        self.color_frames.append((stamp, jpeg))
                        self.record_frames.append((stamp, jpeg, pixels, info))
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
