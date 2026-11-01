#!/usr/bin/env python3
# ============================================================
# ssh_webhook.py — 安全修复版（SSL + 速率限制，IPv4/IPv6 双栈）
# 过期回收由 Worker Cron 处理
# 2026-11-01: 新增 GET /metrics 端点，返回服务器系统指标 JSON
# ============================================================

import http.server
import socketserver
import ssl
import socket
import subprocess
import json
import time
import os
import hmac
import logging
import struct
import platform
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

# 确保日志目录存在
os.makedirs(os.path.dirname('/var/log/ssh_webhook.log'), exist_ok=True)

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


# ============================================================
# 系统指标采集 — 读 /proc 文件系统，零依赖
# ============================================================

def read_cpu_percent():
    """两次采样 /proc/stat 计算 CPU 使用率"""
    def get_cpu_times():
        with open("/proc/stat", "r") as f:
            line = f.readline()
        parts = line.split()
        # user, nice, system, idle, iowait, irq, softirq, steal
        values = [int(x) for x in parts[1:9]]
        idle = values[3] + values[4]  # idle + iowait
        total = sum(values)
        return idle, total
    idle1, total1 = get_cpu_times()
    time.sleep(0.1)
    idle2, total2 = get_cpu_times()
    d_idle = idle2 - idle1
    d_total = total2 - total1
    if d_total == 0:
        return 0.0
    return round((1.0 - d_idle / d_total) * 100.0, 1)

def read_cpu_cores():
    """CPU 物理核心数"""
    try:
        with open("/proc/cpuinfo", "r") as f:
            return sum(1 for line in f if line.startswith("processor"))
    except:
        return 1

def read_meminfo():
    """内存 + Swap 信息 (MB)"""
    info = {}
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    info[parts[0].rstrip(":")] = int(parts[1])
    except:
        pass
    # 转成 MB
    mem_total = info.get("MemTotal", 0) // 1024
    mem_avail = info.get("MemAvailable", info.get("MemFree", 0)) // 1024
    mem_total_kb = info.get("MemTotal", 0)
    mem_free_kb = info.get("MemFree", 0)
    mem_cached_kb = info.get("Cached", 0) + info.get("Buffers", 0)
    mem_used = mem_total - mem_avail
    swap_total = info.get("SwapTotal", 0) // 1024
    swap_free = info.get("SwapFree", 0) // 1024
    swap_used = swap_total - swap_free
    return {
        "mem_total": mem_total, "mem_used": mem_used,
        "mem_avail": mem_avail, "mem_cached": mem_cached_kb // 1024,
        "swap_total": swap_total, "swap_used": swap_used
    }

