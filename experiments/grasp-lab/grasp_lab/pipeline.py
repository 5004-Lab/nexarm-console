import json
from pathlib import Path
from zipfile import ZipFile

import cv2
import numpy as np


def candidates(image, background):
    """Find changed foreground regions in a fixed, empty-table reference image.

    These are geometric candidates, not semantic object labels or certified grasps.
    The background, camera pose and lighting must remain fixed.
    """
    if image is None or background is None or image.shape != background.shape:
        raise ValueError("Scene and background must have the same native dimensions")
    difference = cv2.absdiff(image, background)
    gray = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)
    mask = cv2.threshold(gray, 35, 255, cv2.THRESH_BINARY)[1]
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    result = []
    minimum = max(100, image.shape[0] * image.shape[1] * 0.0005)
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < minimum or area > image.shape[0] * image.shape[1] * .4:
            continue
        (x, y), (w, h), angle = cv2.minAreaRect(contour)
        result.append({"id": f"region-{len(result) + 1}", "pixel_center": [round(x, 2), round(y, 2)],
                       "pixel_size": [round(w, 2), round(h, 2)], "image_yaw_deg": round(angle, 2),
                       "area_px": round(area), "semantic_label": None})
    return sorted(result, key=lambda item: item["area_px"], reverse=True)


def proposal(regions, calibration=None):
    result = {"schema": "nexarm-grasp-proposal/1", "mode": "offline", "execution_enabled": False,
              "candidates": regions, "steps": [], "requirements": []}
    if not calibration or not calibration.get("verified"):
        result["requirements"] = ["固定第三人称相机", "相机内参与畸变标定", "桌面到基座的实测标定", "夹爪工具中心与物体高度", "工作空间与路径验证"]
        return result
    matrix = np.asarray(calibration.get("image_to_table"), dtype=float)
    if matrix.shape != (3, 3) or not np.all(np.isfinite(matrix)) or abs(np.linalg.det(matrix)) < 1e-10:
        raise ValueError("A nonsingular finite 3x3 image-to-table homography is required")
    for region in regions:
        pixel = np.asarray([*region["pixel_center"], 1.0])
        point = matrix @ pixel
        if abs(point[2]) < 1e-8:
            continue
        xy = (point[:2] / point[2]).tolist()
        region["table_xy_mm"] = xy
    result["requirements"] = ["当前仅生成候选点，需用实测高度、夹爪朝向和 IK/碰撞预检形成执行计划"]
    return result


def audit_archive(path):
    with ZipFile(path) as archive:
        members = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("schema") != "nexarm-observations/1":
            raise ValueError("Expected a dual-view nexarm-observations/1 archive")
        total = valid = missing = actions = 0
        skews = []
        for line in archive.read("samples.jsonl").splitlines():
            sample = json.loads(line); total += 1
            images = sample.get("images", {})
            paired = len(images) == 2 and all(image.get("path") in members for image in images.values())
            missing += not paired
            actions += sample.get("action_angles") is not None
            valid += bool(sample.get("training_valid") and paired)
            skews.extend(image["pose_skew_ms"] for image in images.values() if image.get("pose_skew_ms") is not None)
        return {"task": manifest.get("task"), "samples": total, "training_valid": valid,
                "missing_dual_view": missing, "samples_with_actual_command": actions,
                "maximum_pose_skew_ms": max(skews, default=None),
                "ready_for_training": total > 0 and valid == total,
                "note": "A successful audit verifies packaging and timing, not grasp success or dataset diversity."}
