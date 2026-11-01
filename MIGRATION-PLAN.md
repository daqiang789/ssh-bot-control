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


---

## 九、Docker 部署方案（推荐）

Docker 部署比裸装更好：环境隔离、一键迁移、不污染宿主机。

### 9.1 Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 只装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --production

# 复制代码
COPY server.js ./
COPY routes/ ./routes/
COPY lib/ ./lib/
COPY public/ ./public/

# 数据目录（SQLite 挂卷持久化）
RUN mkdir -p /app/data

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
```

### 9.2 docker-compose.yml

```yaml
version: "3.8"

services:
  ssh-bot:
    build: .
    container_name: ssh-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data          # SQLite 持久化
      - ./logs:/app/logs          # 日志持久化
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PORT=3000
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:2-alpine
    container_name: ssh-bot-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - ssh-bot

volumes:
  caddy_data:
  caddy_config:
```

### 9.3 Caddyfile（自动 HTTPS）

```caddyfile
bot-ssh.111298.xyz {
    reverse_proxy ssh-bot:3000
}
```

### 9.4 .env 文件

```env
# Telegram
BOT_TOKEN=你的bot_token
ALLOWED_CHAT_ID=你的chat_id
TG_SECRET_TOKEN=你的webhook_secret

# Dashboard
WEB_PASSWORD=你的dashboard密码

# VPS 通信
SYNC_KEY=你的sync_key
FIXED_PUB_KEY=你的固定公钥

# VPS 列表
VPS_SERVERS=vps1:波兰青蛙机:https://okblog897.111298.xyz:2087|vps2:aws美国光帆:https://awsusssh.111298.xyz:2087|vps3:阿里云日本抢占:https://alijpsoptssh.111298.xyz:2087|vps4:GCP台湾抢占:https://gcptwssh.111298.xyz:2087
```

### 9.5 一键部署命令

```bash
# 1. 克隆代码
git clone https://github.com/daqiang789/ssh-bot-control.git
cd ssh-bot-control
git checkout web-dashboard

# 2. 配置环境变量
cp .env.example .env
vim .env  # 填入 secrets

# 3. 启动
docker compose up -d --build

# 4. 查看日志
docker compose logs -f ssh-bot

# 5. 设置 Telegram webhook 指向新地址
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://bot-ssh.111298.xyz/<TG_SECRET_TOKEN>&secret_token=<TG_SECRET_TOKEN>"
```

### 9.6 Docker 部署的优势

| 对比项 | 裸装 Node.js + pm2 | Docker |
|--------|-------------------|--------|
| 环境隔离 | ❌ 污染宿主机 | ✅ 容器隔离 |
| 迁移到新机器 | 手动装 Node.js + 依赖 | `docker compose up -d` 一行 |
| 版本管理 | 容易混乱 | 镜像版本可追溯 |
| 资源限制 | 靠系统限制 | `mem_limit: 200m` 精确控制 |
| 日志管理 | pm2 logs | `docker compose logs` |
| 健康检查 | 需要自己写 | Dockerfile HEALTHCHECK 内置 |
| Caddy HTTPS | 手动装 Caddy | docker-compose 一起拉起 |
| 回滚 | 手动 | `docker compose down` 即可回滚到 Worker |

### 9.7 Docker 部署的坑点

#### 坑1：better-sqlite3 是原生模块，需要匹配架构

**问题**：`better-sqlite3` 是 C++ 原生模块，预编译二进制只覆盖常见平台。如果宿主机是 ARM（如树莓派），可能需要编译。

**解决**：
- Dockerfile 用 `node:20-alpine`，alpine 用 musl libc，需要 `apk add python3 make g++` 编译
- 或者改用 `node:20-slim`（基于 Debian glibc），预编译二进制覆盖更全
- 推荐用 `node:20-slim`，省去编译麻烦

```dockerfile
# 改用 slim 避免原生模块编译问题
FROM node:20-slim
```

#### 坑2：SQLite 文件挂卷权限

**问题**：容器内 Node.js 进程默认以 node 用户运行（UID 1000），挂载的 `./data` 目录如果宿主机是 root 创建的，容器内可能没写入权限。

**解决**：
```bash
# 宿主机上给权限
mkdir -p data logs
chown 1000:1000 data logs
# 或者在 Dockerfile 里
RUN chown -R node:node /app/data
```

#### 坑3：Caddy 容器获取 Let's Encrypt 证书

**问题**：Caddy 在容器内需要能访问 80/443 端口完成 ACME 验证。如果宿主机 80/443 被占用，证书申请会失败。

**解决**：
- 确保宿主机 80/443 没被 nginx 等占用
- 或者用 DNS 验证方式（需要配置 DNS provider 插件）
- 或者先用 Cloudflare DNS 把域名 A 记录指向服务器 IP，Caddy 会自动处理

#### 坑4：WebSocket 经过 Caddy 反代

**问题**：Caddy 反代 WebSocket 需要正确配置 upgrade 头。

**解决**：Caddy v2 默认支持 WebSocket 反代，不需要额外配置。但确保 Caddyfile 里没有强制 HTTP/1.0。

```caddyfile
bot-ssh.111298.xyz {
    reverse_proxy ssh-bot:3000  # Caddy v2 自动处理 WebSocket upgrade
}
```

#### 坑5：容器时区

**问题**：Docker 容器默认 UTC 时区，cron 定时撤回的时间判断可能和预期不一致。

**解决**：
```yaml
environment:
  - TZ=Asia/Shanghai
```
或挂载时区文件：
```yaml
volumes:
  - /etc/localtime:/etc/localtime:ro
```

#### 坑6：容器重启后 WebSocket 客户端断连

**问题**：容器重启时所有 WebSocket 连接断开，前端需要自动重连。

**解决**：前端已有重连逻辑（之前 WebSocket 尝试时写的），保留即可：
```javascript
ws.onclose = () => {
  setTimeout(() => connectWs(), 3000);  // 3秒后重连
};
```

### 9.8 更新后的目录结构

```
ssh-bot-server/
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── server.js
├── routes/
│   ├── telegram.js
│   ├── api.js
│   └── dashboard.js
├── lib/
│   ├── db.js
│   ├── vps.js
│   ├── ssh-key.js
│   └── telegram-api.js
├── public/
│   └── index.html
├── data/              # SQLite 持久化（挂卷）
├── logs/              # 日志持久化（挂卷）
└── package.json
```

### 9.9 资源占用预估

| 组件 | 内存 | 磁盘 |
|------|------|------|
| Node.js + Express + WebSocket | ~50-80MB | - |
| better-sqlite3 | ~5MB | ~1MB（数据库文件） |
| Caddy | ~20-30MB | ~10MB（证书缓存） |
| Docker 镜像 | - | ~150MB（node:20-slim） |
| **合计** | **~100MB** | **~160MB** |

青蛙机 256MB 内存勉强够用，建议部署到 AWS 美国（1G 内存）或 GCP 台湾。
