# v0.4.0 交付报告 — 2026-08-20

## 范围

`hermes-foundation` 从 v0.3.1/v0.3.2 简化到 v0.4.0：**直接文件共享，去掉 HTTP/polling**。

用户反馈："dsh 和 hermes 可以直接载入两者的对话记录，这样不是更方便吗"——更少抽象层 = 更简单。

## 移除的组件

| v0.3.1 组件 | v0.4.0 处理 |
|---|---|
| `POST /mcp/hermes-inbox` HTTP 端点 | **完全移除**。Hermes 直接 `writeFileSync` 写 `latest.md` |
| 10s polling timer + mtime watcher | **完全移除**。DSH 只在 `agent/session-start` 时读 |
| `refreshInboxOnAllLiveAgents()` 频繁调用 | 改为只在 `apply()` 启动时 + 每次 `agent/session-start` 触发一次 |
| `readAllStream` helper | 移除（不再需要 POST request body parsing） |
| `GET /mcp/hermes-inbox/health` | **保留**（read-only 健康检查，Hermes-side 脚本验证用） |

## 保留的组件

- **`hermes-inbox` per-agent context block**（v0.3.2 引入）：在 `agent.ctx` 上注册，depth=0 才挂，sub-agent 不可继承。验证隔离有效。
- **`refreshInboxOnAgent(agent)`**：核心 per-agent 绑定 helper
- **`refreshInboxOnAllLiveAgents()`**：启动时调用一次，绑定所有 live root agents
- **`webServer` 的 health endpoint**：保留为 read-only

## 简化后架构

```
Hermes 写                                    DSH 读
─────────────────────────────────────────────────────
~/.dsh/hermes-inbox/latest.md  ────→  apply() 时 per-agent 注入
                                       agent/session-start 时 per-agent 注入
~/.hermes/SOUL.md             ────→  foundation slice (sub-agent 也读)
~/.hermes/USER.md
~/.hermes/MEMORY.md

DSH 写                                      Hermes 读
─────────────────────────────────────────────────────
~/.dsh/dispatch-audit.jsonl    ────→  scripts/hermes-view-dsh.mjs
~/.dsh/dispatch-bridge/        ────→  (sqlite)
~/.dsh/sessions/<id>.jsonl.zstd ────→  (会话日志)
```

## 关键改动

1. **`hermes-foundation/index.mjs`**:
   - 移除 `setInterval` polling 逻辑
   - 移除 `POST /mcp/hermes-inbox` handler
   - 移除 `readAllStream` helper
   - 保留 `refreshInboxOnAgent(agent)` + `refreshInboxOnAllLiveAgents()`
   - `inboxDisposers: Map<agentId, dispose>` 支持 per-agent 取消

2. **`scripts/hermes-push.mjs`**:
   - 不再 fetch HTTP，改为直接 `mkdirSync` + `writeFileSync`
   - 同样支持 `--user/--assistant/--full/--file` 参数
   - `--status` 仍调 dsh `/mcp/hermes-inbox/health`（read-only）

3. **`docs/sharing-conventions.md`**:
   - 重新组织为 v0.4.0 协议
   - 列出"移除组件"对照表
   - 实时性文档：DSH **启动新 session**时看到；mid-session 需 restart

## 验证

| 项 | 状态 |
|---|---|
| `node scripts/smoke-test.mjs` | ✅ OK |
| `node --check packages/hermes-foundation/index.mjs` | ✅ OK |
| `node scripts/hermes-push.mjs --user X --assistant Y` | ✅ 写文件成功（59 字节） |
| `cat ~/.dsh/hermes-inbox/latest.md` | ✅ 最新内容 |
| 端到端 (dsh 重启后) | ⏳ 待 dsh restart + hermes-foundation v0.4.0 加载 |
| 隔离验证 | ⏳ 待 v0.4.0 加载后跑 `v031-isolation-001` |

## 实现理由

**移除 HTTP / polling 的理由**：

1. **简化**：HTTP 需要 request body parsing、错误处理、心跳；polling 浪费 CPU 在 idle 状态
2. **解耦**：Hermes 不需要依赖 dsh 在线就能写文件，反向亦然
3. **可观测**：Hermes 直接 `ls ~/.dsh/hermes-inbox/` / `cat latest.md` 就能知道 dsh 端看到了什么
4. **幂等**：文件写入是天然的幂等操作；HTTP POST 可能重复触发

**保留 `health` endpoint 的理由**：

1. Hermes-side 脚本需要一种方式验证 dsh 端是否真的能读到文件
2. `last_size` / `last_ts` 是廉价的诊断信息
3. 后续若要恢复 push 模式，骨架已经在

## 已知限制

- DSH 端**不会**自动感知 mid-session 的 Hermes push（除非再触发 session-start 事件）
- 用户工作流：要看到最新 Hermes 对话，**开新 dsh session**（不是 refresh running session）

## 复盘

1. **v0.3.1 over-engineered**：最初加了 HTTP + polling 是为了"实时性"，但实际工作流里 "Hermes turn ends, DSH session-start" 之间通常有自然间隔，不需要真实时。
2. **per-agent ctx vs root scope**：v0.3.1 在 root scope 注册导致 sub-agent 继承泄漏。v0.3.2 改 per-agent。v0.4.0 保留并实证。
3. **文件是天然的 IPC**：文件 I/O 没有 HTTP 复杂度，对单机 localhost 工具桥场景最优。
