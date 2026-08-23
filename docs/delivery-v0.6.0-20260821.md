# v0.6.0 交付报告 — 2026-08-21 (hermes-link v0.1 → v0.2)

## 范围

按审计清单完成 `hermes-link` 插件 P0–P2 全部工作,将 v0.1 的能力补全为双向、可审计、可持续的完整互通:

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | consult `timeout_ms` 修复 + 单测;**hermes-inbox 共享记录迁入**(原 hermes-foundation v0.6/v0.7 能力,插件已禁用故此前实际丢失) | ✅ |
| P1 | 4 个 DSH 侧 Cordis tools;dispatch 真实 token 回传;README/PACKAGES 单插件化;旧脚本归档;schema/consult 单测补齐 | ✅ |
| P2 | continuable mode + followup/interrupt/list/get;H4 amend;V4 session mirror;D3–D7 心跳/usage/audit/memory-suggest;bearer token | ✅ |

## 新增/改动的文件

### packages/hermes-link/ (v0.2.0)
| 文件 | 内容 |
|---|---|
| `services/hermes-inbox.mjs` | **迁移自 hermes-foundation v0.7**:共享记录 `~/.dsh/hermes-inbox/session.jsonl` 的读取/渲染/注入;工具 `hermes_inbox` / `hermes_inbox_append`;`agent/session-start` 时向主 session(仅 depth=0,hermes-imported 除外)注入最近 20 轮 Hermes 对话,compaction marker 防重注入 |
| `services/consult-hermes.mjs` | **修复**:`consult(prompt, ctx, timeoutOverride)` 第三参数生效——之前 `timeout_ms` 被丢弃,永远等 30s |
| `services/audit.mjs` | D4:dispatch/import/consult 审计落盘 `~/.dsh/hermes-link/audit.jsonl` |
| `services/outbox.mjs` | D3 心跳(60s,`heartbeat/latest.json`)、D6 usage(`usage.jsonl`)、D7 memory-suggest(`memory-suggest/<ts>.json`)、V4 session-mirror(`session-mirror/<sid>.jsonl`,跳过 hermes-* 与噪音事件) |
| `services/continuations.mjs` | P2-10:continuable 子 agent SQLite 注册表(重启存活)+ `waitForNextReply` |
| `services/amend-watcher.mjs` | H4:轮询 `Hermes Home/inbox/dsh/amend/*.json` → `ctx.subagents.followup` 投递,已处理文件移入 `done/` |
| `tools/*.mjs`(4 个) | **DSH 会话内可直接调用的工具**:`list_hermes_sessions`、`import_hermes_session`、`load_hermes_persona`、`consult_hermes`(此前只有 HTTP 端点,SKILL 宣称的工具并不存在) |
| `http/dispatch.mjs` | v0.2:bearer auth(**env `HERMES_LINK_TOKEN`**,除 /health 外全部门禁);audit+usage;one-shot 真实 token(`tokenMeter.measure(run.localAgent)`);`dispatch_task mode=continuable` + `dispatch_followup` / `dispatch_interrupt` / `dispatch_list` / `dispatch_get` / `get_dispatch`;`POST /mcp/collab/memory-suggest`;导出 `validateSpec`/`formatPersona`/`clampInt` 等供单测 |
| `index.mjs` | 装配全部新服务:inbox 工具 + session-start 注入 + session/event mirror hook + 心跳 + amend watcher + 4 tools + 新路由 + `GET /mcp/hermes-inbox/health`(兼容 `hermes-push.mjs --status`);版本 v0.2.0 |
| `dispatch-spec.schema.json` | `mode: [one-shot, continuable]`,`provider`, `shared_history_n` |
| `skills/hermes-link/SKILL.md` | 工具表、RPC 工具、文件协议、auth 全部更新 |

### scripts/
| 文件 | 内容 |
|---|---|
| `test-consult-client.mjs` | **新增**,5 case(含 timeout 覆盖回归) |
| `test-dispatch-schema.mjs` | **新增**,13 case(validateSpec + clampInt + formatPersona) |
| `import-check.mjs` | **新增**,16 模块全量加载检查(需要仓库内 `node_modules/@deepseek-ai` junction 指向 DSH 实例) |
| `smoke-test.mjs` | 覆盖 20 文件 + 16 语法检查(spawnSync 免捕获模式,沙箱可用) |
| `install-all.ps1` / `uninstall-all.ps1` | 改为 hermes-link 安装器的旧名兼容包装 |
| `hermes-view-dsh.mjs` | 状态路径改到 `~/.dsh/hermes-link/{audit.jsonl,continuables.sqlite}` |

