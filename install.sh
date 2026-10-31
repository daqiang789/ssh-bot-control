#!/bin/bash
# ============================================================
# install.sh — SSH Bot Control VPS 端一键安装脚本 (多发行版适配版)
#
# 支持: Ubuntu / Debian / CentOS 7 / RHEL / Alpine (自动识别)
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
#
# 更安全（先下载检查再执行）:
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh
#   less install.sh && bash install.sh
#
# 本脚本自动完成:
#   1. 识别发行版 (os-release) + init 系统 (systemd/OpenRC) + 包管理器
#   2. 缺失 python3 / curl 时自动安装
#   3. SSL 证书: 三种方式
#        a) 已存在 /root/ssl_cert.pem + ssl_key.pem → 直接用
#        b) 提供 CF_ACCOUNT_ID + CF_API_TOKEN + CF_DOMAIN → 调 Cloudflare API
#           自动创建 15 年 Origin 证书 (一次即可，无需手动上传)
#        c) 都没有 → 提示手动放置后重跑
#   4. 下载 key_manager_dynamic.sh + ssh_webhook.py + start_webhook.sh
#   5. 生成随机 SYNC_KEY → /root/.sync_key
#   6. 创建并启动系统服务
#   7. 验证 HTTPS 端口
#
# 前提: root 权限
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
CERT_FILE="${INSTALL_DIR}/ssl_cert.pem"
KEY_FILE="${INSTALL_DIR}/ssl_key.pem"

# ============================================================
# 1. 发行版 / init / 包管理器 自动识别
# ============================================================
info "识别系统环境..."

DISTRO_ID=""
DISTRO_NAME=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_NAME="${PRETTY_NAME:-${ID:-unknown}}"
    # Debian 系 (ID=debian/ubuntu 或 ID_LIKE 含 debian)
    case "${ID:-} ${ID_LIKE:-}" in
        *debian*|*ubuntu*) DISTRO_ID="debian" ;;
        *alpine*)          DISTRO_ID="alpine" ;;
        *rhel*|*centos*|*fedora*|*rhel*) DISTRO_ID="rhel" ;;
    esac
fi

# init 系统
INIT_SYSTEM="unknown"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1; then
    INIT_SYSTEM="openrc"
fi

# 包管理器
PKG_MGR=""
if command -v apt-get >/dev/null 2>&1; then
    PKG_MGR="apt"
elif command -v dnf >/dev/null 2>&1; then
    PKG_MGR="dnf"
elif command -v yum >/dev/null 2>&1; then
    PKG_MGR="yum"
elif command -v apk >/dev/null 2>&1; then
    PKG_MGR="apk"
fi

ok "发行版: ${DISTRO_NAME:-未知} (归一: ${DISTRO_ID:-未知})"
ok "init: ${INIT_SYSTEM}  包管理: ${PKG_MGR:-未识别}"

# ============================================================
# 2. 依赖: python3 + curl (缺失则自动装)
# ============================================================
info "检查/安装依赖 (python3, curl)..."
MISSING=""
command -v python3 >/dev/null 2>&1 || MISSING="${MISSING} python3"
command -v curl    >/dev/null 2>&1 || MISSING="${MISSING} curl"

if [ -n "$MISSING" ]; then
    case "$PKG_MGR" in
        apt)
            warn "自动安装:${MISSING}"
            apt-get update -y && apt-get install -y ${MISSING}
            ;;
        dnf)
            dnf install -y ${MISSING// /}
            ;;
        yum)
            yum install -y ${MISSING// /}
            ;;
        apk)
            apk add ${MISSING// /}
            ;;
        *)
            fail "未识别包管理器，请手动安装:${MISSING}"
            ;;
    esac
fi
ok "python3: $(python3 --version 2>&1)"
ok "curl: $(curl --version 2>&1 | head -1)"

PYTHON3_PATH=$(command -v python3)

# ============================================================
# 3. SSL 证书 — 自动创建 or 复用 or 提示
# ============================================================
info "处理 SSL 证书..."

# 方式 a: 证书已存在
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    chmod 600 "$KEY_FILE"
    ok "复用已有证书: ${CERT_FILE}"

# 方式 b: Cloudflare API 自动创建 15 年 Origin 证书
elif [ -n "$CF_ACCOUNT_ID" ] && [ -n "$CF_API_TOKEN" ] && [ -n "$CF_DOMAIN" ]; then
    info "调用 Cloudflare API 创建 15 年 Origin 证书 (*.${CF_DOMAIN})..."
    RESP=$(curl -fsSL -X POST \
        "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/certificates" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"account_id\":\"${CF_ACCOUNT_ID}\",\"type\":[\"origin\"],\"hostnames\":[\"*.${CF_DOMAIN}\"]}" \
        2>/dev/null || echo "")
    if echo "$RESP" | grep -q '"success":true'; then
        # 提取 cert / key (python 解析 JSON 更稳)
        python3 - "$RESP" > "$CERT_FILE" << 'PYEOF'
