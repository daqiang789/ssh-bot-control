# 部署指南

## 一、Cloudflare 端

### 1. 创建 KV 命名空间

Dashboard → Workers & Pages → KV → 创建命名空间 `SSH_KV`

### 2. 部署 Worker

```bash
# 编辑 wrangler.toml，填入 account_id 和 KV id
npx wrangler deploy
```

### 3. 设置环境变量

Dashboard → Workers & Pages → ssh-bot → Settings → Variables and Secrets：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `BOT_TOKEN` | Secret | Telegram Bot Token（从 @BotFather 获取） |
| `ALLOWED_CHAT_ID` | 变量 | 你的 Telegram Chat ID（从 @userinfobot 获取） |
| `VPS_SERVERS` | 变量 | VPS 列表，格式：`id:名称:url\|id:名称:url` |
| `SYNC_KEY` | Secret | Worker ↔ VPS 鉴权密钥 |
| `FIXED_PUB_KEY` | Secret | 你的固定 SSH 公钥 |
| `TG_SECRET_TOKEN` | Secret | Webhook 验证令牌 |

### 4. 创建 Origin 证书

Dashboard → 域名 → SSL/TLS → Origin Server → Create Certificate
- Hostnames: `*.你的域名`
- Validity: 15 years
- 保存证书和私钥

### 5. 绑定 Telegram Webhook

```bash
curl "https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=https://bot-ssh.你的域名&secret_token=你的TG_SECRET_TOKEN"
```

---

## 二、VPS 端（每台都一样）

### 1. 放置文件

```
/root/key_manager_dynamic.sh   # 密钥管理脚本
/root/ssh_webhook.py           # HTTPS 接收端
/root/ssl_cert.pem             # Origin 证书
/root/ssl_key.pem              # Origin 私钥
/root/.sync_key                # SYNC_KEY 值（纯文本）
```

### 2. 创建启动脚本

```bash
cat > /root/start_webhook.sh << 'EOF'
#!/bin/sh
exec /usr/bin/python3 /root/ssh_webhook.py
EOF
chmod +x /root/start_webhook.sh
chmod +x /root/key_manager_dynamic.sh
chmod 600 /root/.sync_key
```

### 3. 创建 DNS 记录

每台 VPS 一个子域名，A 记录（IPv4）或 AAAA 记录（IPv6），开启橙色云代理。

### 4. 启动服务

**Alpine Linux (OpenRC)：**
```bash
cat > /etc/init.d/ssh-webhook << 'EOF'
#!/sbin/openrc-run
description="SSH Bot Webhook Receiver"
command="/root/start_webhook.sh"
command_background=true
pidfile="/run/ssh-webhook.pid"
depend() { need net; }
EOF
chmod +x /etc/init.d/ssh-webhook
rc-update add ssh-webhook default
rc-service ssh-webhook start
```

**systemd (Ubuntu/Debian)：**
```bash
cat > /etc/systemd/system/ssh-webhook.service << 'EOF'
[Unit]
Description=SSH Bot Webhook Receiver
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 /root/ssh_webhook.py
Environment=SYNC_KEY=你的SYNC_KEY值
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl enable ssh-webhook
systemctl start ssh-webhook
```

### 5. 验证

```bash
# 本地测试（返回 501 或 Forbidden 就对了）
curl -k https://localhost:2087/
```

---

## 三、Telegram 端

打开 Bot 私聊，发送 `/ssh`，应该弹出控制面板。