## 自检结果

| 项 | 结果 |
|---|---|
| `node scripts/smoke-test.mjs` | ✅ 58/58 |
| `node scripts/test-dispatch-schema.mjs` | ✅ 13/13 |
| `node scripts/test-consult-client.mjs` | ✅ 5/5 |
| `node scripts/test-request-dump.mjs` | ✅ 8/8 |
| `node scripts/import-check.mjs`(16 模块全量加载) | ✅ 16/16 |
| 运行时端到端(dispatch/import/consult 回环、H4 投递、V4 镜像) | ⏳ **待 dsh 重启加载 v0.2.0 后验证**(当前 3080 实例仍运行 v0.1) |

## 运行时自检增补(v0.2.0 重启加载后)

| 项 | 结果 |
|---|---|
| 插件加载、健康检查、v0.2 工具出现在 DSH 会话工具列表 | ✅ |
| `agent/session-start` Hermes 对话注入(本会话顶部出现 `[from Hermes conversation]` 系列消息;assistant 消息按 dsh-session 校验要求使用嵌套信封 `{turn,step,message}`——该形状修正已在仓库内) | ✅ |
| 6 个工具调用(`list_hermes_sessions` / `hermes_inbox` 实测) | ⚠️ **发现并修复**:DSH 工具运行时要求 `output.render`,缺省报 `output.render failed: userRender is not a function`。已为全部 6 个工具(tools/ 4 个 + hermes-inbox 2 个)补 `render`,**待下一次重启生效** |
| HTTP 端到端冒烟(`scripts/smoke-e2e.mjs`:dispatch one-shot / continuable+followup / H4 amend / consult 超时 / audit / auth 门禁共 10 项) | ⏳ 待二次重启 + pwsh 恢复后执行 |

## 环境备注

