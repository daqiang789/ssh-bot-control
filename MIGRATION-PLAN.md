# 自部署改造方案：Cloudflare Worker → Node.js 自托管

> 编写日期：2026-11-01
> 状态：方案设计完成，待实施

## 一、为什么要迁移

Cloudflare Workers 免费版限制太多，导致功能不完整：

| 问题 | 根因 | 影响 |
|------|------|------|
| 429 Too Many Requests | 免费版每 invocation 最多 50 subrequest，轮询 4 台 VPS 累加爆限 | 3/4 服务器显示离线 |
| WebSocket 不可用 | 长连接 = 单 invocation，subrequest 累加无上限 | 实时推送做不了，只能轮询 |
| 轮询间隔被迫 5 秒 | 2 秒就触发 429 | 体感不够实时 |
| KV 存储配额 | 免费版 KV 有读写限制 | 高频写入 audit log 可能受限 |
| Cron 最短 1 分钟 | Cloudflare Cron triggers 最小粒度 1 分钟 | 撤回延迟最高 1 分钟 |
| 无法调试 | Worker 运行在 Cloudflare 沙箱，没有 SSH/日志 | 排查问题只能靠 wrangler tail |

**自部署后以上问题全部消失。**

---

## 二、当前架构

```
Telegram Bot
    │
    ▼
Cloudflare Worker (worker.js, ~1240行)
    ├── Telegram webhook 处理（命令、回调、在线状态）
    ├── Web Dashboard（/web 页面，内联 HTML）
    ├── API 端点（/api/login, /api/servers, /api/metrics, /api/ssh/add, /api/ssh/remove）
    ├── Cron 自动撤回过期密钥（每分钟检查）
    └── KV 存储（session, active_sessions, audit_logs, pending_deletes, server_status）
            │
            ▼
    4 台 VPS 上的 Python webhook (ssh_webhook.py)
        ├── POST /exec — 添加/撤销 SSH 密钥
        └── GET /metrics — 返回系统指标 JSON
```

### 环境变量/Secrets 清单

| 变量名 | 用途 | 当前值来源 |
|--------|------|-----------|
| `BOT_TOKEN` | Telegram Bot API Token | Cloudflare Secret |
| `ALLOWED_CHAT_ID` | 允许的 Telegram Chat ID | Cloudflare Secret |
| `TG_SECRET_TOKEN` | Telegram webhook 验证 token | Cloudflare Secret |
| `WEB_PASSWORD` | Dashboard 登录密码 | Cloudflare Secret |
| `SYNC_KEY` | VPS webhook 鉴权密钥 | Cloudflare Secret |
| `FIXED_PUB_KEY` | 固定 SSH 公钥 | Cloudflare Secret |
| `VPS_SERVERS` | VPS 列表配置 | wrangler.toml [vars] |

### KV 存储的 Key

| Key | 内容 | 过期 |
|-----|------|------|
| `web_session_<uuid>` | Dashboard 登录 session | 24h TTL |
| `active_sessions` | 各 VPS 当前活跃密钥 JSON | 无 |
| `audit_logs` | 审计日志（最近 50 条） | 无 |
| `pending_deletes` | 待删除的 Telegram 消息 | 无 |
| `server_status` | 服务器在线状态历史 | 无 |
| `last_status_check` | 上次状态检查时间戳 | 无 |

---

## 三、目标架构

```
Telegram Bot
    │
    ▼
Node.js 服务 (server.js)
    ├── Express HTTP 服务（端口 3000）
    ├── WebSocket 服务（同端口 upgrade）
    ├── Telegram webhook 处理
    ├── Web Dashboard（静态 HTML 文件）
    ├── API 端点
    ├── node-cron 定时撤回（每 30 秒可设）
    └── SQLite 存储（better-sqlite3）
            │
            ▼
    4 台 VPS 上的 Python webhook (ssh_webhook.py) — 不变
```

### 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| HTTP 框架 | Express | 最简单，生态成熟 |
| WebSocket | ws | 轻量级，无依赖 |
| 存储 | better-sqlite3 | 同步 API，性能好，单文件 |
| 定时任务 | node-cron | 灵活设置间隔 |
| HTTPS | Caddy 反代 / Let's Encrypt | Caddy 自动 HTTPS，最省心 |
| 进程守护 | pm2 | 自动重启、日志管理 |
| HTTP 客户端 | node-fetch / undici | Worker 的 fetch 在 Node.js 用 undici 替代 |

### 目录结构

```
ssh-bot-server/
├── server.js          # 主服务（Express + WebSocket + cron）
├── routes/
│   ├── telegram.js    # Telegram webhook 处理
│   ├── api.js         # API 端点
│   └── dashboard.js   # 静态页面服务
├── lib/
│   ├── db.js          # SQLite 封装
│   ├── vps.js         # VPS 通信（fetch /exec, /metrics）
│   ├── ssh-key.js     # RSA 密钥生成（从 worker.js 移植）
│   └── telegram-api.js # Telegram API 封装
├── public/
│   └── index.html     # Dashboard 页面（从 worker.js DASHBOARD_HTML 提取）
├── data/
│   └── ssh-bot.db     # SQLite 数据库文件
├── .env               # 环境变量
├── ecosystem.config.js # pm2 配置
└── package.json
```

