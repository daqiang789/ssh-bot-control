# 15 分钟上手 · 给新接手的运维

> 读这个就够你把系统"跑起来、加机器、不踩雷"。细节别背，去哪查看下面地图。
> 本文**不含任何明文密钥/token**，涉及凭据只说"在哪、怎么拿"。

---

## 1. 这是啥（30 秒心智模型）

在手机上用 Telegram 管多台 VPS 的 SSH 临时密钥：**点按钮 → 下发公钥 → 到期自动回收**，
不用登服务器。三端拓扑：

```
手机 Telegram  ←webhook→  Cloudflare Worker (bot-ssh.<域名>)  ←HTTPS(Origin证书)→  各 VPS 上的 Python 接收端(:2087/2083)
     按钮面板                    生成RSA密钥 / KV存状态 / Cron回收              鉴权+调 bash 改 authorized_keys
```

一句话：**Worker 是大脑（在 CF 上），每台 VPS 是个"执行手"（本地 HTTPS 接收端），TG 是遥控器。**

---

## 2. 关键概念（别被名字绕晕）

| 概念 | 是什么 | 在哪 |
|------|--------|------|
| `SYNC_KEY` | Worker ↔ VPS 的鉴权密钥，**每台 VPS 一把** | VPS `/root/.sync_key`；Worker 侧对应 secret |
| `VPS_SERVERS` | Worker 管哪些 VPS（`id:名:url` 用 `\|` 分） | Worker 的 **env var**（不是 secret），加机器就改它 |
| `SSH_KV` | 存会话状态 + 审计日志 + 待删消息 | Cloudflare KV namespace |
| Origin 证书 | CF↔VPS 的 TLS（15 年），**私钥绝不能进公开 git** | VPS `/root/ssl_{cert,key}.pem` |
| `del_msg` | 每条消息的"删除此消息"按钮回调 | 在 `worker.js` 里 |

---

## 3. 每个文件干嘛的（一张表定位）

| 文件 | 位置 | 职责 |
|------|------|------|
| `worker.js` | Cloudflare | 全部"大脑"逻辑：按钮、密钥生成、Cron、发消息 |
| `ssh_webhook.py` | 每台 VPS | HTTPS 接收端（**只收 POST**，GET=501 正常） |
| `key_manager_dynamic.sh` | 每台 VPS | 真正增删 `authorized_keys` 的 bash |
| `start_webhook.sh` | 每台 VPS | 服务启动壳 |
| `install.sh` | 公开仓 | 新 VPS 一键安装（多发行版） |
| `wrangler.toml` | 仓内（占位符） | 公开模板，**真实值在 gitignore 的 `wrangler.deploy.toml`** |
| `deploy-guide.md` | 仓内 | 一步步部署手册 |
| `AUDIT-YYYY-MM-DD.md` | 仓内 | 历次改动/安全审计交接 |

---

## 4. 你日常会做的 5 件事（去哪看步骤）

1. **加一台 VPS** → VPS 上跑 `install.sh`，再在 Worker 的 `VPS_SERVERS` 追加一段。
   详见 `deploy-guide.md` §二 + README"加/删 VPS"。
2. **下发/撤销密钥** → TG 里发 `/ssh` 用按钮，**不用碰代码**。
3. **看谁有权限** → TG 里 `📊 查看各节点状态 & 记录`，或查 KV `audit_logs`。
4. **改 Worker 代码** → 改 `worker.js`，本地 `node --check` 过，再
   `npx wrangler deploy --config wrangler.deploy.toml`（详见 §5 速查命令）。
5. **换证书**（15 年到期才需）→ 换一对新 Origin 证书到各 VPS `/root/`，重启服务。

---

## 5. 速查命令

```bash
# 部署 Worker（真实配置在 gitignore 的 wrangler.deploy.toml，别提交它）
CLOUDFLARE_API_TOKEN=<你的token> npx wrangler deploy --config wrangler.deploy.toml

# 新 VPS 一键装（证书已就位时）
curl -fsSL https://raw.githubusercontent.com/daqiang789/ssh-bot-control/main/install.sh | bash

# VPS 侧服务状态
systemctl status ssh-webhook   # 或 Alpine: rc-service ssh-webhook status
```

---

## 6. ⚠️ 危险区（先记住，出事先查这）

- **源站暴露面**：VPS 的 2087/2083 **应只放行 Cloudflare 边缘 IP**。
  若直接暴露公网，私钥 TLS 通道的机密性会被绕过。新增 VPS 先查防火墙。
- **凭据治理**：git 远端 URL 里**内嵌了 GitHub PAT**（`github_pat_…`），属长期敏感凭据，
  建议改 credential helper + 定期轮换（见 AUDIT §7）。
- **别把私钥/证书 `git add -f` 进库**：`*.pem`、`*.key`、`reuse-cert/`、
  `wrangler.deploy.toml` 都已 gitignore，是刻意的，别破坏。
- **改 `worker.js` 别忘部署**：改了不 `wrangler deploy` 线上不生效。

---

## 7. 文档地图（别重复读）

- **本文件** → 建立心智模型、定位东西、避坑（15 分钟）
- **`README.md`** → 项目是啥、一键装、加删机器
- **`deploy-guide.md`** → 从零部署的逐步手册（CF + VPS + TG）
- **`AUDIT-2026-10-31.md`** → 最近一次大改动的审计与待办交接（含 §7 待办清单）

> 接手第一件事：读 AUDIT 最新一份的 §5（现状）+ §7（待办），确认线上版本和遗留项。
