#!/bin/bash
# ============================================================
# key_manager_dynamic.sh — 合并修复版
# 基于用户 key_manager.sh 的安全习惯 + 修复命令注入 + 支持动态参数
#
# 用法: bash key_manager_dynamic.sh <add|remove> <pub_key> <tag>
#   add    - 添加指定公钥并开启 SSH 密钥登录
#   remove - 移除指定公钥（按 tag 或公钥内容匹配）
#
# 参数:
#   $1 ACTION  - add 或 remove
#   $2 PUB_KEY - 公钥字符串（由 webhook 传入）
#   $3 TAG     - 标识标签（如 temp_20261031_xxxx 或 fixed）
# ============================================================

ACTION="$1"
PUB_KEY="$2"
TAG="$3"

SSH_DIR="$HOME/.ssh"
AUTH_FILE="$SSH_DIR/authorized_keys"
SSHD_CONFIG="/etc/ssh/sshd_config"

# ---------- root 权限检查（来自用户原脚本） ----------
if [ "$EUID" -ne 0 ]; then
    echo "错误: 修改 authorized_keys 和 sshd_config 需要最高权限，请使用 root 或 sudo 运行。"
    exit 1
fi

if [ -z "$ACTION" ]; then
    echo "用法: bash $0 [add|remove] <pub_key> <tag>"
    echo "  add    - 添加公钥并自动开启 SSH 密钥登录支持"
    echo "  remove - 从服务器移除该公钥"
    exit 1
fi

# ---------- 输入校验（安全修复） ----------
# TAG 只允许字母数字和连字符，防止 sed 注入
if [ -n "$TAG" ]; then
    if ! printf '%s' "$TAG" | grep -qE '^[A-Za-z0-9_-]+$'; then
        echo "ERROR: Invalid tag format (only A-Za-z0-9_- allowed)"
        exit 1
    fi
fi

# 公钥基本格式校验（必须以 ssh- 或 ecdsa- 开头）
if [ "$ACTION" == "add" ] && [ -n "$PUB_KEY" ]; then
    if ! printf '%s' "$PUB_KEY" | grep -qE '^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp[0-9]+) '; then
        echo "ERROR: Invalid public key format"
        exit 1
    fi
fi

# ---------- 智能开启服务端密钥登录（来自用户原脚本，保留备份逻辑） ----------
enable_key_login() {
    echo "正在检查并开启 sshd_config 的密钥登录支持..."

    # 备份配置文件以防万一
    cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak"

    if grep -i -q "^#\?PubkeyAuthentication" "$SSHD_CONFIG"; then
        sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/I' "$SSHD_CONFIG"
    else
        echo "PubkeyAuthentication yes" >> "$SSHD_CONFIG"
    fi

    # 兼容处理所有主流系统的 SSH 服务重启
    if systemctl list-unit-files | grep -q "^sshd.service"; then
        systemctl restart sshd
    elif systemctl list-unit-files | grep -q "^ssh.service"; then
        systemctl restart ssh
    elif command -v service >/dev/null 2>&1; then
        service sshd restart || service ssh restart
    else
        /etc/init.d/sshd restart || /etc/init.d/ssh restart
    fi
    echo "SSH 服务端配置已更新并重启完毕。"
}

# ---------- 初始化安全目录 ----------
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
touch "$AUTH_FILE"

# ---------- 主逻辑 ----------
if [ "$ACTION" == "add" ]; then
    if [ -z "$PUB_KEY" ]; then
        echo "ERROR: No public key provided"
        exit 1
    fi

    # 先清理同名标签旧密钥（使用 # 作为 sed 分隔符，避免 TAG 含 / 出问题）
    if [ -n "$TAG" ]; then
        sed -i "\:# TAG:${TAG}\$:d" "$AUTH_FILE"
    fi

    # 重复添加检查（来自用户原脚本，用 -F 固定字符串匹配）
    if grep -Fq -- "$PUB_KEY" "$AUTH_FILE"; then
        echo "提示: 该公钥已存在于 $AUTH_FILE 中，先移除旧记录再重新写入。"
        grep -Fv -- "$PUB_KEY" "$AUTH_FILE" > "${AUTH_FILE}.tmp" && mv "${AUTH_FILE}.tmp" "$AUTH_FILE"
    fi

    # ★ 关键修复：用 printf '%s\n' 做字面量写入，不经过 shell 展开
    #   旧代码 echo "${PUB_KEY} # TAG:${TAG}" 中 $() 和反引号会被执行
    printf '%s # TAG:%s\n' "$PUB_KEY" "$TAG" >> "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"

    enable_key_login
    echo "OK: Added (tag=${TAG})"

elif [ "$ACTION" == "remove" ]; then
    if [ -n "$TAG" ]; then
        # 根据唯一标签剔除（安全分隔符 #）
        sed -i "\:# TAG:${TAG}\$:d" "$AUTH_FILE"
        echo "OK: Removed by tag=${TAG}"
    elif [ -n "$PUB_KEY" ]; then
        # 根据公钥内容剔除（grep -Fv 固定字符串匹配，不做正则展开）
        grep -Fv -- "$PUB_KEY" "$AUTH_FILE" > "${AUTH_FILE}.tmp" && mv "${AUTH_FILE}.tmp" "$AUTH_FILE"
        echo "OK: Removed by key content"
    else
        echo "ERROR: No tag or pub_key provided for removal"
        exit 1
    fi
    chmod 600 "$AUTH_FILE"

else
    echo "ERROR: Unknown action '${ACTION}'. Please use add or remove."
    exit 1
fi
