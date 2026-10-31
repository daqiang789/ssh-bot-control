#!/bin/bash
# ============================================================
# install.sh — SSH Bot Control VPS 端一键安装脚本
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
#
# 或下载后运行:
#   bash install.sh
#
# 本脚本在 VPS 上完成以下操作:
#   1. 下载 key_manager_dynamic.sh + ssh_webhook.py + start_webhook.sh
#   2. 生成随机 SYNC_KEY 并写入 /root/.sync_key
#   3. 提示用户放置 SSL 证书 (Cloudflare Origin Certificate)
#   4. 创建系统服务 (自动识别 systemd / OpenRC)
#   5. 启动服务并验证
#
# 前提条件:
#   - root 权限
#   - Python 3
#   - 已在 Cloudflare Dashboard 创建 Origin 证书 (ssl_cert.pem + ssl_key.pem)
# ============================================================

set -e

# ---------- 颜色 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

# ---------- root 检查 ----------
if [ "$(id -u)" -ne 0 ]; then
    fail "请使用 root 权限运行: sudo bash install.sh"
fi

# ---------- 变量 ----------
REPO_RAW="https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main"
INSTALL_DIR="/root"
WEBHOOK_PORT=2087
SERVICE_NAME="ssh-webhook"

# ---------- 依赖检查 ----------
info "检查依赖..."
command -v python3 >/dev/null 2>&1 || fail "未找到 python3，请先安装: apt install python3 / apk add python3"
command -v bash  >/dev/null 2>&1 || fail "未找到 bash"

# 检测 init 系统
INIT_SYSTEM="unknown"
if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1; then
    INIT_SYSTEM="openrc"
fi

ok "Python3: $(python3 --version 2>&1)"
ok "Init 系统: ${INIT_SYSTEM}"

# ---------- 下载文件 ----------
info "下载脚本文件..."
cd "$INSTALL_DIR"

FILES=("key_manager_dynamic.sh" "ssh_webhook.py" "start_webhook.sh")
for f in "${FILES[@]}"; do
    curl -fsSL "${REPO_RAW}/${f}" -o "${INSTALL_DIR}/${f}" || fail "下载 ${f} 失败"
    ok "已下载 ${f}"
done

chmod +x key_manager_dynamic.sh start_webhook.sh

# ---------- 生成 SYNC_KEY ----------
SYNC_KEY_FILE="${INSTALL_DIR}/.sync_key"

if [ -f "$SYNC_KEY_FILE" ]; then
    warn "已存在 ${SYNC_KEY_FILE}，保留现有密钥"
else
    # 生成 32 字节随机 hex 作为 SYNC_KEY
    SYNC_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    printf '%s\n' "$SYNC_KEY" > "$SYNC_KEY_FILE"
    chmod 600 "$SYNC_KEY_FILE"
    ok "已生成 SYNC_KEY 并写入 ${SYNC_KEY_FILE}"
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  请将以下 SYNC_KEY 配置到 Cloudflare Worker 环境变量:${NC}"
    echo -e "${GREEN}  SYNC_KEY = ${SYNC_KEY}${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
fi

# ---------- SSL 证书检查 ----------
CERT_FILE="${INSTALL_DIR}/ssl_cert.pem"
KEY_FILE="${INSTALL_DIR}/ssl_key.pem"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    warn "未找到 SSL 证书 (${CERT_FILE} / ${KEY_FILE})"
    echo ""
    echo -e "${YELLOW}请从 Cloudflare Dashboard 获取 Origin 证书:${NC}"
    echo -e "  1. Dashboard → 你的域名 → SSL/TLS → Origin Server"
    echo -e "  2. Create Certificate → 通配符 *.你的域名 → 15 years"
    echo -e "  3. 保存证书到 ${CERT_FILE}"
    echo -e "  4. 保存私钥到 ${KEY_FILE}"
    echo -e "  5. 重新运行本脚本"
    echo ""
    fail "请放置 SSL 证书后重试"
fi

chmod 600 "$KEY_FILE"
ok "SSL 证书已就位"

# ---------- 创建系统服务 ----------
info "创建 ${SERVICE_NAME} 服务..."

if [ "$INIT_SYSTEM" = "systemd" ]; then
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=SSH Bot Webhook Receiver
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/ssh_webhook.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
    sleep 2
    systemctl is-active --quiet "$SERVICE_NAME" && ok "systemd 服务已启动" || fail "服务启动失败"

elif [ "$INIT_SYSTEM" = "openrc" ]; then
    cat > "/etc/init.d/${SERVICE_NAME}" << 'EOF'
#!/sbin/openrc-run
description="SSH Bot Webhook Receiver"
command="/root/start_webhook.sh"
command_background=true
pidfile="/run/ssh-webhook.pid"
depend() {
    need net
}
EOF

    chmod +x "/etc/init.d/${SERVICE_NAME}"
    rc-update add "$SERVICE_NAME" default 2>/dev/null || true
    rc-service "$SERVICE_NAME" restart
    sleep 2
    rc-service "$SERVICE_NAME" status | grep -q "started" && ok "OpenRC 服务已启动" || fail "服务启动失败"

else
    warn "未识别到 systemd 或 OpenRC，请手动启动:"
    echo "  python3 ${INSTALL_DIR}/ssh_webhook.py &"
fi

# ---------- 验证 ----------
info "验证服务..."
if command -v curl >/dev/null 2>&1; then
    HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${WEBHOOK_PORT}/" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "200" ]; then
        ok "HTTPS 端口 ${WEBHOOK_PORT} 响应正常 (HTTP ${HTTP_CODE})"
    else
        warn "端口 ${WEBHOOK_PORT} 返回 HTTP ${HTTP_CODE}（可能需要几秒启动）"
    fi
fi

# ---------- 完成提示 ----------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ VPS 端安装完成!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "已安装文件:"
echo -e "  ${INSTALL_DIR}/key_manager_dynamic.sh  (密钥管理脚本)"
echo -e "  ${INSTALL_DIR}/ssh_webhook.py         (HTTPS 接收端)"
echo -e "  ${INSTALL_DIR}/start_webhook.sh       (启动包装)"
echo -e "  ${INSTALL_DIR}/.sync_key              (鉴权密钥)"
echo -e "  ${INSTALL_DIR}/ssl_cert.pem           (SSL 证书)"
echo -e "  ${INSTALL_DIR}/ssl_key.pem            (SSL 私钥)"
echo ""
echo -e "服务状态: ${SERVICE_NAME} (端口 ${WEBHOOK_PORT})"
echo ""
echo -e "${YELLOW}下一步: 在 Cloudflare 端完成 Worker 部署${NC}"
echo -e "  1. 克隆仓库: git clone https://github.com/daqiang789/ssh-bot-control.git"
echo -e "  2. 编辑 wrangler.toml 填入你的 account_id / KV id / 域名"
echo -e "  3. 部署: CLOUDFLARE_API_TOKEN=你的token npx wrangler deploy"
echo -e "  4. 在 Dashboard 设置 Secrets: BOT_TOKEN, SYNC_KEY, FIXED_PUB_KEY, TG_SECRET_TOKEN, ALLOWED_CHAT_ID"
echo -e "  5. 绑定 Telegram Webhook"
echo ""
