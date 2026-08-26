# Changelog

All notable changes to **dsh-hermes-link** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: Pre-v0.2 versions lived in the `dsh-hermes` monorepo (`packages/dsh-hermes-link/`) alongside the deprecated `hermes-foundation / -oneshot-arbitrate / -dispatch-bridge` triad. The history below is mirrored from that repository's `docs/delivery-v0.6.0-20260821.md`.

---

## [0.3.4] — 2026-08-29

### Changed (perf)
- **`services/amend-watcher.mjs`: event-driven delivery (E3)** - replaced the 2s `setInterval` polling loop with `fs.watch` + a 200ms debounce window that batches burst deliveries into a single `scanOnce()`. A slow 5s `setInterval` runs alongside as a safety net (fs.watch is known to silently miss events on some platforms). Falls back to the legacy 2s polling if `fs.watch` throws or emits an error. New `watcherActive()` accessor exposes which mode is active.

### Changed (refactor)
- **`globalThis.__dsh_hermes_link_broker__` removed (E5)** - the SSE broker is now propagated via explicit deps injection (`createAmendWatcher({ broker })`, `registerHttp` deps chain). A `globalThis` fallback remains for the deprecation window so existing test setups and external callers keep working. All public surface (HTTP routes, JSON-RPC methods, tool names) is unchanged.

### Tests
- `scripts/test-amend-watch.mjs` - 10 cases (lifecycle + `watcherActive()`, new file detection within 4s window, burst batched into single scan, legacy + bad-nonce paths still work, empty dir tolerance, stats counters, idempotent dispose).
- All 370 existing tests pass unchanged (legacy globalThis fallback keeps them working).
- Total: 370 passing (360 baseline + 10 amend-watch).

---

## [0.3.3] — 2026-08-28

### Added
- **`dispatch_dry_run` JSON-RPC tool (F5)** — pre-flight estimator for `dispatch_task`. Returns `{ estimated_prompt_tokens, estimated_max_output_tokens, estimated_total_tokens, prompt_chars, persona_chars, task_chars, knowledge_chars, args_chars, model_tier, would_block_on, warnings }`. Heuristic (chars / 4) but surfaces truncation risks and unknown skills without spawning a sub-agent. Use before `dispatch_task` to validate token budgets on the Hermes side. New `services/dispatch-dry-run.mjs` powers the estimator.

### Changed
- `http/jsonrpc-handlers.mjs` registers `dispatch_dry_run` in `tools/list` and increments `hermes_link_dispatch_total{mode="dry-run",status="requested"}` per call.

### Tests
- `scripts/test-dispatch-dry-run.mjs` — 30 cases (minimal spec + char accounting: persona/task/knowledge/args sums; token estimate formula; validation failures for missing required fields / null / array / empty strings; warnings for length / prompt size / model_tier / max_tokens; `would_block_on` for unknown skills; error tolerance on `ctx.tools.view` throwing; realistic Hermes pre-flight scenario; no-side-effects verification).
- Total: 360 passing (330 baseline + 30 dry-run).

---

## [0.3.2] — 2026-08-27

### Added
- **Prometheus `/mcp/collab/metrics` endpoint (F6)** — returns `text/plain; version=0.0.4` with 16 counters + 8 gauges. Bearer auth same as `/mcp/collab`. New `services/metrics.mjs` registry is wired into:
  - `index.mjs` (per-process singleton, periodic 5s collector pulls gauges from outbox / continuations / sseBroker / dispatcherCount)
  - `http/jsonrpc-handlers.mjs` (per-tool-call counter increments for dispatch_task / followup / interrupt / get_dispatch / dispatch_status / dispatch_tail)
  - `services/audit.mjs` + `services/outbox.mjs` + `services/amend-watcher.mjs` (per-write counter increments via `setMetricsSink` hooks)

### Counters
- `hermes_link_dispatch_total{mode,status}` / `_followup_total{status}` / `_interrupt_total{status}` / `_consult_total{status}` / `_import_total{status}`
- `hermes_link_amend_total{result}` + `_amend_rejected_legacy_total`
- `hermes_link_outbox_flush_runs_total` / `_dropped_queue_full_total` / `_dropped_retries_total` / `_session_mirror_errors_total` / `_memory_suggest_total` / `_usage_total` / `_session_events_total`
- `hermes_link_audit_appends_total` / `_continuables_registered_total`

