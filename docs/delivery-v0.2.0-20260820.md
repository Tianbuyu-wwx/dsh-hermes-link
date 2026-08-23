# v0.2.0 交付报告 — 2026-08-20

## 范围

`hermes-dispatch-bridge` 从 v0.1.0 (audit-only) 跃升到 v0.2.0 (real sub-agent spawn)。

## 已交付（实测跑通）

| 项 | 验证命令 / 指标 | 实测 |
|---|---|---|
| `ctx.subagents.start('spawn', ...)` 真子 agent spawn | `POST /mcp/dispatch dispatch_task` 合法 spec | subagent_session_id 实生成,2-10s 完成 |
| `toolFilter: { allow: [skill] }` 工具限制 | sub-agent 收到"do not call tools beyond"指令 | ✅ 实际严格遵循 |
| foundation slice 注入 (≤4KB) | `persona` 字段承载 SOUL/USER/MEMORY 切片 | ✅ 缓存命中 88% (cacheReadTokens=5632) |
| SQLite 持久幂等表 | `node:sqlite` DatabaseSync + WAL | file 4KB,2 行 seen,重启 ds 不丢 |
| `tokenMeter.measure(localAgent.session)` 真实 token | post-run 调用 | total=7088/6391,usage 含 inputTokens/cacheReadTokens |
| AbortController deadline | `deadline_ms: 45000` 测试 | ✅ 通过 timer + AbortController |
| 错误分段审计 | `error.code: -32010/32011` + `status: "error"` | 已实现 |
| 幂等回查 (含状态) | 同 task_id 第二次 | `error.code: -32004` + `data.output_excerpt` 回查 |

## 自检命令

```bash
# 1. 静态结构
node scripts/smoke-test.mjs     # 3 包 × 17 项 → [smoke] OK
node scripts/test-schema.mjs    # 12 case → [test-schema] OK

# 2. 运行时
curl http://127.0.0.1:3080/mcp/dispatch/health
# → {"ok":true,"version":"0.2.0","provider":"spawn",
#    "parent_agent":"session-...","state_path":"...\\idempotency.sqlite"}

# 3. 端到端
curl -X POST http://127.0.0.1:3080/mcp/dispatch \
  -H "content-type: application/json" \
  -d @scripts/test-dispatch-002.json
# → metadata.rec.subagent_session_id 存在
# → metadata.rec.real_tokens.total_tokens > 0
```

## 关键文件

- `packages/hermes-dispatch-bridge/index.mjs` — 350 行 v0.2 实现
- `packages/hermes-dispatch-bridge/dispatch-spec.schema.json` — version enum: `["0.2"]`
- `packages/hermes-dispatch-bridge/package.json` — version: `0.2.0`
- `packages/hermes-dispatch-bridge/skills/hermes-dispatch-bridge/SKILL.md` — 已重写

## 验证日志 (2026-08-20T13:39-13:40 实跑)

```
audit lines: 5
  2026-08-20T13:39:33.523Z [running] v0-2-smoke-001 stop=undefined elapsed=-ms
  2026-08-20T13:39:44.084Z [completed] v0-2-smoke-001 stop=completed elapsed=10561ms
  2026-08-20T13:40:05.151Z [running] v0-2-smoke-002 stop=undefined elapsed=-ms
  2026-08-20T13:40:07.228Z [completed] v0-2-smoke-002 stop=completed elapsed=2077ms

SQLite seen table:
  {"task_id":"v0-2-smoke-001","status":"completed","stop_reason":"completed","excerpt_len":2070}
  {"task_id":"v0-2-smoke-002","status":"completed","stop_reason":"completed","excerpt_len":21}

真实 token 拆解 (v0-2-smoke-002):
  total_tokens: 6391
  surface_tokens: 1892
  baseline.usage:
    inputTokens: 745
    outputTokens: 14
    cacheReadTokens: 5632    ← 88% cache hit 证明 foundation slice 复用
```

## 已知限制 / 留给 v0.2.1 / v0.3

| 项 | 优先级 | 备注 |
|---|---|---|
| `model_tier: vision` 实际 fallback 到 flash | 中 | 等 pi-ai qwen-vl 路由接好 |
| ajv-grade schema 升级 | 低 | 轻量子集已通过 12 case;JSON Schema 1999-valid |
| postinstall 钩子自动 `hermes mcp add ...` | 低 | 用户手动一次即可 |
| 正式 `dependencies` 声明 + pnpm install | 低 | 当前靠 node_modules junction 临时桥 |
| `knowledge_subset` 实际文件读取注入 | 中 | 现在 persona 不展开 `source` 文件;子 agent 自行读 |
| bearer token + 反向隧道 | v0.3 | 远端安全 |

## 复盘

1. **persona 注入非常有效** —— 模型严格遵守 persona 里的"do not call tools beyond the one allowed tool",即使挂着 read 也拒绝做 grep。
2. **DeepSeek 缓存可观测** —— `cacheReadTokens` 数字证明 Hermes→DSH 派单前后 foundation 切片被识别为前缀,这是隐性收益。
3. **DSH 提供 `subagent-spawn-in-process` 抽象,无需手动配 Context** —— 直接 `ctx.subagents.start('spawn', ...)` 即可拿到自包含的子 agent。
4. **SQLite 在 Node 22.5+ 是 stable** —— `node:sqlite` 是个好选择,避免 better-sqlite3 的 native build。
