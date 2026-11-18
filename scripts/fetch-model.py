#!/usr/bin/env python3
"""Prepare the pinned vendor model for the browser and the kinematics solver."""

import hashlib
from http.client import HTTPException
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from urllib.request import urlopen
import xml.etree.ElementTree as ET

REVISION = "0eb4fb8d806454fa1ff753f6a5ad305c63acceb4"
MODEL_PATH = f"Hiwonder/NexArm/{REVISION}/src/simulations/nexarm_description/"
SOURCE = f"https://raw.githubusercontent.com/{MODEL_PATH}"
MESH_SOURCE = f"https://media.githubusercontent.com/media/{MODEL_PATH}"
DESTINATION = Path(__file__).resolve().parents[1] / "public/model"
XACRO = "urdf/nexarm.urdf.xacro"
XACRO_HASH = "7b42a486f014da05db86708ff650839e8ba1315206d023a6f133404c25d5027a"
MESH_HASHES = {
    "base_link.STL": "f75636a58d4dd3d4799751d6a62c1631785d96c819f517037e42add5ffa90223",
    "camera_link.STL": "a527af8f67d2ce88c51aad624726e68e104096fc07e0347bea31eadd22928923",
    "gripper_base_link.STL": "d5c94f648ccf0c4cf8da2c4da367a2f06cb1d694cc3e134656a8ab709eb4938b",
    "gripper_link.STL": "4b8604aac88625feb5206f63352761b90d1e2cab32ff4bde9d48d45d2fb5b48a",
    "left_jaw_link.STL": "ba5295db31753541f89d12ffba0b9ed69b39d30dc5e8ff52fc76040596363258",
    "link1.STL": "829661ce9c750949ca122338db108574d8d01a9f21b1641459e8c038a0f2e95a",
    "link2.STL": "6504fe1dea92ed810e1e356053b74119bf3643882471fc5752e79607ccd8a9f3",
    "link3.STL": "f6cac9a1f5caf9c2346ca7443ef1d8578d503ffc93669c930a3f80d8770475b3",
    "link4.STL": "a66da164c020883c6fa66b1a9f73e88cd92cf42de5424558c924b1a5e66be12e",
    "link5.STL": "d561902bf0d4027a884981bfc4af77d0deee689db55b2a79bd6f2b28f498bcbf",
    "right_jaw_link.STL": "8bdb1606f233c2ed9a4b6c16c8ee61a4b792f0499cf7e1cc47f56c23fd651434",
}


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def download(source, path, expected):
    print(f"Downloading NexArm model: {path}", flush=True)
    for attempt in range(3):
        try:
            with urlopen(source + path, timeout=30) as response:
                content = response.read()
            break
        except (OSError, HTTPException):
            if attempt == 2:
                raise
    if sha256(content) != expected:
        raise ValueError(f"Checksum mismatch for {path}")
    return content


def write_atomically(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            temp.write(content)
            temp.close()
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)


def browser_urdf(content):
    robot = ET.fromstring(content)
    for node in list(robot):
        if node.tag not in {"link", "joint"}:
            robot.remove(node)
    for link in robot.findall("link"):
        for collision in link.findall("collision"):
            link.remove(collision)
        for mesh in link.findall("visual/geometry/mesh"):
            name = Path(mesh.attrib["filename"]).name
            if name not in MESH_HASHES:
                raise ValueError(f"Unexpected mesh in vendor model: {name}")
            mesh.set("filename", f"meshes/{name}")
    ET.indent(robot)
    return ET.tostring(robot, encoding="utf-8", xml_declaration=True)


def main():
    try:
        urdf = DESTINATION / "nexarm.urdf"
        for name, expected in MESH_HASHES.items():
            path = DESTINATION / "meshes" / name
            if not path.is_file() or sha256(path.read_bytes()) != expected:
                write_atomically(path, download(MESH_SOURCE, f"meshes/{name}", expected))
        if not urdf.is_file():
            write_atomically(urdf, browser_urdf(download(SOURCE, XACRO, XACRO_HASH)))
    except (OSError, HTTPException, ValueError, ET.ParseError) as error:
        sys.exit(f"Unable to prepare the NexArm model: {error}")


if __name__ == "__main__":
    main()