---

## 四、改造步骤

### Step 1: 提取 Dashboard HTML
- 从 worker.js 的 `DASHBOARD_HTML` 常量中提取 HTML
- 保存为 `public/index.html` 独立文件
- 修改 API 调用路径（相对路径不变）
- WebSocket 连接改为 `ws://localhost:3000/ws`（同源）

### Step 2: 实现 SQLite 存储
```sql
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  login_time INTEGER,
  ip TEXT,
  expires_at INTEGER
);

CREATE TABLE active_sessions (
  server_id TEXT,
  tag TEXT,
  key_type TEXT,
  pub_key TEXT,
  expire_at INTEGER,
  PRIMARY KEY (server_id, tag)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  action TEXT,
  detail TEXT
);

CREATE TABLE pending_deletes (
  message_id INTEGER PRIMARY KEY,
  created_at INTEGER
);

CREATE TABLE server_status (
  server_id TEXT,
  timestamp INTEGER,
  online INTEGER
);
```

### Step 3: 移植核心逻辑
从 worker.js 逐函数移植：

| Worker 函数 | Node.js 对应 | 注意点 |
|------------|-------------|--------|
| `scheduled()` | node-cron 任务 | 不再需要 self-call /cron-revoke 绕过 |
| `fetch()` 路由 | Express 路由 | path 匹配逻辑直接搬 |
| `parseServers()` | `lib/vps.js` | 不变 |
| `checkServerOnline()` | `lib/vps.js` | fetch 换 node-fetch |
| `logAudit()` | `lib/db.js` | KV put → SQLite insert |
| RSA 密钥生成 | `lib/ssh-key.js` | Web Crypto API → Node.js crypto |
| `DASHBOARD_HTML` | `public/index.html` | 提取为独立文件 |

### Step 4: WebSocket 实时推送
```javascript
// server.js
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // 验证 token
  // 每 2 秒推送指标（无 subrequest 限制）
  const timer = setInterval(async () => {
    const metrics = await fetchAllMetrics();
    ws.send(JSON.stringify(metrics));
  }, 2000);
  
  ws.on('close', () => clearInterval(timer));
});
```

### Step 5: Telegram Webhook
```javascript
// 设置 webhook 指向新服务器
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<NEW_DOMAIN>/<TG_SECRET_TOKEN>
```

### Step 6: HTTPS + 反代
```caddyfile
# Caddyfile — 自动 HTTPS
bot-ssh.example.com {
  reverse_proxy localhost:3000
}
```

### Step 7: 进程守护
```javascript
// ecosystem.config.js (pm2)
module.exports = {
  apps: [{
    name: 'ssh-bot',
    script: 'server.js',
    cwd: '/opt/ssh-bot-server',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
```

---

## 五、坑点与疑难杂症

### 1. Web Crypto API → Node.js crypto 不兼容

**问题**：Worker 用 `crypto.subtle`（Web Crypto API）生成 RSA 密钥对，Node.js 的 `crypto.subtle` 行为有差异，特别是：
- `crypto.subtle.generateKey()` 的 RSA 参数格式不同
- `crypto.subtle.exportKey()` 的输出格式可能不一致
- JWK → PKCS#1 DER 的手动编码逻辑依赖 Web Crypto 的具体输出

**解决**：改用 Node.js 原生 `crypto.generateKeyPairSync('rsa', ...)`，直接输出 PKCS#1 PEM，不需要 JWK 中间步骤。更简单更可靠。

```javascript
// Worker 方式（复杂）：Web Crypto → JWK → 手动编码 DER → PEM
// Node.js 方式（简单）：
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});
```

### 2. fetch API 差异

**问题**：Worker 的 `fetch()` 和 Node.js 的 `fetch()`（undici）有细微差异：
- `AbortSignal.timeout()` 在 Node.js 18+ 可用，低版本不行
- Response 的 `.json()` 方法行为一致，但错误处理不同
- Worker 的 fetch 自带 TLS 证书验证，Node.js 对自签名证书需要 `rejectUnauthorized: false`

**解决**：
```javascript
// Node.js 中对 VPS 的自签名 HTTPS 请求
const fetch = require('undici').fetch;
const agent = new undici.Agent({
  connect: { rejectUnauthorized: false }
});
await fetch(url, { dispatcher: agent });
```

### 3. KV 的 expirationTtl → SQLite 无自动过期

**问题**：Cloudflare KV 的 `put(key, value, { expirationTtl: 86400 })` 会自动过期删除。SQLite 没有这个功能。

**解决**：
- session 表加 `expires_at` 字段
- 查询时 `WHERE expires_at > strftime('%s','now')`
- 定时清理过期 session（cron 顺便做）

### 4. Telegram webhook URL 变更

**问题**：迁移后 Telegram webhook URL 变了，需要重新设置。如果新旧服务同时运行，会导致消息重复处理。