### Gauges
- `hermes_link_continuable_children{status}` / `_outbox_queue_depth` / `_outbox_items_queued` / `_active_dispatchers`
- `hermes_link_sse_clients` / `_sse_channels` / `_uptime_seconds` / `_build_info{version}`

### Changed
- `services/audit.mjs` + `services/outbox.mjs` + `services/amend-watcher.mjs` now export `setMetricsSink(metrics)` hooks; behavior unchanged when no sink is set.
- `index.mjs` teardown now also stops the metric collector interval timer on plugin dispose.

### Tests
- `scripts/test-metrics.mjs` — 20 cases (registry primitives: counter/gauge semantics, label encoding, text format).
- `scripts/test-metrics-integration.mjs` — 10 cases (shape completeness, realistic increment patterns, format compliance).
- All existing tests pass unchanged (counter increments are best-effort and never break the writer).
- Total: 330 passing (300 baseline + 20 metrics + 10 integration).

---

## [0.3.1] — 2026-08-26

### Added
- **Outbox file rotation (F2)** — `services/outbox-rotation.mjs` rotates `usage.jsonl` / `session-mirror/<sid>.jsonl` when over size, archives `heartbeat/` + `memory-suggest/` after age, purges after retention window. New DSH-side Cordis tool `rotate_outbox_now` for manual triggering (Hermes cron can call hourly).
- **`dispatch_status` / `dispatch_tail` JSON-RPC + DSH-side tool (F4)** — live continuable children snapshot (task_id / child_id / status / tokens / recent audit entries). New `services/dispatch-status.mjs` powers both surfaces; `get_dispatch` also gains `task_id` / `kind` / `since_ts` / `until_ts` filters and `live_continuable` enrichment on each entry.

### Changed (perf)
- **Write-behind outbox queue (E2)** — `appendUsage` / `appendSessionEvent` / `writeMemorySuggestion` enqueue to per-(kind, path) buckets and return immediately; a periodic timer (default 5s) drains the queue with one `appendFileSync` per file per flush. Per-bucket retry on failure (3x), queue cap with warning + counter. `outbox.stop()` on plugin unload flushes synchronously. Heartbeat now also carries `outbox_queue_depth` + `outbox_flush_runs` + caller-provided `last_dispatch_latency_ms` + `dsh_version`.

### Tests
- `scripts/test-outbox-rotation.mjs` — 14 cases (size + age archive for heartbeat / memory-suggest, size rotation for usage + session-mirror, purge, idempotency, defaults, missing-dirs tolerance, stats, lifecycle).
- `scripts/test-dispatch-status.mjs` — 18 cases (readAuditRecords parsing + missing-file tolerance; filterAuditRecords single + combined; buildDispatchStatus with/without filter, with/without audit_recent, null continuations, is_live detection; readChildSessionTail not-live + tail slicing + null ctx + limit cap; round-trip JSON).
- `scripts/test-outbox-writebehind.mjs` — 17 cases (write-behind semantics, batching 100 entries into 1 flush, session-mirror per-sid grouping, timer flush, queue cap, heartbeat enrichment, mixed kinds, stop, counters, config exposed, error tolerance).
- All existing tests pass unchanged (3 K.3 cases + 3 outbox cases updated to call `flushNow()` before reading files). Total: 300 passing (283 baseline + 17 new).

### Security
- No changes to the security model. All cross-process channels remain authenticated (amend nonce + consult secret + bearer). F2/F4 are observability/perf only.

---

## [0.3.0] — 2026-08-25

