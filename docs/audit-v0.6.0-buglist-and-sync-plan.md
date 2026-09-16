# dsh-hermes-link 审计报告 — v0.6.0 收尾 + 双向同步补全方案

> 审计时间：2026-09-15 · 基线：`d41d1ec` + 未提交工作树（v0.6.0 D1 rate-limit）
> 审计方式：全量测试实跑 + 源码走查 + 运行中实例 HTTP 探针 + Hermes Home 落地检查
> 结论一句话（含 4 节订正）：**agent 级 dispatch 两个方向都通；但"双向同步"的两条腿都在静默失败——Hermes→DSH 的会话同步自 2026-09-06 起因 DSH API 漂移完全停摆，DSH→Hermes 的镜像从未生效；再加上 `npm test` 是红的（7 项 e2e 失败），所以体感"BUG 太多"。**

---

## 0. 当前开发进度快照

| 项 | 状态 |
|---|---|
| 已提交 HEAD | `d41d1ec feat(budget): real tokenizer + token-budget gates (v0.5.0 / B1)` |
| 未提交工作树 | 10 改 + 3 新增（v0.6.0 D1：per-token rate-limit + daily token budget） |
| 运行中实例 | 已在跑**未提交的 v0.6.0 代码**（`/mcp/collab/health` → `version 0.6.0`） |
| `npm test` | ❌ **exit 1**，卡在 `test-e2e-integration.mjs`（22 项中 7 失败） |
| 因上述中断而**从未执行**的 6 个套件 | workspace-infer / smoke / import-check / verify-install / version-sync / docs-fresh —— 单独跑**全绿**（2/86/22/29/6/21） |
| 新版 `scripts/test-rate-limit.mjs` | 单独跑 19/19 绿，但**未接入 package.json，也未接入 CI** |

---

## 1. 需要修复的 BUG 清单

### P0 — 挡路 / CI 红

**B1. 新增的两个 rate-limit 计数器未注册 → 任意 `tools/call` 在非生产装配下抛 E_INTERNAL（7 项 e2e 失败的唯一根因）**
- 机理：`http/jsonrpc-handlers.mjs:34-48` 的 `rateLimitGate()`，在 `deps.bearerKey` 为空时会执行 `deps.metrics.inc('hermes_link_rate_limit_skipped_total', {endpoint})`；而 `services/metrics.mjs:87` 对**未注册指标 inc 直接 throw**。
- 触发面：`scripts/test-e2e-integration.mjs:69-87` 只注册了 16 个 counter，没带上 v0.6.0 新增的 2 个 → 任何 tools/call 都抛异常，被外层 catch 成 `E_INTERNAL` / HTTP 500。
- 实测症状：
  - `unknown method` 返回 `E_INTERNAL`（期望 `E_UNKNOWN_TOOL`）
  - `dispatch_dry_run` 返回 `500 !== 200`
  - `dispatch_status` → `Cannot read properties of undefined (reading 'total')`
  - `dispatch_list` → `Cannot read properties of undefined (reading 'content')`
- 说明：**生产实例不受影响**（`index.mjs:215 registerMetricsShape()` 两个计数器都注册了）。但这暴露了一个真实脆弱点——指标形状一旦不同步，整个 JSON-RPC 面全挂。
- 修法（双保险）：
  1. `scripts/test-e2e-integration.mjs` 的 `COUNTERS` 补 `hermes_link_rate_limited_total` / `hermes_link_rate_limit_skipped_total`（更好的做法：从 `index.mjs` 导出 canonical shape 供 harness 复用，杜绝再次漂移）。
  2. `rateLimitGate()` 内对 metrics 调用做 try/catch 或存在性判断——遥测失败**绝不能**影响 RPC 主流程。

