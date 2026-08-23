# v0.5.0 交付报告 — 2026-08-20

## 范围

`hermes-foundation` 从 v0.4.0 升到 v0.5.0：**DSH 加载 Hermes 完整对话记录，而不只是最后一轮**。

用户反馈："我要的是 dsh 和 hermes 主界面的记录互通，dsh 直接载入两者的对话记录"。

## 改动

| 组件 | v0.4.0 | v0.5.0 |
|---|---|---|
| Hermes 写入 | `~/.dsh/hermes-inbox/latest.md`（覆盖，单轮） | `latest.md` + `session.jsonl`（JSONL 追加，完整历史） |
| DSH 读取 | `latest.md` | `session.jsonl`（全文 tail 32 KB），fall back to `latest.md` |
| 隔离 | per-agent `agent.ctx` | **保留** per-agent |
| 写入频次 | 每 turn | 每 turn |
| 文件大小 | ~1 KB | 持续增长，DSH 读 tail 防 OOM |

## 文件格式

`~/.dsh/hermes-inbox/session.jsonl`（JSONL，每行一个 turn）：

```json
{"ts":"2026-08-20T16:37:32.008Z","source":"structured","user":"turn 1 user","assistant":"turn 1 hermes"}
{"ts":"2026-08-20T16:37:32.058Z","source":"structured","user":"turn 2 user","assistant":"turn 2 hermes"}
{"ts":"2026-08-20T16:37:32.105Z","source":"structured","user":"turn 3 user","assistant":"turn 3 hermes"}
```

渲染到 system prompt 时：

```markdown
### Turn 1 — 2026-08-20T16:37:32.008Z
USER: turn 1 user
---
HERMES: turn 1 hermes

### Turn 2 — 2026-08-20T16:37:32.058Z
USER: turn 2 user
---
HERMES: turn 2 hermes
```

## 关键改动

1. **`scripts/hermes-push.mjs`**:
   - 新增 `session.jsonl` JSONL 追加写入
   - 保留 `latest.md` 覆盖（向后兼容）
   - 新增 `--reset-session` 标志（清空 session.jsonl）

2. **`packages/hermes-foundation/index.mjs`**:
   - 新增 `loadHermesSession()` 函数
   - 读 `session.jsonl` tail 32 KB
   - 解析 JSONL → 渲染 markdown
   - `loadHermesInbox()` 优先用 session.jsonl，降级到 latest.md

3. **`packages/hermes-foundation/package.json`** → v0.5.0

## 验证

| 项 | 状态 |
|---|---|
| `node scripts/smoke-test.mjs` | ✅ OK |
| `node --check` | ✅ OK |
| `--reset-session` | ✅ 已测 |
| 3 turns push 到 session.jsonl | ✅ 248 chars rendered |
| session.jsonl 持久化 | ✅ 3 行 |
| latest.md 同步 | ✅ 仍是 turn 3 |
| 端到端（DSH session-start 读 session.jsonl） | ⏳ 等 dsh restart 加 v0.5.0 |
| 隔离验证（sub-agent 仍看不到） | ⏳ 同上 |

## 实时性

- DSH 启动新 session 时 → 读 session.jsonl，看到完整 history
- 不重启情况下无法看到新增 turns（已有 v0.4 的限制）
- 如需保留所有老 turns：用户可定期把 session.jsonl 归档（手动 / cron）

## 已知限制

- DSH **mid-session** 看不到新增 turns（要 restart session）
- session.jsonl 无 size cap（持续增长），DSH 读时只 tail 32 KB
- 完全对称方向（DSH → Hermes 完整 session）暂未实现——Hermes 已经能通过 `hermes-view-dsh.mjs` 看 audit + child 注册表，但 DSH 自己的 session log（`~/.dsh/sessions/<id>/session.jsonl.zstd`）还是 zstd 压缩的，需要解压才能看

## 复盘

1. **v0.4 → v0.5 的边界**：v0.4 只写 latest.md 是 diagnostic-friendly 但丢失了 history；v0.5 解决这一点
2. **JSONL 比 md 适合 append**：每行独立 JSON，DSH 端可以 tail 读最近 N 字节而不需要 parse 全文
3. **32 KB cap 是保守值**：实测一次 `dispatch_task` 子 agent 上下文 ≤ 10 KB，foundation slice 16 KB，hermes-inbox 8 KB；总共 ~34 KB，DSH 主 session 还有自己的 user prompt + 当前 history 空间
4. **fallback 到 latest.md**：v0.4 用户升级到 v0.5 后老的 latest.md 还能用，不会丢失
