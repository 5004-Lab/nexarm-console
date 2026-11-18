"""Generate the model workspace grid used by the digital twin's picker."""

import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexarm import kinematics as arm


def main():
    rng = np.random.default_rng(42)
    low, high = np.array([(joint["min"], joint["max"]) for joint in arm.JOINTS]).T
    points = set()
    for joints in rng.uniform(low, high, (12000, 6)):
        links = arm.transforms(joints)
        xyz = arm.tool_position(links)
        if xyz[2] <= arm.FLOOR + 8 or np.linalg.norm(xyz) > arm.SETUP["max_reach_mm"]:
            continue
        if not arm.contacts(links):
            points.add(tuple(np.round(xyz).astype(int).tolist()))
    output = arm.ROOT / "src" / "reach.json"
    output.write_text(json.dumps(sorted(points), separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
