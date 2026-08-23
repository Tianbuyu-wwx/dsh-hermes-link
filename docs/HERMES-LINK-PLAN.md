# Hermes ↔ DSH Link 方案 (v2)

> **状态:已于 2026-08-21 全部实现**(hermes-link v0.2.0,见 `docs/delivery-v0.6.0-20260821.md`)。本文件保留为设计档案。
> 与原文的差异:DSH→Hermes 通道采用文件协议(Hermes gateway 无公开 consult 端点);SSE 流与反向隧道未实现(路线图保留)。

> 单一 Cordis 插件 `hermes-link` 取代旧的 hermes-foundation / hermes-oneshot-arbitrate / hermes-dispatch-bridge 三件套。
> Hermes 与 DSH **双向对称**互通：**用户视图级**（侧边栏会话合并 + 人设/记忆按需加载） + **agent 级**（任务 dispatch + 主动咨询）。

---

## 0. Hermes 真实形态（写代码前必须知道的）

**Hermes 跟之前以为的完全不一样**，不是简单 CLI，而是个完整 AI agent 系统：

| 项目 | 路径 / 内容 |
|---|---|
| 数据根 | `C:\Users\Tianbuyu\AppData\Local\hermes\` （**不是** `~/.hermes/`—— 那个是 Edge 浏览器 profile） |
| 主入口 | `hermes-agent/venv/Scripts/python.exe -m hermes_cli.main` |
| Gateway | `python -m hermes_cli.main gateway run`（**Hermes 自带 HTTP gateway，detached 启动**） |
| 人设 | `SOUL.md` (10 行 ~1.4KB) + `memories/MEMORY.md` (~3.5KB) |
| 会话 | `sessions/request_dump_<sid>_<ts>.json` — **Anthropic API 格式**的 request dump，每个 0.5-1.6MB |
| Skills | `skills/<name>/SKILL.md` 完整 skill 库（含 `deepseek-harness` 等） |
| 状态 | `state.db` (SQLite) + `kanban.db` + `projects.db` + `verification_evidence.db` |
| 配置 | `config.yaml` (7.9KB, 235 行) — 含 model/personality/skin/toolsets/mcp_servers |
| 主题 | `apps/desktop/dist/hermes-frames` (Electron 桌面 app, `skin: nahida` 原神皮肤) |
| **重要** | `~/.hermes/` (用户家目录下那个) 是 **Microsoft Edge 浏览器 profile 目录**，跟 Hermes Agent **毫无关系**！Edge 把它当 cache dir |

**Hermes 端已经在 `config.yaml` 里配了 dsh-bridge MCP**：
```yaml
mcp_servers:
  dsh-bridge:
    url: http://127.0.0.1:3080/mcp/dispatch  # ← 旧路径, 新方案要改成 /mcp/collab
    enabled: true