**解决**：
1. 先部署新服务，验证健康
2. 调用 `setWebhook` 指向新地址
3. 确认旧 Worker 不再收到消息
4. 最后删除 Worker（或保留作为备份）

```bash
# 设置新 webhook
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<NEW_DOMAIN>/<TG_SECRET_TOKEN>&secret_token=<TG_SECRET_TOKEN>"

# 验证
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### 5. Cloudflare DNS 代理 vs 直连

**问题**：当前 VPS 域名（`awsusssh.111298.xyz` 等）可能通过 Cloudflare DNS 代理（橙色云朵）。自部署后如果服务器也在这些域名后面，请求路径会变。

**解决**：
- 自部署服务器直接用 IP 访问 VPS，不走域名
- 或在 VPS_SERVERS 配置中改用 VPS 直连 IP

### 6. Cron 自动撤回的简化

**问题**：Worker 上 Cron handler 的 subrequest 行为和 fetch handler 不同（之前踩过的坑），需要 self-call `/cron-revoke` 绕过。

**解决**：Node.js 上没有这个问题。cron 回调直接调用 VPS，不需要 self-call 绕过。**删掉 `/cron-revoke` 路由**，删掉 self-call 逻辑。

### 7. 内存泄漏风险

**问题**：Worker 是无状态的，每次请求独立。Node.js 长期运行，WebSocket 连接、定时器、SQLite 连接都需要正确清理，否则内存泄漏。

**解决**：
- WebSocket close 时清理 setInterval
- SQLite 用 better-sqlite3（同步，无需连接池管理）
- pm2 设置 `max_memory_restart: '200M'` 兜底

### 8. 审计日志从 50 条 → 可扩展

**问题**：Worker 上 KV 存审计日志只保留最近 50 条（JSON 数组）。迁移后可以存全量。

**解决**：SQLite 表存全量，API 查询时加 `LIMIT 100`。可选加日志轮转清理（保留最近 1000 条）。

### 9. Dashboard HTML 提取

**问题**：当前 Dashboard HTML 是 worker.js 里的一个巨大字符串常量（~300 行），包含内联 CSS 和 JS。提取为独立文件时要注意：
- 模板字符串中的 `${}` 会被 Node.js 误解析
- 反斜杠转义在独立 HTML 文件中不需要

**解决**：直接把 DASHBOARD_HTML 的内容（去掉外层反引号）存为 `index.html`，Express 用 `res.sendFile()` 返回。不需要模板引擎。

### 10. 磁盘空间考虑

**问题**：青蛙机只有 2.9G 磁盘，Node.js + npm 依赖 + SQLite 可能占 100-200MB。

**解决**：
- 用 `npm install --production` 只装运行依赖
- SQLite 数据库文件很小（KB 级）
- 建议部署到 AWS 美国（18G）或 GCP 台湾（8.5G）

---

## 六、迁移检查清单

- [ ] 选择目标服务器，确认 Node.js 18+ 可装
- [ ] 创建项目目录结构
- [ ] 提取 Dashboard HTML 为独立文件
- [ ] 实现 SQLite 存储层（建表、CRUD 封装）
- [ ] 移植 VPS 通信逻辑（fetch /exec, /metrics）
- [ ] 移植 Telegram webhook 处理（命令、回调）
- [ ] 移植 API 端点（login, servers, metrics, ssh/add, ssh/remove）
- [ ] 移植 RSA 密钥生成（改用 Node.js crypto）
- [ ] 实现 WebSocket 实时推送
- [ ] 实现 cron 自动撤回（node-cron，30 秒间隔）
- [ ] 配置 .env 环境变量
- [ ] Caddy/nginx 反代 + HTTPS
- [ ] pm2 进程守护
- [ ] 设置 Telegram webhook 指向新地址
- [ ] 验证：Telegram 命令正常
- [ ] 验证：Dashboard 登录 + 服务器探针实时显示
- [ ] 验证：SSH 密钥下发 + 自动撤回
- [ ] 验证：WebSocket 实时推送（无 429）
- [ ] 关闭旧 Cloudflare Worker（保留代码做备份）

---

## 七、预估工作量

| 模块 | 预估时间 | 难度 |
|------|---------|------|
| 项目骨架 + SQLite | 1h | 低 |
| Dashboard HTML 提取 | 15min | 低 |
| API 端点移植 | 2h | 中 |
| Telegram webhook 移植 | 2h | 中 |
| RSA 密钥生成重写 | 1h | 中高 |
| WebSocket 实时推送 | 30min | 低 |
| Cron 自动撤回 | 30min | 低 |
| Caddy + pm2 部署 | 1h | 低 |
| 联调测试 | 2h | 中 |
| **合计** | **~10h** | |

---

## 八、VPS Python webhook 不需要改

`ssh_webhook.py` 完全兼容，不需要任何修改：
- `POST /exec`（action: add/remove）— 接口不变
- `GET /metrics` — 接口不变
- `X-Auth-Key` 鉴权 — 不变
- `SYNC_KEY` 从 `/root/.sync_key` 读取 — 不变

唯一建议：如果自部署服务器和 VPS 在同一内网，可以把 VPS_SERVERS 里的 URL 改成内网地址，减少延迟。