**B2. `dispatch_task` 被限流器重复计数 → 有效吞吐直接砍半**
- 机理：`http/jsonrpc-handlers.mjs:90` 先调一次 `rateLimitGate(..., 0)`（分钟窗），`:99` 又调一次 `rateLimitGate(..., tokens)`；而 `services/rate-limit.mjs:92-93` 在**每次允许时都会 push 一条时间戳**进滑动窗。于是每次 dispatch 占 2 个配额。
- 实测复现（rpm=4，模拟 handler 的两次调用）：

  ```
  rpm=4 (expect 4 dispatches/min) ->
  dispatch#1 OK
  dispatch#2 OK
  dispatch#3 BLOCKED at minute-gate (current=4/4)
  minuteWindow entries after: 4
  ```
- 影响：配置 60 rpm 实际只放行 30 次/分钟；`retry_after_ms` 反馈也会偏早。
- 修法：每请求**只调一次** `check()`——把分钟窗与日额度合并成一次调用（tokenCount 一次传入）；spec 非法时再退回一次无 token 的检查。

**B3. e2e 里的版本断言写死 0.5.0**
- `scripts/test-e2e-integration.mjs:220` 与 `:252` → 版本一升 0.6.0 就再添 2 项失败。
- 修法：从 `packages/dsh-hermes-link/package.json` 读取，或复用 `http/dispatch.mjs` 导出的 `VERSION`，禁止硬编码。

### P1 — 正确性 / 安全

**B4. 限流分桶用的是裸 bearer token，而不是现成的 `tokenKey()` 哈希**
- `services/rate-limit.mjs:184` 专门导出了 `tokenKey()`（sha256 取前 16 位十六进制），注释明确写着「Used as the rate-limit bucket key so log lines / metrics never carry the raw credential」——但**全仓库无任何调用点**。
- `http/jsonrpc-handlers.mjs:41` 实际传的是 `key: bearerKey`（原始凭证），裸 token 进了内存 Map，且每次拒绝时还会被复制进 `decision.key`。
- 修法：`key: tokenKey(bearerKey)`。

**B5. 文档承诺的 session-mirror「跳过 hermes-* 与噪音事件」守卫在代码里不存在（回声环风险）**
- `docs/delivery-v0.6.0-20260821.md:21` 写明：V4 session-mirror "跳过 hermes-* 与噪音事件"。
- 实际：`services/outbox.mjs:293-310 appendSessionEvent()` 无任何过滤；`services/session-mirror.mjs:134 handleEvent()` 也无过滤。
- 后果：把 Hermes 会话导入 DSH（得到 `hermes-<sid>`，agentPreset=`hermes-imported`）后，若对该会话开镜像，会把 Hermes 自己的 transcript 再写回 `Hermes Home/inbox/dsh/session-mirror/hermes-<sid>.jsonl` ——内容回声/重复。
- 修法：在 `handleEvent` / 镜像入口补 `hermes-*` 与噪音事件（tool-call 噪音等）过滤；并在事件里加 `origin_session_id` + `source` 幂等键。

**B6. consult 工单无 TTL，永久滞留且无人可见**
- 实测：`Hermes Home/inbox/dsh/consult/` 有 **3 张 2026-08-21 的工单**（`kind:"consult"`, prompt `probe from audit`），`consult-reply/` **为空**——即 D2（DSH→Hermes 主动咨询）**从未真正闭环**。
- 无超时、无过期、无「stuck」可见性：失败是静默的。
- 修法：加 TTL + `E_CONSULT_TIMEOUT` 显式回传 + 一个回复清扫器；`consult` 目录积压进健康检查。

