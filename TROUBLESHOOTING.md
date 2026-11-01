# SSH Bot Control 故障排查记录

> 日期：2026-11-01  
> 分支：web-dashboard  
> 涉及组件：Cloudflare Worker (ssh-bot) + VPS Python Webhook (ssh_webhook.py)

---

## 一、故障现象

1. **审计日志时区错误**：显示美国时间，非北京时间
2. **日志保留数量不一致**：各处不同（30/100 等）
3. **Telegram Bot 完全无响应**：发消息没有回复
4. **Cron 自动撤回持续失败**：每分钟报错，4 台 VPS 全部失败（HTTP 404/405/502）

---

## 二、逐项排查与修复

### 2.1 审计日志时区 + 保留数量

**根因**：多处代码各自用不同方式格式化时间，保留条数硬编码不一致。

**修复**：
- 统一 `logAudit()` 函数，所有审计日志走同一个入口
- 时间统一用 `toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })`
- 保留条数统一 `> 50`（超过 50 条截断）

**教训**：审计日志必须单一入口，不要在每个调用点各自格式化。

---

### 2.2 Telegram Bot 无响应

**根因**：Worker fetch handler 的 dashboard 路由匹配条件过宽。

```javascript
// BUG：匹配所有 path === "/" 的请求，包括 Telegram POST webhook
if (path === "/" || path === "/web") {
  return new Response(DASHBOARD_HTML, ...);  // 返回 HTML，Telegram 收不到 JSON
}
```

Telegram 向 `https://bot-ssh.111298.xyz/` 发 POST 请求，被 dashboard 路由拦截，返回 HTML 页面，Telegram API 认为 webhook 无效，Bot 静默失效。

**修复**：加 method 判断：

```javascript
if ((path === "/" || path === "/web") && request.method === "GET") {
  return new Response(DASHBOARD_HTML, ...);
}
```

**教训**：路由匹配必须同时判断 path 和 method，`GET /` 和 `POST /` 是完全不同的请求。

---

### 2.3 Cron 自动撤回失败（核心问题）

这是本次排查耗时最长的问题，涉及多层误解。

#### 2.3.1 现象

Cron Trigger 每分钟执行 `scheduled handler`，检查过期 session，向 VPS 发 POST 请求撤回 SSH 密钥。4 台 VPS 全部失败：

| VPS | 错误码 | 响应来源 |
|-----|--------|---------|
| vps1 波兰青蛙机 | 405 / 404 | nginx 或未知服务 |
| vps2 aws美国光帆 | 405 / 404 | nginx |
| vps3 阿里云日本抢占 | 502 | Cloudflare 代理层 |
| vps4 GCP台湾抢占 | 404 | 不明 |

但**手动撤回**（从 Telegram 触发，走 fetch handler）对同样的 VPS、同样的 URL、同样的 POST + header —— **成功**。

#### 2.3.2 排查过程中的弯路

1. **怀疑路径问题**：Cron 用 `/`，下发密钥用 `/exec`。尝试把 Cron 改成 `/exec` → 仍然失败。
2. **怀疑部署没生效**：多次让用户手动部署，用户复制粘贴旧代码 → 反复确认才发现部署的代码没更新。
3. **加 debug 日志**：在 Cron 失败时把完整响应（status、headers、body）写入 KV `cron_debug_*` key → 发现 VPS 返回的响应不是 Python webhook 的格式（nginx 405/404），说明请求没到达 Python webhook。
4. **怀疑 SYNC_KEY 在 scheduled handler 里不可用**：debug 显示 `syncKey: string:sshbot_1` → 排除。
5. **怀疑 VPS 配置不一致**：不同 VPS 返回不同错误（405/404/502），但手动撤回到同样的 URL 成功 → 排除 VPS 侧问题。

#### 2.3.3 根因

**Cloudflare Worker 的 `scheduled handler`（Cron Trigger）发出的 subrequest，与 `fetch handler` 发出的 subrequest 行为不同。**

同样的 `fetch(url, { method: "POST", ... })` 调用：
- 从 **fetch handler** 发出 → 正常到达 VPS 的 Python webhook → 200 ✅
- 从 **scheduled handler** 发出 → 被 nginx/CF 代理层拦截 → 404/405/502 ❌

这是 Cloudflare 平台层面对两种 handler 上下文的 subrequest 处理机制差异导致的，不是代码 bug，不是 VPS 配置问题，也不是网络问题。

> ⚠️ **Cloudflare 官方文档未明确说明此差异**。社区中有类似反馈：scheduled handler 的 subrequest 在经过同 zone 的 CF 代理时，路由行为可能与 fetch handler 不一致。

#### 2.3.4 解决方案：Self-call Workaround

**思路**：不让 Cron 直接调 VPS，而是让 Cron 调 Worker 自己的 URL，由 fetch handler 执行实际 VPS 调用。

```
Cron (scheduled handler)
  → POST https://bot-ssh.111298.xyz/cron-revoke  [subrequest 1: scheduled → fetch]
  → fetch handler 收到请求，执行 VPS 调用
  → POST https://vps.xxx:2087/exec               [subrequest 2: fetch → VPS] ✅
  → 返回结果给 Cron
  → Cron 更新 KV
```