### Added
- **SSE real-time event stream (F1)** — `GET /mcp/collab/stream?task_id=…&since_seq=N&timeout_ms=N` (Bearer auth same as main routes). Output is `text/event-stream`. Event kinds: `lifecycle`, `step`, `token`, `amend`, `followup`, `interrupt`, `overflow` (replay miss), `not_found` (unknown task). Supports `since_seq` replay; bounded ring buffer (1000 events/channel) with 5s terminal hold + GC. Heartbeat 15s. New `services/sse-broker.mjs` (pub-sub + bounded ring + slow-consumer drop). New `dispatch_subscribe` JSON-RPC tool as a discovery helper that returns the SSE URL.
- `services/error-codes.mjs` (E9) — centralized error code registry (`E_AUTH_REQUIRED`, `E_DUPLICATE_TASK_ID`, `E_NO_LIVE_AGENT`, `E_SPAWN_FAILED`, `E_DISPATCH_FAILED`, `E_UNKNOWN_CHILD`, `E_TOOL_CATALOG_UNAVAILABLE`, `E_UNKNOWN_METHOD`, `E_UNKNOWN_TOOL`, `E_INVALID_SPEC`, `E_INTERNAL`, `E_INVALID_REQUEST`, `E_PARSE_ERROR`). All error responses carry `data.error_code` (symbolic name) and `data.hint` (one-line remediation).
- `scripts/check-version-sync.mjs` — cross-file version consistency check (8 canonical locations, CI-friendly).
- `scripts/check-docs-fresh.mjs` — README / SKILL.md tool table vs `tools/*.mjs` actual content + CHANGELOG section check.

### Changed (refactor)
- **HTTP layer split (E1)** — `http/dispatch.mjs` slimmed from 1147 lines to ~290; new files `http/jsonrpc-handlers.mjs` (JSON-RPC envelope + tools/list + dispatch_probe), `http/dispatch-task.mjs` (dispatch_task + validateSpec + formatPersona + helpers), `http/dispatch-control.mjs` (followup / interrupt / list / get), `http/_util.mjs` (mcpError / mcpResult / clampInt / sendJson). Public API fully preserved via re-export from `dispatch.mjs`; existing tests pass unchanged.
- All `mcpError(null, -32xxx, ...)` literal numeric calls replaced with `mcpError(null, 'E_*', ...)`. JSON-RPC wire codes preserved (backward compatible with existing Hermes clients).

### Tests
- `scripts/test-error-codes.mjs` — 12 cases (envelope, hint merge, unknown guard, code invariants, field completeness, reachability, re-export shim).
- `scripts/test-sse-broker.mjs` — 16 cases (pub/sub, SSE headers, since_seq replay, overflow, multi-subscriber, detach, backpressure, heartbeat, stats, close, re-attach, isAttached, timeout, manual close).
- All existing tests pass unchanged: 202 baseline + 12 error-codes + 16 sse-broker = **230 total**.

### Security
- New Layer 12 — SSE auth (Bearer auth required, same token as main routes; no token → open, same as `/health` exemption). All cross-process channels remain authenticated (amend nonce + consult secret + bearer).

---

## [0.2.6] — 2026-08-24

### Fixed
- **Hermes → DSH import now preserves Hermes AI replies and tool activity.** `requestDumpToEvents()` previously only parsed Anthropic-style `content` blocks; real Hermes request dumps can be OpenAI-compatible (`assistant.content` as a string, `assistant.tool_calls[]`, and separate `role: 'tool'` tool-result messages). The converter now normalizes both formats, emitting `assistant/message`, `tool/call`, and `tool/result` events instead of dropping them or leaving blank assistant placeholders.

---

## [0.2.5] — 2026-08-23

### Changed (BREAKING)
- **Plugin id rename: `hermes-link` → `dsh-hermes-link`** — Cordis bundle id, install/uninstall script names, npm package, GitHub repo, local paths, all log prefixes (`[dsh-hermes-link]`), HTTP header names (`x-dsh-hermes-link-*`), cordis provider name, dispatch `serverInfo.name`, imported-history `provider` field, label prefixes, doc titles, and internal id references are all renamed. The functional surface (tools, routes, file protocols) is unchanged.
- **npm package**: `@tianbuyu-wwx/dsh-hermes-link` v0.2.5 (was `@tianbuyu-wwx/dsh-hermes-link` v0.2.4 in the same scope — note the npm scope `@tianbuyu-wwx` is unchanged; only the package-name segment after the slash moved from `dsh-hermes-link` to `dsh-hermes-link`).
- **GitHub repo**: `github.com/Tianbuyu-wwx/dsh-hermes-link` (was `…/dsh-hermes-link`).
- **Local install path**: `node_modules/dsh-hermes-link` (was `node_modules/dsh-hermes-link`).
- **Skills folder**: `skills/dsh-hermes-link/SKILL.md` (was `skills/dsh-hermes-link/SKILL.md`); users who relied on `@skill dsh-hermes-link` must switch to `@skill dsh-hermes-link`.
- **Audit + continuation state**: `~/.dsh/dsh-hermes-link/{audit.jsonl,continuables.sqlite}` (was `~/.dsh/dsh-hermes-link/…`); install script auto-renames the legacy directory on first run.
- **Install / uninstall scripts**: `scripts/install-dsh-hermes-link.ps1` + `scripts/uninstall-dsh-hermes-link.ps1` (was `install-dsh-hermes-link.ps1` + `uninstall-dsh-hermes-link.ps1`).
- **Backup filename for Hermes `config.yaml`**: `.bak.dsh-hermes-link.<ts>` (was `.bak.dsh-hermes-link.<ts>`).