```
所以下行通道**早就有 client 端**，DSH 端只要把路径换名就行。

---

## 1. 旧思路复盘 & 新方案核心取舍

### 旧思路问题（三个插件拆三层）
- **过度工程**：3 个插件 × 3 处安装/卸载钩子 × 3 处 service locator
- **"双向"是假的**：Hermes→DSH 有（HTTPS dispatch），DSH→Hermes 只有子 agent 兜底 CLI 调；**主 session 不能主动问 Hermes**；Hermes 不能中途 amend 子 agent
- **协议膨胀**：JSON-Schema + SQLite + audit + token projection 复杂，但实际用不到
- **没有用户视图同步**：DSH 侧边栏看不到 Hermes 历史会话，用户想"接着几个月前的 Hermes 会话继续开发"完全没路径

### 新方案核心取舍
| 取舍 | 旧 | 新 |
|---|---|---|
| 插件数 | 3 | **1** `hermes-link` |
| Hermes→DSH 下行 | `/mcp/dispatch` | `/mcp/collab`（路径改，Hermes 端 config 改 URL 即可） |
| DSH→Hermes 上行 | 仅子 agent CLI 兜底 | **走 Hermes gateway HTTP API**（Hermes 自带 gateway）+ 文件 fallback |
| 用户视图同步 | ❌ 没有 | ✅ **侧边栏合并**（DSH Session + Hermes Session 共列） |
| 会话继续开发 | ❌ | ✅ **按需灌全文**（点开 Hermes 会话 → 格式转换 → `ctx.sessions.create` seed → 列表里出现新 DSH session） |
| 人设/记忆加载 | 启动切片 ≤16KB | **按需 tool 加载**（`load_hermes_persona`）— 启动 0 字节 |
| 协议字段 | ~30 | **~10** |
| 持久化 | SQLite + WAL | **in-memory map + 文件** |
| 旧插件 | 3 个残留 | install 脚本顺手 unlink |

---

## 2. 互通清单 (按用户视图 + agent 通信分两类)

### A. 用户视图同步（核心新增，MVP 必做）

| # | 内容 | 通道 | 触发 |
|---|---|---|---|
| V1 | **侧边栏合并显示**：DSH Web GUI 侧边栏同时列 DSH session 和 Hermes session 摘要（标题/首句/时间/source-tag） | DSH **session-projection** + `ui-sidebar` 自动列（不用改 sidebar 客户端代码） | Hermes session 文件 `mtime` 变更 |
| V2 | **点开 Hermes 会话 → 新 DSH session**：把 `request_dump_*.json` 转成 DSH SessionEvent[] → `ctx.sessions.create(id, { seed, meta })` | Cordis `ctx.sessions` API | 用户点 sidebar 的 Hermes row |
| V3 | **人设按需加载**：`load_hermes_persona` tool，user 调时读 `SOUL.md` + `MEMORY.md` 全量 + 注入 system prompt | Tool API | user 调 tool |
| V4 | **Hermes 端反向可见 DSH session**（TODO v0.2）：DSH session 写一份 mirror 到 Hermes `inbox/` 让 Hermes gateway 能感知 | 文件 append | `session/event` hook |

### B. Agent 通信（次要，MVP 部分做）

| # | 内容 | 通道 | 频度 | MVP? |
|---|---|---|---|---|
| H1 | Hermes → DSH `dispatch_task`（结构化任务下发） | HTTP `/mcp/collab` (JSON-RPC 2.0) | 每次任务 | **✅** |
| D1 | DSH → Hermes task_result 回传 | **Hermes gateway HTTP API**（主） + 文件 outbox/ 备份（次） | 每次任务 | **✅** |
| D2 | DSH 主 session / 子 agent 主动 `consult_hermes`（Hermes gateway API 同步调用） | Hermes gateway HTTP | 偶尔 | **✅** |
| H4 | Hermes 中途 amend 子 agent | 文件 amend/ + DSH fs.watch | 偶尔 | ⏭ TODO |
| D3-D7 | 心跳/usage/session-tap/audit/memory-suggest | 文件 | - | ⏭ TODO |

### 共享根目录
`C:\Users\Tianbuyu\AppData\Local\hermes\`（**用 Hermes 自己的家目录**，不另起 ~/.dsh/hermes-link/）
```
Hermes Home/
├── SOUL.md                                 # V3: 人设按需加载
├── memories/MEMORY.md                      # V3: 记忆按需加载
├── config.yaml                             # V3: 加载以同步模型/personality
├── skills/<name>/SKILL.md                  # H3: Hermes 挑选下发
├── sessions/request_dump_*.json            # V1: 侧边栏列, V2: 按需灌
├── inbox/dsh/                              # NEW: DSH 写给 Hermes 的 mirror (V4)
│   ├── dispatch-result/{task_id}.json
│   └── session-mirror/{dsh_session_id}.jsonl
└── outbox/hermes/                          # NEW: Hermes 给 DSH 的主动通知 (D1/H4)
    └── task-event/{task_id}.json
```

---

## 3. 架构

```
         Hermes (Electron + Python venv)              DSH (Cordis)
                       │                                       │
        ┌──────────────┴──────────────┐         ┌─────────────┴─────────────┐
        │  python -m hermes_cli.main │         │  packages/hermes-link/   │
        │  gateway run                │         │  ├── index.mjs            │
        │  ↓                           │         │  │   - /mcp/collab (HTTP)  │
        │  Hermes Gateway HTTP API    │◄───────►│  │   - session-importer    │
        │  (port ?, see §4)            │  HTTP   │  │   - persona-loader tool │
        │  ↓                           │         │  │   - hermes-link sv      │
        │  sessions/ skills/ memories/ │         │  ├── package.json         │
        │  SOUL.md config.yaml state.db│   fs    │  ├── cordis.patch.yml     │
        └─────────────────────────────┘◄───────►└──────┬──────────────────────┘
                                                          │
                                                          ▼
                                                  ctx.sessions.create(...)
                                                  ctx.subagents.start('spawn', ...)
                                                  ctx.tokenMeter.measure()
                                                  ctx.sessionProjections.register(...)
