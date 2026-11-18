"""Write a local LeRobotDataset v3 from a packaged NexArm capture."""

import argparse
import json
from pathlib import Path

from lerobot.datasets.lerobot_dataset import LeRobotDataset
import numpy as np
from PIL import Image, ImageOps

IMAGE = "observation.images.wrist"
IMAGE_SIZE = (640, 480)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.capture / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "nexarm-episodes/1" or not manifest["episodes"]:
        parser.error("A completed NexArm capture is required")

    axes = manifest["joint_order"]
    features = {
        "observation.state": {"dtype": "float32", "shape": (6,), "names": axes},
        "action": {"dtype": "float32", "shape": (6,), "names": axes},
        "observation.tcp_mm": {"dtype": "float32", "shape": (3,), "names": ["X", "Y", "Z"]},
        IMAGE: {"dtype": "video", "shape": (480, 640, 3), "names": ["height", "width", "channels"]},
    }
    dataset = LeRobotDataset.create(
        repo_id="nexarm/" + args.capture.name, root=args.output, fps=manifest["fps"],
        robot_type="nexarm", features=features, use_videos=True, vcodec="h264",
    )
    for episode in manifest["episodes"]:
        directory = args.capture / episode["directory"]
        with (directory / "frames.jsonl").open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                with Image.open(directory / row["observation.image"]) as image:
                    rgb = ImageOps.fit(image.convert("RGB"), IMAGE_SIZE)
                    dataset.add_frame({
                        **{key: np.asarray(row[key], dtype=np.float32)
                           for key in ("observation.state", "action", "observation.tcp_mm")},
                        IMAGE: np.asarray(rgb),
                        "task": row["task"],
                    })
        dataset.save_episode()
    dataset.finalize()


if __name__ == "__main__":
    main()
