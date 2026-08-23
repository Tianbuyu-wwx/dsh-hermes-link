# Hermes 端升级到 dsh-hermes-link v0.2.2 协议

> 适用对象:Hermes Agent 仓库中负责"读 DSH inbox、写 reply/amend 文件"的任何 gateway/poller/worker。
> 配套代码:`scripts/hermes-gateway-demo.py`(本仓库,独立可运行的 Python 参考实现)。

## 为什么必须升级

`dsh-hermes-link` v0.2.2(2026-08-21)在**两个文件通道**加了不可降级的鉴权:

| 通道 | 旧(v0.2.0 / v0.2.1) | 新(v0.2.2) |
|---|---|---|
| **Consult reply**(DSH 端在等 Hermes 的回复) | `inbox/dsh/consult-reply/<ticket>.json` | `inbox/dsh/consult-reply/<ticket>-<secret>.json`,`secret` 来自 consult inbox payload 的 `reply_secret` |
| **Amend**(Hermes 中途改运行中的子 agent) | `inbox/dsh/amend/<ts>-<task_id>.json` | `inbox/dsh/amend/<ts>-<task_id>-<nonce>.json`,`nonce` 来自 `dispatch_task mode=continuable` 响应 metadata 的 `amend_nonce` |

不升级会发生什么:
- Consult reply 文件被**直接拒绝**,poll 文件留在 `inbox/dsh/consult/`,不再被消费,`consult()` 一律返回 pending。
- Amend 文件被**直接拒绝**,文件被移到 `inbox/dsh/amend/done/legacy-*.json`,sub-agent 不被改动。
- 兼容开关:`HERMES_LINK_TRUST_LEGACY=1` 环境变量可让 consult 临时回退到 `<ticket>.json`(off by default,**不**覆盖 amend)。

升级后这两个通道就稳定,v0.2.0/v0.2.1 引入的"任意能写 Hermes 文件系统的进程都能伪装 reply / amend"的攻击面同时关闭。

## 协议改动一览(给 Hermes 端的实现者)

### A. Consult reply

#### A.1 旧协议(v0.2.0/1)
```
# Hermes 写入
INBOX/dsh/consult-reply/<ticket>.json
{
  "answer": "...",
  "ts": ...,
  "source": "hermes"
}
```

#### A.2 新协议(v0.2.2,**必须**)
```
# Hermes 写入
INBOX/dsh/consult-reply/<ticket>-<secret>.json
{
  "ticket": "<uuid>",          # 必须和 inbox payload.ticket 一致
  "answer": "...",
  "ts": ...,
  "source": "hermes",
  "version": "dsh-hermes-link/0.2.2"
}
```

`secret` 16 hex chars(32 位)来自上游 inbox 文件:
```
INBOX/dsh/consult/<ts>-<ticket>.json   # 由 DSH 写入
{
  "ticket": "<uuid>",
  "ts": ...,
  "source": "dsh",
  "kind": "consult",
  "prompt": "...",
  "context": { ... },
  "reply_secret": "<32-hex>",     # ← Hermes 必须读这个字段
  "version": "dsh-hermes-link/0.2.2"
}
```

#### A.3 Hermes 端要做的改动
1. **读 inbox payload** 时多读一个字段 `reply_secret`(若不存在则该文件来自老 Hermes,应跳过并归档到 `consult/done/legacy-*`)。
2. **写 reply 文件名** 用 `<ticket>-<secret>.json`,**不再用** `<ticket>.json`。
3. (可选)回写 `version` 字段为 `"dsh-hermes-link/0.2.2"` 方便审计。

#### A.4 参考 Python 实现
见 `scripts/hermes-gateway-demo.py#process_consult_once` —— 包含 `parse_consult_filename`、`read_consult_payload`、`atomic_write_json`、legacy fallback 等所有要点。

### B. Amend

#### B.1 旧协议(v0.2.0/1)
```
INBOX/dsh/amend/<ts>-<task_id>.json
{
  "task_id": "...",
  "content": [ContentBlock],
  "ts": ...
}
```

#### B.2 新协议(v0.2.2,**必须**)
```
INBOX/dsh/amend/<ts>-<task_id>-<nonce>.json
{
  "task_id": "...",
  "ts": ...,
  "content": [ContentBlock],
  "source": "hermes",
  "version": "dsh-hermes-link/0.2.2"
}
```