```

### Cordis patch 钩子 (host-plane)
| 钩子 | 干啥 | MVP? |
|---|---|---|
| `session/created` | 新 session 进 store；Hermes-imported 标记加到 header | ✅ |
| `session/event` | DSH session 内容 mirror 到 Hermes `inbox/dsh/session-mirror/` | ⏭ TODO |
| `session/flush` | flush 时保证 mirror 写完 | ⏭ TODO |
| HTTP `POST /mcp/collab` | H1 任务下发 → `ctx.subagents.start('spawn', ...)` | ✅ |
| fs.watch `Hermes Home/sessions/` | V1: 新 request_dump 出现 → 列表更新 | ✅ |
| service `hermes-gateway-client` | D1/D2: Hermes gateway HTTP API client | ✅ |
| service `hermes-session-importer` | V2: 转换 request_dump → DSH SessionEvent | ✅ |
| tool `consult_hermes` | D2: 主 session + sub-agent 都可用 | ✅ |
| tool `load_hermes_persona` | V3: 按需加载人设 | ✅ |
| tool `list_hermes_sessions` | V1: sidebar 数据源（也走 projection） | ✅ |
| tool `import_hermes_session` | V2: 手动触发（不只 sidebar 点击） | ✅ |
| projection unit `hermes-session-meta` | V1: 把 Hermes session 作为额外 projection 注入 session | ⏭ TODO v0.2 |

---

## 4. MVP 协议细节

### H1: Hermes → DSH dispatch (HTTP POST /mcp/collab)

请求（JSON-RPC 2.0）：
```json
{
  "jsonrpc": "2.0",
  "id": "uuid",
  "method": "tools/call",
  "params": {
    "name": "dispatch_task",
    "arguments": {
      "task_id": "t-2026-08-21-001",
      "skill": "web-search",
      "task": "查 GitHub 上 stars 最多的 5 个 React 状态管理库",
      "args": {},
      "knowledge_subset": ["react-state-mgmt.md#top5"],
      "model_tier": "sonnet",
      "max_tokens": 4096,
      "deadline_ms": 60000
    }
  }
}
```
响应（同步阻塞）：`{status, output, tokens_used, error, started_at, finished_at}`

10 字段精简，无 audit/projections/bounds 累赘。

**Hermes 端配置改**（`config.yaml`）：
```yaml
mcp_servers:
  dsh-bridge:
    url: http://127.0.0.1:3080/mcp/collab  # 旧 /mcp/dispatch → 新 /mcp/collab
