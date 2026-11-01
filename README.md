# SSH Bot Control — Telegram 远程 SSH 密钥管理系统

## 项目介绍

通过 Telegram Bot 远程管理多台 VPS 的 SSH `authorized_keys`，实现临时密钥的下发与自动回收。无需 SSH 登录服务器，在手机上点几个按钮即可完成。

**适用场景：** 临时给同事/客户开通 SSH 访问，到期自动回收，避免密钥堆积带来的安全隐患。

> 📖 **文档导航**（新接手先读 → 细节按需查）
> - **`QUICKSTART.md`** — 15 分钟上手：心智模型 / 文件地图 / 危险区
> - **`README.md`** — 项目介绍、一键安装、加删机器（你正在看）
> - **`deploy-guide.md`** — 从零部署逐步手册
> - **`AUDIT-2026-10-31.md`** — 最近改动审计 + 待办清单
>
> ⚠️ 接手第一件事：先读 `AUDIT` 的 §5（现状）+ §7（待办），再动手。

---

### 核心功能

- 🔑 **固定密钥下发** — 一键将自己的公钥推到多台服务器，1h/2h 后自动回收
- 🎲 **动态密钥生成** — Worker 端实时生成 RSA 2048 密钥对，私钥发给你转发给对方
- 🛑 **手动撤销** — 随时撤销任意服务器上的临时密钥
- ⏰ **自动过期回收** — Cron 每分钟扫描，到期自动删除
- 📊 **状态面板** — 查看各服务器当前授权状态 + 审计日志
- 🖥️ **多服务器批量操作** — 勾选多台同时下发/撤销
- 📋 **聊天菜单按钮** — Telegram 输入框左下角「/」菜单，无需手动输入命令
- 📡 **一键在线检测** — `/status` 或点按钮，实时检测所有服务器 🟢在线/🔴离线
- 🔔 **每小时状态监控** — Cron 每小时自动 ping 所有服务器，上线/离线变化时主动发 Telegram 通知

---

## 快速开始

### VPS 端一键安装

在每台 VPS 上执行一行命令即可完成安装（`SYNC_KEY` 需与 Cloudflare Worker 中的保持一致）：

```bash
SYNC_KEY=你的SYNC_KEY curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
```

> 若不传 `SYNC_KEY`，脚本会随机生成一个，但需手动同步到 Cloudflare Worker，多台 VPS 不推荐。

脚本会自动完成：

1. 下载 `key_manager_dynamic.sh` + `ssh_webhook.py` + `start_webhook.sh`
2. 将 `SYNC_KEY` 写入 `/root/.sync_key`
3. 检测 SSL 证书是否就位（需提前放置 `ssl_cert.pem` + `ssl_key.pem`）
4. 自动识别 systemd / OpenRC，创建并启动系统服务
5. 验证 HTTPS 端口 2087 响应正常

> **前提：** 需 root 权限 + Python 3 + 已放置 Cloudflare Origin 证书

### Cloudflare Worker 部署

```bash
git clone https://github.com/daqiang789/ssh-bot-control.git
cd ssh-bot-control

# 1. 编辑 wrangler.toml，填入你的 account_id / KV id / 域名
# 2. 创建 KV 命名空间
npx wrangler kv namespace create SSH_KV

# 3. 部署 Worker（务必加 --keep-vars 保留 secrets）
CLOUDFLARE_API_TOKEN=你的TOKEN npx wrangler deploy --keep-vars

# 4. 设置 Secrets（Dashboard → Workers → ssh-bot → Settings → Variables and Secrets）
#    BOT_TOKEN       = Telegram Bot Token
#    SYNC_KEY        = 你自定义的鉴权密钥（与 VPS 端 install.sh 传入的 SYNC_KEY 一致）
#    FIXED_PUB_KEY   = 你的固定 SSH 公钥
#    TG_SECRET_TOKEN = Webhook 验证令牌
#    ALLOWED_CHAT_ID = 你的 Telegram Chat ID

# 5. 绑定 Telegram Webhook
curl "https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=https://bot-ssh.你的域名.com&secret_token=你的TG_SECRET_TOKEN"
```

