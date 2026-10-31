#!/usr/bin/env python3
# ============================================================
# ssh_webhook.py — 安全修复版（SSL + 速率限制，IPv4/IPv6 双栈）
# 过期回收由 Worker Cron 处理
# ============================================================

import http.server
import socketserver
import ssl
import socket
import subprocess
import json
import time
import os
import logging
from collections import defaultdict

PORT = 2087
BIND_ADDR = "::"               # IPv6 双栈，纯 v6 和 v4+v6 都能用
AUTH_KEY = os.environ.get("SYNC_KEY") or (open("/root/.sync_key").read().strip() if os.path.exists("/root/.sync_key") else "PLACEHOLDER")
SCRIPT = "/root/key_manager_dynamic.sh"

CERT_FILE = "/root/ssl_cert.pem"
KEY_FILE = "/root/ssl_key.pem"

RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX = 20
MAX_PAYLOAD = 16 * 1024

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler('/var/log/ssh_webhook.log'), logging.StreamHandler()]
)
logger = logging.getLogger("ssh_webhook")

request_times = defaultdict(list)

def is_rate_limited(client_ip):
    now = time.time()
    request_times[client_ip] = [t for t in request_times[client_ip] if now - t < RATE_LIMIT_WINDOW]
    if len(request_times[client_ip]) >= RATE_LIMIT_MAX:
        return True
    request_times[client_ip].append(now)
    return False


# ---------- IPv6 双栈 Server ----------
class DualStackServer(socketserver.TCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        # 绑定 :: 同时接受 IPv4 和 IPv6 连接
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        client_ip = self.client_address[0]

        if is_rate_limited(client_ip):
            logger.warning(f"RATE LIMITED: {client_ip}")
            self._respond(429, b"Too Many Requests")
            return

        auth_header = self.headers.get("X-Auth-Key", "")
        if auth_header != AUTH_KEY:
            logger.warning(f"AUTH FAILED from {client_ip}")
            self._respond(403, b"Forbidden")
            return

        content_len = int(self.headers.get("Content-Length", 0))
        if content_len > MAX_PAYLOAD:
            self._respond(413, b"Payload Too Large")
            return

        post_data = self.rfile.read(content_len)

        try:
            data = json.loads(post_data.decode("utf-8"))
            action = data.get("action", "")
            pub_key = data.get("pub_key", "")
            tag = data.get("tag", "temp")

            if action not in ("add", "remove"):
                self._respond(400, b"Bad Request")
                return
            if len(tag) > 64:
                self._respond(400, b"Tag too long")
                return

            result = subprocess.run(
                ["bash", SCRIPT, action, pub_key, tag],
                capture_output=True, timeout=10, text=True
            )

            if result.returncode == 0:
                logger.info(f"OK: action={action} tag={tag} ip={client_ip}")
                self._respond(200, b"Success")
            else:
                logger.error(f"SCRIPT FAILED: {result.stderr} ip={client_ip}")
                self._respond(500, b"Script error")

        except json.JSONDecodeError:
            self._respond(400, b"Invalid JSON")
        except subprocess.TimeoutExpired:
            self._respond(504, b"Gateway Timeout")
        except Exception as e:
            logger.error(f"INTERNAL ERROR: {e}")
            self._respond(500, b"Internal Error")

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not os.path.exists(CERT_FILE) or not os.path.exists(KEY_FILE):
        logger.error(f"SSL cert/key not found! {CERT_FILE} / {KEY_FILE}")
        exit(1)

    logger.info(f"Starting HTTPS ssh_webhook on [{BIND_ADDR}]:{PORT} (IPv4+IPv6 dual-stack)")
    httpd = DualStackServer((BIND_ADDR, PORT), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()