```

### D1: DSH → Hermes 结果回传（走 Hermes gateway HTTP API + 文件备份）

**主路径**：调 Hermes gateway（端口待 §4.1 确认）
```
POST http://127.0.0.1:<HERMES_GATEWAY_PORT>/v1/notify/task-done
Content-Type: application/json
{
  "task_id": "t-2026-08-21-001",
  "status": "ok|error",
  "output": "...",
  "tokens_used": 1234,
  "finished_at": "..."
}
```
**备用**：同时写文件 `Hermes Home/inbox/dsh/dispatch-result/{task_id}.json`（atomic rename），Hermes 端 watcher 拾取。

### D2: DSH 主动 consult Hermes
```
POST http://127.0.0.1:<HERMES_GATEWAY_PORT>/v1/consult
{ "prompt": "...", "context": {task_id, ...} }
→ { "answer": "..." }
```
或（Hermes gateway 不暴露这个时）：fallback 写文件 `Hermes Home/inbox/dsh/consult/{ts}.json`，等 Hermes 端 cron 拾取再回复（异步，慢）。

### V1: 侧边栏合并（Hermes session 列在 DSH sidebar）

**实现路径**：
- **不**改 ui-sidebar 客户端代码（不可控）
- 用 **session-projection 注册自定义 unit** + **ctx.sessionProjections.snapshot()**
- 或者更简单：**tool `list_hermes_sessions`** 提供给 ui-sidebar/前端，DSH sidebar 是 client 端，由 ui-sidebar 自己决定怎么列（**但 ui-sidebar 是客户端插件，不属于 host-plane 范围**）
- **退而求其次**：写一个 service 给 host plane 的 sidebar 数据源；DSH sidebar 在 web 端按 host 提供的 sessions list + 我们注入的 Hermes list 合并

但其实**更优雅的方案**：把 Hermes session **真的变成 DSH session**（见 V2），DSH sidebar 自然列。

### V2: 点开 Hermes session → 真的变成 DSH session

**核心**：把 `request_dump_*.json` 格式转成 DSH `SessionEvent[]`，调 `ctx.sessions.create(id, { seed, meta })`

转换步骤：
1. 读 `request_dump_*.json` → 拿到 `request.body.messages[]`
2. 按 `role` 转成 DSH events：
   - `role: user` (text) → `user/message` event
   - `role: user` (tool_result) → `tool/result` event
   - `role: assistant` (text) → `assistant/message` event
   - `role: assistant` (tool_use) → `tool/call` event
3. 加 boundary events：`turn/start`, `step/start`, `step/end`, `turn/end`, `session/end-seed`
4. 给每条加 `surfaceOp: 'append'` 和递增 `sourceEventSeqs`
5. `ctx.sessions.create('hermes-' + session_id, { seed: events, meta: { cwd: process.cwd(), origin: undefined, agentPreset: 'hermes-imported' } })`
6. 系统提示注入（在 session header 加 `agentPreset: 'hermes-imported'` 后）：
   ```
   <hermes-imported-from>
   This session was imported from Hermes session <hermes_session_id>.
   You have full historical context. Continue development seamlessly.
   When the user requests operations that would normally be done in Hermes
   (SOUL/MEMORY/skills edit), call the corresponding hermes-link tool.
   </hermes-imported-from>
   ```
7. session-title 自动生成（已有 dsh-session-title-first-prompt-llm，会用 Hermes 首条 user msg 做标题）

**token 效率**：默认开启 `dsh-compaction-basic` + `dsh-tool-result-pruner`，自动压缩。

**用户在 sidebar 看到的**：标题同 Hermes 首句，source-tag 由 `agentPreset` 字段驱动（projection unit `hermes-session-meta` 显示 "↻ Hermes" 前缀）。

### V3: load_hermes_persona tool
```js
{
  name: "load_hermes_persona",
  description: "Load Hermes persona + memory into current session's system prompt. Use when user asks for Hermes context.",
  parameters: {
    scope: { enum: ["all", "soul", "memory", "config"], default: "all" }
  }
}
```
读 `Hermes Home/SOUL.md` + `Hermes Home/memories/MEMORY.md` + `Hermes Home/config.yaml` 关键段（model/personality/skin）→ 注入到当前 session 的 system prompt section（通过 `ctx.inject(['system-prompt'], ...)` 或追加消息）。

不预加载：启动时**完全不读**，只 tool 调用时才读。

---

## 5. 安装 / 卸载 / 自测

### 安装
```powershell
pwsh -File scripts/install-hermes-link.ps1
```
动作：
1. unlink 旧 4 个 hermes-* node_modules (`hermes-foundation`, `-oneshot-arbitrate`, `-dispatch-bridge`, `-dsh-collab`)
2. symlink `packages/hermes-link` → `~/.dsh/profiles/web/node_modules/hermes-link`
3. patch `~/.dsh/profiles/web/cordis.config.yml` 注册 hermes-link 服务
4. 提示用户改 Hermes `config.yaml`:
   - `mcp_servers.dsh-bridge.url`: `http://127.0.0.1:3080/mcp/dispatch` → `http://127.0.0.1:3080/mcp/collab`

### 卸载
```powershell
pwsh -File scripts/uninstall-hermes-link.ps1
```
反向操作，保留 Hermes 数据目录不动。

### 自测
```
node scripts/smoke-test.mjs                       # 静态结构
node scripts/test-import-request-dump.mjs         # V2 格式转换单测 (5 case)
node scripts/test-dispatch-schema.mjs             # H1 schema (5 case)
node scripts/test-hermes-gateway-client.mjs       # D1/D2 client (mock)
node scripts/verify-install.mjs                   # 装完 5 项核验
```

---

## 6. Hermes gateway 端口确认（写代码前必做）

**还没确认**——`hermes_cli.main gateway run` 启动后监听哪个端口？

执行计划：
1. 直接跑 `python -m hermes_cli.main gateway --help`（沙箱会拒，先 ask 用户执行贴输出）
2. 或读 `hermes-agent/hermes_cli/` 源码（Python 包，可读）
3. 或读 `Hermes Home/gateway_state.json`（如果 gateway 正在跑）

我会先 read 源码找端口；如找不到则 ask_user_question 让用户跑 `--help`。