def read_disk_usage():
    """各挂载点磁盘使用情况 (GB)"""
    disks = []
    try:
        # 用 df 获取挂载点，先尝试 GNU df (--output)，失败则用通用 df
        result = subprocess.run(["df", "-B1", "--output=target,size,used,avail,pcent"],
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split("\n")[1:]:
                parts = line.split()
                if len(parts) >= 5:
                    mount = parts[0]
                    # 只关注主要挂载点，跳过 tmpfs/devtmpfs 等
                    if mount == "/" or mount.startswith("/root") or mount.startswith("/home") or mount.startswith("/data"):
                        total_b = int(parts[1])
                        used_b = int(parts[2])
                        avail_b = int(parts[3])
                        percent = parts[4].rstrip("%")
                        disks.append({
                            "mount": mount,
                            "total": round(total_b / 1073741824, 2),   # GB，保留2位小数以支持小磁盘
                            "used": round(used_b / 1073741824, 2),
                            "avail": round(avail_b / 1073741824, 2),
                            "percent": int(percent)
                        })
    except:
        pass
    # 如果 --output 不支持（BusyBox df），用通用 df -B1
    if not disks:
        try:
            result = subprocess.run(["df", "-B1"],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.strip().split("\n")[1:]:
                    parts = line.split()
                    # df -B1 输出: Filesystem 1B-blocks Used Available Use% Mounted
                    if len(parts) >= 6:
                        mount = parts[5]
                        fs = parts[0]
                        # 跳过 tmpfs/devtmpfs/overlay 等虚拟文件系统
                        if fs.startswith("/dev") or (mount == "/" and not fs.startswith("tmpfs")):
                            total_b = int(parts[1])
                            used_b = int(parts[2])
                            avail_b = int(parts[3])
                            percent_str = parts[4].rstrip("%")
                            percent = int(percent_str) if percent_str.isdigit() else (round(used_b / total_b * 100) if total_b > 0 else 0)
                            disks.append({
                                "mount": mount,
                                "total": round(total_b / 1073741824, 2),
                                "used": round(used_b / 1073741824, 2),
                                "avail": round(avail_b / 1073741824, 2),
                                "percent": percent
                            })
        except:
            pass
    # 如果上面都没拿到，用 shutil.disk_usage 兜底
    if not disks:
        try:
            import shutil
            usage = shutil.disk_usage("/")
            disks.append({
                "mount": "/",
                "total": round(usage.total / 1073741824, 2),
                "used": round(usage.used / 1073741824, 2),
                "avail": round(usage.free / 1073741824, 2),
                "percent": round(usage.used / usage.total * 100, 1) if usage.total > 0 else 0
            })
        except:
            pass
    # 最后兜底：os.statvfs
    if not disks:
        try:
            st = os.statvfs("/")
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            used = total - free
            disks.append({
                "mount": "/",
                "total": round(total / 1073741824, 2),
                "used": round(used / 1073741824, 2),
                "avail": round(free / 1073741824, 2),
                "percent": round(used / total * 100, 1) if total > 0 else 0
            })
        except:
            pass
    return disks

def read_loadavg():
    """系统负载 1/5/15 分钟"""
    try:
        with open("/proc/loadavg", "r") as f:
            parts = f.read().split()
        return [float(parts[0]), float(parts[1]), float(parts[2])]
    except:
        return [0.0, 0.0, 0.0]

def read_uptime():
    """开机时间，返回秒数和可读字符串"""
    try:
        with open("/proc/uptime", "r") as f:
            seconds = float(f.read().split()[0])
        days = int(seconds // 86400)
        hours = int((seconds % 86400) // 3600)
        minutes = int((seconds % 3600) // 60)
        if days > 0:
            human = f"{days}天 {hours}小时"
        elif hours > 0:
            human = f"{hours}小时 {minutes}分"
        else:
            human = f"{minutes}分"
        return {"seconds": int(seconds), "human": human}
    except:
        return {"seconds": 0, "human": "未知"}

def read_network():
    """网络流量 (字节) — 取第一个非 lo 网卡"""
    rx_bytes = 0
    tx_bytes = 0
    iface = ""
    try:
        with open("/proc/net/dev", "r") as f:
            lines = f.readlines()
        for line in lines[2:]:  # 跳过表头
            parts = line.strip().split(":")
            if len(parts) >= 2:
                name = parts[0].strip()
                if name == "lo":
                    continue
                stats = parts[1].split()
                rx = int(stats[0])
                tx = int(stats[8])
                # 取第一个有流量的非 lo 网卡
                if rx > 0 or tx > 0:
                    iface = name
                    rx_bytes = rx
                    tx_bytes = tx
                    break
    except:
        pass
    return {"iface": iface, "rx_bytes": rx_bytes, "tx_bytes": tx_bytes}

def read_network_speed():
    """实时网速 — 两次采样差值"""
    net1 = read_network()
    time.sleep(0.5)
    net2 = read_network()
    dt = 0.5
    rx_speed = (net2["rx_bytes"] - net1["rx_bytes"]) / dt  # bytes/s
    tx_speed = (net2["tx_bytes"] - net1["tx_bytes"]) / dt
    return {
        "iface": net2["iface"],
        "rx_bytes": net2["rx_bytes"],
        "tx_bytes": net2["tx_bytes"],
        "rx_speed": round(rx_speed, 1),
        "tx_speed": round(tx_speed, 1)
    }

def read_os_info():
    """操作系统信息"""
    os_name = "Unknown"
    kernel = platform.release()
    try:
        with open("/etc/os-release", "r") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    os_name = line.split("=", 1)[1].strip().strip('"')
                    break
    except:
        os_name = platform.system() + " " + platform.release()
    # CPU 型号
    cpu_model = "Unknown"
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
    except:
        pass
    return {"os": os_name, "kernel": kernel, "cpu_model": cpu_model}

def collect_metrics():
    """采集全部系统指标，返回 dict"""
    try:
        cpu_percent = read_cpu_percent()
    except:
        cpu_percent = 0.0
    try:
        net = read_network_speed()
    except:
        net = {"iface": "", "rx_bytes": 0, "tx_bytes": 0, "rx_speed": 0, "tx_speed": 0}

    mem = read_meminfo()
    return {
        "cpu_percent": cpu_percent,
        "cpu_cores": read_cpu_cores(),
        "mem_total": mem["mem_total"],
        "mem_used": mem["mem_used"],
        "mem_avail": mem["mem_avail"],
        "mem_cached": mem["mem_cached"],
        "swap_total": mem["swap_total"],
        "swap_used": mem["swap_used"],
        "disk": read_disk_usage(),
        "load": read_loadavg(),
        "uptime": read_uptime(),
        "net_iface": net["iface"],
        "net_rx": net["rx_bytes"],
        "net_tx": net["tx_bytes"],
        "net_rx_speed": net["rx_speed"],
        "net_tx_speed": net["tx_speed"],
        "os_info": read_os_info(),
        "timestamp": int(time.time())
    }


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

    def do_GET(self):
        """处理 GET 请求 — /metrics 返回系统指标"""
        client_ip = self.client_address[0]

        if is_rate_limited(client_ip):
            self._respond(429, b"Too Many Requests")
            return

        # 鉴权 — /metrics 也需要 SYNC_KEY
        auth_header = self.headers.get("X-Auth-Key", "")
        if not hmac.compare_digest(auth_header, AUTH_KEY):
            self._respond(403, b"Forbidden")
            return

        if self.path == "/metrics" or self.path.startswith("/metrics"):
            try:
                metrics = collect_metrics()
                body = json.dumps(metrics).encode("utf-8")
                self._respond_json(200, body)
            except Exception as e:
                logger.error(f"METRICS ERROR: {e}")
                self._respond_json(500, json.dumps({"error": str(e)}).encode())
        else:
            self._respond(404, b"Not Found")

    def do_POST(self):
        client_ip = self.client_address[0]

        if is_rate_limited(client_ip):
            logger.warning(f"RATE LIMITED: {client_ip}")
            self._respond(429, b"Too Many Requests")
            return

        auth_header = self.headers.get("X-Auth-Key", "")
        # 使用恒定时间比较防止时序攻击
        if not hmac.compare_digest(auth_header, AUTH_KEY):
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

    def _respond_json(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not os.path.exists(CERT_FILE) or not os.path.exists(KEY_FILE):
        logger.error(f"SSL cert/key not found! {CERT_FILE} / {KEY_FILE}")
        exit(1)

    logger.info(f"Starting HTTPS ssh_webhook on [{BIND_ADDR}]:{PORT} (IPv4+IPv6 dual-stack)")
    httpd = DualStackServer((BIND_ADDR, PORT), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    # 强制最低 TLS 1.2，拒绝不安全的旧协议
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()