`nonce` 32 hex chars(64 位)来自 `dispatch_task mode=continuable` 响应:
```jsonc
// POST /mcp/collab → tools/call dispatch_task { mode: "continuable", ... }
// 返回 metadata:
{
  "v0_2_status": "continuable_started",
  "task_id": "t-001",
  "child_id": "<session-id>",
  "message_id": "...",
  "parent_agent_id": "...",
  "mode": "continuable",
  "amend_nonce": "<32-hex>",                                    // ← Hermes 必须保存
  "amend_filename_pattern": "<ts>-t-001-<nonce>.json"          // ← 可直接拿来拼文件路径
}
```

DSH 同时在响应正文里给出提示:
```
Use filename pattern: <ts>-t-001-<32-hex>.json when writing the amend file (v0.2.2+ nonce-authenticated protocol).
```

#### B.3 Hermes 端要做的改动
1. **保存 nonce**:收到 `dispatch_task mode=continuable` 的 metadata 后,把 `amend_nonce` 与 `task_id` / `child_id` 一起存到 Hermes 自己的任务表里(就像现在存 task_id 一样)。
2. **构造文件名**:当用户/编排器决定 amend,文件名 = `<ts_ms>-<task_id>-<amend_nonce>.json`。可以直接套响应里的 `amend_filename_pattern` 字段(把 `<ts>` 替换为新时间戳)。
3. (可选)写文件时带 `source: "hermes"` 与 `version: "dsh-hermes-link/0.2.2"`,便于 DSH 端审计。

#### B.4 没有 nonce 时怎么办
- **永远不要**写 `<ts>-<task_id>.json` 老格式——DSH 会直接拒绝(移入 `done/legacy-*`)。
- 如果你的 Hermes 没升级 gateway(还在发老格式 amend),DSH 端看到 `validateAmendNonce()` 返回 false 后,文件被移动到 `done/bad-nonce-*.json`,sub-agent **不会**被改。
- 升级方案:升级 Hermes 的 dispatch + amend 链路即可;`dispatch_task` 的 `metadata.amend_nonce` 字段由 DSH 自动生成。

#### B.5 参考 Python 实现
见 `scripts/hermes-gateway-demo.py#write_amend_file` —— 包含 `parse_amend_filename` 解析三段、原子写入、伪造 nonce 演示(DSH 会拒绝该演示 amend 因为没有 child 注册)。

## 升级路径(推荐三步)

### Step 1:读 inbox 改造(consult reply)
在 Hermes 的 consult poller / gateway 里:
- 解析 inbox 文件时取 `reply_secret` 字段(若空 → 跳过并归档 legacy)
- 构造 reply 文件名时把 secret 拼进去:`f"{ticket}-{secret}.json"`
- 用 atomic rename 写文件(避免 half-write)

伪 diff:
```diff
- reply_path = reply_dir / f"{ticket}.json"
+ secret = payload["reply_secret"]
+ if not secret: skip_to_legacy(payload_file); continue
+ reply_path = reply_dir / f"{ticket}-{secret}.json"
```

### Step 2:dispatch / amend 链路
- Hermes 端 dispatch_task continuable 时,解析响应 metadata,保存 `amend_nonce` 到 Hermes 自己的任务表。
- amend 时用保存的 nonce 拼文件名:`f"{now_ms()}-{task_id}-{nonce}.json"`。

伪 diff:
```diff
- amend_path = amend_dir / f"{ts}-{task_id}.json"
+ amend_path = amend_dir / f"{ts}-{task_id}-{task.amend_nonce}.json"
```

### Step 3:回归测试
用 `scripts/hermes-gateway-demo.py` 在 Hermes Home 目录跑一次端到端:
```bash
python scripts/hermes-gateway-demo.py "$LOCALAPPDATA/hermes" --demo-amend
python scripts/hermes-gateway-demo.py "$LOCALAPPDATA/hermes"
```
第一次跑会写一个**故意不可投递**的 amend(DSH 没注册 child),你可以观察 `inbox/dsh/amend/done/bad-nonce-*` 与 `unknown_task` 的出现。

要跑一个**真正可投递**的 amend,需要在 Hermes 端先 dispatch_task continuable,拿到 `metadata.amend_nonce`,再用 `--demo-amend` 之外的代码路径构造 amend(可参考 demo 的 `write_amend_file` 函数)。

## Hermes 端可选增强