---

## 7. 实施 TODO 列表

1. ✅ 写 `docs/HERMES-LINK-PLAN.md` (本文件)
2. 探 Hermes gateway 端口（读 hermes_cli 或 gateway_state.json）
3. 写 `packages/hermes-link/index.mjs` 主入口
4. 写 `packages/hermes-link/import/request-dump-to-events.mjs` (V2 格式转换)
5. 写 `packages/hermes-link/import/import-hermes-session.mjs` (V2 service)
6. 写 `packages/hermes-link/services/hermes-gateway-client.mjs` (D1/D2)
7. 写 `packages/hermes-link/tools/consult-hermes.mjs` (D2)
8. 写 `packages/hermes-link/tools/load-hermes-persona.mjs` (V3)
9. 写 `packages/hermes-link/tools/list-hermes-sessions.mjs` (V1)
10. 写 `packages/hermes-link/tools/import-hermes-session.mjs` (V2 tool)
11. 写 `packages/hermes-link/http/dispatch.mjs` (H1 /mcp/collab)
12. 写 `packages/hermes-link/cordis.patch.yml`
13. 写 `packages/hermes-link/package.json`
14. 写 `scripts/install-hermes-link.ps1` (含 unlink 旧 4 个)
15. 写 `scripts/uninstall-hermes-link.ps1`
16. 写 4 个测试脚本
17. 更新根 README.md + PACKAGES.md（删旧三件套表）

---

## 8. 风险 & 决策记录

| 风险 | 缓解 |
|---|---|
| Hermes gateway 端口未知 | 先读 hermes_cli 源码；查不到时 ask_user_question |
| `request_dump_*.json` 多次 dump 同一 session（失败重试） | 按 session_id 分组，时间倒序去重，合并 unique messages |
| DSH session header.cwd 必须绝对存在 | 用 `process.cwd()` (DSH 工作目录) 或 `Hermes Home`；Hermes-imported 用前者（用户当前 workspace） |
| `request_dump` tool_use/tool_result 缺 callId | 跳到 assistant 后面用 call_id 匹配；缺则丢 |
| DSH SessionEvent lossless JSON 校验（不能有 BigInt/Map/Date） | 转换时强制 toJSON + isJsonValue 自检 |
| Hermes session 巨大（1.6MB 单 dump） | 灌完调 dsh-compaction-basic 自动压；user 也可在 import tool 选 "summary only" |
| Hermes gateway 没启（用户没启动） | D1/D2 走文件 fallback；UI 提示"启动 Hermes gateway 以获得完整功能" |
| 旧 4 个 hermes-* 残留 | install 脚本 unlink；verify-install 检测 |
| mcp_servers.dsh-bridge URL 切换需要改 Hermes config | install 脚本自动提示 + 提供 sed 替换 |

---

## 9. 文件树 (最终)

```
dsh-hermes/
├── README.md                              # 改: 单列 hermes-link
├── PACKAGES.md                            # 改: 移除三件套表
├── docs/
│   ├── HERMES-LINK-PLAN.md                # 你正在看
│   └── dispatch-spec.md                   # 新: H1 协议文档
├── packages/
│   └── hermes-link/
│       ├── index.mjs                      # Cordis 入口
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── dispatch.schema.json           # H1 schema
│       ├── import/
│       │   ├── request-dump-to-events.mjs # V2 转换器
│       │   └── import-hermes-session.mjs  # V2 service
│       ├── services/
│       │   ├── hermes-gateway-client.mjs  # D1/D2 client
│       │   ├── hermes-session-watcher.mjs # V1 fs.watch
│       │   └── hermes-link.mjs            # 主 service 容器
│       ├── tools/
│       │   ├── consult-hermes.mjs         # D2
│       │   ├── load-hermes-persona.mjs    # V3
│       │   ├── list-hermes-sessions.mjs   # V1
│       │   └── import-hermes-session.mjs  # V2
│       ├── http/
│       │   ├── dispatch.mjs               # H1
│       │   └── health.mjs
│       └── skills/hermes-link/SKILL.md
└── scripts/
    ├── install-hermes-link.ps1            # 含 unlink 旧 4 个
    ├── uninstall-hermes-link.ps1
    ├── smoke-test.mjs
    ├── test-import-request-dump.mjs       # 新
    ├── test-dispatch-schema.mjs
    ├── test-hermes-gateway-client.mjs     # 新
    └── verify-install.mjs
```