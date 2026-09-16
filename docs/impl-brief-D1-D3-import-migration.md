# 实现简报 D1–D3：import 路径迁移到 DSH 现行 sessionPersistence API

> 目标文件：`packages/dsh-hermes-link/import/import-hermes-session.mjs`（约 640 行）
> 依据：`@deepseek-ai/dsh-session-persistence@0.1.5-rc.2` 的 `lib/types/*.d.ts` 与 DSH 安装树中的实际实现（已逐条核对，非推测）

## 0. 为什么要改

Hermes→DSH 会话同步自 2026-09-06 起完全停摆 9 天且**静默无报错**。根因是插件调用了 DSH 已删除的 API，异常又被降级成 `already_imported`。

## 1. 现行 API 契约（权威）

```ts
// packages/@deepseek-ai/dsh-session-persistence/lib/types/index.d.ts
abstract class SessionPersistence {
  abstract create(header: SessionHeader, options?): Promise<SessionHandle>   // 抛 SessionAlreadyExistsError
  abstract open(id: SessionId, access: 'read'|'write', options?): Promise<SessionHandle>
  abstract flush(): Promise<void>
  abstract stat(id: SessionId, options?): Promise<SessionPersistenceSnapshot | undefined>
  abstract list(options?): Promise<readonly SessionPersistenceSnapshot[]>
}
interface SessionPersistenceSnapshot { header: SessionHeader; revision; eventCount?: number; sizeBytes?: number }
// 注意：Snapshot 没有 path 字段（旧的 listArtifacts().path 已不存在）

// SessionHandle（lib/types/handle.d.ts）
interface SessionHandle extends AsyncDisposable {
  readonly id; readonly header; readonly inheritedEventCount; readonly access
  read(offset?, length?, options?): Promise<{ eventState; events }>
  append(events: readonly SessionEvent[], options?): Promise<void>
  flush(options?): Promise<void>
  close(): Promise<void>          // 幂等；释放写所有权
}
```

```ts
// packages/@deepseek-ai/dsh-session/lib/types/types.d.ts
export declare const SESSION_FORMAT_VERSION = 3     // ← 实测值就是 3
export interface SessionHeader {
  version: typeof SESSION_FORMAT_VERSION   // 必须=3
  id: SessionId
  createdAt: number                        // 非负安全整数 epoch ms
  cwd?: string
  parentSession?: SessionId
  isSeeded: boolean                        // ← **必填**
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}
```

## 2. 逐点迁移映射

| 旧代码 | 位置 | 改为 |
|---|---|---|
| `ctx.sessionPersistence.inspect(id)` → `{meta, events}` | :323 | `stat(id)` → `Snapshot \| undefined`；取 cwd 用 `snap.header.cwd` |
| `ctx.sessionPersistence.listArtifacts()` → `[{path, header, meta}]` | :345, :396 | `list()` → `Snapshot[]`（**无 path**） |
| `ctx.sessionPersistence.create(header)`（返回值被丢弃） | :488 | 保留，但**必须接住返回的 write handle** |
| `ctx.sessionPersistence.append(dshSessionId, allEvents)` | :489 | `await handle.append(allEvents)` → `await handle.flush()` → `await handle.close()` |
| header `version: 0` | :481 | `version: SESSION_FORMAT_VERSION`（=3） |
| header 缺 `isSeeded` | :479-487 | 补 `isSeeded: false` |
| header `type: 'session'` | :480 | `SessionHeader` 里没有该字段——若后端仍需要请保留在磁盘层，但不要当作 header 契约字段依赖 |

**"已存在"判定改为**：`stat(id)` 返回非 undefined，或 `create` 抛 `SessionAlreadyExistsError`（类名判断即可，避免 import 路径耦合）。
**"不存在"判定改为**：`SessionPersistenceNotFoundError`（同样建议按 `err.name` 判断），**不要**再用 `msg.includes('not found')` 字符串匹配。

## 3. D2 —— 让失败响亮（最高优先级，独立于 D1）

`import-hermes-session.mjs:381-384` 当前逻辑：
```js
const notFound = msg.includes('not found') || msg.includes('no stored session')
if (!notFound) { ... return { status: 'already_imported', ... } }
```
`TypeError: ...inspect is not a function` 不含 "not found" → 落入"损坏"分支 → 返回 `already_imported` → `sync()` 只记 `skipped` → **9 天静默**。

要求：
1. `stat`/`list` 抛出**任何非"不存在"类异常**时，必须返回 `{status:'import_failed', error}`（或 `create_failed`），**绝不能**降级为 `already_imported`。
2. `importAll`/`sync()` 必须把这类结果计入 `failed`（现有代码已把非 created/already_imported 计入 failed——保持并确保真的走这条分支）。
3. `sync()` 在 `failed > 0` 时已 `console.error` 每个失败（:551-558）——确认它现在真的会触发。
4. 建议加一个显式的 API 能力自检：启动时若 `typeof ctx.sessionPersistence.stat !== 'function'`，直接打印一条醒目的不兼容告警，而不是等每个会话静默失败。

## 4. D3 —— cwd 修正

1. **去掉空目录回落**：`resolveCwd()` :289 `return hermesWorkspaceDir` —— 这是把 46 条会话丢进空目录的原因。改为：无法确定 cwd 时返回 `undefined`（让 `SessionHeader.cwd` 缺省、由后端落到 `_no-cwd` 项目目录），或返回一个**带显式标记**的目录；**不要**静默复用 `hermes-workspace`。
2. **修分隔符**：:42-43 用字符串拼接 `+ '/hermes-workspace'` 产生 `C:\Users\...\.dsh/hermes-workspace` 混合分隔符。改用 `join(DSH_HOME, 'hermes-workspace')`。
3. **增强推断**：`inferWorkspaceFromDump()`（:196-）未能识别 prompt 里明写的 `@folder:E:\项目\...`。已知反例：会话 `20260913_074803_3b7bee` 的 prompt 首行就是 `@folder:\`E:\项目\太湖水质预测\地基实现_太湖水质预测\``，却仍被丢进 hermes-workspace。请让推断也能识别 `@folder:` 形式（现有逻辑已支持 `path`/`cwd`/`workspace`/`directory` 键，:222）。推断结果必须 `existsSync` 且是目录才采用。

## 5. 验收（必须给原始输出，不得只给结论）

1. 迁移后直接打活体接口验证一条**从未导入过**的会话能真正创建：
   ```
   POST http://127.0.0.1:3080/mcp/collab/import
   {"hermesSessionId":"<9/14 之后某个真实 sid>"}
   期望：status:"created"，eventCount 为真实数字（非 null）
   ```
   （注意：插件跑在 DSH 进程内，**改动需要重启 DSH 才生效**。若无法重启，必须明确说明"未做活体验证"，不得声称已验证。）
2. `node scripts/test-request-dump.mjs`、`node scripts/smoke-test.mjs`、`node scripts/import-check.mjs` 保持通过。
3. 检查 `~/.dsh/sessions/<projectDir>/<sessionId>/` 下确实生成了 `session.jsonl.zstd`（或对应格式文件），且该目录名对应 `finalCwd` 而非空目录。

## 6. 不要做的事

- 不要碰 `packages/dsh-hermes-link/http/**`、`scripts/test-e2e-integration.mjs`、`services/rate-limit.mjs`（另一个 agent 正在改，会冲突）。
- 不要删除既有 73 条已导入会话（D4 单独处理，且用户要求代码修好后再统一重建）。
- 不要为了让测试变绿而放宽断言。
