#!/bin/sh
# 启动包装脚本 — 设置环境变量并启动 Python 接收端
# SYNC_KEY 从 /root/.sync_key 文件读取，或在此处直接设置
# export SYNC_KEY="你的密钥"

# 自动探测 python3 路径（兼容 /usr/bin 和 /usr/local/bin）
if command -v python3 >/dev/null 2>&1; then
    PYTHON3=$(command -v python3)
elif [ -x /usr/bin/python3 ]; then
    PYTHON3=/usr/bin/python3
elif [ -x /usr/local/bin/python3 ]; then
    PYTHON3=/usr/local/bin/python3
else
    echo "ERROR: python3 not found" >&2
    exit 1
fi

exec "$PYTHON3" /root/ssh_webhook.py
