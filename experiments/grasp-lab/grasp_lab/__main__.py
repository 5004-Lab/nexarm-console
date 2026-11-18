import argparse
import json
from pathlib import Path
import urllib.request

import cv2
from .pipeline import audit_archive, candidates, proposal


def main():
    parser = argparse.ArgumentParser(description="Read-only NexArm grasping experiment preparation")
    commands = parser.add_subparsers(dest="command", required=True)
    snapshot = commands.add_parser("snapshot")
    snapshot.add_argument("--console", default="http://127.0.0.1:8765")
    snapshot.add_argument("--output", type=Path, required=True)
    analyze = commands.add_parser("analyze")
    analyze.add_argument("--image", type=Path, required=True)
    analyze.add_argument("--background", type=Path, required=True)
    analyze.add_argument("--calibration", type=Path)
    analyze.add_argument("--output", type=Path, required=True)
    audit = commands.add_parser("audit")
    audit.add_argument("archive", type=Path)
    args = parser.parse_args()
    if args.command == "snapshot":
        args.output.mkdir(parents=True, exist_ok=True)
        for name, endpoint in (("wrist.jpg", "/api/camera"), ("external.jpg", "/api/camera/external"), ("state.json", "/api/state"), ("cameras.json", "/api/camera-info")):
            with urllib.request.urlopen(args.console.rstrip('/') + endpoint, timeout=10) as response:
                content = response.read()
                if response.status != 200:
                    raise RuntimeError(f"{endpoint} unavailable")
                (args.output / name).write_bytes(content)
        result = {"saved": str(args.output), "actuation": False}
    elif args.command == "analyze":
        regions = candidates(cv2.imread(str(args.image)), cv2.imread(str(args.background)))
        calibration = json.loads(args.calibration.read_text()) if args.calibration else None
        result = proposal(regions, calibration)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        result = audit_archive(args.archive)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
