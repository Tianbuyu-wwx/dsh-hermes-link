# @tianbuyu-wwx/dsh-hermes-link

## 0.6.6

### Patch Changes

- **Fixed: imports silently pinned no model route in production.** The importer's route resolver read `ctx.agentDefaultModel` directly, and that service turned out to be unreachable from the plugin's context — so every import since the pin shipped (33 sessions) appended no `model/selection` while every test stayed green (the tests inject the service by hand). The resolver now tries, in order: the injected service, the registry lookup `ctx.get('agentDefaultModel')`, and finally the deployment's own `agent-default-model` block in `$DSH_HOME/settings.yaml` (`HERMES_LINK_IMPORT_MODEL` still wins over all three). The live pin scan is what caught it — 33/178 sessions without a route — and `scripts/repair-imported-model-selection.mjs --apply` has pinned them.
- **`GET /mcp/collab/health` now reports `import_model_route`** — the route the next import would pin, or `null` when none resolves. An import that pins nothing leaves the conversation's model and mode selectors blocked, and until now that was only visible after the fact.
- Test: `test-import-migration` case (k) covers the settings fallback (no `agentDefaultModel` on the context at all).

## 0.6.5

### Minor Changes

- **The doctor now reports `signals`: what each channel has actually DONE, not just whether it can work.** "No failures" and "no traffic" used to look identical in the report — which is exactly how three dead channels survived an audit that read the code. The `signals` check carries dispatches, imports, consults, mirror sessions auto-enabled, outbox notifications, skipped events, expiry markers, queue depth, SSE channels and uptime.
  - One parser (`parsePrometheus`, exported) serves both the in-process registry (`metrics.serialize()`) and the CLI reading `GET /mcp/collab/metrics` over HTTP, so the two can never drift into reporting different numbers for the same metric. Labels collapse into one number on purpose; per-label detail stays one curl away.
  - Wired through all three surfaces: `GET /mcp/collab/doctor`, the session tool `hermes_link_doctor`, and `npx hermes-link-doctor --url <host> [--token <t>]` (which falls back to reading `/metrics` directly when the live probe is unavailable or auth-gated). `renderDoctor` prints the numbers as a table under the checks.

### Patch Changes

- **Fixed: the metric collector had been failing silently since v0.3.2.** Its whole cycle sat inside one `try/catch` that swallowed everything, and it called `set()` on metrics registered as COUNTERS (`hermes_link_outbox_flush_runs_total`, the dropped-`*` totals, `hermes_link_continuables_registered_total`) — which the registry refuses by contract — so everything after them (`sse_clients`, `sse_channels`, `active_dispatchers`, `uptime_seconds`, `build_info`) was never written. Every scrape reported 0 and nothing said why. The collector now lives in `services/metric-collector.mjs` (testable), writes gauges through a per-value guard, exports externally-owned totals as monotonic counter deltas, records each rejected metric once, and `hermes_link_continuables_registered_total` is incremented where continuables actually register.

## 0.6.4

### Minor Changes

