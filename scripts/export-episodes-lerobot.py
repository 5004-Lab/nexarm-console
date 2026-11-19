"""Convert one or more reviewed NexArm ZIPs into a local LeRobot v3 dataset."""

import argparse
from contextlib import ExitStack
from io import BytesIO
import json
from pathlib import Path
import tempfile
from zipfile import ZipFile

import numpy as np
from PIL import Image, ImageOps


SIZE = (640, 480)
FEATURES = ("observation.state", "action")
CAMERA = "observation.images."


def load_episode(archive):
    manifest = json.loads(archive.read("manifest.json"))
    if (manifest.get("schema") != "nexarm-multimodal/1" or manifest.get("variant") != "training"
            or manifest.get("result") != "success"):
        raise ValueError("Use the reviewed training ZIP from NexArm.")
    with archive.open("frames.jsonl") as stream:
        rows = {row["frame_index"]: row for row in map(json.loads, stream)}
    clips = []
    expected = set()
    for clip in manifest["review"]["clips"]:
        indices = range(clip["first"], clip["last"] + 1)
        if len(indices) != clip["frames"] or not indices or expected.intersection(indices):
            raise ValueError("Invalid or overlapping training clips.")
        clips.append([rows[index] for index in indices])
        expected.update(indices)
    if expected != rows.keys() or not clips:
        raise ValueError("Training clip indices do not match the exported frames.")
    return manifest, clips


def convert(inputs, output, repo_id, include_third):
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    if output.exists():
        raise ValueError("Output directory already exists.")
    channels = ["front", "wrist"] + (["third"] if include_third else [])
    keys = [CAMERA + channel for channel in channels]
    with ExitStack() as resources:
        packages = []
        role_map, fps, axes, units = None, None, None, None
        seen = set()
        for source in inputs:
            archive = resources.enter_context(ZipFile(source))
            manifest, clips = load_episode(archive)
            metadata = manifest["metadata"]
            roles = {key: [metadata["camera_roles"][key], metadata.get("camera_devices", {}).get(key)]
                     for key in channels}
            schema = (roles, manifest["fps"], manifest["axes"], manifest["units"])
            if packages and schema != (role_map, fps, axes, units):
                raise ValueError("Keep camera roles, sampling rate and joint units consistent within a dataset.")
            if manifest["id"] in seen:
                raise ValueError("Duplicate original Episode.")
            if include_third and not manifest["review"]["settings"]["third"]:
                raise ValueError("Third must be required during cleaning for a three-view dataset.")
            seen.add(manifest["id"])
            role_map, fps, axes, units = schema
            packages.append((archive, manifest, clips))

        features = {key: {"dtype": "float32", "shape": (len(axes),), "names": axes} for key in FEATURES}
        features.update({key: {"dtype": "image", "shape": (SIZE[1], SIZE[0], 3),
                               "names": ["height", "width", "channels"]} for key in keys})
        provenance = []
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output.parent, prefix=".nexarm-export-") as staging:
            directory = Path(staging) / "dataset"
            dataset = LeRobotDataset.create(repo_id=repo_id, root=directory, fps=fps,
                                           robot_type="nexarm", features=features, use_videos=False)
            try:
                for archive, manifest, clips in packages:
                    for clip in clips:
                        provenance.append({"episode_index": len(provenance), "source_id": manifest["id"],
                                           "source_episode_index": manifest["episode_index"],
                                           "first": clip[0]["frame_index"], "last": clip[-1]["frame_index"]})
                        for row in clip:
                            frame = {key: np.asarray(row[key], dtype=np.float32) for key in FEATURES}
                            if any(v.shape != (len(axes),) or not np.isfinite(v).all() for v in frame.values()):
                                raise ValueError("Invalid state or action vector.")
                            for key in keys:
                                with Image.open(BytesIO(archive.read(row[key]))) as image:
                                    frame[key] = np.asarray(ImageOps.pad(image.convert("RGB"), SIZE))
                            dataset.add_frame({**frame, "task": row["task"]})
                        dataset.save_episode()
            finally:
                dataset.finalize()
            (directory / "meta" / "nexarm-source.json").write_text(
                json.dumps({"axes": axes, "units": units, "camera_roles": role_map,
                            "source_clips": provenance}, ensure_ascii=False, indent=2), encoding="utf-8")
            directory.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path, nargs="+", help="NexArm training ZIPs from one split")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repo-id", default="nexarm/teaching")
    parser.add_argument("--third", action="store_true", help="Include a third RGB input")
    args = parser.parse_args()
    convert(args.captures, args.output, args.repo_id, args.third)


if __name__ == "__main__":
    main()