**代码变更**：

1. fetch handler 新增路由：

```javascript
if (path === "/cron-revoke" && request.method === "POST") {
  const authKey = request.headers.get("X-Auth-Key");
  if (authKey !== env.SYNC_KEY) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 403, headers: { "Content-Type": "application/json" }
    });
  }
  const { serverUrl, pubKey, tag } = await request.json();
  const res = await fetch(`${serverUrl}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
    body: JSON.stringify({ action: "remove", pub_key: pubKey, tag }),
    signal: AbortSignal.timeout(10000)
  });
  // 返回结果给 Cron
  return new Response(JSON.stringify({ success: res.ok, status: res.status, ... }), ...);
}
```

2. Cron scheduled handler 改为调自身 URL：

```javascript
// 旧代码（直接调 VPS，失败）
const res = await fetch(`${targetServer.url}/exec`, { ... });

// 新代码（通过 Worker 自身 URL，在 fetch handler 上下文执行）
const res = await fetch("https://bot-ssh.111298.xyz/cron-revoke", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
  body: JSON.stringify({ serverUrl: targetServer.url, pubKey: sess.pubKey, tag: sess.tag }),
  signal: AbortSignal.timeout(15000)
});
const result = await res.json();
if (result.success) { removeOk = true; }
```

**验证结果**：4 台 VPS 全部自动撤回成功 ✅

---

## 三、运维避坑清单

### 3.1 Cloudflare Worker 相关

| 坑 | 说明 | 规避方式 |
|----|------|---------|
| **scheduled handler subrequest 行为差异** | Cron Trigger 的 fetch 调用到同 zone 域名时，行为可能与 fetch handler 不同 | 用 self-call：Cron 调 Worker 自身 URL，由 fetch handler 代发 |
| **手动部署易出错** | 从 GitHub raw URL 复制代码到 CF Dashboard，容易复制到缓存版本 | 用 `wrangler deploy` 自动部署，或通过 CF API 部署 |
| **wrangler 部署保留 secret** | wrangler.toml 不列 secret_text binding 时，不会清除已有 secret | 确认 wrangler.toml 有 KV 和 plain_text，secret 会自动保留 |
| **路由匹配必须带 method** | `path === "/"` 会同时匹配 GET 和 POST | 永远写 `path === "/" && request.method === "GET"` |

### 3.2 排查方法论

1. **加 debug 日志写 KV**：当 subrequest 失败但看不到响应内容时，把 `res.status`、`res.headers`、`await res.text()` 写入 KV key，事后读取分析。
2. **对比成功/失败路径**：手动操作成功但自动失败时，对比两条路径的 handler 类型、URL、method、header、body，逐一排除。
3. **确认部署真的生效**：通过 CF API 下载已部署代码，或加一个版本标记（如 console.log 版本号），确认部署的代码是最新版。
4. **不要假设 VPS 配置一致**：不同 VPS 可能有不同的 nginx 配置、不同的服务版本，逐台确认。

### 3.3 本项目特殊注意

- **VPS 路径**：nginx 只把 `/exec` 代理到 Python webhook，`/` 由 nginx 直接处理（POST → 405）。所有 VPS 调用必须走 `/exec`。
- **Python webhook**：`ssh_webhook.py` 的 `do_POST` 不检查 path，所有 POST 路径处理逻辑相同，支持 `action: "add"` 和 `action: "remove"`。
- **KV 数据结构**：
  - `active_sessions`：JSON 对象，key 是 vpsId，value 含 `pubKey`、`tag`、`expireAt`、`createdAt`
  - `audit_logs`：JSON 数组，最多 50 条，新条目 unshift 到头部
  - `pending_deletes`：JSON 对象，待删除的 Telegram 消息

---

## 四、变更记录

| Commit | 内容 |
|--------|------|
| `07b9233` | 统一时区 Asia/Shanghai + 保留 50 条 |
| `885f7b1` | 修复路由：dashboard 只匹配 GET |
| `44c234e` | Cron self-call workaround：通过 /cron-revoke 路由绕过 scheduled handler 限制 |
| `3f69961` | 清理 debug 代码，最终版本 |

---

## 五、未解决问题（供后续跟进）

1. **vps1 上可能运行了旧版 webhook**：debug 数据显示 vps1 对 `/exec` 返回 `{"success": false, "error": "未知的 action: remove"}`，但 repo 中的 `ssh_webhook.py` 支持 remove。建议检查 vps1 上实际部署的 Python webhook 版本。
2. **vps3 偶发 502**：阿里云日本抢占实例通过 CF 代理时偶尔 502，可能是抢占式实例被回收导致源站不可达。Cron 的 self-call workaround 已能正确处理此情况（撤回失败会保留 session 下次重试）。
3. **scheduled handler subrequest 差异的官方解释**：建议向 Cloudflare 提交工单确认此行为是否为 by-design，是否有更正规的解决方案（如 `cf: { ... }` 选项）。
