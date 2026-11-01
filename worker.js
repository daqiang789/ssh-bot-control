// ============================================================
// worker.js — SSH Bot 安全修复版（Cron + HTTPS + RSA 2048）
// VPS 列表从环境变量 VPS_SERVERS 读取，格式：
// id:名称:url | id:名称:url | ...
// 例：vps1:香港:https://ssh-vps1.111298.xyz:2083|vps2:日本:https://ssh-vps2.111298.xyz:2083
// 在 Dashboard → Workers → ssh-bot → Settings → Variables and Secrets 里直接加删
// ============================================================

function parseServers(env) {
 const raw = env.VPS_SERVERS || "";
 if (!raw) return [];
 return raw.split("|").filter(s => s.trim()).map(entry => {
 const parts = entry.split(":");
 // url 里也有冒号（https://），所以前两段是 id 和 name，剩下的拼回 url
 const id = parts[0];
 const name = parts[1];
 const url = parts.slice(2).join(":");
 return { id: id.trim(), name: name.trim(), url: url.trim() };
 });
}

export default {
 // ===== Cron：每分钟扫描过期会话自动回收 + 每小时服务器状态检测 =====
 async scheduled(event, env, ctx) {
 const SERVERS = parseServers(env);
 const now = Date.now();

 // ===== 每小时服务器在线状态检测 + 上下线通知 =====
 await checkServerStatusHourly(env, SERVERS, now);

 // ===== 过期会话自动回收 =====
 const rawSessions = await env.SSH_KV.get("active_sessions");
 if (rawSessions) {
 let sessions = JSON.parse(rawSessions);
 let updated = false;
 let recoveredNames = [];
 let failedNames = [];

 for (const [srvId, sess] of Object.entries(sessions)) {
 if (sess.expireAt && now >= sess.expireAt) {
 const targetServer = SERVERS.find(s => s.id === srvId);
 if (targetServer) {
 // 尝试向 VPS 发送删除请求，检查实际结果
 let removeOk = false;
 let failReason = "";
 try {
        // 通过 Worker 自身 URL 触发撤回，让 VPS 调用在 fetch handler 上下文执行
        const res = await fetch("https://bot-ssh.111298.xyz/cron-revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
          body: JSON.stringify({ serverUrl: targetServer.url, pubKey: sess.pubKey, tag: sess.tag }),
          signal: AbortSignal.timeout(15000)
        });
        const result = await res.json();
        if (result.success) {
          removeOk = true;
        } else {
          failReason = `HTTP ${result.status || res.status}: ${result.error || result.body || ""}`;
        }
      } catch (e) {
        failReason = e.message || "连接超时";
      }

 if (removeOk) {
 // VPS 确认删除成功，从 KV 移除会话
 delete sessions[srvId];
 updated = true;
 recoveredNames.push(targetServer.name);
 await logAudit(env, "自动到期撤回", targetServer.name);
 } else {
 // VPS 不可达或删除失败，保留 KV 记录下次重试
 failedNames.push(`${targetServer.name} (${failReason})`);
 await logAudit(env, "自动撤回失败", `${targetServer.name}: ${failReason}`);
 }
 }
 }
 }

 if (updated) {
 await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
 }

 // 发送通知：区分成功和失败
 if (recoveredNames.length > 0 || failedNames.length > 0) {
 let msg = "";
 if (recoveredNames.length > 0) {
 msg += `⏰ 以下服务器临时密钥已到期，已自动回收：\n${recoveredNames.join(", ")}`;
 }
 if (failedNames.length > 0) {
 if (msg) msg += "\n\n";
 msg += `⚠️ 以下服务器密钥到期但撤回失败（VPS不可达），将下次重试：\n${failedNames.join(", ")}`;
 }
 await sendTGMessage(env, msg);
 }
 }

 // ===== 自动删除过期的私钥文件消息 =====
 const rawDeletes = await env.SSH_KV.get("pending_deletes");
 if (rawDeletes) {
 let deletes = JSON.parse(rawDeletes);
 let delUpdated = false;
 for (const [key, del] of Object.entries(deletes)) {
 if (now >= del.deleteAt) {
 await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ chat_id: del.chatId, message_id: del.messageId })
 }).catch(() => {});
 delete deletes[key];
 delUpdated = true;
 }
 }
 if (delUpdated) {
 await env.SSH_KV.put("pending_deletes", JSON.stringify(deletes));
 }
 }
 },

 // ===== Web Dashboard + API 入口 =====
 async fetch(request, env) {
 const url = new URL(request.url);
 const path = url.pathname;

 // --- Web Dashboard 页面 ---
 if ((path === "/web" || path === "/") && request.method === "GET") {
 return new Response(DASHBOARD_HTML, {
 headers: { "Content-Type": "text/html; charset=utf-8" }
 });
 }

  // --- Cron 触发撤回（绕过 scheduled handler subrequest 限制）---
  if (path === "/cron-revoke" && request.method === "POST") {
    const authKey = request.headers.get("X-Auth-Key");
    if (authKey !== env.SYNC_KEY) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 403, headers: { "Content-Type": "application/json" }
      });
    }
    const { serverUrl, pubKey, tag } = await request.json();
    try {
      const res = await fetch(`${serverUrl}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
        body: JSON.stringify({ action: "remove", pub_key: pubKey, tag }),
        signal: AbortSignal.timeout(10000)
      });
      const ok = res.ok;
      const body = await res.text().catch(() => "");
      return new Response(JSON.stringify({ success: ok, status: res.status, body: body.substring(0, 200) }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }

 // --- REST API 路由 ---
 if (path.startsWith("/api/")) {
 return handleAPI(request, env, path);
 }

 // --- CORS preflight ---
 if (request.method === "OPTIONS") {
 return new Response(null, {
 headers: {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
 "Access-Control-Allow-Headers": "Content-Type, Authorization"
 }
 });
 }

 // ===== Telegram Webhook 入口 =====
 if (request.method !== "POST") return new Response("OK");

 const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
 if (secret !== env.TG_SECRET_TOKEN) {
 return new Response("Forbidden", { status: 403 });
 }

 const SERVERS = parseServers(env);

 try {
 const update = await request.json();

 if (update.message) {
 const chatId = update.message.chat.id;
 if (chatId !== Number(env.ALLOWED_CHAT_ID)) return new Response("OK");

 const text = (update.message.text || "").trim();
 if (text === "/start" || text === "/ssh") {
 await setupBotMenu(env); // 注册菜单按钮和命令列表
 const defaultSelected = SERVERS.map(s => s.id);
 await renderDashboard(env, chatId, null, defaultSelected, SERVERS);
 } else if (text === "/status") {
 await renderQuickStatus(env, chatId, null, SERVERS);
 }
 }

 if (update.callback_query) {
 const callback = update.callback_query;
 const chatId = callback.message.chat.id;
 if (chatId !== Number(env.ALLOWED_CHAT_ID)) return new Response("OK");

 const data = callback.data || "";
 const messageId = callback.message.message_id;

 if (data.startsWith("toggle:")) {
 const parts = data.split(":");
 const toggleId = parts[1];
 let currentList = parts[2] ? parts[2].split(",") : [];

 if (toggleId === "ALL") {
 currentList = currentList.length === SERVERS.length ? [] : SERVERS.map(s => s.id);
 } else {
 currentList = currentList.includes(toggleId)
 ? currentList.filter(id => id !== toggleId)
 : [...currentList, toggleId];
 }
 await renderDashboard(env, chatId, messageId, currentList, SERVERS);

 } else if (data.startsWith("act:")) {
 const [, actionType, hours, srvIdsStr] = data.split(":");
 const targetIds = srvIdsStr ? srvIdsStr.split(",") : [];

 if (targetIds.length === 0) {
 await answerCallback(env, callback.id, "⚠️ 请至少勾选一台目标服务器！");
 return new Response("OK");
 }

 await answerCallback(env, callback.id, "正在下发任务，请稍候...");
 await executeAction(env, chatId, actionType, parseInt(hours || "1"), targetIds, SERVERS);
 await renderDashboard(env, chatId, messageId, targetIds, SERVERS);

 } else if (data === "quick_status") {
 await answerCallback(env, callback.id, "正在检测服务器状态...");
 await renderQuickStatus(env, chatId, messageId, SERVERS);

 } else if (data === "view_status") {
 await renderStatusPanel(env, chatId, messageId, SERVERS);

 } else if (data.startsWith("back_main:")) {
 const parts = data.split(":");
 const selected = parts[1] ? parts[1].split(",") : SERVERS.map(s => s.id);
 await renderDashboard(env, chatId, messageId, selected, SERVERS);

 } else if (data === "del_msg" || data === "del_key") {
 // 手动删除当前消息（统一"删除此消息"按钮；del_key 为私钥旧按钮，保留兼容）
 try {
 await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ chat_id: chatId, message_id: messageId })
 });
 } catch (e) {}
 await answerCallback(env, callback.id, "已删除 ✓");
 return new Response("OK");
 }

 await answerCallback(env, callback.id);
 }

 return new Response("OK");
 } catch (e) {
 return new Response("Internal Error", { status: 500 });
 }
 }
};

// ============================================================
// RSA 2048 密钥对生成 → OpenSSH 公钥 + PKCS#1 PEM 私钥
// （从 Ed25519 改为 RSA 2048，解决 Xshell 不支持 Ed25519 的问题）
// ============================================================
async function generateRSAKeyPair() {
 const keyPair = await crypto.subtle.generateKey({
 name: "RSASSA-PKCS1-v1_5",
 modulusLength: 2048,
 publicExponent: new Uint8Array([1, 0, 1]), // 65537
 hash: "SHA-256"
 }, true, ["sign", "verify"]);

 // JWK 导出 → 拿到 RSA 各分量
 const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
 const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

 // --- 公钥：拼 OpenSSH ssh-rsa wire 格式 ---
 const eBytes = toMpint(base64urlToBytes(pubJwk.e));
 const nBytes = toMpint(base64urlToBytes(pubJwk.n));

 const wire = new Uint8Array(4 + 7 + 4 + eBytes.length + 4 + nBytes.length);
 const dv = new DataView(wire.buffer);
 let off = 0;
 dv.setUint32(off, 7); off += 4;
 wire.set(new TextEncoder().encode("ssh-rsa"), off); off += 7;
 dv.setUint32(off, eBytes.length); off += 4;
 wire.set(eBytes, off); off += eBytes.length;
 dv.setUint32(off, nBytes.length); off += 4;
 wire.set(nBytes, off);

 const pubKeyB64 = base64Encode(wire);
 const opensshPubKey = `ssh-rsa ${pubKeyB64} temp-${Date.now()}`;

 // --- 私钥：从 JWK 手动编码 PKCS#1 DER → PEM ---
 // WebCrypto 不支持 exportKey("pkcs1")，所以手动编码
 const der = derSequence(
 derInteger(new Uint8Array([0])), // version = 0
 derInteger(base64urlToBytes(privJwk.n)), // modulus
 derInteger(base64urlToBytes(privJwk.e)), // publicExponent
 derInteger(base64urlToBytes(privJwk.d)), // privateExponent
 derInteger(base64urlToBytes(privJwk.p)), // prime1
 derInteger(base64urlToBytes(privJwk.q)), // prime2
 derInteger(base64urlToBytes(privJwk.dp)),// exponent1
 derInteger(base64urlToBytes(privJwk.dq)),// exponent2
 derInteger(base64urlToBytes(privJwk.qi)) // coefficient
 );

 const privKeyB64 = base64Encode(der);
 const privKeyPem = formatPem(privKeyB64, "RSA PRIVATE KEY");

 return { publicKey: opensshPubKey, privateKey: privKeyPem };
}

// --- base64url → Uint8Array ---
function base64urlToBytes(b64url) {
 const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
 const binary = atob(b64);
 const bytes = new Uint8Array(binary.length);
 for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
 return bytes;
}

// --- OpenSSH mpint 编码：正整数最高位为 1 时前补 0x00 ---
function toMpint(bytes) {
 if (bytes[0] & 0x80) return new Uint8Array([0, ...bytes]);
 return bytes;
}

// --- DER 编码辅助 ---
function derLen(len) {
 if (len < 0x80) return [len];
 if (len < 0x100) return [0x81, len];
 return [0x82, (len >> 8) & 0xff, len & 0xff];
}

function derInteger(bytes) {
 // 高位为 1 时前补 0（保持正整数）
 if (bytes[0] & 0x80) bytes = new Uint8Array([0, ...bytes]);
 const len = derLen(bytes.length);
 return new Uint8Array([0x02, ...len, ...bytes]);
}

function derSequence(...items) {
 let total = new Uint8Array(0);
 for (const item of items) {
 const merged = new Uint8Array(total.length + item.length);
 merged.set(total);
 merged.set(item, total.length);
 total = merged;
 }
 const len = derLen(total.length);
 return new Uint8Array([0x30, ...len, ...total]);
}


function base64Encode(bytes) {
 let binary = "";
 for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
 return btoa(binary);
}

function formatPem(b64, type) {
 const lines = b64.match(/.{1,64}/g) || [];
 return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

// ============================================================
// Bot 菜单设置 — 注册命令列表 + 聊天底部菜单按钮
// ============================================================
async function setupBotMenu(env) {
 try {
 await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({
 commands: [
 { command: "start", description: "打开 SSH 管理面板" },
 { command: "ssh", description: "打开 SSH 管理面板" },
 { command: "status", description: "检测服务器在线状态" }
 ]
 })
 });
 await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setChatMenuButton`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({
 chat_id: Number(env.ALLOWED_CHAT_ID),
 menu_button: { type: "commands" }
 })
 });
 await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setChatMenuButton`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({
 menu_button: { type: "commands" }
 })
 });
 } catch (e) {}
}

// ============================================================
// 服务器在线检测
// ============================================================
async function checkServerOnline(url) {
 try {
 const res = await fetch(url, {
 method: "GET",
 signal: AbortSignal.timeout(8000)
 });
 return true; // 收到任何 HTTP 响应都算在线
 } catch (e) {
 return false; // 超时、连接拒绝、DNS 失败等 = 离线
 }
}

// ============================================================
// 快速状态检测面板（实时 ping 所有服务器）
// ============================================================
async function renderQuickStatus(env, chatId, messageId, SERVERS) {
 const results = await Promise.all(SERVERS.map(async srv => {
 const online = await checkServerOnline(srv.url);
 return { ...srv, online };
 }));

 let text = `📡 服务器在线状态检测\n\n`;
 results.forEach(r => {
 text += `${r.online ? "🟢" : "🔴"} ${r.name}\n`;
 text += `   └ ${r.online ? "在线" : "离线"}\n`;
 });

 const onlineCount = results.filter(r => r.online).length;
 const totalCount = results.length;
 text += `\n📊 总计: ${onlineCount}/${totalCount} 在线`;

 const keyboard = [
 [{ text: "🔄 重新检测", callback_data: "quick_status" }],
 [{ text: "📊 详细状态&记录", callback_data: "view_status" }],
 [{ text: "⬅️ 返回管理面板", callback_data: `back_main:${SERVERS.map(s => s.id).join(",")}` }]
 ];

 if (messageId) {
 await updateTGMessage(env, chatId, messageId, text, keyboard);
 } else {
 await sendTGMessage(env, text, keyboard);
 }
}

// ============================================================
// 每小时服务器状态检测 + 上下线通知（Cron 调用）
// ============================================================
async function checkServerStatusHourly(env, SERVERS, now) {
 // 距上次检测不足 1 小时则跳过
 const lastCheck = parseInt((await env.SSH_KV.get("last_status_check")) || "0");
 if (now - lastCheck < 3600000) return;

 // 并行检测所有服务器
 const results = await Promise.all(SERVERS.map(async srv => {
 const online = await checkServerOnline(srv.url);
 return { id: srv.id, name: srv.name, online };
 }));

 // 读取上次状态
 const prevStatusRaw = (await env.SSH_KV.get("server_status")) || "{}";
 const prevStatus = JSON.parse(prevStatusRaw);

 // 比较状态变化
 let changes = [];
 const newStatus = {};
 for (const r of results) {
 newStatus[r.id] = r.online;
 const wasOnline = prevStatus[r.id];
 if (wasOnline !== undefined && wasOnline !== r.online) {
 changes.push({ name: r.name, online: r.online });
 }
 }

 // 有变化则发通知
 if (changes.length > 0) {
 let msg = `📢 服务器状态变更通知\n\n`;
 changes.forEach(c => {
 msg += `${c.online ? "🟢" : "🔴"} ${c.name}: ${c.online ? "已上线 ✅" : "已离线 ❌"}\n`;
 });
 await sendTGMessage(env, msg);
 await logAudit(env, "状态变更通知", changes.map(c => `${c.name}:${c.online ? "上线" : "离线"}`).join(", "));
 }

 // 更新存储的状态和检测时间
 await env.SSH_KV.put("server_status", JSON.stringify(newStatus));
 await env.SSH_KV.put("last_status_check", String(now));
}

// ============================================================
// 渲染控制面板
// ============================================================
async function renderDashboard(env, chatId, messageId, selectedIds, SERVERS) {
 const isAll = selectedIds.length === SERVERS.length;
 const selStr = selectedIds.join(",");

 let text = `🛠 SSH 临时权限控制面板\n\n`;
 text += `🎯 已勾选目标 (${selectedIds.length}/${SERVERS.length})：\n`;
 if (selectedIds.length === 0) {
 text += `未勾选任何机器，请点击下方进行选择\n`;
 } else {
 selectedIds.forEach(id => {
 const s = SERVERS.find(item => item.id === id);
 text += ` • ${s ? s.name : id}\n`;
 });
 }
 text += `\n勾选完成后，点击下方操作按钮执行：`;

 const keyboard = [];
 keyboard.push([{ text: isAll ? "☑️ 取消全选" : "🔲 一键全选", callback_data: `toggle:ALL:${selStr}` }]);
 SERVERS.forEach(srv => {
 const checked = selectedIds.includes(srv.id);
 keyboard.push([{ text: `${checked ? "✅" : "⬜"} ${srv.name}`, callback_data: `toggle:${srv.id}:${selStr}` }]);
 });
 keyboard.push([
 { text: "🔑 下发固定 (1h)", callback_data: `act:fixed:1:${selStr}` },
 { text: "🔑 下发固定 (2h)", callback_data: `act:fixed:2:${selStr}` }
 ]);
 keyboard.push([
 { text: "🎲 动态密钥 (1h)", callback_data: `act:dynamic:1:${selStr}` },
 { text: "🛑 撤销选中机器", callback_data: `act:revoke:0:${selStr}` }
 ]);
 keyboard.push([
 { text: "📡 在线检测", callback_data: "quick_status" },
 { text: "📊 状态&记录", callback_data: "view_status" }
 ]);

 if (messageId) {
 await updateTGMessage(env, chatId, messageId, text, keyboard);
 } else {
 await sendTGMessage(env, text, keyboard);
 }
}

// ============================================================
// 下发逻辑
// ============================================================
async function executeAction(env, chatId, actionType, hours, targetIds, SERVERS) {
 const targetServers = SERVERS.filter(s => targetIds.includes(s.id));
 const tag = `temp_${Date.now()}`;
 const expireTime = Date.now() + hours * 3600 * 1000;

 let rawSessions = (await env.SSH_KV.get("active_sessions")) || "{}";
 let sessions = JSON.parse(rawSessions);

 if (actionType === "revoke") {
 const results = await Promise.all(targetServers.map(async srv => {
 const current = sessions[srv.id];
 const pubKey = current ? current.pubKey : env.FIXED_PUB_KEY;
 const t = current ? current.tag : "temp";
 try {
 const res = await fetch(`${srv.url}/exec`, {
 method: "POST",
 headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
 body: JSON.stringify({ action: "remove", pub_key: pubKey, tag: t }),
 signal: AbortSignal.timeout(10000)
 });
 if (res.ok) {
 delete sessions[srv.id];
 return `✅ ${srv.name}: 撤销成功`;
 }
 return `❌ ${srv.name}: 撤销失败 (HTTP ${res.status})`;
 } catch (e) {
 return `⚠️ ${srv.name}: 离线/失败`;
 }
 }));
 await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
 await logAudit(env, "手动撤回", targetServers.map(s => s.name).join(", "));
 await sendTGMessage(env, `🛑 【批量撤销报告】\n\n${results.join("\n")}`);
 return;
 }

 let finalPubKey = env.FIXED_PUB_KEY;
 let finalPrivKey = null;
 let keyTypeName = "固定预设公钥";

 if (actionType === "dynamic") {
 keyTypeName = "动态临时公钥 (RSA 2048)";
 const keyPair = await generateRSAKeyPair();
 finalPubKey = keyPair.publicKey;
 finalPrivKey = keyPair.privateKey;
 }

 const results = await Promise.all(targetServers.map(async srv => {
 try {
 const res = await fetch(`${srv.url}/exec`, {
 method: "POST",
 headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
 body: JSON.stringify({ action: "add", pub_key: finalPubKey, tag: tag }),
 signal: AbortSignal.timeout(10000)
 });
 if (res.ok) {
 sessions[srv.id] = { tag, type: keyTypeName, pubKey: finalPubKey, expireAt: expireTime };
 return `✅ ${srv.name}: 成功`;
 }
 return `❌ ${srv.name}: 执行失败`;
 } catch (e) {
 return `⚠️ ${srv.name}: 离线`;
 }
 }));

 await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
 await logAudit(env, `下发密钥 (${keyTypeName})`, targetServers.map(s => s.name).join(", "));

 const expireStr = new Date(expireTime).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
 let report = `🚀 【批量下发完成】\n`;
 report += `• 类型: ${keyTypeName}\n`;
 report += `• 有效期至: ${expireStr} (${hours}小时后自动作废)\n\n`;
 report += `执行结果：\n${results.join("\n")}`;
 await sendTGMessage(env, report);

 if (finalPrivKey) {
 // 以文件附件发送私钥（聊天里只显示一行文件名），附带删除按钮，5分钟后自动删除
 const fileName = `temp_key_${tag}.pem`;
 const res = await sendTGDocument(env, finalPrivKey, fileName, "🔑 临时私钥 · 5分钟后自动删除");
 const resData = await res.json();
 if (resData.ok) {
 // 存入 KV，Cron 到期自动删除该消息
 let deletes = JSON.parse((await env.SSH_KV.get("pending_deletes")) || "{}");
 deletes[`msg_${resData.result.message_id}`] = {
 chatId: Number(env.ALLOWED_CHAT_ID),
 messageId: resData.result.message_id,
 deleteAt: Date.now() + 5 * 60 * 1000
 };
 await env.SSH_KV.put("pending_deletes", JSON.stringify(deletes));
 }
 }
}

// ============================================================
// 状态面板（详细：密钥状态 + 审计记录）
// ============================================================
async function renderStatusPanel(env, chatId, messageId, SERVERS) {
 const rawSessions = (await env.SSH_KV.get("active_sessions")) || "{}";
 const sessions = JSON.parse(rawSessions);
 const rawLogs = (await env.SSH_KV.get("audit_logs")) || "[]";
 const logs = JSON.parse(rawLogs);

 let text = `📊 各服务器当前授权状态：\n\n`;
 SERVERS.forEach(srv => {
 const sess = sessions[srv.id];
 if (sess) {
 const leftMin = Math.max(0, Math.round((sess.expireAt - Date.now()) / 60000));
 const expTime = new Date(sess.expireAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
 text += `🟢 ${srv.name}\n └ 模式: ${sess.type} | 剩 ${leftMin}m (${expTime}失效)\n`;
 } else {
 text += `🔴 ${srv.name}: 无临时密钥生效\n`;
 }
 });

 text += `\n📋 最近审计记录：\n`;
 if (logs.length === 0) {
 text += `暂无记录\n`;
 } else {
 logs.slice(0, 5).forEach(l => { text += `• [${l.time}] ${l.event}: ${l.target}\n`; });
 }

 const keyboard = [
 [{ text: "📡 在线检测", callback_data: "quick_status" }],
 [{ text: "⬅️ 返回管理面板", callback_data: `back_main:${SERVERS.map(s => s.id).join(",")}` }]
 ];
 if (messageId) { await updateTGMessage(env, chatId, messageId, text, keyboard); }
 else { await sendTGMessage(env, text, keyboard); }
}

// ============================================================
// 日志
// ============================================================
async function logAudit(env, event, target) {
 let logs = JSON.parse((await env.SSH_KV.get("audit_logs")) || "[]");
 logs.unshift({ time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }), event, target });
 if (logs.length > 50) logs.pop();
 await env.SSH_KV.put("audit_logs", JSON.stringify(logs));
}

// ============================================================
// Telegram API
// ============================================================
// 统一为每条消息追加"删除此消息"按钮（与私钥文件消息一致）
const DEL_BTN_ROW = [{ text: "🗑 删除此消息", callback_data: "del_msg" }];
function withDeleteButton(keyboard) {
 const rows = Array.isArray(keyboard) ? keyboard.slice() : [];
 const hasDel = rows.some(
 r => Array.isArray(r) && r.some(b => b && (b.callback_data === "del_msg" || b.callback_data === "del_key"))
 );
 if (!hasDel) rows.push(DEL_BTN_ROW);
 return rows;
}

async function sendTGMessage(env, text, keyboard = null) {
 const kb = withDeleteButton(keyboard);
 const body = { chat_id: Number(env.ALLOWED_CHAT_ID), text, parse_mode: "HTML" };
 body.reply_markup = { inline_keyboard: kb };
 return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
 method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
 });
}

async function sendTGDocument(env, content, fileName, caption, keyboard = null) {
 const formData = new FormData();
 formData.append("chat_id", String(env.ALLOWED_CHAT_ID));
 if (caption) formData.append("caption", caption);
 const blob = new Blob([content], { type: "text/plain" });
 formData.append("document", blob, fileName);
 formData.append("reply_markup", JSON.stringify({ inline_keyboard: withDeleteButton(keyboard) }));
 return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
 method: "POST",
 body: formData
 });
}

async function updateTGMessage(env, chatId, messageId, text, keyboard = null) {
 const kb = withDeleteButton(keyboard);
 const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
 body.reply_markup = { inline_keyboard: kb };
 return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
 method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
 });
}

async function answerCallback(env, id, text = null) {
 const body = { callback_query_id: id };
 if (text) body.text = text;
 return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
 method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
 });
}

// ============================================================
// Web API 处理 — 登录 / 指标代理 / SSH 管理
// ============================================================
async function handleAPI(request, env, path) {
  const SERVERS = parseServers(env);

  try {
    // POST /api/login — 密码登录
    if (path === "/api/login" && request.method === "POST") {
      const body = await request.json();
      const password = body.password || "";
      if (password !== env.WEB_PASSWORD) {
        return jsonResp(401, { error: "密码错误" });
      }
      const token = crypto.randomUUID();
      await env.SSH_KV.put("web_session_" + token, JSON.stringify({
        loginTime: Date.now(),
        ip: request.headers.get("CF-Connecting-IP") || "unknown"
      }), { expirationTtl: 86400 });
      return jsonResp(200, { token, expiresIn: 86400 });
    }

    // 其他 API 需要 session 验证
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return jsonResp(401, { error: "未登录" });
    const session = await env.SSH_KV.get("web_session_" + token);
    if (!session) return jsonResp(401, { error: "会话过期，请重新登录" });

    // GET /api/servers — 服务器列表 + 在线状态
    if (path === "/api/servers" && request.method === "GET") {
      const results = await Promise.all(SERVERS.map(async srv => {
        const online = await checkServerOnline(srv.url);
        return { id: srv.id, name: srv.name, online };
      }));
      return jsonResp(200, { servers: results });
    }

    // GET /api/metrics — 所有服务器实时指标
    if (path === "/api/metrics" && request.method === "GET") {
      const results = await Promise.all(SERVERS.map(async srv => {
        try {
          const res = await fetch(srv.url + "/metrics", {
            headers: { "X-Auth-Key": env.SYNC_KEY },
            signal: AbortSignal.timeout(8000)
          });
          if (res.ok) {
            const metrics = await res.json();
            return { id: srv.id, name: srv.name, online: true, metrics };
          } else {
            return { id: srv.id, name: srv.name, online: false, error: "HTTP " + res.status };
          }
        } catch (e) {
          return { id: srv.id, name: srv.name, online: false, error: e.message || "timeout" };
        }
      }));
      return jsonResp(200, { servers: results, timestamp: Date.now() });
    }

    // GET /api/sessions — 活跃 SSH 会话
    if (path === "/api/sessions" && request.method === "GET") {
      const raw = await env.SSH_KV.get("active_sessions");
      const sessions = raw ? JSON.parse(raw) : {};
      const auditRaw = await env.SSH_KV.get("audit_logs");
      const audits = auditRaw ? JSON.parse(auditRaw) : [];
      return jsonResp(200, { sessions, audits: audits.slice(0, 20) });
    }

    // POST /api/ssh/add — 下发密钥
    if (path === "/api/ssh/add" && request.method === "POST") {
      const body = await request.json();
      const { serverIds, keyType, duration } = body;
      const selected = SERVERS.filter(s => serverIds.includes(s.id));
      if (!selected.length) return jsonResp(400, { error: "未选择服务器" });

      let actualPubKey = "";
      let keyDesc = "";
      if (keyType === "fixed") {
        actualPubKey = env.FIXED_PUB_KEY;
        keyDesc = "固定预设公钥";
      } else if (keyType === "dynamic") {
        const { pub, priv } = await generateRSAKeyPair();
        actualPubKey = pub;
        keyDesc = "动态临时公钥 (RSA 2048)";
        const privKey = "privkey_" + Date.now();
        await env.SSH_KV.put(privKey, priv, { expirationTtl: 86400 });
      }

      const tag = keyType === "fixed" ? "fixed_" + Date.now() : "temp_" + Date.now();
      const results = await Promise.all(selected.map(async srv => {
        try {
          const res = await fetch(`${srv.url}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
            body: JSON.stringify({ action: "add", pub_key: actualPubKey, tag }),
            signal: AbortSignal.timeout(10000)
          });
          return { id: srv.id, name: srv.name, success: res.ok };
        } catch (e) {
          return { id: srv.id, name: srv.name, success: false, error: e.message };
        }
      }));

      const durationSeconds = body.durationSeconds;
      const expireAt = durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : 0;
      const raw = await env.SSH_KV.get("active_sessions");
      const sessions = raw ? JSON.parse(raw) : {};
      for (const srv of selected) {
        sessions[srv.id] = { tag, type: keyDesc, pubKey: actualPubKey, expireAt };
      }
      await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
      if (expireAt > 0) {
        const pendingRaw = await env.SSH_KV.get("pending_deletes");
        const pending = pendingRaw ? JSON.parse(pendingRaw) : {};
        pending[tag] = { servers: selected.map(s => s.id), expireAt };
        await env.SSH_KV.put("pending_deletes", JSON.stringify(pending));
      }
      await logAudit(env, "下发密钥 (" + keyDesc + ")", selected.map(s => s.name).join(", "));

      return jsonResp(200, { results, tag, pubKey: keyType === "dynamic" ? actualPubKey : null });
    }

    // POST /api/ssh/remove — 撤销密钥
    if (path === "/api/ssh/remove" && request.method === "POST") {
      const body = await request.json();
      const { serverIds, tag } = body;
      const selected = SERVERS.filter(s => serverIds.includes(s.id));
      if (!selected.length) return jsonResp(400, { error: "未选择服务器" });

      const results = await Promise.all(selected.map(async srv => {
        try {
          const res = await fetch(`${srv.url}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
            body: JSON.stringify({ action: "remove", tag }),
            signal: AbortSignal.timeout(10000)
          });
          return { id: srv.id, name: srv.name, success: res.ok };
        } catch (e) {
          return { id: srv.id, name: srv.name, success: false, error: e.message };
        }
      }));

      const raw = await env.SSH_KV.get("active_sessions");
      const sessions = raw ? JSON.parse(raw) : {};
      for (const srv of selected) {
        delete sessions[srv.id];
      }
      await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
      await logAudit(env, "手动撤回", selected.map(s => s.name).join(", "));

      return jsonResp(200, { results });
    }

    // POST /api/logout — 登出
    if (path === "/api/logout" && request.method === "POST") {
      await env.SSH_KV.delete("web_session_" + token);
      return jsonResp(200, { ok: true });
    }

    return jsonResp(404, { error: "Unknown API: " + path });

  } catch (e) {
    return jsonResp(500, { error: e.message });
  }
}

function jsonResp(code, data) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

// ============================================================
// Web Dashboard HTML — 单文件内嵌 CSS + JS
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SSH Bot — 服务器监控面板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#1e293b;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.3);width:360px}
.login-box h2{text-align:center;margin-bottom:24px;color:#38bdf8}
.login-box input{width:100%;padding:12px 16px;border:1px solid #334155;border-radius:8px;background:#0f172a;color:#e2e8f0;font-size:14px;margin-bottom:16px}
.login-box button{width:100%;padding:12px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;font-size:14px;cursor:pointer;transition:.2s}
.login-box button:hover{background:#0284c7}
.login-error{color:#ef4444;text-align:center;margin-bottom:12px;font-size:13px;min-height:18px}
.dashboard{display:none}
.header{background:#1e293b;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.2);flex-wrap:wrap;gap:12px}
.header h1{font-size:18px;color:#38bdf8}
.tabs{display:flex;gap:8px}
.tab{padding:8px 20px;border-radius:8px;cursor:pointer;transition:.2s;font-size:14px;color:#94a3b8}
.tab.active{background:#0ea5e9;color:#fff}
.tab:hover:not(.active){background:#334155}
.logout-btn{padding:8px 16px;border-radius:8px;background:#dc2626;color:#fff;border:none;cursor:pointer;font-size:13px}
.content{padding:24px;max-width:1400px;margin:0 auto}
.server-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:20px}
.server-card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155;transition:.2s}
.server-card:hover{border-color:#0ea5e9}
.server-card.offline{opacity:.6}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.server-name{font-size:16px;font-weight:600}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px}
.online{background:#22c55e}.offline-dot{background:#ef4444}
.metric-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
.metric-label{color:#94a3b8}
.metric-value{color:#e2e8f0;font-weight:500}
.progress-bar{height:6px;background:#334155;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;border-radius:3px;transition:width .8s ease}
.live-text{position:relative;margin-left:4px}
.live-text::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:#22c55e;margin-right:4px;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.cpu-fill{background:linear-gradient(90deg,#22c55e,#eab308,#ef4444)}
.mem-fill{background:linear-gradient(90deg,#3b82f6,#6366f1)}
.disk-fill{background:linear-gradient(90deg,#a855f7,#ec4899)}
.net-info{display:flex;gap:16px;margin-top:12px;padding-top:12px;border-top:1px solid #334155}
.net-item{flex:1;text-align:center}
.net-item .speed{font-size:18px;font-weight:700;color:#38bdf8}
.net-item .label{font-size:11px;color:#64748b;margin-top:2px}
.os-info{font-size:11px;color:#64748b;margin-top:8px}
.ssh-panel{background:#1e293b;border-radius:12px;padding:24px;max-width:800px;margin:0 auto}
.ssh-panel h3{margin-bottom:16px;color:#38bdf8}
.server-select{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.server-checkbox{display:flex;align-items:center;gap:6px;background:#334155;padding:8px 16px;border-radius:8px;cursor:pointer}
.server-checkbox input{accent-color:#0ea5e9}
.btn-group{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.btn{padding:10px 24px;border-radius:8px;border:none;cursor:pointer;font-size:14px;transition:.2s}
.btn-primary{background:#0ea5e9;color:#fff}.btn-primary:hover{background:#0284c7}
.btn-danger{background:#dc2626;color:#fff}.btn-danger:hover{background:#b91c1c}
.btn-success{background:#22c55e;color:#fff}.btn-success:hover{background:#16a34a}
.session-list{margin-top:20px}
.session-item{display:flex;justify-content:space-between;align-items:center;padding:12px;background:#0f172a;border-radius:8px;margin-bottom:8px;font-size:13px}
.audit-log{font-size:12px;color:#64748b;max-height:200px;overflow-y:auto;margin-top:16px}
.audit-log div{padding:4px 0;border-bottom:1px solid #1e293b}
.refresh-info{text-align:center;color:#64748b;font-size:12px;margin-top:16px}
.result-msg{padding:12px;border-radius:8px;margin-bottom:12px;font-size:13px;white-space:pre-wrap}
.result-ok{background:#05966933;color:#34d399}
.duration-section{margin-bottom:16px}
.duration-section label{display:block;color:#94a3b8;font-size:13px;margin-bottom:8px}
.preset-btns{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.preset-btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#94a3b8;cursor:pointer;font-size:12px;transition:.2s}
.preset-btn:hover{border-color:#0ea5e9;color:#38bdf8}
.preset-btn.active{background:#0ea5e9;color:#fff;border-color:#0ea5e9}
.custom-time{display:flex;gap:8px;align-items:center}
.custom-time input{padding:8px 12px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#e2e8f0;font-size:13px}
.custom-time input:focus{outline:none;border-color:#0ea5e9}
.select-all-bar{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:8px 0;border-bottom:1px solid #334155}
.select-all-bar button{padding:6px 16px;border-radius:6px;border:1px solid #334155;background:#334155;color:#e2e8f0;cursor:pointer;font-size:12px;transition:.2s}
.select-all-bar button:hover{background:#0ea5e9;color:#fff}
.select-all-bar span{font-size:13px;color:#64748b}
.result-err{background:#dc262633;color:#f87171}
</style>
</head>
<body>
<div class="login-wrap" id="loginPage">
  <div class="login-box">
    <h2>🔐 SSH Bot 监控面板</h2>
    <div class="login-error" id="loginError"></div>
    <input type="password" id="passwordInput" placeholder="请输入密码" onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()">登 录</button>
  </div>
</div>
<div class="dashboard" id="dashboard">
  <div class="header">
    <h1>📊 SSH Bot 监控面板</h1>
    <div class="tabs">
      <div class="tab active" onclick="switchTab('monitor')">📡 服务器探针</div>
      <div class="tab" onclick="switchTab('ssh')">🔑 SSH 管理</div>
    </div>
    <button class="logout-btn" onclick="doLogout()">退出</button>
  </div>
  <div class="content" id="monitorTab">
    <div class="server-grid" id="serverGrid"></div>
    <div class="refresh-info" id="refreshInfo">⏳ 加载中...</div>
  </div>
  <div class="content" id="sshTab" style="display:none">
    <div class="ssh-panel">
      <h3>🔑 SSH 密钥管理</h3>
      <div id="sshResult"></div>
      <div class="select-all-bar">
        <button onclick="toggleSelectAll()" id="selectAllBtn">☑ 全选</button>
        <span id="selectCount">未选择</span>
      </div>
      <div class="server-select" id="serverSelect"></div>
      <div class="duration-section">
        <label>⏱ 密钥有效期</label>
        <div class="preset-btns">
          <button class="preset-btn" data-seconds="3600" onclick="setPreset(this,3600)">1 小时</button>
          <button class="preset-btn" data-seconds="7200" onclick="setPreset(this,7200)">2 小时</button>
          <button class="preset-btn" data-seconds="21600" onclick="setPreset(this,21600)">6 小时</button>
          <button class="preset-btn" data-seconds="43200" onclick="setPreset(this,43200)">12 小时</button>
          <button class="preset-btn active" data-seconds="86400" onclick="setPreset(this,86400)">1 天</button>
          <button class="preset-btn" data-seconds="259200" onclick="setPreset(this,259200)">3 天</button>
          <button class="preset-btn" data-seconds="432000" onclick="setPreset(this,432000)">5 天</button>
          <button class="preset-btn" data-seconds="604800" onclick="setPreset(this,604800)">7 天</button>
          <button class="preset-btn" data-seconds="0" onclick="setPreset(this,0)">永久</button>
        </div>
        <div class="custom-time">
          <input type="datetime-local" id="customExpire" step="1" onchange="onCustomTimeChange()">
          <span style="font-size:12px;color:#64748b">自定义到期时间（精确到秒）</span>
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="addKey('fixed')">📌 下发固定密钥</button>
        <button class="btn btn-success" onclick="addKey('dynamic')">🎲 生成动态密钥</button>
        <button class="btn btn-danger" onclick="removeKey()">🛑 撤销选中密钥</button>
      </div>
      <div class="session-list" id="sessionList"></div>
      <div class="audit-log" id="auditLog"></div>
    </div>
  </div>
</div>
<script>
let token = localStorage.getItem('sshbot_token') || '';
let refreshTimer = null;
let serverList = [];

async function doLogin() {
  const pwd = document.getElementById('passwordInput').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({password: pwd})
    });
    const data = await res.json();
    if (res.ok) {
      token = data.token;
      localStorage.setItem('sshbot_token', token);
      showDashboard();
    } else {
      errEl.textContent = data.error || '登录失败';
    }
  } catch(e) {
    errEl.textContent = '网络错误: ' + e.message;
  }
}

function doLogout() {
  fetch('/api/logout', {method:'POST', headers:{'Authorization':'Bearer '+token}});
  localStorage.removeItem('sshbot_token');
  token = '';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  if (refreshTimer) clearInterval(refreshTimer);
}

function showDashboard() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  loadServers();
  startMetricsPolling();
  loadSessions();
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('monitorTab').style.display = tab === 'monitor' ? 'block' : 'none';
  document.getElementById('sshTab').style.display = tab === 'ssh' ? 'block' : 'none';
  if (tab === 'ssh') loadSessions();
}

async function loadServers() {
  try {
    const res = await fetch('/api/servers', {headers:{'Authorization':'Bearer '+token}});
    if (!res.ok) { doLogout(); return; }
    const data = await res.json();
    serverList = data.servers;
    const el = document.getElementById('serverSelect');
    el.innerHTML = data.servers.map(s =>
      '<label class="server-checkbox"><input type="checkbox" value="' + s.id + '" onchange="updateSelectCount()"> ' +
      (s.online ? '🟢' : '🔴') + ' ' + s.name + '</label>'
    ).join('');
  } catch(e) { console.error(e); }
}

function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('#serverSelect input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(c => c.checked);
  checkboxes.forEach(c => c.checked = !allChecked);
  document.getElementById('selectAllBtn').textContent = allChecked ? '☑ 全选' : '☐ 取消全选';
  updateSelectCount();
}

function updateSelectCount() {
  const checked = document.querySelectorAll('#serverSelect input:checked').length;
  const total = document.querySelectorAll('#serverSelect input[type="checkbox"]').length;
  document.getElementById('selectCount').textContent = checked === 0 ? '未选择' : '已选 ' + checked + '/' + total;
  const allChecked = checked === total && total > 0;
  document.getElementById('selectAllBtn').textContent = allChecked ? '☐ 取消全选' : '☑ 全选';
}

let selectedDurationSeconds = 86400; // 默认1天

function setPreset(btn, seconds) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedDurationSeconds = seconds;
  // 清除自定义时间
  document.getElementById('customExpire').value = '';
}

function onCustomTimeChange() {
  const val = document.getElementById('customExpire').value;
  if (val) {
    const target = new Date(val).getTime();
    const diff = Math.round((target - Date.now()) / 1000);
    if (diff > 0) {
      selectedDurationSeconds = diff;
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    } else {
      showSshResult('自定义时间必须晚于当前时间', false);
      document.getElementById('customExpire').value = '';
    }
  }
}

function startMetricsPolling() {
  fetchMetrics();
  refreshTimer = setInterval(fetchMetrics, 2000);
}

async function fetchMetrics() {
  try {
    const res = await fetch('/api/metrics', {headers:{'Authorization':'Bearer '+token}});
    if (!res.ok) return;
    const data = await res.json();
    renderServerCards(data.servers);
    const time = new Date().toLocaleTimeString('zh-CN');
    document.getElementById('refreshInfo').textContent = '🔄 最后更新: ' + time + ' (每5秒自动刷新)';
  } catch(e) {}
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps/1024).toFixed(1) + ' KB/s';
  return (bps/1048576).toFixed(2) + ' MB/s';
}

function fmtDisk(gb) {
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return Math.round(gb * 1024) + ' MB';
}

function renderServerCards(servers) {
  const grid = document.getElementById('serverGrid');
  const existingCards = {};
  grid.querySelectorAll('[data-sid]').forEach(c => existingCards[c.dataset.sid] = c);

  servers.forEach(s => {
    let card = existingCards[s.id];
    if (!s.online || !s.metrics) {
      // Offline card
      if (!card) {
        card = document.createElement('div');
        card.dataset.sid = s.id;
        grid.appendChild(card);
      }
      card.className = 'server-card offline';
      card.innerHTML = '<div class="card-header"><span class="server-name">' + s.name + '</span>' +
        '<span><span class="status-dot offline-dot"></span>离线</span></div>' +
        '<div style="color:#64748b;font-size:13px">⚠ ' + (s.error || '无法连接') + '</div>';
      return;
    }

    const m = s.metrics;
    const memPct = m.mem_total > 0 ? Math.round(m.mem_used/m.mem_total*100) : 0;
    const diskInfo = m.disk && m.disk.length > 0 ? m.disk[0] : {percent:0,used:0,total:0};
    const osInfo = m.os_info || {};
    const swPct = m.swap_total > 0 ? Math.round(m.swap_used/m.swap_total*100) : 0;
    const hasSwap = m.swap_total > 0;

    if (!card) {
      // First render: create card structure with stable element IDs
      card = document.createElement('div');
      card.dataset.sid = s.id;
      card.className = 'server-card';
      card.innerHTML =
        '<div class="card-header"><span class="server-name">' + s.name + '</span>' +
          '<span><span class="status-dot online"></span><span class="live-text">在线</span></span></div>' +
        '<div class="metric-row"><span class="metric-label">CPU</span><span class="metric-value" data-v="cpu"></span></div>' +
        '<div class="progress-bar"><div class="progress-fill cpu-fill" data-v="cpuBar"></div></div>' +
        '<div class="metric-row" style="margin-top:10px"><span class="metric-label">内存</span><span class="metric-value" data-v="mem"></span></div>' +
        '<div class="progress-bar"><div class="progress-fill mem-fill" data-v="memBar"></div></div>' +
        '<div class="metric-row" style="margin-top:10px"><span class="metric-label">磁盘</span><span class="metric-value" data-v="disk"></span></div>' +
        '<div class="progress-bar"><div class="progress-fill disk-fill" data-v="diskBar"></div></div>' +
        '<div class="swap-row" data-v="swapRow">' +
          '<div class="metric-row" style="margin-top:10px"><span class="metric-label">Swap</span><span class="metric-value" data-v="swap"></span></div>' +
          '<div class="progress-bar"><div class="progress-fill" data-v="swapBar" style="background:linear-gradient(90deg,#f59e0b,#f97316)"></div></div>' +
        '</div>' +
        '<div class="metric-row" style="margin-top:10px"><span class="metric-label">负载</span><span class="metric-value" data-v="load"></span></div>' +
        '<div class="metric-row"><span class="metric-label">运行时间</span><span class="metric-value" data-v="uptime"></span></div>' +
        '<div class="net-info">' +
          '<div class="net-item"><div class="speed" data-v="rxSpeed">↓ </div><div class="label" data-v="rxTotal">接收 </div></div>' +
          '<div class="net-item"><div class="speed" data-v="txSpeed">↑ </div><div class="label" data-v="txTotal">发送 </div></div>' +
        '</div>' +
        '<div class="os-info" data-v="os"></div>';
      grid.appendChild(card);
    }

    // In-place update: only change values, DOM stays → CSS transition works
    card.className = 'server-card';
    const q = (v) => card.querySelector('[data-v="' + v + '"]');
    q('cpu').textContent = m.cpu_percent + '% (' + m.cpu_cores + '核)';
    q('cpuBar').style.width = m.cpu_percent + '%';
    q('mem').textContent = m.mem_used + '/' + m.mem_total + ' MB (' + memPct + '%)';
    q('memBar').style.width = memPct + '%';
    q('disk').textContent = fmtDisk(diskInfo.used) + '/' + fmtDisk(diskInfo.total) + ' (' + diskInfo.percent + '%)';
    q('diskBar').style.width = diskInfo.percent + '%';
    // Swap
    const swapRow = q('swapRow');
    if (hasSwap) {
      swapRow.style.display = '';
      q('swap').textContent = m.swap_used + '/' + m.swap_total + ' MB (' + swPct + '%)';
      q('swapBar').style.width = swPct + '%';
    } else {
      swapRow.style.display = 'none';
    }
    q('load').textContent = m.load[0] + ' / ' + m.load[1] + ' / ' + m.load[2];
    q('uptime').textContent = m.uptime ? m.uptime.human : '未知';
    q('rxSpeed').textContent = '↓ ' + fmtSpeed(m.net_rx_speed);
    q('rxTotal').textContent = '接收 ' + fmtBytes(m.net_rx);
    q('txSpeed').textContent = '↑ ' + fmtSpeed(m.net_tx_speed);
    q('txTotal').textContent = '发送 ' + fmtBytes(m.net_tx);
    q('os').textContent = (osInfo.os || '') + ' | 内核 ' + (osInfo.kernel || '') + ' | ' + (osInfo.cpu_model || '').substring(0,40);
  });

  // Remove cards for servers no longer in the list
  const currentIds = new Set(servers.map(s => s.id));
  Object.keys(existingCards).forEach(sid => {
    if (!currentIds.has(sid)) existingCards[sid].remove();
  });
}

function getSelectedServers() {
  return Array.from(document.querySelectorAll('#serverSelect input:checked')).map(c => c.value);
}

function showSshResult(msg, ok) {
  const el = document.getElementById('sshResult');
  el.innerHTML = '<div class="result-msg ' + (ok ? 'result-ok' : 'result-err') + '">' + msg + '</div>';
}

async function addKey(type) {
  const ids = getSelectedServers();
  if (!ids.length) { showSshResult('请先选择服务器', false); return; }
  try {
    const res = await fetch('/api/ssh/add', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({serverIds: ids, keyType: type, durationSeconds: selectedDurationSeconds})
    });
    const data = await res.json();
    if (res.ok) {
      const okList = data.results.filter(r => r.success).map(r => r.name).join(', ');
      const failList = data.results.filter(r => !r.success).map(r => r.name).join(', ');
      let msg = '✅ 密钥已下发到: ' + okList;
      if (failList) msg += '\\n❌ 失败: ' + failList;
      if (data.pubKey) msg += '\\n\\n公钥:\\n' + data.pubKey;
      showSshResult(msg, true);
      loadSessions();
    } else {
      showSshResult(data.error || '操作失败', false);
    }
  } catch(e) { showSshResult('网络错误: ' + e.message, false); }
}

async function removeKey() {
  const ids = getSelectedServers();
  if (!ids.length) { showSshResult('请先选择服务器', false); return; }
  try {
    const res = await fetch('/api/ssh/remove', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({serverIds: ids, tag: 'all'})
    });
    const data = await res.json();
    if (res.ok) {
      const okList = data.results.filter(r => r.success).map(r => r.name).join(', ');
      showSshResult('✅ 密钥已撤销: ' + okList, true);
      loadSessions();
    } else {
      showSshResult(data.error || '操作失败', false);
    }
  } catch(e) { showSshResult('网络错误: ' + e.message, false); }
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions', {headers:{'Authorization':'Bearer '+token}});
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions || {};
    const sList = document.getElementById('sessionList');
    const keys = Object.keys(sessions);
    if (keys.length === 0) {
      sList.innerHTML = '<div style="color:#64748b;font-size:13px">暂无活跃会话</div>';
    } else {
      sList.innerHTML = keys.map(k => {
        const s = sessions[k];
        const expire = s.expireAt > 0 ? new Date(s.expireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '永久';
        return '<div class="session-item"><span>🖥 ' + k + ' | ' + s.type + ' | 过期: ' + expire + '</span><button class="btn btn-danger" style="padding:4px 12px;font-size:12px" onclick="removeSession(\\''+k+'\\')">撤销</button></div>';
      }).join('');
    }
    const audits = data.audits || [];
    const aLog = document.getElementById('auditLog');
    if (audits.length > 0) {
      aLog.innerHTML = '<div style="margin-bottom:8px;color:#38bdf8">📋 审计日志</div>' + audits.slice(-15).reverse().map(a =>
        '<div>' + a.time + ' | ' + a.event + ' | ' + a.target + '</div>'
      ).join('');
    }
  } catch(e) {}
}

async function removeSession(serverId) {
  try {
    await fetch('/api/ssh/remove', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({serverIds: [serverId], tag: 'all'})
    });
    loadSessions();
  } catch(e) {}
}

// 启动 — 检查是否有 token
if (token) {
  fetch('/api/servers', {headers:{'Authorization':'Bearer '+token}}).then(res => {
    if (res.ok) showDashboard();
    else { localStorage.removeItem('sshbot_token'); token = ''; }
  }).catch(() => {});
}
<\/script>
</body>
</html>`;