> ⚠️ **重要：** `wrangler deploy` 必须加 `--keep-vars` 参数，否则会删除已有的 secret 环境变量！详见坑点 #13。

### 加/删 VPS 服务器

无需改代码，在 Dashboard 编辑 `VPS_SERVERS` 环境变量即可：
```
# 加一台
现有值|新id:新名称:https://新域名:2087

# 删一台
去掉对应的 |id:名称:url 段
```
新 VPS 上跑一遍 `install.sh` 即可接入。

---

## 架构

```
你手机 Telegram
    │  发送 /ssh 或点菜单按钮
    ▼
Telegram Bot API (Webhook)
    │
    ▼
Cloudflare Worker (bot-ssh.你的域名.com)
    │  ├── 接收 Telegram 消息，渲染 inline 按钮面板
    │  ├── 生成 RSA 2048 密钥对（动态模式）
    │  ├── KV 存储会话状态 + 审计日志 + 服务器状态
    │  ├── Cron 每分钟扫描过期会话 → 自动回收
    │  ├── Cron 每小时检测服务器在线状态 → 变化时通知
    │  └── /status 一键检测所有服务器在线/离线
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
| `worker.js` | Cloudflare Worker | Telegram Webhook + 按钮面板 + 密钥生成 + Cron 回收 + 在线检测 + 菜单按钮 |
| `ssh_webhook.py` | 每台 VPS | HTTPS 接收端，鉴权 + 速率限制 + 调用 bash |
| `key_manager_dynamic.sh` | 每台 VPS | 操作 authorized_keys，安全写入 + 格式校验 |
| Cloudflare KV | Cloudflare | 会话状态 + 审计日志 + 服务器状态 (server_status) |
| Origin 证书 | 每台 VPS | Cloudflare ↔ VPS 加密，通配符 `*.你的域名.com`，15 年 |

---

## 新功能详解（2026-11-01 更新）

### 1. 📋 聊天菜单按钮

**问题：** 每次都要手动输入 `/start` 或 `/ssh` 才能打开面板，不方便。

**实现：** 用户首次发 `/start` 时，Worker 自动调用两个 Telegram API：
- `setMyCommands` — 注册命令列表（`/start`、`/ssh`、`/status`），出现在输入框「/」菜单里
- `setChatMenuButton` — 设置聊天左下角菜单按钮类型为 `commands`，点开即显示命令列表

设置后，Telegram 输入框旁边出现「/」按钮，点开可直接选择命令，不用手打。

**注意：** 设置后可能需要**重启 Telegram 客户端**才能看到菜单按钮（Telegram 会缓存旧 UI）。

### 2. 📡 一键在线检测

**问题：** 不知道哪些服务器在线、哪些挂了，要逐个试才知道。

**实现：** 新增 `/status` 命令和「📡 在线检测」按钮：
- Worker 并发向所有 VPS 的 2087 端口发 GET 请求
- 8 秒内收到任何 HTTP 响应 → 🟢 在线
- 超时/连接拒绝/DNS 失败 → 🔴 离线
- 结果以消息形式展示在 Telegram 聊天中

**检测原理：** 不需要知道真实 IP，直接通过 `VPS_SERVERS` 中的域名检测。每台 VPS 上跑着 `ssh_webhook.py` 监听 2087 端口，只要服务存活并响应 HTTP，就算在线。同时验证了 DNS 正常 + 网络可达 + webhook 服务存活，三个条件都满足才算在线。

### 3. 🔔 每小时状态监控通知

**问题：** 服务器挂了不知道，等到要用时才发现。

**实现：** Worker Cron 每小时自动检测所有服务器在线状态：
- 状态存储在 KV 的 `server_status` key 中
- 对比上次检测结果，如果某台服务器 **在线→离线** 或 **离线→在线**，主动发 Telegram 消息通知
- 通知格式：`🔴 vps3 阿里云日本抢占 离线了` / `🟢 vps3 阿里云日本抢占 恢复在线`
- 状态未变化时不发消息（避免刷屏）

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
- 实现 RSA 2048 密钥对生成（WebCrypto API → PKCS#1 PEM → OpenSSH 格式）
- KV 存储会话状态 + 审计日志
- Cron 定时扫描过期会话自动回收

### 第四阶段：部署与调试

详见下方「坑点」章节。

### 第五阶段：多 VPS 调试与修复（2026-11-01）

部署到 4 台 VPS 后发现"bot 显示成功但密钥不生效"，逐层排查：

| 问题 | 根因 | 修复 |
|------|------|------|
| 密钥写入 `/.ssh/` 而非 `/root/.ssh/` | systemd 服务未设置 `HOME` 环境变量 | `Environment=HOME=/root` + 硬编码 `SSH_DIR="/root/.ssh"` |
| 多台 VPS 鉴权失败 | 每台 VPS 各自随机生成不同的 SYNC_KEY | install.sh 三优先级逻辑：环境变量 → 已有文件 → 随机生成 |
| vps3/vps4 超时离线 | Worker 5s 超时太短，往返 3-7s | 改为 10s 超时 |
| vps3/vps4 始终离线 | `VPS_SERVERS` 中缺少 `https://` 前缀 | 通过 Cloudflare API 修正绑定值 |