### Migration from v0.2.4 (hermes-link)
1. Pull v0.2.5 from npm: `npm install -g @tianbuyu-wwx/dsh-hermes-link` (or use the install script in the new repo).
2. Run the new install script — it:
   - auto-renames `~/.dsh/dsh-hermes-link/` → `~/.dsh/dsh-hermes-link/` (audit + continuables are preserved),
   - unlinks the legacy `node_modules/dsh-hermes-link` junction,
   - disables the legacy `- id: dsh-hermes-link` row in profile `cordis.patch.yml` (with a comment pointing at the new id; harmless while disabled),
   - adds the enabled `- id: dsh-hermes-link` row,
   - writes the new symlink + adds `dsh-hermes-link` to `dependencies` + `bundles` in profile `package.json`.
3. Restart DSH web. Old tooling (`@skill dsh-hermes-link`) will no longer match the skill id — use `@skill dsh-hermes-link` instead.
4. Existing Hermes-side scripts (those that read/write `Hermes Home/inbox/dsh/…`) do not change; only the human-readable log prefixes and the optional `version` string in the file envelope are renamed (`hermes-link/X.Y.Z` → `dsh-hermes-link/X.Y.Z`).

### Notes
- Functional behavior, all 161 unit / smoke / import-check tests, and the Hermes-side wire protocol (dispatch, consult, amend) are unchanged.
- Legacy id `dsh-hermes-link` is kept **disabled** in `cordis.patch.yml` after migration so DSH still boots cleanly; remove it manually if you want a fully clean patch file.
- `hermes-foundation / -oneshot-arbitrate / -dispatch-bridge / -dsh-collab` plugin rows remain disabled as before; this rename only affects the active `dsh-hermes-link` id.

---

## [0.2.4] — 2026-08-22

### Fixed
- **Turn envelope (turn:0 → turn:1)** — DSH persistence validator rejects `turn/end` with `data.turn < 1` as `malformed pre-react-loop turn/end`. The converter now emits every control/message event with `turn: 1`. Without this, **every imported Hermes session was unresumable** (visible in sidebar, open-to-resume failed). Closes the "can sync but cannot continue" symptom.
- **Corrupt-artifact auto-rebuild** — `importSession()` now detects inspect failures that mention `failed validation` / `malformed`, removes the on-disk session.jsonl.zstd, and rebuilds from the request dump on the same call. Prevents the previous `already_imported + "persisted but inspect failed"` stuck state.
- **`import_hermes_session` tool output schema** — declared `firstUserSnippet`, `model`, `attach`; execute normalizes nullable fields instead of leaking `null` into the schema. Tool calls no longer return `tool returned invalid output`.

