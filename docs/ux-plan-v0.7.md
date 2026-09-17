# dsh-hermes-link — 用户体验计划（v0.7）

写这份计划的方式：把自己当成用户，从"我为什么装这个插件"出发走一遍真实路径，记录每一步的摩擦点，
再决定先修什么。事实依据来自本项目 v0.6.0–v0.6.9 的真实踩坑记录（审计、自检、端到端测试）。

---

## 一、用户真正想要的三件事

1. **两个 agent 要互通**：Hermes 是平时聊天、攒记忆的那个；DSH 是写代码的那个。用户要的是
   "在 DSH 里干活时能问一句 Hermes"和"我在 Hermes 的会话能在这里看见"。
2. **它得自己能说清楚状态**：出问题不该靠读日志、curl 四个端点或问 AI。
3. **它得能自己好起来**：常见故障（插件没装/没启用、模型 pin 丢失、弃单堆积）应该有一条命令。

## 二、现状盘点（v0.6.9 为止）

| 通道 | 用户可见入口 | 现状 | 用户能感知的缺口 |
|---|---|---|---|
| Hermes→DSH 会话导入 | 侧栏出现 hermes-* 会话 | ✅ 180 条自动导入、自动 pin 模型 | 会话是**只读快照**，用户以为能接着聊 |
| Hermes→DSH 通知 | 无需感知 | ✅ 每回合结束推送、dump 门控、双预算重试 | 无（噪音已压掉） |
| DSH→Hermes 咨询 | consult_hermes 工具 | ✅ 真模型 2.5s 作答、用量记账 | 用户不知道花了多少 token（本轮解决） |
| DSH→Hermes 镜像 | session_mirror 工具 + 作用域文件 | ✅ 按项目作用域、可达、可诊断 | 用户不知道"哪些会话在镜像" |
| 自检 | hermes_link_doctor / hermes_link_status（本轮） | ✅ 11 项检查 + 一句话状态 | 发现问题后仍需手动跑脚本 |

## 三、五个"用户会抱怨"的场景（按痛感排序）

- **S1 装不上/装不全**：要装 Hermes 插件、要 `hermes plugins enable`、要重启两侧、偶尔还要配环境变量。
  README 有全部信息，但没有"照着做 60 秒就好"的路径。
- **S2 不知道通不通**：第一反应是"它是不是坏了？"，答案却散落在 4 个端点和 11 项检查里。
- **S3 导入会话是"死"的**：点开一条 Hermes 会话，在 DSH 里发消息只改本地副本，Hermes 侧毫不知情；
  用户会以为"接着聊"成功，其实分叉了。
- **S4 侧栏被淹没**：180 条导入会话与自己的项目会话混在一起，找不到昨天在写的那条。
- **S5 出问题只能找人**：弃单堆积、pin 丢失、插件未加载——都需要知道去哪条命令。

## 四、开发计划（按优先级，含验收标准）

### P0-1 一条命令接入：`npx dsh-hermes-link-setup`
- 做：检测 Hermes home → 复制插件 → 调 `hermes plugins enable dsh-link`（找不到 hermes CLI 就打印精确命令）
  → 检查必要配置 → 跑一次 self-check → 打印"下一步：重启 Hermes / 重启 DSH"。
- 验收：干净机器上从零到 `hermes_link_status` 全绿 ≤ 2 条命令；每步可 `--dry-run`。
- 为什么第一：S1 是所有新用户的第一次体验。

### P0-2 一句话状态：`hermes_link_status`（**本轮已交付**）
- 做：把 doctor 的检查压成"每通道一行 + 计数器 + 下一步动作"；`json=true` 给机器。
- 验收：问"通不通"一次工具调用就够；全绿时输出 `next: nothing to do`。

### P0-3 快照语义显性化
- 做：导入会话标题加统一标记（如 `[Hermes] …`），或在会话首条事件里写明"Hermes 快照，只读；
  要继续请在 Hermes 里说"；可选 `hermes_followup`：把一句话投递回原 Hermes 会话。
- 验收：用户不再误以为在 DSH 里继续聊能同步回 Hermes（S3 消失）。

### P1-1 侧栏清理
- 做：`hermes_link_sessions` 增加 `action=archive --older-than <days> [--dry-run]`（或等价 CLI）。
- 验收：180 条导入会话可批量归档，侧栏只留在用的（S4 消失）。

### P1-2 咨询用量可见（**本轮已交付**）
- 做：回复里的 usage 记入 `hermes_link_consult_tokens_total{kind}`，状态与 doctor signals 显示。
- 验收：一次 consult 后能在 status 里看到 in/out token 数。

### P1-3 Hermes 侧 `/dsh-status`
- 做：插件再加一个斜杠命令，把 DSH 的 doctor 摘要读出来给 Hermes 用户。
- 验收：在 Hermes 里 `/dsh-status` 一句话说明 DSH 侧是否健康。

### P1-4 通知节流（可选）
- 做：同一会话在 N 秒内只发一条 import；dump 未变化（mtime 相同）不发。
- 验收：DSH 侧 scanned/executed 计数在长时间对话中不线性增长。

### P2 后续
- 多 Hermes home / 多 profile 的显式支持；`/mcp/collab/status` 的可视化面板；中英文 README 完全对齐；
  失败通知的"最近 5 条"视图。

## 五、怎么知道体验真的变好了（度量）

| 指标 | 现在 | 目标 |
|---|---|---|
| 首次接入步数 | 6 步（装插件/启用/重启/验证/配置/排错） | 1 条命令 + 1 次重启 |
| "通不通"的回答成本 | 问 AI 或 curl 4 个端点 | 1 次 hermes_link_status |
| 弃单/失败归档堆积 | 需要人工发现 | doctor 全绿 + 一条清理命令 |
| 误以为快照可续聊 | 会发生 | 不会发生（显性标注） |

## 六、执行顺序

1. **本轮（v0.6.9）**：P0-2 状态工具、P1-2 用量记账、弃单清理工具（hermes-link-consult-admin）。
2. **下一轮（v0.7.0）**：P0-1 setup 向导、P0-3 快照标注（含 hermes_followup 的最小版本）。
3. **再下一轮**：P1-1 侧栏清理、P1-3 /dsh-status、P1-4 节流。