### 第六阶段：新功能开发（2026-11-01）

- 聊天菜单按钮（`setMyCommands` + `setChatMenuButton`）
- 一键在线检测（并发 GET 所有 VPS 2087 端口）
- 每小时状态监控通知（Cron + KV 状态对比 + 变化通知）

---

## 坑点（踩过的坑）

### 1. Cloudflare Worker Cron 数量限制

**问题：** 第一个 Cloudflare 账户的免费 Cron 配额已满（5/5），无法添加新的 Cron Trigger。

**解决：** 部署到第二个账户。后续改为 VPS 端 `threading.Timer` 本地倒计时，最终又改回 Cron（第二个账户配额充足）。

### 2. Cloudflare Origin 证书 API 权限不足

**问题：** 通过 API Token 创建 Origin 证书返回 error 1002 "Unsupported request_type"。

**解决：** 改为在 Cloudflare Dashboard 手动创建。通配符 `*.你的域名.com`，15 年有效期，所有 VPS 共用一张证书。

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

**解决：** 改为环境变量 `VPS_SERVERS`，用 `|` 分割，Dashboard 直接编辑。

### 8. DNS 代理端口冲突

**问题：** 占位 IP 1.1.1.1 是 Cloudflare DNS 解析器 IP，不允许作为代理记录目标。

**解决：** 改用文档保留 IP 203.0.113.1 作为占位，部署后替换为真实 VPS IP。

### 9. Worker 自定义域名与 VPS 域名混淆

**问题：** 误将 `bot-ssh.你的域名.com` 绑定到 Worker 作为自定义域名，实际应作为 VPS 的 DNS 记录。

**解决：** 明确两个地址的职责：
- `bot-ssh.你的域名.com` → Worker（Telegram Webhook 入口）
- `ssh-vps1.你的域名.com` 等 → VPS（Worker 回源地址）

### 10. start_webhook.sh 硬编码旧 SYNC_KEY 导致鉴权始终失败

**问题：** 早期调试时在 `start_webhook.sh` 中写了 `export SYNC_KEY="旧值"`，后来改用 `/root/.sync_key` 文件存储新密钥并重启服务，但 Python 代码 `os.environ.get("SYNC_KEY")` 优先读环境变量，导致始终用旧值鉴权。

**解决：** `start_webhook.sh` 只保留一行，不 export 任何变量：
```sh
#!/bin/sh
exec /usr/bin/python3 /root/ssh_webhook.py
```

**教训：** 当存在「环境变量优先，文件兜底」的读取逻辑时，修改文件值不会生效——必须同时清除环境变量中的旧值。

### 11. 动态密钥 Ed25519 在 Xshell 中无法导入

**问题：** Worker 生成 Ed25519 密钥对，私钥以 PKCS#8 PEM 格式发送。Xshell 7 以下版本不支持 Ed25519。

**解决：** 改为 RSA 2048。从 JWK 手动编码 PKCS#1 DER，输出 `-----BEGIN RSA PRIVATE KEY-----`（传统格式，Xshell 全版本支持）。

### 12. 撤销授权提示成功但密钥实际未删除