**B7. 发布状态自相矛盾（下次 release 会升错版本）**
- `package.json` = **0.6.0**，但 `packages/dsh-hermes-link/CHANGELOG.md` 最新条目仍是 **0.5.0**，而且 `## 0.5.0` **出现了两次**（第 3 行 = 文档/CI 杂项，第 13 行 = session-mirror 功能），B1 token-budget 的内容**一条都没有**。
- `.changeset/v0.5.0-token-budget.md` 仍是**未消费**状态且声明 `minor`——而 B1 早已随 0.5.0 发布（HEAD 就是那条 commit）。下次 `changeset version` 会把 0.6.0 **再升成 0.7.0**，并生成重复条目。
- `scripts/check-version-sync.mjs` 对缺失的 CHANGELOG 条目是 `-- not present, skipping`，所以这道闸门**抓不住**。
- 修法：补 0.6.0 CHANGELOG 章节、修掉重复的 `## 0.5.0`、删除过期 changeset，并把 version-sync 的 skip 改成「版本跳变必须有条目」的硬断言。

### P2 — 工程卫生

**B8. 新测试套件没进 CI。** `scripts/test-rate-limit.mjs`（19/19 绿）既不在 `package.json` 的 `test` 脚本里，也不在 `.github/workflows/ci.yml` 的任何 step 里 → 永远不会被执行。另有一个未跟踪的调试残留 `scripts/_peek.mjs`。

**B9. `index.mjs:211-214` 插入代码把缩进撞坏了：** `buildRateLimiterFromEnv()` 与 `const metrics` 的缩进错位。不是语法错误，但明显未经 review。

**B10. `extractBearerKey()`（dispatch.mjs:70-76）与 `checkAuth()`（:59-65）是同一段比较逻辑的两份拷贝。** 今天两者恰好一致，但一旦有人给 `checkAuth` 加大小写宽容 / 多 token 支持，鉴权与限流分桶就会静默错位（鉴权放行但限流按匿名旁路）。

**B11. 工作树是脏的，而且运行中的实例正在服务这份脏代码。** 10 个文件已改 + 3 个未跟踪，版本号已跳到 0.6.0 却没提交 → "已发布的 0.5.0" 和 "正在跑的代码" 已经对不上了。

---

## 2. 双向同步现状（实测，非文档）

### Hermes → DSH：✅ 通
| 证据 | 值 |
|---|---|
| Hermes 侧 MCP 配置 | `mcp_servers.dsh-bridge.url = http://127.0.0.1:3080/mcp/collab`（`enabled: true`） |
| Hermes 进程 | 5 个 `Hermes` + 多个 `python` 在跑 |
| 任务结果回流 | `inbox/dsh/dispatch-result/*.json` 20+ 个（`e2e-*` / `mnemo-*` / `probe-*` …） |
| 心跳 | `inbox/dsh/heartbeat/latest.json` `seq:7` @ 2026-09-15T10:52:49Z（新鲜） |
| 会话侧边栏（V1/V2） | `createWatcher(Hermes Home/sessions)` → `change` → `importer.sync()`（`index.mjs:45,250-257`）已接线 |
| 路由 | `POST /mcp/collab`（dispatch_task / followup / interrupt / list / get / status / dry_run / tail / probe） |

### DSH → Hermes：❌ 代码在，但从未生效
| 通道 | 状态 | 证据 |
|---|---|---|
| V4 实时会话镜像 | **默认 OFF，本机从未开启** | `inbox/dsh/session-mirror/` 下**只有 `archive/2026-08-21/`，没有任何活跃 .jsonl**；`GET /sessions` 里每个会话 `mirror_status.enabled=false, default_off=true` |
| 传输层 | 其实**已经建好了** | `GET /mcp/collab/session-stream`（SSE，支持 `since_seq`）、`session_mirror` 工具、`session-mirror/status`、`list_hermes_sessions` 里的 `mirror_status`、`outbox` write-behind |
| D1 任务结果 | ✅ 通（见上表） |
| D2 consult 主动咨询 | ❌ **未闭环** | 3 张工单滞留 2026-08-21，`consult-reply/` 空 |
| H4 amend 反向 amend | ⚠️ **从未被行使** | `inbox/dsh/amend/done/` **0 个文件** |
| `outbox/hermes/`（Hermes→DSH 主动通知） | ❌ **目录不存在，从未实现** | 计划文档里的 NEW 项，代码无对应 |

