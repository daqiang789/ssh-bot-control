# -*- coding: utf-8 -*-
p = "/root/workspace/ssh-bot-control/install.sh"
s = open(p, encoding="utf-8").read()

# ---- 1) 顶部用法注释：加 SYNC_KEY 指定示例 + 修正第 5 步说明 ----
old_usage = '''# 用法:
#   curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
#
# 更安全（先下载检查再执行）:
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh
#   less install.sh && bash install.sh'''
new_usage = '''# 用法:
#   curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
#
# 指定 SYNC_KEY（推荐；需与 Worker 共享值及所有其他 VPS 一致）:
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh
#   SYNC_KEY=你的共享密钥 bash install.sh
#
# 更安全（先下载检查再执行）:
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh
#   less install.sh && bash install.sh'''
assert s.count(old_usage) == 1, "用法块匹配数异常"
s = s.replace(old_usage, new_usage, 1)

old_step5 = "#   5. 生成随机 SYNC_KEY → /root/.sync_key"
new_step5 = "#   5. 配置 SYNC_KEY（可用 SYNC_KEY=xxx 输入 / 交互填写，缺省才随机）→ /root/.sync_key"
assert s.count(old_step5) == 1, "第5步说明匹配数异常"
s = s.replace(old_step5, new_step5, 1)

# ---- 2) 第 5 段：随机生成 -> 支持自己输入 ----
old_body = '''SYNC_KEY_FILE="${INSTALL_DIR}/.sync_key"
if [ -f "$SYNC_KEY_FILE" ]; then
    warn "已存在 ${SYNC_KEY_FILE}，保留现有密钥"
    SYNC_KEY=$(cat "$SYNC_KEY_FILE")
else
    SYNC_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    printf '%s\\n' "$SYNC_KEY" > "$SYNC_KEY_FILE"
    chmod 600 "$SYNC_KEY_FILE"
    ok "已生成 SYNC_KEY → ${SYNC_KEY_FILE}"
fi'''
new_body = '''SYNC_KEY_FILE="${INSTALL_DIR}/.sync_key"
if [ -f "$SYNC_KEY_FILE" ]; then
    warn "已存在 ${SYNC_KEY_FILE}，保留现有密钥"
    SYNC_KEY=$(cat "$SYNC_KEY_FILE")
else
    # 优先级: 环境变量 SYNC_KEY > 命令行参数 $1 > 交互输入 > 随机兜底
    SYNC_KEY="${SYNC_KEY:-${1:-}}"
    if [ -z "$SYNC_KEY" ] && [ -t 0 ]; then
        read -rp "请输入 SYNC_KEY（直接回车 = 随机生成）: " SYNC_KEY
    fi
    if [ -z "$SYNC_KEY" ]; then
        SYNC_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
        warn "未提供 SYNC_KEY，已随机生成。"
        warn "注意: 若该 VPS 要接入 Worker，此值必须与 Worker 的 SYNC_KEY secret"
        warn "      及所有其他 VPS 的 /root/.sync_key 完全一致，否则鉴权 403。"
        warn "      推荐做法: SYNC_KEY=共享值 bash install.sh"
    else
        ok "使用你提供的 SYNC_KEY"
    fi
    printf '%s\\n' "$SYNC_KEY" > "$SYNC_KEY_FILE"
    chmod 600 "$SYNC_KEY_FILE"
    ok "SYNC_KEY 已写入 ${SYNC_KEY_FILE}"
fi'''
assert s.count(old_body) == 1, "第5段匹配数异常"
s = s.replace(old_body, new_body, 1)

open(p, "w", encoding="utf-8").write(s)
print("[OK] install.sh 已改：SYNC_KEY 支持自己输入")
