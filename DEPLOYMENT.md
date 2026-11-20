# Linux deployment

Use Python 3.9+ and Node 20.19+ or 22.12+. Run ./start.sh. The script uses a project-local .runtime/node installation when present.

Linux cameras use FFmpeg and V4L2. Choose stable /dev/v4l/by-id device paths. Use --camera-device and --camera-format yuyv422 for the wrist camera, and --external-camera-device for the third-person MJPEG camera. The existing camera endpoint remains /api/camera; /api/camera/external provides the external view. Keep uncompressed cameras on separate USB controllers when bandwidth allocation fails.

CH340 adapters bound to the generic USB serial driver can use the project compatibility initializer. Install deploy/70-nexarm-ch340.rules in /etc/udev/rules.d and reload udev rules to allow dialout users to initialize the adapter. Prefer a native ch341 kernel driver when available.

### CH340 disappears after reboot

If `lsusb` shows `1a86:7523` but there is no `/dev/ttyUSB*`, first check that the kernel has the native `ch341` driver. On hosts that lack it and have `/sys/bus/usb-serial/drivers/generic/new_id`, install the optional system service to register the device ID at every boot:

```sh
sudo install -m 0644 deploy/nexarm-ch340-generic.service.example /etc/systemd/system/nexarm-ch340-generic.service
sudo systemctl daemon-reload
sudo systemctl enable --now nexarm-ch340-generic.service
ls -l /dev/serial/by-id/
```

The service skips registration when the native driver is registered. The NexArm service detects the serial port when it appears. Check that joint feedback and supply voltage are both visible before enabling control.

Use password-protected LAN viewing and the authorized control gateway as described in README.md. Keep service-specific addresses and credentials in local configuration, outside Git. Sample Linux service templates will be provided separately. Never commit .env files or capture data.

Run .venv/bin/python -m unittest discover -s tests -v before deployment. Build with npm run build, then restart the managed services during an idle period. Do not interrupt an active operator.

Firmware may remain in bridge mode after stopping the service. If normal firmware, battery and joint queries do not reply after a restart, power-cycle the controller. Host receipt timestamps are not sensor exposure timestamps; calibrate capture latency before training.

## Optional RealSense D405 depth

Install `.venv/bin/python -m pip install -r requirements-depth.txt`, then append `--depth-camera` to the server command. This discovers a D405 by model instead of choosing a potentially unrelated `/dev/videoN`. Pass `--depth-camera SERIAL` to bind a particular unit. The optional SDK wheel must support the host Python, CPU and USB backend; test actual streaming on the target rather than relying on USB enumeration alone. No firmware update or camera self-calibration is performed.

The independent capture thread requests native 640×480 Z16 and RGB8 together at 15 fps from one SDK pipeline, reads the device's actual depth scale and factory depth intrinsics, and retries after disconnection. `/api/camera/realsense?after=STAMP` serves its RGB frames encoded as JPEG without resizing; it does not open the device a second time. `/api/depth-info` provides status and metadata. Authenticated `/api/depth?after=STAMP` returns gzip-encoded NDEPTH: a uint32 little-endian JSON length, UTF-8 JSON metadata, then width×height little-endian uint16 raw depth samples. Version 2 (`z16-le-pair`) appends an equally sized, separate filtered-preview plane; the browser also accepts legacy v1 raw-only packets. Zero is invalid; millimetres = raw × depth_scale_m × 1000. Stale depth and color frames are never served as live. The control gateway preserves the gzip header.

The browser shows D405 RGB/depth above wrist/external RGB in a simultaneous 2×2 grid. It defaults to an unshaded depth-color preview with an adaptive foreground color scale; raw view and fixed color scales remain selectable. Optional relief lighting is disabled by default because it amplifies depth noise into misleading surface bumps. SDK processing uses disparity-domain spatial edge-preserving filtering, light temporal smoothing without stale-value persistence, bounded two-pixel spatial hole filling, and neighbor-support rejection of isolated speckles. No decimation is applied. Processing settings and duration are reported in `preview_filters`; the suggested range excludes values outside 50–1000 mm and is display-only. Readings, validity percentages and downloads always use the raw plane, including invalid zeros in areas filled for display. Downloads are grayscale 16-bit PNGs containing unchanged Z16 and a `nexarm` PNG text field with JSON metadata, scale, intrinsics and `export_plane: raw`. This is optical-axis Z in the camera frame, not a radial distance or a calibrated robot-base position. D405 RGB and depth are not currently included in the existing dual-RGB demonstration ZIP. Independently refreshed views are not an assertion of pixel registration or cross-camera synchronization.

Browser completion has two modes. Conservative completion requires a four-connected component that does not touch an image border and fits within 32×32 pixels. Both horizontal and vertical endpoints must agree within max(12 mm, 5% of mean Z); their interpolations must agree within max(5 mm, 1.5% of mean Z). The default scene-observation mode additionally uses normalized inverse-depth interpolation with radii 2/4/8/12 pixels, at least 6 samples and 25% window support, and inverse-depth coefficient of variation <=3.5%. This stronger mode can extend surfaces into unobserved open gaps and is explicitly labelled as estimated display. All support comes from the input filtered frame, never previously completed points. Observed preview pixels are preserved; unsupported large-hole centers stay invalid. Raw and filter-only views remain selectable; raw-zero completed points are labelled as estimated without a native measurement. The additional completion count is display-only and is not a sensor-validity metric.