### 为什么 DSH→Hermes 是关着的？
不是忘了，是**有意的**：v0.2.1 出过事故——把全局、**不区分 cwd** 的 `session.jsonl` 在 `agent/session-start` 时无差别注入每个主会话，导致 A 项目会话被灌进 B 项目的 Hermes 对话；而 DSH `Session.events` 是 append-only / deep-frozen，**写进去就删不掉**。团队的反应是把所有跨项目通道改成显式 opt-in。

这个决定是对的，但结果就是：**"双向"目前是承诺，不是行为**——因为没人会每天记得手动 `session_mirror action=enable`。

---

## 3. 如何完成双向同步（沿用现有资产的补全路线）

**核心判断：不要重建管道。** 传输层（SSE `session-stream` + 每会话镜像状态 + 全量脱敏 + write-behind JSONL）已经写完了；缺的是**默认策略、回声防护、反方向通道**。而"默认开启"的顾虑可以用一个**更精确的开关**解决，而不是继续靠手动 opt-in。

### 阶段 A — v0.6.0 收尾，先把 CI 修绿（B1–B4, B8–B10）
不改行为、只修缺陷。目标：`npm test` 全绿、`test-rate-limit.mjs` 进 CI、清理工作树并提交。**这一步不做完，后面任何改动都无法验证。**

### 阶段 B — 让 DSH→Hermes 变成「默认开、但按项目作用域」的通道（正面解决 v0.2.1 的反对理由）
v0.2.1 的错在于 *cwd 无关的全局注入*；镜像不必重蹈覆辙。引入 **cwd 作用域策略**：
- 新增 `HERMES_LINK_MIRROR_POLICY=off|scoped|all`，**默认 `scoped`**。
- `scoped` = 仅当该 DSH 会话的 `header.cwd` 能匹配到一个真实存在的 Hermes 项目（同 cwd / 同 git repo root）时才自动开镜像；匹配不上就保持 OFF。
  - 复用现成能力：`services/hermes-project-memory.mjs` 已经就是这么按 `agent.session.header.cwd` 匹配 state.db 的——同一套判据，不发明新东西。
- 脱敏**始终开启**（保持现状）。
- 补上缺失的 `hermes-*` + 噪音事件过滤（B5），保证导入回 DSH 的会话不会再回声回 Hermes。

这样"开箱即双向"的适用范围 = "两侧可证明是同一个项目"，既兑现承诺，又诚实地守住了 v0.2.1 的教训。

### 阶段 C — 补全反方向通道 + 可续传游标
1. **实现 `Hermes Home/outbox/hermes/` 的消费端**（Hermes→DSH 主动通知），这是计划里承诺、代码里完全缺失的一块。直接照抄已被验证的 `services/amend-watcher.mjs` 模式（轮询 + 处理后移入 `done/`），不要新设计。
2. **给镜像 JSONL 加 seq 游标契约**：SSE 路由已支持 `since_seq`，让落盘文件也带 seq，Hermes 才能断点续读而不是每次重扫。
3. **双向幂等键**：事件带 `source: dsh|hermes` + `origin_session_id`，任一侧都不重复消费自己写出的内容（与 B5 的回声守卫是同一件事的两端）。

### 阶段 D — 让"BUG 太多"这件事不再复发（可观测性）
- 新增 `hermes-link doctor`（或扩展 `scripts/verify-install.mjs`）一次性自检：token 是否配置、镜像策略解析结果、consult 积压/TTL、amend 目录可写、SSE 可达、镜像文件是否真的在增长。
  - 这次审计里"3 张工单滞留 3 周""镜像目录只有 archive"都是**静态看代码看不出来**的，必须靠运行时探针。
- consult 增加超时与显式失败回传（B6），失败不再静默。