**问题：** 两个 bug 叠加：
1. **sed 分隔符冲突**：`sed -i "\:# TAG:${TAG}$:d"` 用 `:` 做分隔符，但模式串 `# TAG:xxx` 里也含 `:`，sed 报错什么都没删。
2. **撤销路径不检查 HTTP 状态**：`await fetch(...)` 后直接返回"撤销成功"，没检查 `res.ok`。

**解决：** sed 分隔符改回 `/`；撤销路径加 `if (res.ok)` 检查。

### 13. wrangler deploy 删除所有 secret 环境变量

**问题：** 用 `wrangler deploy` 部署新代码后，Worker 的所有 `secret_text` 绑定（BOT_TOKEN、SYNC_KEY、TG_SECRET_TOKEN、ALLOWED_CHAT_ID、FIXED_PUB_KEY）全部丢失，只剩 `wrangler.toml` 中定义的绑定。Worker 报 500 错误，所有按钮无响应。

**根因：** wrangler 默认行为是「删除所有不在 wrangler.toml 中的变量再部署」。secret_text 绑定不在 wrangler.toml 中，所以被删除。wrangler 文档中有一句 "secrets are never deleted by deployments"，但实际上新版本 wrangler 4.x 仍然会丢失 secrets。

**解决：** 两种方式：
- **方式一（推荐）：** `wrangler deploy --keep-vars` — 保留不在 wrangler.toml 中的变量和 secrets
- **方式二：** 部署后用 `wrangler secret put SECRET_NAME` 逐个重新设置

**教训：** 永远加 `--keep-vars`。如果不确定，先 `wrangler deploy --dry-run` 看会删什么。

### 14. Cloudflare API PATCH /settings 替换全部 bindings

**问题：** 用 Cloudflare API `PATCH /workers/scripts/{name}/settings` 更新 `VPS_SERVERS` 时，只在请求体中包含了 `VPS_SERVERS`，结果**所有其他绑定被清空**（BOT_TOKEN、SYNC_KEY 等全没了）。

**根因：** PATCH /settings 是**全量替换**，不是增量更新。请求体中没包含的绑定会被删除。但 `secret_text` 类型的绑定如果不在请求体中，会从当前已部署版本继承保留。

**解决：** PATCH 时必须包含所有 `plain_text` 和 `kv_namespace` 绑定（`secret_text` 可省略，会自动继承）。或者使用 `wrangler deploy --keep-vars` 代替 API 调用。

### 15. Cloudflare Worker versions API 不继承 bindings

**问题：** 通过 versions API 创建新版本并部署，新版本没有任何 bindings，Worker 报错。

**根因：** versions API 创建的新版本是空白的，不会从当前版本继承 bindings。必须单独设置 bindings。

**解决：** 不用 versions API 部署。改用 `wrangler deploy --keep-vars` 或 Dashboard Quick Edit。

### 16. systemd 服务未设置 HOME 导致密钥写入错误路径

**问题：** 密钥成功下发但无法 SSH 登录。检查发现密钥被写入了 `/.ssh/authorized_keys`（根目录下的 .ssh），而不是 `/root/.ssh/authorized_keys`。

**根因：** systemd 服务未设置 `HOME` 环境变量，bash 脚本中 `$HOME` 为空，`$HOME/.ssh` 变成 `/.ssh`。

**解决：**
1. systemd 服务文件加 `Environment=HOME=/root`
2. bash 脚本硬编码 `SSH_DIR="/root/.ssh"`，不依赖 `$HOME`

### 17. VPS_SERVERS 缺少 https:// 前缀导致服务器离线

**问题：** vps3 和 vps4 在 bot 中始终显示离线，但直接 curl 它们的域名能通。

**根因：** `VPS_SERVERS` 环境变量中 vps3/vps4 的 URL 缺少 `https://` 前缀，Worker 的 `fetch(url)` 把域名当作相对路径，请求失败。

**解决：** 修正 `VPS_SERVERS`，确保每个 URL 都以 `https://` 开头。

---

## 文件清单

