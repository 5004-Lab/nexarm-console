"""Verify independent camera routing and the authenticated LAN relay."""
import base64
import gzip
import json
from contextlib import closing
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler
import threading
from types import SimpleNamespace
import unittest

from nexarm.server import ConsoleHTTPServer, application
from nexarm.lan_control import GatewayServer, application as gateway_application


class CameraHTTPTest(unittest.TestCase):
    def setUp(self):
        self.servers = []
        self.controller = SimpleNamespace(match_feedback=lambda stamp: (3, [[2048, 0]] * 6))
        self.wrist = SimpleNamespace(frame=lambda after: ("live", (10.0, b"wrist-jpeg")))
        self.external = SimpleNamespace(frame=lambda after: ("live", (20.0, b"external-jpeg")))
        self.depth_body = gzip.compress(b"native-z16-depth")
        self.depth = SimpleNamespace(frame=lambda after: ("live", (30.0, self.depth_body)),
                                     info=lambda: {"status": "live", "depth_scale_m": .0001},
                                     color_frame=lambda after: ("live", (30.0, b"d405-rgb-jpeg")),
                                     color_info=lambda: {"status": "live", "format": "rgb8-jpeg"})

    def server(self, external=True, password=None):
        server = ConsoleHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        server.RequestHandlerClass = application(
            self.controller, f"http://127.0.0.1:{server.server_port}", self.wrist,
            view_password=password, external_camera=self.external if external else None, depth_camera=self.depth)
        return self.start(server)

    def start(self, server):
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.servers.append((server, worker))
        return server

    def get(self, server, path, headers=None):
        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=3)) as connection:
            connection.request("GET", path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def tearDown(self):
        for server, worker in reversed(self.servers):
            server.shutdown()
            server.server_close()
            worker.join(2)

    def test_camera_streams_are_distinct_and_only_wrist_has_pose(self):
        server = self.server()
        wrist = self.get(server, "/api/camera")
        external = self.get(server, "/api/camera/external?after=0")
        self.assertEqual((wrist[0], wrist[2]), (200, b"wrist-jpeg"))
        self.assertEqual((external[0], external[2]), (200, b"external-jpeg"))
        self.assertIn("X-Camera-Pose", wrist[1])
        self.assertNotIn("X-Camera-Pose", external[1])
        d405 = self.get(server, "/api/camera/realsense")
        self.assertEqual((d405[0], d405[2]), (200, b"d405-rgb-jpeg"))
        self.assertNotIn("X-Camera-Pose", d405[1])

    def test_missing_external_camera_does_not_break_wrist(self):
        server = self.server(external=False)
        self.assertEqual(self.get(server, "/api/camera/external")[0], 404)
        self.assertEqual(self.get(server, "/api/camera")[0], 200)

    def test_offline_external_camera_does_not_break_wrist(self):
        self.external.frame = lambda after: ("missing", None)
        server = self.server()
        status, headers, body = self.get(server, "/api/camera/external")
        self.assertEqual(status, 204)
        self.assertEqual(headers["X-Camera-State"], "missing")
        self.assertEqual(body, b"")
        self.assertEqual(self.get(server, "/api/camera")[0], 200)

    def test_external_camera_requires_lan_authentication(self):
        server = self.server(password="test-password-long")
        self.assertEqual(self.get(server, "/api/camera/external")[0], 401)
        authorization = "Basic " + base64.b64encode(b"nexarm:test-password-long").decode()
        self.assertEqual(self.get(server, "/api/camera/external", {"Authorization": authorization})[0], 200)

    def test_control_gateway_relays_external_camera(self):
        upstream = self.server()
        gateway = GatewayServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        gateway.RequestHandlerClass = gateway_application(
            "127.0.0.1", gateway.server_port, "127.0.0.1", upstream.server_port, "test-password-long")
        self.start(gateway)
        authorization = "Basic " + base64.b64encode(b"nexarm:test-password-long").decode()
        response = self.get(gateway, "/api/camera/external?after=0", {"Authorization": authorization})
        self.assertEqual((response[0], response[2]), (200, b"external-jpeg"))
        response = self.get(gateway, "/api/camera/realsense?after=0", {"Authorization": authorization})
        self.assertEqual((response[0], response[2]), (200, b"d405-rgb-jpeg"))

    def test_depth_requires_auth_and_gateway_preserves_compression(self):
        secured = self.server(password="test-password-long")
        self.assertEqual(self.get(secured, "/api/depth")[0], 401)
        upstream = self.server()
        gateway = GatewayServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        gateway.RequestHandlerClass = gateway_application(
            "127.0.0.1", gateway.server_port, "127.0.0.1", upstream.server_port, "test-password-long")
        self.start(gateway)
        authorization = "Basic " + base64.b64encode(b"nexarm:test-password-long").decode()
        response = self.get(gateway, "/api/depth?after=0", {"Authorization": authorization})
        self.assertEqual(response[0], 200)
        self.assertEqual(response[1]["Content-Encoding"], "gzip")
        self.assertEqual(gzip.decompress(response[2]), b"native-z16-depth")
        info = self.get(gateway, "/api/depth-info", {"Authorization": authorization})
        self.assertEqual(json.loads(info[2])["depth_scale_m"], .0001)

    def test_depth_offline_and_bad_timestamp_do_not_affect_rgb(self):
        self.depth.frame = lambda after: ("missing", None)
        server = self.server()
        self.assertEqual(self.get(server, "/api/depth")[0], 204)
        self.assertEqual(self.get(server, "/api/depth?after=nan")[0], 400)
        self.assertEqual(self.get(server, "/api/camera/external")[0], 200)


if __name__ == "__main__":
    unittest.main()
