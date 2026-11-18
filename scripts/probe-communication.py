"""Read-only controller probe. Stop the console before opening its serial port."""
import json
from pathlib import Path
import time

import serial
from nexarm.server import packet, Frames


results = []
for lines in (False, True):
    link = serial.Serial(baudrate=1_000_000, timeout=0.1, write_timeout=1, exclusive=True)
    link.port = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
    link.dtr = link.rts = lines
    entry = {"baudrate": 1_000_000, "dtr": lines, "rts": lines, "tx": [], "rx_hex": "", "frames": []}
    try:
        with link:
            time.sleep(6)
            raw = bytearray(link.read(link.in_waiting))
            parser = Frames()
            # Firmware, battery and joint feedback only; no configuration or motion writes.
            for _ in range(3):
                for command in (1, 2, 65):
                    data = packet(command)
                    entry["tx"].append(data.hex(" "))
                    link.write(data)
                    deadline = time.monotonic() + 0.35
                    while time.monotonic() < deadline:
                        raw.extend(link.read(link.in_waiting or 1))
            entry["rx_hex"] = raw.hex(" ")
            entry["frames"] = [frame.hex(" ") for frame in parser.feed(raw)]
    except OSError as error:
        entry["error"] = str(error)
    results.append(entry)
    print(json.dumps(entry), flush=True)
Path(".deploy/communication-probe.json").write_text(json.dumps(results, indent=2) + "\n")
