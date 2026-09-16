# 实现简报 B：HERMES_LINK_MIRROR_POLICY —— 让 DSH→Hermes 镜像「默认开、但按项目作用域」

## 背景（为什么不是直接把镜像默认打开）

v0.2.1 出过事故：把全局、**不区分 cwd** 的 `~/.dsh/hermes-inbox/session.jsonl` 在 `agent/session-start` 时无差别注入每个主会话，导致 A 项目的 DSH 会话被灌进 B 项目的 Hermes 对话；而 DSH `Session.events` 是 append-only / deep-frozen，**写进去删不掉**。团队的反应是把所有跨项目通道改成显式 opt-in。

后果：V4 实时镜像（`services/session-mirror.mjs`）**默认 OFF 且从未被开启过**（本机 `~/.dsh/dsh-hermes-link/session-mirror-state.json` 根本不存在，`Hermes Home/inbox/dsh/session-mirror/` 只有 `archive/`）。所以"双向同步"目前是承诺，不是行为——没人会每天记得手动 `session_mirror action=enable`。

**关键判断：不要重建管道。** 传输层已经写完了：SSE `GET /mcp/collab/session-stream`（支持 `since_seq`）、`session_mirror` 工具（enable/disable/status）、`GET /mcp/collab/session-mirror/status`、`list_hermes_sessions` 里的 `mirror_status`、`outbox.appendSessionEvent` write-behind JSONL、脱敏始终开启。缺的只是**默认策略 + 回声防护**。

## 目标

新增 `HERMES_LINK_MIRROR_POLICY` 环境变量，取值 `off | scoped | all`，**默认 `scoped`**：

| 取值 | 行为 |
|---|---|
| `off` | 维持现状：一切都要显式 `session_mirror action=enable` |
| `scoped`（默认） | 仅当该 DSH 会话的 cwd **能匹配到一个真实存在的 Hermes 项目**时，自动开启镜像；匹配不上保持 OFF |
| `all` | 所有会话自动开启（给明确想要的人） |

`scoped` 的判据要**复用现成能力，不要发明新的**：`services/hermes-project-memory.mjs` 已经在按 `agent.session.header.cwd` 匹配 Hermes `state.db` 的 sessions 表（`load_hermes_project_memory` 工具就是它）。同一套 cwd 匹配逻辑即可。

这样"开箱即双向"的适用范围 = "两侧可证明是同一个项目"，既兑现承诺，又诚实地守住了 v0.2.1 的教训。

## 具体要求

1. **环境变量读取**：`HERMES_LINK_MIRROR_POLICY`，非法值要有明确行为（建议告警 + 退回 `scoped`，不要静默变成 `all`）。
2. **`scoped` 判定**：给定一个 DSH 会话 id，取它的 header cwd；若该 cwd（规范化后，注意大小写与路径分隔符）匹配到 Hermes `state.db` 中任一 session 的 `cwd`（或 `git_repo_root`），则视为同一项目 → 自动 `enable`。
3. **脱敏始终开启**，不受策略影响（现状如此，保持）。
4. **补上缺失的回声/噪音守卫（本轮审计的 B5，属同一处代码）**：`docs/delivery-v0.6.0-20260821.md:21` 声称 V4 镜像"跳过 hermes-* 与噪音事件"，但**代码里根本没有这个过滤**——`services/outbox.mjs` 的 `appendSessionEvent()` 与 `services/session-mirror.mjs` 的 `handleEvent()` 都无条件写。后果：把 Hermes 会话导入 DSH（得到 `hermes-<sid>`，agentPreset=`hermes-imported`）后再对该会话开镜像，会把 Hermes 自己的 transcript 写回 Hermes 自己的 inbox —— 回声。请加上：
   - 跳过 `hermes-*` 会话（它们的内容本来就源自 Hermes）
   - 跳过噪音事件（如 `session/title`、heartbeat 类；请按实际事件类型判断并写注释说明依据）
5. **可观测**：策略解析结果、自动开启/跳过的计数要走已有的 metrics 注册表（注意：`services/metrics.mjs` 对**未注册指标 inc 会 throw**；必须同时用 `index.mjs` 的 `registerMetricsShape()` 注册，并像 `http/_util.mjs` 的 `incMetric` 那样**不要**让遥测失败影响主流程 —— 本轮刚因为这个问题修过一次 CI）。
6. **文档**：更新 `SKILL.md` 与 `README.md`（`check-docs-fresh.mjs` 会校验 README/SKILL 提到所有工具名与版本号）。

## 验收（必须给原始输出）

- `node scripts/test-session-mirror.mjs` 与 `node scripts/test-mirror-opt-in.mjs` 必须仍然通过（默认 OFF 的既有断言可能需要按新默认更新——**如果是，请明确说明改了什么断言以及为什么不是放宽**）。
- 新增一个测试覆盖：`off` 不自动开；`scoped` 对匹配项目自动开、对不匹配项目不开；`all` 全开；非法值退回 `scoped`；`hermes-*` 会话被跳过；噪音事件被跳过。接入 `package.json` 的 `test` 链与 `.github/workflows/ci.yml`（与既有 step 风格一致）。
- `npm test` 必须 exit 0。
- **诚实说明**：插件跑在 DSH 进程内，源码改动需重启 DSH 才生效。**不要重启 DSH**。若无法做活体验证，必须明确写"未做活体验证"，不得暗示已验证端到端。

## 不要碰

- `packages/dsh-hermes-link/import/**`（迁移与 cwd 修复刚落地，正在验证中）
- `packages/dsh-hermes-link/http/**`、`scripts/test-e2e-integration.mjs`、`scripts/test-rate-limit.mjs`、`scripts/test-telemetry-resilience.mjs`、`scripts/test-seed-load-validation.mjs`、`scripts/test-cwd-platform-paths.mjs`、`scripts/test-workspace-account-dedupe.mjs`
- `~/.dsh/storages/workspace.json`、`~/.dsh/sessions/**`（用户数据；另一个 worker 也在动这些）
- 不要删除或重写别人的文件；如果发现冲突，停下来报告，不要覆盖。

## 增补（captain 于简报补发时追加）

- **`package.json` 与 `.github/workflows/ci.yml` 在 21:29–21:30 的改动是 captain 本人做的**，不是另一个 worker：新增了 `test:seed-load` / `test:workspace-accounts` / `test:cwd-paths` 三个 script 与对应 CI step，并把 `test-seed-load-validation` / `test-workspace-account-dedupe` / `test-cwd-platform-paths` 接进 `test` 链。你按原计划"每次改动前重读、改完再确认两边共存"即可，**不要回退这些行**。
- 你的新测试请加在 `test:cwd-paths` 之后、`test:e2e` 之前，保持既有风格。