### Added
- `dispatch_probe` MCP tool — zero-cost tool-name validation against `ctx.tools.view().restrictableNames`. Prevents Hermes from burning an LLM turn on a typo'd `skill`.
- UTF-8 chunk-safe `readAllStream` (chunk-boundary multi-byte mojibake fix) and `content-type: application/json; charset=utf-8` in `sendJson`.
- Persona envelope `encoding rules` block (CJK mojibake: don't guess-reconstruct; sentinel strings verbatim).
- Public release: split from `dsh-hermes` monorepo to `github.com/Tianbuyu-wwx/dsh-hermes-link`, MIT-licensed, npm-scoped `@Tianbuyu-wwx/dsh-hermes-link`, dshmarket-ready.

---

## [0.2.3] — 2026-08-22

### Security (K.1–K.5)
- **K.1**: `load_hermes_persona` no longer reads `MEMORY.md`; `scope: 'memory'` returns a migration hint pointing at `load_hermes_project_memory`.
- **K.2**: `import_hermes_session` cwd safety: rejects non-absolute paths, null bytes, >1024 chars, and 17 system-critical roots (Windows `C:\Windows`, `C:\Program Files`, etc.; POSIX `/etc`, `/bin`, `/usr`, etc.). Caller-supplied `workspace` overrides are not restricted.
- **K.3**: `outbox.appendSessionEvent` filename >200 chars → sha1(12 hex) tail truncation.
- **K.4**: turn/end strict envelope (legacy-only error path hardened against malformed modern events).
- **K.5**: `redactEvent` regex list extended with `cookie`, `set_cookie`, `session_id`, plus a Set-Cookie-specific regex.

### Added
- `test-v0.2.3-hardening.mjs` — 18 case regression suite.

---

## [0.2.2] — 2026-08-21

### Security (S1–S4)
- **S1**: V4 session-mirror no longer auto-writes on every session event. Becomes opt-in via the new `mirror_session_to_hermes` tool.
- **S2**: H4 amend nonce protocol — filenames now `<ts>-<task_id>-<nonce>.json`; nonce returned in `dispatch_task` metadata. Legacy two-segment names auto-archive to `done/legacy-*`.
- **S3**: Consult reply_secret — filenames now `<ticket>-<secret>.json`; secret returned in the consult payload. Opt-out via `HERMES_LINK_TRUST_LEGACY=1`.
- **S4**: Dispatch foundation is SOUL-only; cwd-scoped MEMORY.md requires explicit `include_project_memory: true` per dispatch or `load_hermes_project_memory` for the current session.

### Added
- `mirror_session_to_hermes` and `load_hermes_project_memory` tools.

---

## [0.2.1] — 2026-08-21

### Security
- Disabled main-session auto-injection of Hermes turns (v0.2.0 leaked cross-project dialogues via `~/.dsh/hermes-inbox/session.jsonl`). The historical `injectHermesTurns` function is retained for future opt-in/cwd-scoped variants.

### Added
- `hermes_clear_injected` audit tool — counts how many turns were auto-injected by an older hermes-foundation/dsh-hermes-link version; points at "open a new session" (DSH `Session.events` is append-only / deep-frozen).

---

## [0.2.0] — 2026-08-21

Consolidated the three deprecated plugins (`hermes-foundation`, `hermes-oneshot-arbitrate`, `hermes-dispatch-bridge`) into this single bundle.

### Added
- `consult_hermes`, `load_hermes_persona`, `list_hermes_sessions`, `import_hermes_session` (DSH-side Cordis tools).
- `mode: continuable` dispatch + `dispatch_followup` / `dispatch_interrupt` / `dispatch_list` / `dispatch_get` (durable sub-agents across DSH restarts).
- `tokenMeter.measure()` populates `tokens_used` on dispatch-result (was `null`).
- Audit log (D4) + usage records (D6) appended for every dispatch/consult.
- Bearer auth via `HERMES_LINK_TOKEN` env (off by default).
- `consult(prompt, ctx, timeoutOverride)` honors timeout (was always 30s).
- Hermes Home auto-detect: `HERMES_HOME` env → `%LOCALAPPDATA%\hermes` on Windows.

---

## [0.1.0] — 2026-08-20

Initial release: three-pack consolidation prototype with file-based Hermes consult + dispatch-result writer. Later superseded by v0.2.0; remains as historical reference in `dsh-hermes`.

---

## Legacy: `hermes-foundation` / `hermes-oneshot-arbitrate` / `hermes-dispatch-bridge`

The pre-v0.2 triad was archived under `dsh-hermes` with tag `archive/hermes-legacy-2026-08-22`. Each package kept its own CHANGELOG for v0.1–v0.7 (hermes-foundation) and v0.1–v0.5 (the others). See `dsh-hermes/docs/delivery-v0.{2..5}.0-20260820.md` for the full history.