### 建议顺序与验收
```
A (修绿 CI + 提交)  →  B (scoped 默认镜像)  →  C (反方向通道 + 游标)  →  D (doctor + consult TTL)
   ↑ 先决条件，不可跳过        ↑ 兑现"双向"承诺的主体          ↑ 补缺      ↑ 防复发
```
每阶段验收：A = `npm test` 全绿且改动已提交；B = 新开一个本项目的 DSH 会话后，`inbox/dsh/session-mirror/<sid>.jsonl` 自动出现并随对话增长，且跨项目会话**不**被镜像；C = Hermes 侧能通过 `since_seq` 续读，`outbox/hermes/` 投递可被 DSH 消费；D = doctor 能报出滞留工单与失活镜像。

---

## 4. 【决定性发现 · 补录】Hermes→DSH 不通的真正根因：DSH sessionPersistence API 漂移

> 用户反馈"Hermes 到 DSH 也不通，同步后完全无法正常开发，甚至无法同步"——已复现并定位。
> 我最初判定"Hermes→DSH 通"是**错的**：我依据的 `dispatch-result/*.json` 是 **2026-08-24 的陈旧文件**。

### 4.1 实测证据链

| # | 探针 | 结果 |
|---|---|---|
| 1 | `POST /mcp/collab` initialize / tools/list / dispatch_status / dispatch_list / dispatch_dry_run / dispatch_task(one-shot) / dispatch_task(continuable) | ✅ **全部 200 正常**（agent 级通道是好的） |
| 2 | `POST /mcp/collab/import {hermesSessionId:'20260914_133918_e423fa'}` | ⚠️ `status:"already_imported"` + `eventCount:null` + `"note":"persisted but inspect failed: ctx.sessionPersistence.inspect is not a function"` |
| 3 | 同上，另外两个**从未导入过**的会话 | ⚠️ **同样报 `already_imported`** ← 假阳性 |
| 4 | 统计 `~/.dsh/sessions/*/hermes-*` | 共 **73** 条，**最新一条 = `hermes-20260906_203440_a4534d`（2026-09-06）** |
| 5 | 对照 Hermes `sessions/` | 9/10、9/11–13（44 个 cron）、9/14 均有新会话，且此刻仍有活跃会话 `20260910_183153_bce2f9` |

**结论：Hermes→DSH 的会话同步自 2026-09-06 起已彻底停摆 9 天，且完全静默（无报错、无告警、`sync()` 返回 `imported=0 skipped=N failed=0`）。**

### 4.2 根因：插件调用了 DSH 已删除的 API

`import/import-hermes-session.mjs` 仍在用旧版 `ctx.sessionPersistence` 契约，而 DSH 现版本（`@deepseek-ai/dsh-session-persistence@0.1.5-rc.2`）已改成 **handle 模型**：

| 插件当前调用 | 位置 | 现状 | 现行 API |
|---|---|---|---|
| `ctx.sessionPersistence.inspect(id)` | :323 | ❌ **已删除** | `stat(id)` → `{header, revision, eventCount?, sizeBytes?} \| undefined` |
| `ctx.sessionPersistence.listArtifacts()` | :345, :396 | ❌ **已删除** | `list()` → `Snapshot[]`（**已无 `path` 字段**） |
| `ctx.sessionPersistence.append(id, events)` | :489 | ❌ **已删除** | 由 `create()` 返回的 **write handle** 上 `handle.append(events)`，再 `flush()`/`close()` |
| `ctx.sessionPersistence.create(header)` | :488 | ✅ 仍在，但**返回 handle**（当前被丢弃） | 同上；id 已存在时抛 `SessionAlreadyExistsError` |

### 4.3 为什么这个 bug 藏了 9 天（两个放大器）

