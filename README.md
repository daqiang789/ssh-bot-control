# SSH Bot Control — Telegram 远程 SSH 密钥管理系统

## 项目介绍

通过 Telegram Bot 远程管理多台 VPS 的 SSH `authorized_keys`，实现临时密钥的下发与自动回收。无需 SSH 登录服务器，在手机上点几个按钮即可完成。

**适用场景：** 临时给同事/客户开通 SSH 访问，到期自动回收，避免密钥堆积带来的安全隐患。

### 核心功能

- 🔑 **固定密钥下发** — 一键将自己的公钥推到多台服务器，1h/2h 后自动回收
- 🎲 **动态密钥生成** — Worker 端实时生成 Ed25519 密钥对，私钥发给你转发给对方
- 🛑 **手动撤销** — 随时撤销任意服务器上的临时密钥
- ⏰ **自动过期回收** — Cron 每分钟扫描，到期自动删除
- 📊 **状态面板** — 查看各服务器当前授权状态 + 审计日志
- 🖥️ **多服务器批量操作** — 勾选多台同时下发/撤销

---

## 架构

```
你手机 Telegram
    │  发送 /ssh
    ▼
Telegram Bot API (Webhook)
    │
    ▼
Cloudflare Worker (bot-ssh.111298.xyz)
    │  ├── 接收 Telegram 消息，渲染 inline 按钮面板
    │  ├── 生成 Ed25519 密钥对（动态模式）
    │  ├── KV 存储会话状态 + 审计日志
    │  └── Cron 每分钟扫描过期会话 → 自动回收
    │
    ▼  HTTPS (Cloudflare Origin 证书，15 年)
VPS Python 接收端 (端口 2087)
    │  ├── 鉴权 (SYNC_KEY)
    │  ├── 速率限制 (20 次/分钟)
    │  └── 调用 bash 脚本操作 authorized_keys
    │
    ▼
bash key_manager_dynamic.sh
    ├── add: 写入公钥 + 开启 PubkeyAuthentication + 重启 sshd
    └── remove: 按 tag 或公钥内容删除
```

### 组件说明

| 组件 | 位置 | 作用 |
|------|------|------|
| `worker.js` | Cloudflare Worker | Telegram Webhook 接收 + 按钮面板 + 密钥生成 + Cron 回收 |
| `ssh_webhook.py` | 每台 VPS | HTTPS 接收端，鉴权 + 速率限制 + 调用 bash |
| `key_manager_dynamic.sh` | 每台 VPS | 操作 authorized_keys，安全写入 + 格式校验 |
| Cloudflare KV | Cloudflare | 存储会话状态 (active_sessions) + 审计日志 (audit_logs) |
| Origin 证书 | 每台 VPS | Cloudflare ↔ VPS 加密，通配符 `*.111298.xyz`，15 年 |

---

## 开发过程

### 第一阶段：需求分析与方案设计

原始需求：VPS 的 Web 面板挂了，无法通过网页管理 SSH 密钥，需要一个替代方案。

方案演进：
1. ~~直接 SSH 登录手动操作~~ → 不够自动化，且 Web 挂了可能 SSH 也不通
2. ~~Telegram Bot 直连 VPS~~ → VPS 需要公网暴露 Telegram API 出口
3. **Telegram → Cloudflare Worker → VPS** → Worker 做中间层，VPS 只需暴露一个 HTTPS 端口

### 第二阶段：安全审计与修复

对用户原有 `key_manager.sh` 进行安全审计，发现以下问题：

| 问题 | 严重度 | 修复 |
|------|--------|------|
| `echo "${PUB_KEY}"` 命令注入 (RCE) | 🔴 严重 | 改用 `printf '%s\n'` 字面量写入 |
| 无公钥格式校验 | 🟡 中等 | 增加 `grep -qE '^(ssh-(rsa\|ed25519\|dss)\|ecdsa-...)' ` 校验 |
| 无 TAG 格式校验 | 🟡 中等 | 只允许 `A-Za-z0-9_-`，防 sed 注入 |
| 硬编码 Secrets | 🟡 中等 | 改用环境变量 |
| 无速率限制 | 🟡 中等 | Python 端加 20 次/分钟限制 |

### 第三阶段：Worker 开发

- 实现 Telegram inline keyboard 面板（勾选服务器 + 操作按钮）
- 实现 Ed25519 密钥对生成（WebCrypto API → OpenSSH 格式）
- KV 存储会话状态 + 审计日志
- Cron 定时扫描过期会话自动回收

### 第四阶段：部署与调试

详见下方「坑点」章节。

---

## 坑点（踩过的坑）

### 1. Cloudflare Worker Cron 数量限制

**问题：** 第一个 Cloudflare 账户的免费 Cron 配额已满（5/5），无法添加新的 Cron Trigger。

**解决：** 部署到第二个账户。后续改为 VPS 端 `threading.Timer` 本地倒计时，最终又改回 Cron（第二个账户配额充足）。

### 2. Cloudflare Origin 证书 API 权限不足

**问题：** 通过 API Token 创建 Origin 证书返回 error 1002 "Unsupported request_type"。

**解决：** 改为在 Cloudflare Dashboard 手动创建。通配符 `*.111298.xyz`，15 年有效期，所有 VPS 共用一张证书。

### 3. Cloudflare HTTPS 代理端口限制

**问题：** 橙色云代理只支持特定端口 (443, 2053, 2083, 2087, 2096, 8443)。最初用 9099 端口，Cloudflare 无法回源。

**解决：** 改用 2087 端口。需注意 VPS_SERVERS 环境变量中的端口要与 Python 监听端口一致。

### 4. 纯 IPv6 服务器兼容