import sys, json
data = json.loads(sys.argv[1])
print(data["result"]["cert"], end="")
PYEOF
        python3 - "$RESP" > "$KEY_FILE" << 'PYEOF'
import sys, json
data = json.loads(sys.argv[1])
print(data["result"]["private_key"], end="")
PYEOF
        chmod 600 "$KEY_FILE"
        ok "已自动创建证书并保存: ${CERT_FILE} / ${KEY_FILE}"
        warn "注意: 此证书 15 年有效，创建后所有 VPS 可共用同一对文件"
    else
        warn "CF API 创建证书失败 (响应: ${RESP:0:200})，请检查 CF_ACCOUNT_ID/CF_API_TOKEN/CF_DOMAIN"
        fail "请改用手动放置证书后重试"
    fi

# 方式 c: 都没有 → 提示手动
else
    warn "未找到证书，且未提供 CF_API_TOKEN 自动创建。"
    echo ""
    echo -e "${YELLOW}两种处理:${NC}"
    echo -e "  ① 手动放置 (从 Cloudflare Dashboard 获取 Origin 证书):"
    echo -e "     - 证书存到 ${CERT_FILE}"
    echo -e "     - 私钥存到 ${KEY_FILE}"
    echo -e "  ② 自动创建 (推荐，一次即可):"
    echo -e "     CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx CF_DOMAIN=你的域名.com bash install.sh"
    echo ""
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        :  # 兜底
    else
        fail "请先放置 SSL 证书或提供 CF API 凭据后重试"
    fi
fi

# ============================================================
# 4. 下载脚本文件
# ============================================================
info "下载脚本文件..."
cd "$INSTALL_DIR"
for f in key_manager_dynamic.sh ssh_webhook.py start_webhook.sh; do
    curl -fsSL "${REPO_RAW}/${f}" -o "${INSTALL_DIR}/${f}" || fail "下载 ${f} 失败"
    ok "已下载 ${f}"
done
chmod +x key_manager_dynamic.sh start_webhook.sh

# ============================================================
# 5. 生成 SYNC_KEY
# ============================================================
SYNC_KEY_FILE="${INSTALL_DIR}/.sync_key"
if [ -f "$SYNC_KEY_FILE" ]; then
    warn "已存在 ${SYNC_KEY_FILE}，保留现有密钥"
    SYNC_KEY=$(cat "$SYNC_KEY_FILE")
else
    SYNC_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    printf '%s\n' "$SYNC_KEY" > "$SYNC_KEY_FILE"
    chmod 600 "$SYNC_KEY_FILE"
    ok "已生成 SYNC_KEY → ${SYNC_KEY_FILE}"
fi
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  请将以下 SYNC_KEY 配置到 Cloudflare Worker 环境变量:${NC}"
echo -e "${GREEN}  SYNC_KEY = ${SYNC_KEY}${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ============================================================
# 6. 创建系统服务
# ============================================================
info "创建 ${SERVICE_NAME} 服务 (${INIT_SYSTEM})..."

if [ "$INIT_SYSTEM" = "systemd" ]; then
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=SSH Bot Webhook Receiver
After=network.target

[Service]
Type=simple
ExecStart=${PYTHON3_PATH} ${INSTALL_DIR}/ssh_webhook.py
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
    cat > "/etc/init.d/${SERVICE_NAME}" << EOF
#!/sbin/openrc-run
description="SSH Bot Webhook Receiver"
command="${INSTALL_DIR}/start_webhook.sh"
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
    echo "  ${PYTHON3_PATH} ${INSTALL_DIR}/ssh_webhook.py &"
fi

# ============================================================
# 7. 验证
# ============================================================
info "验证服务..."
sleep 1
HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${WEBHOOK_PORT}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "200" ]; then
    ok "HTTPS 端口 ${WEBHOOK_PORT} 响应正常 (HTTP ${HTTP_CODE})"
else
    warn "端口 ${WEBHOOK_PORT} 返回 HTTP ${HTTP_CODE}（服务可能仍需几秒启动）"
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ VPS 端安装完成!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "已安装 (系统: ${DISTRO_NAME:-未知} / ${INIT_SYSTEM}):"
echo -e "  ${INSTALL_DIR}/key_manager_dynamic.sh  (密钥管理脚本)"
echo -e "  ${INSTALL_DIR}/ssh_webhook.py         (HTTPS 接收端)"
echo -e "  ${INSTALL_DIR}/start_webhook.sh       (启动包装)"
echo -e "  ${INSTALL_DIR}/.sync_key              (鉴权密钥)"
echo -e "  ${INSTALL_DIR}/ssl_cert.pem           (SSL 证书)"
echo -e "  ${INSTALL_DIR}/ssl_key.pem            (SSL 私钥)"
echo ""
echo -e "下一步: 在 Cloudflare 端部署 Worker 并设置 Secrets (见 README)"
