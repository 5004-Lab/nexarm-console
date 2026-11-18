import unittest
import cv2
import numpy as np
from grasp_lab.pipeline import candidates, proposal


class PipelineTest(unittest.TestCase):
    def test_foreground_region_is_detected_and_never_executable_without_calibration(self):
        background = np.full((480, 640, 3), 230, np.uint8)
        image = background.copy(); cv2.rectangle(image, (200, 150), (280, 210), (30, 40, 50), -1)
        regions = candidates(image, background)
        self.assertEqual(len(regions), 1)
        self.assertLess(np.linalg.norm(np.array(regions[0]["pixel_center"]) - [240, 180]), 2)
        result = proposal(regions)
        self.assertFalse(result["execution_enabled"])
        self.assertEqual(result["steps"], [])
        self.assertTrue(result["requirements"])

    def test_bad_calibration_rejected(self):
        with self.assertRaises(ValueError): proposal([], {"verified": True, "image_to_table": [[0] * 3] * 3})

    def test_empty_scene_has_no_candidate(self):
        scene = np.full((480, 640, 3), 128, np.uint8)
        self.assertEqual(candidates(scene, scene), [])