**问题：** Python 脚本绑定 `0.0.0.0`（仅 IPv4），纯 IPv6 VPS 无法监听。

**解决：** 改为绑定 `::` + `IPV6_V6ONLY=0`（双栈），同时接受 IPv4 和 IPv6 连接。DNS 用 AAAA 记录。

### 5. Alpine Linux 无 systemd

**问题：** 目标 VPS 运行 Alpine Linux，没有 systemd，systemctl 命令不存在。

**解决：** 改用 OpenRC (`rc-service`) 创建 init 脚本，`rc-update add` 设开机自启。

### 6. OpenRC 环境变量传递失败

**问题：** OpenRC 的 `export SYNC_KEY="..."` 在 init 脚本中无法正确传递给 Python 子进程，导致 AUTH FAILED。

**解决：** 将 SYNC_KEY 写入 `/root/.sync_key` 文件，Python 脚本优先读环境变量，没有则读文件：
```python
AUTH_KEY = os.environ.get("SYNC_KEY") or (open("/root/.sync_key").read().strip() if os.path.exists("/root/.sync_key") else "PLACEHOLDER")
```

### 7. VPS 列表硬编码问题

**问题：** VPS 列表硬编码在 `worker.js` 中，每次加减服务器都要改代码重新部署。

**解决：** 改为环境变量 `VPS_SERVERS`，用 `|` 分割，Dashboard 直接编辑：
```
青蛙机:波兰:https://okblog897.111298.xyz:2087|vps2:日本:https://ssh-vps2.111298.xyz:2087
```
解析逻辑：`id:name:url` 用 `:` 分割，url 中的 `:` 拼回。

### 8. DNS 代理端口冲突

**问题：** 占位 IP 1.1.1.1 是 Cloudflare DNS 解析器 IP，不允许作为代理记录目标。

**解决：** 改用文档保留 IP 203.0.113.1 作为占位，部署后替换为真实 VPS IP。

### 9. Worker 自定义域名与 VPS 域名混淆

**问题：** 误将 `bot-ssh.111298.xyz` 绑定到 Worker 作为自定义域名，实际应作为 VPS 的 DNS 记录。

**解决：** 明确两个地址的职责：
- `bot-ssh.111298.xyz` → Worker（Telegram Webhook 入口）
- `okblog897.111298.xyz` 等 → VPS（Worker 回源地址）

---

## 文件清单

```
ssh-bot-control/
├── README.md                    # 本文档
├── worker.js                    # Cloudflare Worker（Telegram Bot 逻辑 + Cron）
├── ssh_webhook.py               # VPS 端 HTTPS 接收端（SSL + 速率限制 + IPv6 双栈）
├── key_manager_dynamic.sh       # VPS 端密钥管理脚本（安全修复版）
├── wrangler.toml                # Wrangler 部署配置
├── start_webhook.sh             # VPS 端启动包装脚本（设置 SYNC_KEY 环境变量）
└── deploy-guide.md              # 部署指南（快速上手）
```

---

## 后期维护

### 加/删 VPS 服务器

**不用改代码，不用重新部署 Worker。**

在 Cloudflare Dashboard → Workers & Pages → ssh-bot → Settings → Variables and Secrets → 编辑 `VPS_SERVERS`：

```
# 加一台
现有值|新id:新名称:https://新域名:2087

# 删一台
去掉对应的 |id:名称:url 段即可
```

保存即生效。新 VPS 上需部署：
1. 上传 `key_manager_dynamic.sh` + `ssh_webhook.py` + `start_webhook.sh`
2. 放置 Origin 证书 (`ssl_cert.pem` + `ssl_key.pem`)
3. 写入 SYNC_KEY 到 `/root/.sync_key`
4. 创建 OpenRC 服务并启动

### 更新 Worker 代码

```bash
cd /root/ssh-bot-deploy
# 编辑 worker.js
CLOUDFLARE_API_TOKEN=你的TOKEN npx wrangler deploy
```

### 更新 VPS 端脚本

通过跳板机 scp 上传新文件，然后重启服务：
```bash
rc-service ssh-webhook restart
```

### 证书续期

Origin 证书有效期 15 年，到期前在 Cloudflare Dashboard 重新生成即可。通配符证书所有 VPS 共用一张。

### Cron 自动回收

Worker Cron 每分钟执行，扫描 KV 中的 `active_sessions`，过期则向对应 VPS 发 remove 请求并清理 KV 记录。无需人工干预。

### 日志查看

**VPS 端：**
```bash
cat /var/log/ssh_webhook.log
```

**审计日志：** 存在 KV 的 `audit_logs` key 中，最近 20 条。通过 Telegram 发 `/status` 查看。

### 安全注意事项

- `SYNC_KEY` 是 Worker ↔ VPS 的鉴权密钥，切勿泄露
- `TG_SECRET_TOKEN` 是 Telegram Webhook 验证令牌，切勿泄露
- 动态生成的 Ed25519 私钥通过 Telegram 消息发送，请用私聊不要发到群里
- `key_manager_dynamic.sh` 必须以 root 运行（修改 authorized_keys 和 sshd_config）
- 建议定期检查 `authorized_keys` 确认无残留密钥

---

## 技术栈

- **Cloudflare Worker** — Serverless 边缘计算，Telegram Webhook 接收
- **Cloudflare KV** — 键值存储，会话状态 + 审计日志
- **Cloudflare Origin Certificate** — 源服务器 TLS 证书（15 年）
- **Telegram Bot API** — Inline Keyboard + Webhook
- **Python 3** — VPS 端 HTTPS 接收端（标准库，无第三方依赖）
- **Bash** — authorized_keys 操作脚本
- **OpenRC** — Alpine Linux 服务管理
- **Ed25519** — 动态临时密钥生成（WebCrypto API）
