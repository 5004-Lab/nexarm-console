"""LAN entry point for an explicitly authorized NexArm operator."""

import argparse
import base64
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
import secrets
import shutil
from urllib.parse import unquote, urlsplit

CONTROL_ACTIONS = frozenset({
    "arm", "disarm", "heartbeat", "read", "preview-target", "move-target",
    "move-joints", "jog", "stop", "run", "park", "capture-start", "capture-export",
    "observation-start", "observation-stop", "observation-mark",
    "episode-start", "episode-stop", "episode-mark", "episode-review", "episode-segment",
})
READ_APIS = frozenset({"/api/state", "/api/camera", "/api/camera/external", "/api/camera/realsense", "/api/camera-info", "/api/depth", "/api/depth-info", "/api/history/sessions", "/api/history/samples", "/api/history/archive", "/api/logs", "/api/capture-state", "/api/capture-file", "/api/capture-library"})
READ_APIS |= frozenset(f"/api/episodes/{name}" for name in ("library", "detail", "frames", "media", "archive"))
MAX_BODY = 65536


class GatewayServer(ThreadingHTTPServer):
    request_queue_size = 64


def application(host, port, peer, upstream_port, password):
    authority = f"{host}:{port}"
    origin = f"http://{authority}"
    local_origin = f"http://127.0.0.1:{upstream_port}"
    authorization = b"Basic " + base64.b64encode(f"nexarm:{password}".encode())
    control_key = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        disable_nagle_algorithm = True

        def reply(self, code, value, **headers):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            for name, value in headers.items():
                self.send_header(name.replace("_", "-"), value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def authorized(self):
            if self.client_address[0] not in (host, peer) or self.headers.get("Host") != authority:
                self.close_connection = True
                self.reply(403, {"error": "此控制端口只允许授权电脑访问"})
                return False
            if secrets.compare_digest(self.headers.get("Authorization", "").encode(), authorization):
                return True
            self.close_connection = True
            self.reply(401, {"error": "请登录远程控制台"}, WWW_Authenticate='Basic realm="NexArm Control"')
            return False

        def relay(self, path, body=None):
            archive = path.startswith(("/api/history/archive?", "/api/episodes/archive?"))
            connection = HTTPConnection("127.0.0.1", upstream_port, timeout=1800 if archive else 8)
            headers = {"X-Operator": self.headers.get("X-Operator", "")}
            try:
                if body is not None:
                    connection.request("GET", "/api/session")
                    session = connection.getresponse()
                    local_key = json.loads(session.read())["key"]
                    headers.update({
                        "Origin": local_origin,
                        "Content-Type": "application/json",
                        "X-Control-Key": local_key,
                    })
                connection.request(self.command, path, body=body, headers=headers)
                upstream = connection.getresponse()
                if path == "/api/state" and self.command == "GET" and upstream.status == 200:
                    state = json.loads(upstream.read())
                    state["remote_control"] = True
                    self.reply(200, state)
                    return
                self.send_response(upstream.status)
                for name, value in upstream.getheaders():
                    if name.lower() in {
                        "content-type", "content-length", "content-encoding", "cache-control", "last-modified", "content-disposition",
                        "x-camera-state", "x-camera-time", "x-pose-skew", "x-camera-pose",
                    }:
                        self.send_header(name, value)
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(upstream, self.wfile, 65536)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (OSError, HTTPException, KeyError, ValueError):
                # Closing also handles an upstream error after response headers were sent.
                self.close_connection = True
            finally:
                connection.close()

        def do_GET(self):
            if not self.authorized():
                return
            target = urlsplit(self.path)
            path = unquote(target.path)
            if path == "/api/session":
                self.reply(200, {"key": control_key})
            elif (not target.netloc and ".." not in path.split("/") and
                  (path in READ_APIS or path in ("/", "/index.html", "/favicon.ico") or path.startswith(("/assets/", "/model/")))):
                self.relay(self.path)
            else:
                self.reply(404, {"error": "资源不存在"})

        do_HEAD = do_GET

        def do_POST(self):
            if not self.authorized():
                return
            if (self.headers.get("Origin") != origin
                    or not secrets.compare_digest(self.headers.get("X-Control-Key", "").encode(), control_key.encode())):
                self.close_connection = True
                self.reply(403, {"error": "请从授权的远程控制页面操作"})
                return
            if self.path not in {"/api/" + action for action in CONTROL_ACTIONS}:
                self.close_connection = True
                self.reply(403, {"error": "此操作请在连接机械臂的电脑执行"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = 0
            if not 0 < size <= MAX_BODY:
                self.close_connection = True
                self.reply(400, {"error": "请求大小无效"})
                return
            self.relay(self.path, self.rfile.read(size))

        def log_message(self, format, *args):
            if self.path == "/":
                super().log_message(format, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--peer", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--upstream-port", type=int, default=8765)
    args = parser.parse_args()
    password = os.environ.get("NEXARM_CONTROL_PASSWORD", "")
    if (len(password) < 12 or args.host.is_unspecified or args.peer.is_unspecified):
        parser.error("a specific host and peer, and a control password of at least 12 characters, are required")
    host, peer = str(args.host), str(args.peer)
    with GatewayServer((host, args.port), application(host, args.port, peer, args.upstream_port, password)) as server:
        print(f"NexArm control: http://{host}:{args.port}/ (peer {peer})", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
