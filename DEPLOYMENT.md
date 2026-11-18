# Linux deployment

Use Python 3.9+ and Node 20.19+ or 22.12+. Run ./start.sh. The script uses a project-local .runtime/node installation when present.

Linux cameras use FFmpeg and V4L2. Choose stable /dev/v4l/by-id device paths. Use --camera-device and --camera-format yuyv422 for the wrist camera, and --external-camera-device for the third-person MJPEG camera. The existing camera endpoint remains /api/camera; /api/camera/external provides the external view. Keep uncompressed cameras on separate USB controllers when bandwidth allocation fails.

CH340 adapters bound to the generic USB serial driver can use the project compatibility initializer. Install deploy/70-nexarm-ch340.rules in /etc/udev/rules.d and reload udev rules to allow dialout users to initialize the adapter. Prefer a native ch341 kernel driver when available.

Use password-protected LAN viewing and the authorized control gateway as described in README.md. Keep service-specific addresses and credentials in local configuration, outside Git. Sample Linux service templates will be provided separately. Never commit .env files or capture data.

Run .venv/bin/python -m unittest discover -s tests -v before deployment. Build with npm run build, then restart the managed services during an idle period. Do not interrupt an active operator.

Firmware may remain in bridge mode after stopping the service. If normal firmware, battery and joint queries do not reply after a restart, power-cycle the controller. Host receipt timestamps are not sensor exposure timestamps; calibrate capture latency before training.