仓库根新增 `node_modules/@deepseek-ai` junction → DSH 实例(node_modules 在 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules`),用于脱离 DSH 的模块级自检;`.gitignore` 已含 `node_modules/`,不入库。

## 行为变化(从 v0.1 → v0.2)

1. `/mcp/collab/consult` 尊重 `timeout_ms`(缺省仍是 30s)
2. `dispatch_task` 默认 one-shot 不变;`mode=continuable` 返回 `child_id` 后可 followup/interrupt
3. 主 DSH session 启动时会看到 Hermes 最近对话注入在最顶部(`[from Hermes conversation]` 前缀)——v0.5.0 的用户诉求恢复
4. DSH session 内可以直接 `list_hermes_sessions` / `import_hermes_session` / `load_hermes_persona` / `consult_hermes`
5. 设置了 `HERMES_LINK_TOKEN` 时,除 `/health` 外所有 `/mcp/collab*` 需要 Bearer 头
6. Hermes 侧拿到 `dispatch-result/<task_id>.json` 时已含 `tokens_used`(真实测量,不再为 null)

---

## v0.2.1 hotfix — 关闭主 session 自动注入

**问题**:v0.7 → v0.2.0 在 `agent/session-start` 钩子里调用 `injectHermesTurns`,把 `~/.dsh/hermes-inbox/session.jsonl` 最近 20 轮无差别写进主 session 的 `Session.events`。该共享记录是 hermes-push.mjs 写入的**全局、不区分 cwd**,所以跨项目时(用户在 DSH 跑 A 项目,但 Hermes 在跑 B 项目,二者无关)会把 B 的对话灌进 A 的 session 顶部,污染上下文,而且一旦写入就**永久**(`Session.events` 是 append-only / deep-frozen,DSH 不提供删除 API)。

**修复**:
1. `index.mjs` 的 `agent/session-start` 钩子不再调用 `injectHermesTurns`。`injectHermesTurns` 函数仍保留并导出,作为未来 opt-in / 按 cwd 注入方案的备用。
2. 新增 Cordis 工具 **`hermes_clear_injected`**(services/hermes-inbox.mjs):扫描当前主 session 的 events,统计 `id` 以 `hermes-injected-` 开头的 `user/message` + `assistant/message`,以及 `compaction/start` with `endsWith('hermes-inbox-injection-marker')` 的 marker,返回:
   ```json
   { ok: true, session_id, agent_preset, delegation_depth,
     counts: { user_injected, assistant_injected, marker_found },
     total_injected_events,
     note: 'Session.events are append-only / deep-frozen; cannot be removed retroactively',
     suggestion: 'open a New session in the DSH GUI' }
   ```
   **这是审计工具,不修改任何状态**。老实告诉用户:那些污染没法回滚,唯一干净的办法是开新 session(新 session 不会再被注入)。

**v0.2.1 → 新主 session 行为**:零 Hermes 上下文。要看 Hermes 历史用 `hermes_inbox` 工具按需读(返回 markdown 渲染到聊天里,不修改 events)。

**已污染的 session**:用 `hermes_clear_injected` 看清楚到底有多少条;然后开新 session。

**已改文件**:
- `index.mjs`(注释 + 钩子替换)
- `services/hermes-inbox.mjs`(`sessionHasHermesMarker` export + `hermes_clear_injected` 工具 + 头部 doc 更新)
- `skills/hermes-link/SKILL.md`(描述 + 工具表 + 第 7 节文案)
- `README.md`(用户视图线段 + 路线图新增 v0.2.1 行)
- `docs/HERMES-LINK-PLAN.md` 头部状态仍为 "v0.2.0 全部实现"(v0.2.1 是对设计本身的修正)

---

## v0.2.2 hotfix — 关闭剩余 4 个"跨界污染"严重问题(S1–S4)

### S1: V4 session-mirror 自动写 → opt-in 工具

**问题**:`index.mjs` 里 `ctx.on('session/event', ...)` 把 DSH 主 session 的全部事件(用户输入 + assistant 输出 + tool_calls)写到 Hermes `inbox/dsh/session-mirror/<sid>.jsonl`。**这是 v0.2.1 关掉的主 session 注入的对称问题**(只是方向反过来)。当用户切换项目,DSH 新项目会话的内容也写到 Hermes 默认目录,污染 Hermes 端的索引。

**修复**:
- `index.mjs` 移除 `ctx.on('session/event', ...)` 整个块
- 新增 Cordis 工具 **`mirror_session_to_hermes`**(`tools/mirror-session-to-hermes.mjs`):默认 `redact=true` 走 `redactEvent`(脱敏 OpenAI/Anthropic/AWS/GitHub/Slack/PEM/JWT/通用 key=value 等),把当前主 session 的 events 写到 Hermes mirror 文件
- 工具**只**在用户显式调用时运行;绝不自动

### S2: H4 amend 文件无认证 → nonce 后缀

**问题**:`Hermes Home/inbox/dsh/amend/<ts>-<task_id>.json` 仅靠 `task_id` 路由,**任何人**能写 Hermes 文件系统就能改运行中的子 agent。比 consult reply 攻击面更严重(amend 直接进 sub-agent inbox)。

**修复**:v0.2.2 协议:
- DSH `dispatch_task mode=continuable` 时为每个 child 生成 32 hex nonce(`amend_nonce`),存入 SQLite `continuable_children.amend_nonce`,并通过 metadata 返回给 Hermes
- amend 文件必须命名为 `<ts>-<task_id>-<nonce>.json`
- DSH `amend-watcher` 解析文件名 → 验证 nonce 与注册表一致 → 才投递
- 旧 `<ts>-<task_id>.json`(两段) 直接移 `done/legacy-*` + `stats.rejected_legacy++`,**永不投递**
- 兼容开关:无(v0.2.2 必须升级 gateway/Hermes 端)

### S3: Consult reply 文件无认证 → secret 后缀

**问题**:`inbox/dsh/consult-reply/<ticket>.json` 的 ticket 是 UUID(无 secret),任何能写 Hermes 的人就能写一个 reply 喂给 DSH 子 agent。

**修复**:v0.2.2 协议:
- DSH 在 `consult()` 时生成 16 hex secret(`reply_secret`),写入 consult inbox payload
- Hermes-side pickup 必须读 payload 里的 secret,把 reply 文件命名为 `<ticket>-<secret>.json`
- DSH 只匹配 secret 后缀格式
- 兼容开关:`HERMES_LINK_TRUST_LEGACY=1` 启用,允许旧的 `<ticket>.json`(off by default 安全)
- 响应里多了 `reply_kind: 'secret' | 'legacy'`

### S4: Dispatch 灌 MEMORY.md → SOUL only + cwd 显式 opt-in

**问题**:`dispatch_task` 子 agent 收到的 foundation slice **包含 Hermes MEMORY.md**,而 MEMORY.md 通常记了 Hermes 跑过的所有项目的 notes。子 agent 哪怕是在 DSH 跑完全无关的项目,也会被这些全局笔记带着走。同类污染。

**修复**:
- `buildFoundationSlice(hermesHome)` 现在只读 SOUL.md(去掉 MEMORY),foundation slice 严格 ≤4096 chars SOUL
- 新增 **`services/hermes-project-memory.mjs`**:按 `agent.session.header.cwd` 与 Hermes `state.db.sessions.cwd` 精确匹配(大小写/尾斜杠规范化),只截取 MEMORY.md 里提到该 cwd 的连续块;**没匹配则返回空**
- 新增 Cordis 工具 **`load_hermes_project_memory`**:当前 session cwd-scoped 加载 Hermes MEMORY
- dispatch spec 新字段 **`include_project_memory: boolean`(default false)**:Hermes 显式 opt-in 时,DSH 把 cwd-matched MEMORY 块注入 persona envelope;off by default

### 已改文件

- `services/continuations.mjs`(schema ALTER ADD COLUMN、register 时生成 nonce、`validateAmendNonce`、`generateAmendNonce`、registryRowToEntry 加 amendNonce)
- `services/amend-watcher.mjs`(文件名三段解析 + nonce 验证 + 旧格式 legacy 拒绝 + 文件名/正文 task_id 双校)
- `services/consult-hermes.mjs`(reply_secret + secret 后缀 poll + `HERMES_LINK_TRUST_LEGACY` 兼容开关 + `consumeReply` 抽出)
- `services/hermes-project-memory.mjs`(新文件,state.db cwd 匹配 + MEMORY.md 上下文抽取)
- `tools/mirror-session-to-hermes.mjs`(新文件,opt-in + `redactEvent` 含 9 种 secret regex)
- `tools/load-hermes-project-memory.mjs`(新文件,cwd-scoped DSH 侧查看)
- `tools/mirror-session-to-hermes.mjs#redactEvent` 导出,供单测
- `index.mjs`(移除 session/event mirror hook;`buildFoundationSlice` 只 SOUL;注册两个新工具;VERSION → '0.2.2';`buildFoundationSlice` 导出供测试)
- `http/dispatch.mjs`(`include_project_memory` 在 persona envelope 注入;`formatPersona` 加 projectMemorySlice 块;continuable metadata 返回 `amend_nonce` + `amend_filename_pattern`)
- `dispatch-spec.schema.json`(title v0.2.2;加 `include_project_memory: boolean`)
- `skills/hermes-link/SKILL.md`(描述、工具表、文件协议、矢量图同步)
- `README.md`(用户视图线段、自测清单、文件协议表、路线图、矢量图)
- `scripts/smoke-test.mjs`(文件 + 语法检查列表)
- `scripts/test-services.mjs`(加 `project-memory` cwd 匹配 + 老库 ALTER 升级 + amend_nonce roundtrip)
- `scripts/test-amend-security.mjs`(新;5 case)
- `scripts/test-consult-security.mjs`(新;4 case)
- `scripts/test-foundation-policy.mjs`(新;4 case)
- `scripts/test-mirror-opt-in.mjs`(新;8 case)

### Hermes-side pickup 升级要点(breaking change)

- Hermes 网关写 consult reply 时:文件名 `<ticket>-<secret>.json`(从 consult payload 读 `reply_secret`)
- Hermes 网关写 amend 时:文件名 `<ts>-<task_id>-<nonce>.json`(从 dispatch_task 响应读 `amend_nonce`)
- 否则 DSH 会**直接拒绝**文件(legacy 格式入 done/ignored)

## 已知限制(计划外/未来)

- SSE 流(`/mcp/dispatch/stream` 时代的实时观察)未移植;continuable 由 followup 返回值观察
- 反向隧道(跨机/防火墙)未做,仅 bearer token;README 路线图保留条目
- session.jsonl / mirror / usage 文件无自动轮转,建议用户定期归档(Hermes 侧 cron)

---

## 完整自检(2026-08-21)

| 套件 | 结果 |
|---|---|
| `node scripts/smoke-test.mjs` | 62/62 |
| `node scripts/test-request-dump.mjs` | 8/8 |
| `node scripts/test-dispatch-schema.mjs` | 13/13 |
| `node scripts/test-consult-client.mjs` | 5/5 |
| `node scripts/test-services.mjs` | 11/11(原 6 + amend_nonce roundtrip + 老库 ALTER 升级 + 3 project-memory cwd 用例) |
| `node scripts/test-amend-security.mjs`(新) | 5/5 |
| `node scripts/test-consult-security.mjs`(新) | 4/4 |
| `node scripts/test-foundation-policy.mjs`(新) | 4/4 |
| `node scripts/test-mirror-opt-in.mjs`(新) | 8/8 |
| `node scripts/import-check.mjs` | 19/19 |
| `node scripts/verify-install.mjs` | 29/29 |
| **合计** | **168/168** |

---

## Hermes 端升级包(v0.2.2)

DSH 端 v0.2.2 引入的两个不可降级协议(consult reply_secret、amend nonce)需要 Hermes 端配合:

| 交付物 | 位置 | 说明 |
|---|---|---|
| 完整迁移指南 | `docs/hermes-upgrade-v0.2.2.md` | 协议对比、参考 Python、故障排查、升级验收清单 8 项、兼容矩阵 |
| Hermes 端参考实现 | `scripts/hermes-gateway-demo.py` | 独立可运行 Python 脚本:consult reply poller + 三段 amend writer + legacy fallback |
| Hermes-side 查看工具升级 | `scripts/hermes-view-dsh.mjs` | children 查询输出多带 `amend_nonce`(老 schema 自动降级) |

Hermes 端升级核心 diff(摘要):
```diff
# 1) consult reply poller
- reply_path = reply_dir / f"{ticket}.json"
+ secret = payload.get("reply_secret")
+ if not secret: skip_to_legacy(); continue
+ reply_path = reply_dir / f"{ticket}-{secret}.json"

# 2) amend writer (Hermes-side)
- amend_path = amend_dir / f"{ts}-{task_id}.json"
+ amend_path = amend_dir / f"{ts}-{task_id}-{task.amend_nonce}.json"
```

兼容开关:`HERMES_LINK_TRUST_LEGACY=1` env 让 consult 临时回退到旧 `<ticket>.json` 格式(off by default,只覆盖 consult,不覆盖 amend)。

完整细节见 `docs/hermes-upgrade-v0.2.2.md`。

---

## v0.2.3 hotfix — K.1–K.5 后续加固

### K.1 — `load_hermes_persona` 不再读 Hermes 全局 MEMORY.md

**问题**:v0.2.2 把 dispatch 的 foundation 切到 SOUL-only,但 `load_hermes_persona` 工具没改——`scope: 'memory'` 直接读 `MEMORY.md` 全量注入当前 session。这是同类跨项目污染残留(任何 DSH session 调它都会拿到 Hermes 全局 MEMORY)。

**修复**:
- `services/persona-loader.mjs`:删除 `if (want.memory)` 整块;**不再读** `MEMORY.md`
- `scope: 'memory'` 退化为发一条迁移提示(`use load_hermes_project_memory for cwd-scoped Hermes memory`),`parts.MEMORY.md.bytes = 0` + `note: 'removed in v0.2.3'` 显式标注
- `tools/load-hermes-persona.mjs`:schema enum 从 `['all','soul','memory','config']` 改为 `['all','soul','config']`(DSH 工具运行时层防御);execute 检测到 `scope === 'memory'` 也输出迁移提示

**效果**:任何用户/工具调用 `load_hermes_persona` 都**不会**再把 MEMORY.md 内容加载进 session。要 cwd-scoped Hermes memory,改用 `load_hermes_project_memory`。

### K.2 — `import-hermes-session` cwd 路径安全校验

**问题**:`resolveCwd` 接受 Hermes state.db 的任意 cwd,只检查 `existsSync` + `isDirectory`。若 Hermes 端有 bug 或被攻破,`cwd = C:\Windows\System32` 之类会被 DSH 接受,后续 dispatch 子 agent 用相对路径会触达系统目录。

**修复**(`import-hermes-session.mjs#isSafeCwd`):
- 拒绝非绝对路径(Win `C:\` / POSIX `/`)
- 拒绝空、null 字节(`\u0000`)、> 1024 字符路径
- 拒绝 Windows 系统关键目录根与子目录:`C:\Windows`、`C:\Windows\System32`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`
- 拒绝 POSIX 系统关键目录根与子目录:`/etc`、`/bin`、`/sbin`、`/usr`、`/var`、`/proc`、`/sys`、`/boot`、`/root`、`/lib`、`/lib64`、`/opt`、`/dev`
- 用户显式 `importSession({ workspace })` 不受影响(用户主动传入 = opt-in)

### K.3 — `outbox.appendSessionEvent` 文件名长度上限 200

**问题**:`String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')` 不截断。超长 sessionId 触发 Windows 255 字符上限 → `ENAMETOOLONG` → try/catch 静默吞掉错误,`mirror_session_to_hermes` 工具看起来成功,实际什么都没写。

**修复**(`services/outbox.mjs`):
```js
let safeId = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
if (safeId.length > 200) {
  const head = safeId.slice(0, 184)
  const tail = createHash('sha1').update(safeId).digest('hex').slice(0, 12)
  safeId = `${head}_${tail}`
}
```
sha1 12 hex 字符尾巴保证超长 ID 的文件名唯一性。

### K.5 — redact regex 加 cookie / set-cookie / session_id

**问题**:`redactEvent` 的通用 regex 列表没有 cookie 关键字。`Cookie: session=abc123`、`Set-Cookie: sid=xyz` 原样 mirror 给 Hermes,泄露 session token。

**修复**(`tools/mirror-session-to-hermes.mjs`):
- 通用关键字列表加 `cookie`、`session_id`、`set_cookie`
- 新增 Set-Cookie header 单独 regex:`(?:^|[\s;,])(?:cookie|set-cookie)\s*[:=]\s*([^\s"',;]+)`
- 已有 JWT / AWS / OpenAI / Anthropic / PEM 等不变

### 已改文件

- `services/persona-loader.mjs`(删除 memory 块 + scope='memory' 迁移提示)
- `tools/load-hermes-persona.mjs`(scope enum + execute 防御)
- `import/import-hermes-session.mjs`(`isSafeCwd` + `resolveCwd` 调用)
- `services/outbox.mjs`(`createHash` 截断)
- `tools/mirror-session-to-hermes.mjs`(regex 列表 + Set-Cookie)
- `index.mjs` / `http/dispatch.mjs`(`VERSION = '0.2.3'`)
- `skills/hermes-link/SKILL.md`(描述 + 工具表)
- `README.md` / `PACKAGES.md`(v0.2.3 行 + 自测清单)
- `scripts/test-v0.2.3-hardening.mjs`(新;18 case)
- `scripts/smoke-test.mjs`(K.1-K.5 静态断言)
- `scripts/run-all-tests.cmd`(加入新脚本)

### 完整自检(2026-08-21,v0.2.3)

| 套件 | 结果 |
|---|---|
| `node scripts/smoke-test.mjs` | 77/77(+K.1-K.5 静态断言) |
| `node scripts/test-request-dump.mjs` | 8/8 |
| `node scripts/test-dispatch-schema.mjs` | 13/13 |
| `node scripts/test-consult-client.mjs` | 5/5 |
| `node scripts/test-services.mjs` | 12/12 |
| `node scripts/test-amend-security.mjs` | 5/5 |
| `node scripts/test-consult-security.mjs` | 4/4 |
| `node scripts/test-foundation-policy.mjs` | 4/4 |
| `node scripts/test-mirror-opt-in.mjs` | 8/8 |
| `node scripts/test-v0.2.3-hardening.mjs`(新) | 18/18 |
| `node scripts/import-check.mjs` | 19/19 |
| `node scripts/verify-install.mjs` | 29/29 |
| `python -m py_compile scripts/hermes-gateway-demo.py` | exit 0 |
| **合计** | **202/202 + Python OK** |