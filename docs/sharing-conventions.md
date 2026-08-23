# Hermes ↔ DSH 双向互通约定 (v0.4.0)

> **设计原则：直接文件共享**。Hermes 写文件，DSH 读文件；DSH 写文件，Hermes 读文件。
> 没有 HTTP push endpoint（v0.3.1 移除），没有 polling timer（v0.3.1 移除）。
> 每个工具在已知事件触发时读对方的文件。

## 0. 总览

```
┌────────────────────────┐                  ┌────────────────────────┐
│  Hermes (orchestrator)  │                  │  DSH (executor + main) │
│                        │                  │                        │
│  scripts/hermes-push.mjs│ 写文件            │  agent/session-start  │
│  writes                │ ────────────────→│  reads                 │
│  ~/.dsh/hermes-inbox/   │                  │  ~/.dsh/hermes-inbox/  │
│  latest.md             │                  │  latest.md             │
│                        │                  │                        │
│  hermes-view-dsh.mjs  │ 读文件            │  foundation slice 写入  │
│  reads                 │ ←────────────────│  /mcp/dispatch routes  │
│  ~/.dsh/dispatch-      │                  │  dispatch-audit.jsonl   │
│  audit.jsonl           │                  │  + idempotency.sqlite  │
│  + idempotency.sqlite  │                  │                        │
└────────────────────────┘                  └────────────────────────┘
```

## 1. Hermes → DSH 通道

### 路径
- `~/.dsh/hermes-inbox/latest.md` — Hermes 写，DSH 读
- `~/.dsh/hermes-inbox/turn-<ts>.md` — Hermes 写的历史快照（DSH 不读）

### 格式
```markdown
USER: <最新一轮 user 消息>
---
HERMES: <最新一轮 assistant 回复>
```
或者 `full` 字段直接传任意文本。

### Hermes 侧自动写入
**Hermes (本 agent) 必须在每个 turn 结尾自动写入 latest.md**。

```bash
node scripts/hermes-push.mjs --user "USER said X" --assistant "HERMES replied Y"
node scripts/hermes-push.mjs --full "verbatim turn text"
node scripts/hermes-push.mjs --file path/to/turn.md
```

或直接用 Node.js fs：
```js
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
mkdirSync(join(process.env.DSH_HOME || '~/.dsh', 'hermes-inbox'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME || '~/.dsh', 'hermes-inbox/latest.md'), content, 'utf8')
```

### DSH 侧自动读取
`hermes-foundation` v0.4.0：
- `apply()` 时：调用 `refreshInboxOnAllLiveAgents()`，对 depth=0 的 live agent 注册 `hermes-inbox` per-agent context block
- `agent/session-start` 时：找到 main session agent，在 `agent.ctx` 上注册 `hermes-inbox` per-agent context block
- **不轮询**，**不监听文件 mtime**

### 隔离保证
- `hermes-inbox` 是 **per-agent context block**（在 `agent.ctx` 上注册），不在 root scope
- dsh 的 `composeFrom` 只传播 **root scope** 的预设和 context block，不会传播 per-agent 注册
- **sub-agent 看不到 Hermes-inbox**（保留 v0.3 隔离）
- bridge 的 `buildFoundationSlice()` 只读 SOUL/USER/MEMORY，不读 inbox

### 实时性
- DSH **启动新 session 时**看到最新 latest.md
- 不重启的情况下，要看到新 push：需要 restart dsh session（新会话触发）
- Hermes 想让正在运行的 dsh 看到实时更新：暂时不支持（要不 restart dsh，要不等下一个 session-start）

## 2. DSH → Hermes 通道

### 路径
- `~/.dsh/dispatch-audit.jsonl` — 每次 `dispatch_task` 落一行
- `~/.dsh/dispatch-bridge/idempotency.sqlite` — `seen` 表 + `continuable_children` 表
- `~/.dsh/sessions/<workspace-hash>/<id>/session.jsonl.zstd` — DSH 自己的 session log

### 格式
audit 每行一个 JSON record：
```json
{"ts":"2026-08-20T14:50:00.000Z","status":"continuable_started","task_id":"...","child_id":"...","parent_agent_id":"...","model":"...","skill":"..."}
```

### Hermes 侧自动读取
**Hermes (本 agent) 默认能看 dsh 的工作**：

```bash
node scripts/hermes-view-dsh.mjs          # 全部
node scripts/hermes-view-dsh.mjs audit    # 只看审计
node scripts/hermes-view-dsh.mjs children # 只看 child 注册表
node scripts/hermes-view-dsh.mjs inbox    # 看 Hermes-inbox 内容（自己写的）
```

或直接 `cat ~/.dsh/dispatch-audit.jsonl` / `Read` 工具读。

### 实时性
- `dispatch-audit.jsonl` 每次 dispatch 立即 append（无延迟）
- `idempotency.sqlite` 每次通过 WAL 同步
- Hermes 端 `hermes-view-dsh.mjs` 是 read-only，可随时跑

## 3. 移除的 v0.3.1 复杂性

| v0.3.1 组件 | v0.4.0 移除原因 |
|---|---|
| `POST /mcp/hermes-inbox` HTTP 端点 | 文件直接写更简单 |
| `GET /mcp/hermes-inbox/health` | 保留（read-only 健康检查） |
| 10s polling timer | session-start 读就够 |
| refreshInboxOnAllLiveAgents() 频繁调用 | 只在 session-start 触发 |

## 4. 完整双向同步的 4 个事件

| 事件 | 触发 | 同步路径 |
|---|---|---|
| Hermes 完成一轮回复 | Hermes 直接写 `~/.dsh/hermes-inbox/latest.md` | Hermes → 文件 |
| DSH 启动新 session | `agent/session-start` → 读 hermes-inbox → 注入 `hermes-inbox` ctx block | DSH ← 文件 |
| DSH 派单 v0.3 dispatch_task | `dispatch-audit.jsonl` + `idempotency.sqlite` | DSH → 文件 |
| DSH 子 agent 完结 | continuation manager → 主 session 注入结算消息 | DSH ← DSH |

## 5. 配置 / 兼容性

- **Hermes 端**：hermes-push.mjs 与 hermes-view-dsh.mjs 是 Node.js 脚本
- **DSH 端**：hermes-foundation v0.4.0 + `inject: ['skills', 'systemPrompt', 'webServer']`（webServer 仅用于 health）
- **旧版本兼容**：v0.3.0-v0.3.2 hermes-foundation 没有 polling 也没有 push，写文件后 dsh 端要 restart session 才能看到

## 6. 故障排查

| 症状 | 排查 |
|---|---|
| DSH 主 session 看不到 Hermes 最新对话 | `cat ~/.dsh/hermes-inbox/latest.md` 看 fresh；`curl http://127.0.0.1:3080/mcp/hermes-inbox/health` 看 last_size；restart dsh session 让 `agent/session-start` 重新读 |
| DSH 派单后 Hermes 看不到 | `cat ~/.dsh/dispatch-audit.jsonl` 看 audit；`node scripts/hermes-view-dsh.mjs children` 看注册表 |
| sub-agent 误收了 inbox | 不应该发生。`hermes-inbox` 在 `agent.ctx` 上注册，sub-agent 的 composeFrom 不会 inherit |
| 旧版本 sub-agent 收到 inbox | v0.3.1 registry 在 root scope，会 inherit。必须升级 v0.4.0 |