- **The Hermes-side bridge now answers consults too** (`hermes-plugin/dsh-link`, renamed from `dsh-outbox`). `consult_hermes` has been writing tickets into `inbox/dsh/consult/` since v0.2.0 and nothing on the Hermes side ever answered one — the audit found three tickets that had been sitting for three weeks. The plugin now runs a background poller that answers each pending ticket with `ctx.llm.complete(...)` (the host-owned LLM facade: the user's active model, no API keys in the plugin) and writes `consult-reply/<ticket>-<secret>.json` where the DSH client expects it, plus a durable `<ticket>.answered.json` marker. `/dsh-consult [n]` drains the queue on demand; tickets older than `ttl_hours` are left to DSH's own expiry sweep. Config: `plugins.entries.dsh-link.consult.{enabled,interval_seconds,ttl_hours,max_tokens,max_per_cycle,system_prompt}`.

### Patch Changes

- **The channel health check no longer cries dead once a reply has been consumed**: it reads the `<ticket>.answered.json` marker as answer evidence, so abandoned tickets (the three from the audit) report `degraded` — "Hermes answered recently, these are abandoned" — instead of `dead`, and the consult pre-flight stops trimming every future call to 2s.
- The consult sweep counts an answered ticket once (the marker is evidence, not a second ticket).

## 0.6.3

### Minor Changes

- **The reverse channel finally has a producer.** `Hermes Home/outbox/hermes/` was promised by `docs/DSH-HERMES-LINK-PLAN.md` and the DSH-side consumer shipped in 0.6.0 — but nothing on the Hermes side ever wrote a file, so the channel sat idle (a consumer with no producer looks exactly like "nothing to do"). `npx hermes-link-install-hermes-plugin` installs `hermes-plugin/dsh-outbox` into `<Hermes Home>/plugins/dsh-outbox/`, the documented out-of-tree plugin location, where it registers `on_session_end` and the `/dsh-notify <message>` slash command:
  - one `import` notification per Hermes **turn end** → DSH imports/refreshes that session immediately instead of waiting for its own dump watcher;
  - a `notify` when a turn failed or was interrupted (also published on DSH's `hermes-outbox` SSE channel);
  - a `producer_ready` ping at load, so "no notifications" can be told apart from "no producer".
  Hermes must be **restarted** after installing (plugins are discovered at start-up); `GET /mcp/collab/doctor` reports whether the producer is present.

### Patch Changes

- **Consumer hardening**: scans can no longer overlap (the fs.watch debounce, the safety poll and the start-up pass used to race), and a notification that vanishes between listing and reading is counted as `gone` instead of sticking into `last_error` and raising a doctor warning for a benign race.
- **New doctor check `hermes_producer`**, plus the installer hardening it exposed (`copyFileSync` + a post-copy existence check).

## 0.6.2

### Patch Changes

- **`hermes_link_doctor` tool** — the runtime self-check is now callable from inside a DSH session, not only from a shell or curl. Same module behind `npx hermes-link-doctor`, `GET /mcp/collab/doctor` and the tool.
- **Consult pre-flight** — `consult_hermes` checks the channel before waiting. With a backlog and no reply for days (the state the audit found: three tickets, three weeks) it waits 2s instead of the full 15s and says why, instead of making every caller rediscover a dead channel. An explicit `timeout_ms` still wins.
- **The mirror scope is editable the safe way** — `session_mirror` gains `action=projects|add-project|remove-project` (`path=<dir>`), writing `<DSH_HOME>/dsh-hermes-link/mirror-projects.json` as bare UTF-8 and applying it to the next event without a restart. Hand-writing that file is what produced the BOM that silently disabled the mirror.
- **Fixed: `GET /mcp/collab/metrics` returned 503 in production** — `index.mjs` never passed the metrics registry into the HTTP layer, and the e2e suite builds its own deps so CI stayed green. A wiring guard now asserts that every `deps.*` the HTTP layer reads is provided by the production call.
- **Fixed: the mirror scope file is BOM-tolerant**, and a file that exists but cannot be parsed is reported (`policyStatus().projects_file_error` + a doctor warning) instead of being silently ignored.
- **Fixed: decision diagnostics** no longer glue the packed config revision onto the reported `cwd`.

## 0.6.1

### Patch Changes

- **The doctor and the model-pin repair tool now ship with the package.** `bin/hermes-link-doctor.mjs` and `bin/repair-imported-model-selection.mjs` are exposed as the `hermes-link-doctor` and `hermes-link-repair-model-pins` bins, so an npm install can run `npx hermes-link-doctor` (or `npx hermes-link-repair-model-pins --apply`) without cloning the repository. The repository's `scripts/hermes-link-doctor.mjs` and `scripts/repair-imported-model-selection.mjs` remain as thin wrappers; `GET /mcp/collab/doctor` is still the in-process surface.

## 0.6.0

### Minor Changes

- **Both sync directions now work end to end (audit phases A–D).**
  - **Hermes → DSH import** migrated to the DSH 0.1.5 handle-based persistence API (`stat`/`list` + the write handle `create()` returns: `append`/`flush`/`close`). Failures no longer degrade to `already_imported`, imported history is anchored in one workspace (`HERMES_LINK_IMPORT_WORKSPACE`, with `HERMES_LINK_IMPORT_PER_PROJECT=1` restoring per-project inference), and a Windows cwd that is not fully qualified is never handed to DSH.
  - **Imported sessions get a live model route.** Imports now append a `model/selection` event pointing at the deployment's own route (`ctx.agentDefaultModel`). DSH reads a session's current model from its last `request/header`, and the synthetic `dsh-hermes-link` provider recorded there is served by no adapter — which blocked the whole composer (model *and* agent preset unchangeable). Existing sessions: `node scripts/repair-imported-model-selection.mjs --apply`; override the route with `HERMES_LINK_IMPORT_MODEL=provider/model[#effort]`.
  - **Session mirror that is actually reachable.** `HERMES_LINK_MIRROR_POLICY=off|scoped|all` (default `scoped`), plus `HERMES_LINK_MIRROR_PROJECTS` and the plugin-owned `<DSH_HOME>/dsh-hermes-link/mirror-projects.json` for local paths whose Hermes project key is stale or missing (re-read live — no restart). `GET /mcp/collab/session-mirror/status` now returns the resolved policy and per-session decisions, so "why is nothing mirrored?" is answerable. Mirror lines carry `{ts, cursor, source, origin_session_id, event}`; resume with `GET /mcp/collab/session-stream?session_id=<sid>&since_seq=<cursor>`.
  - **Hermes → DSH notification channel (new).** `Hermes Home/outbox/hermes/**/*.json` is consumed with the verified amend-watcher shape (fs.watch + debounce + safety poll): `kind:"import"` runs the importer, `notify`/`ping` publish on the `hermes-outbox` SSE channel, every file leaves the scan set (executed → `done/`, redelivery → `duplicate-*`, echo/malformed/unsupported/failed → prefixed), and `(source,id)` is remembered across restarts. Status: `GET /mcp/collab/hermes-outbox/status`.
  - **Runtime doctor + consult TTL.** `npm run doctor` (or `GET /mcp/collab/doctor`) measures heartbeat freshness, mirror liveness, consult backlog with per-ticket age, amend writability and outbox state — plus `--pin-scan` for imported-session model pins. Consult tickets unanswered past 24h get a non-destructive `<ticket>.expired.json` marker, counted by `hermes_link_consult_expired_total`.

### Patch Changes

- Per-token rate limiting and a daily token budget for `dispatch_task` (one `check()` per request, guarded metrics), plus a real-tokenizer path for `dispatch_dry_run`/`dispatch_task` budgets.
- Telemetry can no longer break a request path: `http/_util.mjs` exports guarded `incMetric`/`setMetric` (the registry throws on unregistered names), with a permanent regression gate in `scripts/test-telemetry-resilience.mjs`.
- Housekeeping tools: `scripts/prune-empty-workspaces.mjs` (must run with DSH stopped), `scripts/repair-imported-model-selection.mjs`, `scripts/hermes-link-doctor.mjs`.

## 0.5.0

### Patch Changes

- 8df0e6a: docs(changelog): add a "Published-vs-documented version map" header that explicitly marks `0.3.1`–`0.3.4` as **never published to npm** and points readers to `0.3.5` (the actual consolidating release). Also adds the same pointer to the package-level `CHANGELOG.md`. No runtime changes.
- 8df0e6a: ci(test): wrap `npm ci` in a 3-attempt retry via `nick-fields/retry@v3` to absorb intermittent `EPERM` / `ENOTEMPTY` failures on `macos-26-arm64` runners (the npm temp dir under `/var/folders` interacting with the homebrew node shim has produced occasional fs hiccups). All existing jobs still preserve real install failures on the 3rd attempt. No runtime changes.
- 8df0e6a: ci(release): drop the `NODE_AUTH_TOKEN` env from the publish step and document the npm trusted-publishing setup at `npmjs.com → settings → Publishing access → Trusted Publishers`. The `permissions: id-token: write` block above already wires the OIDC token; once the trusted-publisher entry exists, `--provenance` will produce a real attestation. No runtime changes.

> **Versions 0.3.1, 0.3.2, 0.3.3, and 0.3.4 were documented in the monorepo CHANGELOG (`../../CHANGELOG.md`) but never published to npm. See the "Published-vs-documented version map (2026-08-26)" section there. Use `0.3.5` (or later) for the consolidating release.**

## 0.5.0

### Minor Changes

- - Add opt-in automatic DSH session mirror (V4 opt-in): new `session_mirror` tool with `enable` / `disable` / `status`, default OFF, per-session persistence, and shared secret redaction.
  - Add Hermes real-time session sync / session-projection: `GET /mcp/collab/session-stream` SSE feed, `GET /mcp/collab/session-mirror/status`, and `mirror_status` in `list_hermes_sessions` / `GET /mcp/collab/sessions`.
  - Add `scripts/test-session-mirror.mjs`, extend smoke/import/e2e coverage, and add `session_mirror` to docs/skill/readme.

## 0.2.6

### Patch Changes

- fe4d389: fix(import): preserve Hermes AI replies and tool calls in OpenAI-style dumps