| 增强 | 说明 |
|---|---|
| **`amend_filename_pattern`** 直接用 | 响应里已经给出 `<ts>-<task_id>-<nonce>.json`,把 `<ts>` 替成新时间戳就是 amend 文件名 |
| `version` 字段 | 写文件时带 `version: "dsh-hermes-link/0.2.2"` 让 DSH 审计区分 |
| `source` 字段 | 写文件时带 `source: "hermes"`(Hermes 侧)或 `source: "hermes-gateway-demo"`(开发) |
| atomic rename | 用 tmp 文件 + rename 避免 DSH 读到 half-write reply/amend |

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| consult 永远 pending | reply 文件 `<ticket>.json` 旧格式 | 升级:带 secret 后缀;或开 `HERMES_LINK_TRUST_LEGACY=1` 临时兼容 |
| amend 文件出现在 `done/legacy-*` | 文件名两段(旧)或三段但 nonce 错 | 升级 dispatch_task 链路读取 `metadata.amend_nonce`,写三段文件名 |
| amend 文件出现在 `done/bad-nonce-*` | nonce 与注册表不匹配 | Hermes 端用错 nonce / 用错 task_id / 重启后 SQLite 重置;以 `hermes-view-dsh children` 看 `amend_nonce` 验证 |
| amend 文件出现在 `done/retry_unknown_task-*` | task_id 暂时没注册(还在 spawn) | 正常,DSH 60s 内会重试 |
| 写 reply 文件报"reply_secret 字段缺失" | inbox 文件来自老 DSH(<v0.2.2) | 升级 DSH 端 dsh-hermes-link;或开 `HERMES_LINK_TRUST_LEGACY=1` |

## 旧文件兼容矩阵

| 端 \ DSH 版本 | v0.2.0/1 | v0.2.2(default) | v0.2.2 + `HERMES_LINK_TRUST_LEGACY=1` |
|---|---|---|---|
| **Hermes 旧** reply `<ticket>.json` | ✅ 投递 | ❌ pending | ✅ 投递(临时兼容) |
| **Hermes 新** reply `<ticket>-<secret>.json` | ❌ pending(旧 DSH 无 secret 处理) | ✅ 投递 | ✅ 投递 |
| **Hermes 旧** amend `<ts>-<task_id>.json` | ✅ 投递 | ❌ done/legacy-* | ❌ done/legacy-* |
| **Hermes 新** amend `<ts>-<task_id>-<nonce>.json` | ❌ done/legacy-* (旧 DSH 无 nonce 处理) | ✅ 投递 | ✅ 投递 |

矩阵含义:**两端**必须升级到 v0.2.2 才能完整工作;临时只升级一端会让该端写出的文件被对方忽略。`HERMES_LINK_TRUST_LEGACY=1` 只在两边都升级、但 Hermes gateway 短期忘带 secret 后缀时作为 emergency switch,不能替代真正的升级。

## 参考实现清单

- `scripts/hermes-gateway-demo.py` —— **独立可运行**的 Hermes 端 Python 参考实现(本仓库)
  - `process_consult_once(hermes_home)` —— consult reply poller 主体,含 legacy 处理
  - `parse_consult_filename(name)` —— `<ts>-<ticket>.json` 解析
  - `read_consult_payload(path)` —— 读 inbox payload,校验必填字段
  - `write_amend_file(hermes_home, task_id, amend_nonce, content|text)` —— 三段文件名 + atomic write
  - `parse_amend_filename(name)` —— 三段文件名解析 + legacy 检测
  - `demo_amend(hermes_home)` —— 演示一次合法的 amend 写入(DSH 会拒绝,用于排查协议)
- `scripts/hermes-view-dsh.mjs` —— Hermes-side 查看工具(已升级,显示 `amend_nonce` 字段)
- `docs/delivery-v0.6.0-20260821.md` —— "v0.2.2 hotfix" 段,含 S1–S4 完整动机

## 升级验收清单

Hermes 端升级后,做下面 8 件事确认通过:

- [ ] Hermes gateway 在读 consult inbox 时,日志里能看到 `reply_secret=...` 字段被读到
- [ ] Hermes gateway 写出的 reply 文件名形如 `<uuid>-<16hex>.json`
- [ ] Hermes dispatch_task continuable 后,响应 metadata 里有 `amend_nonce`(32 hex)字段并被持久化
- [ ] Hermes 写 amend 文件名形如 `<ts>-<task_id>-<32hex>.json`
- [ ] DSH 的 `hermes-inbox/health` 路由可达(`GET /mcp/hermes-inbox/health`)
- [ ] DSH 的 `audit.jsonl` 里 `kind: "continuable_started"` 记录的同任务条目,后续 `amend` 不再出现 `bad-nonce`
- [ ] `scripts/hermes-view-dsh.mjs children` 输出每行带 `amend_nonce`
- [ ] 一段时间运行后,`inbox/dsh/amend/done/` 下不应有 `legacy-*` 或 `bad-nonce-*` 文件

## License

本仓库整体 MIT;本指南与 `scripts/hermes-gateway-demo.py` 可自由并入 Hermes-agent 仓库。