#!/bin/sh
# 启动包装脚本 — 设置环境变量并启动 Python 接收端
# SYNC_KEY 从 /root/.sync_key 文件读取，或在此处直接设置
# export SYNC_KEY="你的密钥"
exec /usr/bin/python3 /root/ssh_webhook.py