**放大器 1 —— 异常被降级成"已导入"。** `import-hermes-session.mjs:381-384`：
```js
} catch (e) {
  const msg = String(e && e.message || e)
  const notFound = msg.includes('not found') || msg.includes('no stored session')
  if (!notFound) { ... return { status: 'already_imported', ... } }
```
`TypeError: ...inspect is not a function` 不含 `"not found"` → 走进"artifact 损坏"分支 → **返回 `already_imported`**。
于是每个会话都被判定为"已导入过"，**永远不再创建**，而 `sync()` 只把 `already_imported` 记为 `skipped`，不打印任何错误。

**放大器 2 —— 侧边栏列表与实际导入无关。** `list()` 直接读 Hermes `request_dump_*` 文件，所以**侧边栏照样列出 144 个会话**，看起来"同步好了"；但这些会话从未真正落盘，点开就是坏的/空的。这正是"同步后完全无法正常开发"。

### 4.4 为什么"无法正常开发" —— cwd 全部落进空目录

- `resolveCwd()`（:270-290）在 state.db `cwd` 为 null 且 dump 推断失败时，回落到 `hermesWorkspaceDir`。
- 实测：**73 条已导入会话里有 46 条（63%）落在 `--C-Users-Tianbuyu-.dsh-hermes-workspace--`**，而 `~/.dsh/hermes-workspace` 是**一个从未使用过的空目录**。
- 更糟的是路径拼接产生了**混合分隔符**：`"cwd":"C:\\Users\\Tianbuyu\\.dsh/hermes-workspace"`（`import-hermes-session.mjs:42-43` 用 `+ '/hermes-workspace'`）。
- 且推断能力不足：会话 `20260913_074803_3b7bee` 的 prompt **明写** `@folder:E:\项目\太湖水质预测\地基实现_太湖水质预测`，却仍被丢进 hermes-workspace。

### 4.5 相应的修复项（并入阶段 A，优先级高于原 B1–B4）

| 编号 | 修复 |
|---|---|
| **D1** | 迁移到新 API：`inspect→stat`、`listArtifacts→list`、服务级 `append→handle.append`（create 返回的 handle 必须 `flush`/`close`）。**这是"同步不通"的唯一根因修复。** |
| **D2** | 让失败**响亮**：`inspect/stat` 抛非"not found"类异常时**不得**降级为 `already_imported`——应返回 `import_failed` 并计入 `failed`，让 `sync()` 的返回值真实反映结果。这是防止同类静默故障再发生的**结构性修复**。 |
| **D3** | 修 cwd：去掉空目录回落（改为"无法确定 cwd 就不导入，或导入到一个显式的、有标记的 cwd"）、修混合分隔符（用 `path.join`）、增强 `inferWorkspaceFromDump` 识别 prompt 里的 `@folder:` / 绝对路径。 |
| **D4** | 清理存量：46 条落在空目录的会话需要重建/迁移（或至少标记），否则用户的侧边栏会一直是坏的。 |

### 4.6 结论订正

| 方向 | 原判定 | **订正后** |
|---|---|---|
| Hermes→DSH · agent dispatch（dispatch_task / followup / status / dry_run） | 通 | ✅ **确实通**（实测 200，含 continuable） |
| Hermes→DSH · **会话同步 / 侧边栏导入** | 通 | ❌ **自 2026-09-06 起完全停摆**（DSH API 漂移 + 静默降级） |
| Hermes→DSH · 心跳 | 通 | ✅ 通（但 `dsh_version` 为 null） |
| DSH→Hermes · V4 镜像 | 从未生效 | ❌ 从未生效（无 state 文件、无活跃 JSONL） |
| DSH→Hermes · consult | 未闭环 | ❌ 未闭环（3 张工单滞留） |

> **因此"双向同步"的真实北极星不是"把镜像默认打开"，而是先让 DSH→Hermes 与 Hermes→DSH 两条腿都停止静默失败。**
> 原四阶段路线仍然成立，但**阶段 A 必须加入 D1/D2/D3**，且 D2 是其中最重要的一条——没有它，任何后续同步功能都会以同样的方式静默烂掉。