```
ssh-bot-control/
├── README.md                    # 本文档（项目介绍 + 快速开始 + 架构 + 新功能 + 坑点记录）
├── install.sh                   # VPS 端一键安装脚本（自动检测 systemd/OpenRC）
├── worker.js                    # Cloudflare Worker（Bot 逻辑 + Cron + RSA 密钥生成 + 在线检测 + 菜单按钮）
├── ssh_webhook.py               # VPS 端 HTTPS 接收端（SSL + 速率限制 + IPv6 双栈）
├── key_manager_dynamic.sh       # VPS 端密钥管理脚本（安全修复版 + sed 分隔符修复）
├── wrangler.toml                # Wrangler 部署配置（含占位符，需替换为你的值）
├── start_webhook.sh             # VPS 端启动包装脚本
└── deploy-guide.md              # 详细部署指南
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

保存即生效。新 VPS 上跑一遍 `install.sh` 即可自动完成部署。

### 更新 Worker 代码

```bash
cd ssh-bot-control
# 编辑 worker.js
CLOUDFLARE_API_TOKEN=你的TOKEN npx wrangler deploy --keep-vars
```

> ⚠️ 务必加 `--keep-vars`，否则 secrets 会丢失！

### 更新 VPS 端脚本

重新运行 `install.sh` 即可更新到最新版本：
```bash
curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash
```

### 证书续期

Origin 证书有效期 15 年，到期前在 Cloudflare Dashboard 重新生成即可。

### Cron 自动回收

Worker Cron 每分钟执行，扫描 KV 中的 `active_sessions`，过期则向对应 VPS 发 remove 请求并清理 KV 记录。

### 服务器状态监控

Worker Cron 每小时检测所有服务器在线状态，存储在 KV 的 `server_status` 中。状态变化时自动发 Telegram 通知。也可随时发 `/status` 手动检测。

### 日志查看

**VPS 端：**
```bash
cat /var/log/ssh_webhook.log
```

**审计日志：** 存在 KV 的 `audit_logs` key 中，最近 20 条。

### 安全注意事项

- `SYNC_KEY` 是 Worker ↔ VPS 的鉴权密钥，切勿泄露
- `TG_SECRET_TOKEN` 是 Telegram Webhook 验证令牌，切勿泄露
- 动态生成的 RSA 2048 私钥通过 Telegram 消息发送，请用私聊不要发到群里
- `key_manager_dynamic.sh` 必须以 root 运行（修改 authorized_keys 和 sshd_config）
- 建议定期检查 `authorized_keys` 确认无残留密钥

---

## 技术栈

- **Cloudflare Worker** — Serverless 边缘计算，Telegram Webhook 接收
- **Cloudflare KV** — 键值存储，会话状态 + 审计日志 + 服务器状态
- **Cloudflare Origin Certificate** — 源服务器 TLS 证书（15 年）
- **Telegram Bot API** — Inline Keyboard + Webhook + Chat Menu Button + Callback Query
- **Python 3** — VPS 端 HTTPS 接收端（标准库，无第三方依赖）
- **Bash** — authorized_keys 操作脚本
- **OpenRC / systemd** — Linux 服务管理
- **RSA 2048** — 动态临时密钥生成（WebCrypto API + PKCS#1 PEM）

---

## 🌐 Web Dashboard — 服务器监控面板（探针）

> **分支：`web-dashboard`** | 访问地址：`https://bot-ssh.你的域名.com/web`

### 功能概览

| 功能 | 说明 |
|------|------|
| 📡 服务器探针 | 实时显示 CPU/内存/磁盘/Swap/负载/运行时间/网速/流量 |
| 🔑 SSH 密钥管理 | Web 界面下发固定/动态密钥、撤销密钥、查看活跃会话 |
| 📋 审计日志 | 记录所有密钥操作（下发/撤回）的时间和目标 |
| 🔐 密码登录 | 密码存 Worker 环境变量，POST body 传输不进 URL |
| 🔄 实时刷新 | 每 5 秒自动轮询，无需手动刷新 |

### 架构图

