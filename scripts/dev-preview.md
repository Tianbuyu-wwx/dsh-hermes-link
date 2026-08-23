# Dev preview via dynamic Cordis

> 在 `install-all.ps1` 之前,可以用 `cordis_define` + `cordis_run` 直接挂插件代码预览效果。失败可改可重试;对当前会话即时生效。

## L1 `hermes-foundation`

把 `packages/hermes-foundation/index.mjs` 的内容粘到动态预览:

```
host: |
  ...hermes-foundation/index.mjs 全文...
```

(client 留空;foundation 不涉及 UI。)

会注入一个 `systemPrompt.context` 段 `hermes-foundation`,带 SOUL/USER/MEMORY 切片 ≤4K。

## L2 `hermes-oneshot-arbitrate`

同上,把 `packages/hermes-oneshot-arbitrate/index.mjs` 贴进 `host:`。

会注册一个动态 tool `consult_hermes`,spawn `hermes.exe -z` 子进程。**先在 PowerShell 里手测** `hermes -z "hello"` 能跑通,否则预览也会报错。

## L3 `hermes-dispatch-bridge`(v0.1)

同上;但 v0.1 几乎全是 HTTP 路由注册。验证步骤:

1. 注册后看 dsh 控制台是否打印:
   ```
   [hermes-dispatch-bridge] routes registered: /mcp/dispatch  /mcp/dispatch/health  (webServer port assumed 3080)
   ```
2. 在 PowerShell 里 curl `http://127.0.0.1:3080/mcp/dispatch/health`,应该回 JSON:
   ```json
   {"ok":true,"version":"0.1.0",...}
   ```
3. POST 一条 dispatch spec,看 audit 行是否落 `<DSH_HOME>/dispatch-audit.jsonl`。

## 退路

挂载完发现不对:

- `cordis_stop(pluginId)` 暂时停
- 改代码 → `cordis_define` 加新包 → `cordis_run` mode update 切到新包
- 改坏 → `cordis_undefine(pluginId)` 删到底

## 跑通之后

把 `packages/` 里能用的代码固化下来。这之后才需要走 `scripts/install-all.ps1` 做成安装包。
