# v0.3.0 交付报告 — 2026-08-20

## 范围

`hermes-dispatch-bridge` 从 v0.2.0 (one-shot dispatch) 跃升到 v0.3.0 (**bidirectional / continuable**)。

Hermes ↔ DSH 现在可以：
- **Hermes → DSH**：派单 + 多轮 followup + 中断
- **DSH → Hermes**：实时事件流（SSE）+ 子 agent 持久 session log 可读
- **共享历史**：persistent session 跨 dsh 重启持续；cold-resume 让旧 child 复活

## 已交付

| 项 | 端到端验证 |
|---|---|
| `mode: continuable` dispatch_task | ✅ `v03-final-001` spawn `child_id=e883e89d-...` 立即返回 |
| `dispatch_followup` 跨轮对话 | ✅ `2068cafd-...` cold-resume 后输出"Next 5 notes" |
| `dispatch_followup` 跨 dsh 重启 | ✅ dsh 重启后再 followup，session 复活，子 agent 记住历史 |
| `dispatch_get` 读 live session events | ✅ 返 `event_id` + `total_events` + events 数组 |
| `dispatch_list` 列 children | ✅ SQLite-backed + 实时状态增强 |
| `dispatch_interrupt` 中断 | ✅ 已实现；尚未在 v0.3 端到端测试 |
| `GET /mcp/dispatch/stream?child_id=...` SSE | ✅ `hello` 事件 + 实时 `session/event` 推送 |
| 持久 session 重启恢复 | ✅ active_children=1，恢复 `2068cafd-...` |
| 真实 token 测量（cache 复用） | ✅ `total=4872, surface=1859, cache=baseline` |
| SQLite ↔ 内存双向同步 | ✅ child registry 跨重启保留 |

## 关键修复（在 v0.3 端到端调试中发现）

| Bug | 触发 | 修复 |
|---|---|---|
| `dispatch_followup` 对 disposed child 误返 -32012 | dsh 自动回收冷 activation 后 | 让 `subagents.followup` 内部 cold-resume（不预检） |
| `waitForNextReply` 抛 "child agent disposed" | activation 跑完即 dispose，poll 错过 turn/end | 改用 `ctx.sessions.get(childId)` 监听 session（durable） |
| `beforeSeq` 取错时机 | cold-resume 时 events 数组被重加载 | 在 `followup` 返回后**再**读 `agent.session.seq` |
| `turn_end_reason` 渲染 `[object Object]` | 是个 `{kind: ...}` 对象 | `JSON.stringify` |

## 客户端集成图

```
Heremes (orchestrator)                              DSH (executor)
                            ┌─────────────────────┐
                            │  /mcp/dispatch      │
   POST dispatch_task ──→   │  + /mcp/dispatch/   │   ──→ spawn continuable child
   POST dispatch_followup ──→│    stream/:child_id │   ──→ send more content
   GET  dispatch_stream ──→   │   (SSE)             │   ←── child events
                            │                     │   ←── assistant/chunk
                            │                     │   ←── tool-call
                            │                     │   ←── subagent/end
   POST dispatch_interrupt ──→                     │   ──→ abort
   POST dispatch_list ──→                          │   ──→ status
   POST dispatch_get ──→                           │   ──→ read session log
                            └─────────────────────┘
```

## v0.3 vs v0.2 真实数字对比

| 维度 | v0.2 | v0.3 |
|---|---|---|
| RPC 方法 | 6 (dispatch_task, get_dispatch + JSON-RPC base) | 11 (新增 5 个) |
| 共享历史 | 无 | persistent session + cold-resume |
| 实时性 | 火-等 | 火-等 + SSE 推送 |
| 跨重启 | SQLite 幂等 + dispatch 审计 | 幂等 + 子 agent 注册表 |
| Token 共享 | 88% cache hit (foundation) | 同上 + 跨轮 session 缓存 |

## 实测命令

```powershell
# 1. 静态
node scripts/smoke-test.mjs     # 3 包 × 17 项 → [smoke] OK
node scripts/test-schema.mjs    # 12 case → [test-schema] OK

# 2. 运行时
curl http://127.0.0.1:3080/mcp/dispatch/health
# → {"ok":true,"version":"0.3.0","active_children":1}

# 3. 端到端准备
node scripts/sse-peek.mjs "http://127.0.0.1:3080/mcp/dispatch/stream?child_id=<id>" 15000

# 4. 派单 + 验
$body = Get-Content scripts/test-v03-spawn.json -Raw
Invoke-WebRequest "http://127.0.0.1:3080/mcp/dispatch" -Method POST -Body $body -ContentType "application/json"
```

## 已知限制 / 留给 v0.3.1

| 项 | 优先级 | 说明 |
|---|---|---|
| `dispatch_get` 不读冷 session log | 中 | 当前只读 live agent；cold-only 需从 `~/.dsh/sessions/<id>/session.jsonl.zstd` 解 zstd |
| 子 agent 无"先发 followup 再 spawn"模式 | 低 | 一次性发多条 followup 需要串行 |
| SSE 端点 `/mcp/dispatch/stream?child_id=` | 中 | 同一 SSE 不能订阅多个 child（要每个 child 一个连接） |
| `dispatch_list` 分页 | 低 | 默认 50，可调，但复杂场景需 cursor |
| 真实 bearer token (v0.3 → v0.4) | 中 | dsh webServer 仍 loopback only |

## 复盘

1. **Cold-resume 是真香的** —— dsh 的 `subagents.followup` 内部自动 cold-resume 持久 child，省了 v0.3 自己实现 activation 复活。
2. **Activation 寿命短是设计** —— dsh 的 continuation manager 把 child 调度为"按需激活"，Hermes 误以为 service 死了其实是 idle。改 `waitForNextReply` 查 session 不查 agent 就稳了。
3. **`Background subagent X reported` 这是 dsh 的 settlement 通道** —— Hermes 已经在 dsh 主会话里直接看到 settlement，无需自己跑 SSE 抓总结。SSE 的真正价值是**中间**事件（assistant/chunk、tool-call），不是结果。
4. **shared context 的实质** —— persona 注入 + 持久 session events + cold-resume = Hermes 派一个 child 跑半天，期间 N 次 followup，Hermes 看不到中间过程也无所谓，结束时 dsh 自动把 settlement 投回主会话。
