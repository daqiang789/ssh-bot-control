// ============================================================
// worker.js — SSH Bot 安全修复版（Cron + HTTPS + RSA 2048）
// VPS 列表从环境变量 VPS_SERVERS 读取，格式：
//   id:名称:url | id:名称:url | ...
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
  // ===== Cron：每分钟扫描过期会话自动回收 =====
  async scheduled(event, env, ctx) {
    const rawSessions = await env.SSH_KV.get("active_sessions");
    if (!rawSessions) return;

    const SERVERS = parseServers(env);
    let sessions = JSON.parse(rawSessions);
    const now = Date.now();
    let updated = false;
    let expiredNames = [];

    for (const [srvId, sess] of Object.entries(sessions)) {
      if (sess.expireAt && now >= sess.expireAt) {
        const targetServer = SERVERS.find(s => s.id === srvId);
        if (targetServer) {
          await fetch(`${targetServer.url}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Auth-Key": env.SYNC_KEY },
            body: JSON.stringify({ action: "remove", pub_key: sess.pubKey, tag: sess.tag }),
            signal: AbortSignal.timeout(10000)
          }).catch(() => {});
          expiredNames.push(targetServer.name);
        }
        delete sessions[srvId];
        updated = true;
        await logAudit(env, "自动到期撤回", targetServer ? targetServer.name : srvId);
      }
    }

    if (updated) {
      await env.SSH_KV.put("active_sessions", JSON.stringify(sessions));
      await sendTGMessage(env, `⏰ <b>以下服务器临时密钥已到期，已自动回收：</b>\n${expiredNames.join(", ")}`);
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

  // ===== Telegram Webhook 入口 =====
  async fetch(request, env) {
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
          const defaultSelected = SERVERS.map(s => s.id);
          await renderDashboard(env, chatId, null, defaultSelected, SERVERS);
        } else if (text === "/status") {
          await renderStatusPanel(env, chatId, null, SERVERS);
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
    publicExponent: new Uint8Array([1, 0, 1]),  // 65537
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
    derInteger(new Uint8Array([0])),        // version = 0
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
// 渲染控制面板
// ============================================================
async function renderDashboard(env, chatId, messageId, selectedIds, SERVERS) {
  const isAll = selectedIds.length === SERVERS.length;
  const selStr = selectedIds.join(",");

  let text = `🛠 <b>SSH 临时权限控制面板</b>\n\n`;
  text += `🎯 <b>已勾选目标 (${selectedIds.length}/${SERVERS.length})：</b>\n`;
  if (selectedIds.length === 0) {
    text += `<i>未勾选任何机器，请点击下方进行选择</i>\n`;
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
  keyboard.push([{ text: "📊 查看各节点状态 & 记录", callback_data: "view_status" }]);

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
    await sendTGMessage(env, `🛑 <b>【批量撤销报告】</b>\n\n${results.join("\n")}`);
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
  let report = `🚀 <b>【批量下发完成】</b>\n`;
  report += `• 类型: ${keyTypeName}\n`;
  report += `• 有效期至: ${expireStr} (${hours}小时后自动作废)\n\n`;
  report += `<b>执行结果：</b>\n${results.join("\n")}`;
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
// 状态面板
// ============================================================
async function renderStatusPanel(env, chatId, messageId, SERVERS) {
  const rawSessions = (await env.SSH_KV.get("active_sessions")) || "{}";
  const sessions = JSON.parse(rawSessions);
  const rawLogs = (await env.SSH_KV.get("audit_logs")) || "[]";
  const logs = JSON.parse(rawLogs);

  let text = `📊 <b>各服务器当前授权状态：</b>\n\n`;
  SERVERS.forEach(srv => {
    const sess = sessions[srv.id];
    if (sess) {
      const leftMin = Math.max(0, Math.round((sess.expireAt - Date.now()) / 60000));
      const expTime = new Date(sess.expireAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
      text += `🟢 <b>${srv.name}</b>\n   └ 模式: ${sess.type} | 剩 <b>${leftMin}m</b> (${expTime}失效)\n`;
    } else {
      text += `🔴 <b>${srv.name}</b>: <i>无临时密钥生效</i>\n`;
    }
  });

  text += `\n📋 <b>最近审计记录：</b>\n`;
  if (logs.length === 0) {
    text += `<i>暂无记录</i>\n`;
  } else {
    logs.slice(0, 5).forEach(l => { text += `• [${l.time}] ${l.event}: ${l.target}\n`; });
  }

  const keyboard = [[{ text: "⬅️ 返回管理面板", callback_data: `back_main:${SERVERS.map(s => s.id).join(",")}` }]];
  if (messageId) { await updateTGMessage(env, chatId, messageId, text, keyboard); }
  else { await sendTGMessage(env, text, keyboard); }
}

// ============================================================
// 日志
// ============================================================
async function logAudit(env, event, target) {
  let logs = JSON.parse((await env.SSH_KV.get("audit_logs")) || "[]");
  logs.unshift({ time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }), event, target });
  if (logs.length > 20) logs.pop();
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