```
┌──────────────────────────────────────────────────┐
│  浏览器 (Web Dashboard)                          │
│  https://bot-ssh.你的域名.com/web                │
│                                                  │
│  ┌────────────┐    ┌────────────┐               │
│  │ 📡 服务器探针 │    │ 🔑 SSH 管理 │               │
│  │ CPU/内存/网速│    │ 下发/撤销   │               │
│  └────────────┘    └────────────┘               │
└──────────────────┬───────────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────────────┐
│  Cloudflare Worker (worker.js)                   │
│                                                  │
│  GET  /web          → 返回 HTML 页面              │
│  POST /api/login    → 密码验证，发 session token   │
│  GET  /api/metrics  → 并发调所有 VPS /metrics      │
│  POST /api/ssh/add  → 下发密钥到选中 VPS           │
│  POST /api/ssh/remove → 撤销密钥                  │
│  GET  /api/sessions → 活跃会话 + 审计日志          │
│                                                  │
│  KV 存储: session token (TTL 24h) + 活跃会话      │
└──────────────────┬───────────────────────────────┘
                   │ HTTPS + SYNC_KEY 鉴权
                   ▼
┌──────────────────────────────────────────────────┐
│  VPS (ssh_webhook.py 端口 2087)                  │
│                                                  │
│  POST /          → 密钥 add/remove (现有)         │
│  GET  /metrics   → 系统指标 JSON (新增)           │
│    CPU: /proc/stat 采样                           │
│    内存: /proc/meminfo                           │
│    磁盘: df / os.statvfs                         │
│    网络: /proc/net/dev 两次采样算网速              │
│    负载: /proc/loadavg                           │
│    开机: /proc/uptime                            │
│    系统: /etc/os-release + uname                 │
└──────────────────────────────────────────────────┘
```

### 新增环境变量

| 变量名 | 类型 | 说明 | 设置方式 |
|--------|------|------|----------|
| `WEB_PASSWORD` | secret_text | Web 面板登录密码 | `wrangler secret put WEB_PASSWORD` |

其他 7 个现有变量不变。

### 部署步骤

1. **VPS 端**：更新 `ssh_webhook.py`（新增 `/metrics` 端点），重启服务
   ```bash
   systemctl restart ssh-webhook
   ```

2. **Worker 端**：部署新 worker.js
   ```bash
   wrangler deploy
   wrangler secret put WEB_PASSWORD    # 设置 Web 登录密码
   ```

3. **访问**：打开 `https://bot-ssh.你的域名.com/web`，输入密码登录

### 安全设计

- **密码不进 URL**：登录用 POST body 传输 `{"password": "xxx"}`
- **Session token**：登录成功后生成 `crypto.randomUUID()`，存 KV 带 24 小时 TTL
- **后续请求鉴权**：`Authorization: Bearer <token>` 头，不存 cookie（避免 CSRF）
- **Token 存 localStorage**：刷新页面不用重新登录，退出时清除
- **`/metrics` 端点鉴权**：也需要 `X-Auth-Key: SYNC_KEY`，不暴露系统信息
- **CORS**：API 响应带 `Access-Control-Allow-Origin: *`，但需要 token 才能访问

### 页面截图说明

```
┌─────────────────────────────────────┐
│  🔒 登录页                          │
│  ┌──────────────┐                  │
│  │ 密码输入框    │ [登录]           │
│  └──────────────┘                  │
└─────────────────────────────────────┘
        │ 登录成功
        ▼
┌─────────────────────────────────────┐
│  📊 SSH Bot 监控面板 │ 🔑 SSH 管理  │  ← Tab 切换
├─────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐           │
│  │ 🟢 vps1 │ │ 🟢 vps2 │           │  ← 服务器卡片
│  │ CPU 23% │ │ CPU 45% │           │
│  │ RAM 50% │ │ RAM 70% │           │  ← 进度条
│  │ 磁盘 40%│ │ 磁盘 60%│           │
│  │ ↓45 KB/s│ │ ↓12 KB/s│           │  ← 实时网速
│  │ 3天5小时│ │ 1天2小时│           │  ← 运行时间
│  └─────────┘ └─────────┘           │
│  🔄 最后更新: 14:32:05 (每5秒刷新)  │
├─────────────────────────────────────┤
│  SSH 管理: [固定密钥] [动态密钥] [撤销]│
│  ☑ vps1  ☑ vps2  ☐ vps3            │
│  活跃会话列表 + 审计日志             │
└─────────────────────────────────────┘
```
