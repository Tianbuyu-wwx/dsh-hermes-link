---
name: dsh-hermes-link
description: Hermes ↔ DSH bidirectional link. Use when the user wants to import a Hermes session into DSH, load Hermes persona (SOUL + config), load Hermes memory scoped to the current working directory, dispatch a task to a DSH sub-agent (one-shot or continuable), amend a running sub-agent, push a result to / consult Hermes from DSH, or see Hermes's conversation record in DSH. The plugin targets v0.6.9: it does NOT auto-inject Hermes turns into the current session (v0.3.6), it mirrors DSH sessions to Hermes ONLY for cwds that provably match a real Hermes project (HERMES_LINK_MIRROR_POLICY, default scoped since v0.6.0; off = manual opt-in, all = every session; hermes-* and noise events are always skipped), and it does NOT auto-load Hermes MEMORY.md (v0.2.3); every other cross-project channel remains explicit opt-in only.
when_to_use: |
  The dsh-hermes-link plugin connects DSH to a Hermes Agent installation. DSH-side
  tools (callable from this session):
    - list_hermes_sessions         — enumerate Hermes session archives (JSON dumps in Hermes Home/sessions/)
    - import_hermes_session        — convert a Hermes session archive to a live DSH session, seed it with full history
    - load_hermes_persona          — load Hermes SOUL.md + relevant config slices into the current session (v0.2.3: NO LONGER reads MEMORY.md)
    - load_hermes_project_memory   — cwd-scoped Hermes MEMORY.md loader (matches ONLY this project's Hermes sessions)
    - consult_hermes               — ask Hermes a question (file-based async; secret-suffixed reply required since v0.2.2)
    - mirror_session_to_hermes     — opt-in V4 session mirror with secret-pattern redaction (v0.2.2; cookies + JWTs + API keys covered since v0.2.3)
- session_mirror                — v0.6.0 mirror switch: enable/disable per-session mirroring to Hermes with redaction. The default policy HERMES_LINK_MIRROR_POLICY=scoped auto-enables it for a session whose cwd matches a real Hermes project; an explicit disable is a durable opt-out.
    - hermes_inbox                 — read the shared Hermes/DSH conversation record (~/.dsh/hermes-inbox/session.jsonl)
    - hermes_inbox_append          — append a turn to the shared record (DSH → Hermes)
    - hermes_clear_injected        — audit-only: report how many turns were auto-injected into THIS session by an older version; suggests "open a new session"
    - rotate_outbox_now            — v0.3.4 F2: force an immediate outbox file rotation pass (size + age archive + purge); Hermes cron can call this hourly
    - dispatch_status             — v0.3.4 F4: list live continuable dispatch children with status / tokens / recent audit entries; filterable by task_id
  On the inbound side, dsh-hermes-link runs an HTTP listener at POST /mcp/collab (the same path
  Hermes' config.yaml mcp_servers.dsh-bridge.url should point to). Hermes dispatches tasks
  there (JSON-RPC 2.0: dispatch_task one-shot or continuable, dispatch_followup,
  dispatch_interrupt, dispatch_list, dispatch_get); DSH spawns a narrow sub-agent and
  returns the result synchronously. Amendments require a nonce in the filename since v0.2.2:
  Hermes Home/inbox/dsh/amend/<ts>-<task_id>-<nonce>.json — the nonce is returned in
  dispatch_task metadata so only processes that read the consult/continuable response can
  legitimately write amend files.

  Use this skill whenever the user mentions Hermes, asks to "continue" an old Hermes conversation,
  asks to "use Hermes persona", wants DSH to act as a backend for a Hermes-dispatched task,
  or wants to share conversation records between DSH and Hermes.
---

# dsh-hermes-link

DSH-side plugin that makes Hermes Agent and DeepSeek Harness a single, bidirectional system.

## What it does

1. **Sidebar parity** — Hermes sessions appear alongside DSH sessions in the sidebar
   (read-only summary list; click to import).
2. **Click-to-resume** — opening a Hermes session from the sidebar imports the full
   conversation into a live DSH session with full historical context, ready to continue.
3. **Persona on demand** — `load_hermes_persona` injects Hermes' SOUL + MEMORY +
   relevant config slices into the current session's system prompt. Off by default;
   the user opts in. v0.2.2: foundation slice carried into dispatched sub-agents
   is SOUL-only; MEMORY.md is opt-in per dispatch via the `include_project_memory`
   flag, or via `load_hermes_project_memory` for the current session.
4. **Inbound dispatch** — Hermes posts `dispatch_task` to `POST /mcp/collab`; DSH
   spawns a sub-agent with the requested `skill` as its only allowed tool and returns
   the result synchronously (`mode=one-shot`), or keeps a durable child for followups
   (`mode=continuable`). Continuable children are nonce-bound for amend (v0.2.2).
5. **Outbound consult / result** — DSH writes to `Hermes Home/inbox/dsh/`
   (`consult/<ts>-<ticket>.json` carrying a `reply_secret`, and
   `dispatch-result/<task_id>.json`); Hermes gateway picks it up and replies at
   `<ticket>-<secret>.json` (secret suffix required since v0.2.2).
6. **Mid-task amend (H4, v0.2.2 nonce-bound)** — Hermes writes
   `Hermes Home/inbox/dsh/amend/<ts>-<task_id>-<nonce>.json`. DSH verifies the nonce
   against the registered continuable entry before delivering. Legacy two-segment
   names are rejected.
7. **Shared conversation record** — Hermes writes `~/.dsh/hermes-inbox/session.jsonl`
   (one turn per line); DSH reads it via `hermes_inbox`, writes via `hermes_inbox_append`.
   **The main DSH session does NOT auto-inject these turns on session-start
   (since v0.3.4)** — they are available on demand only.
8. **V4 session mirror (policy-scoped by default) + heartbeat + usage + memory-suggest** —
   DSH writes `Hermes Home/inbox/dsh/heartbeat/{ts}.json`, `usage.jsonl`,
   `memory-suggest/<ts>.json` automatically. The **session-mirror** follows
   `HERMES_LINK_MIRROR_POLICY` (v0.6.0; default `scoped`): a session is mirrored
   automatically only when its `header.cwd` matches a real Hermes project
   (Hermes `state.db` `sessions.cwd` / `git_repo_root`, or the same git worktree
   root); no match stays OFF. `off` restores the pre-v0.6.0 manual
   `session_mirror action=enable`, `all` mirrors every session, and an invalid
   value warns and falls back to `scoped`. Redaction is always on, and the
   echo/noise guard always skips `hermes-*` / `hermes-imported` sessions plus
   lifecycle/bookkeeping event types (`turn/start`, `turn/end`, `step/*`,
   `request/*`, `session/end-seed`, `assistant/attempt`, `session/title`,
   `model/selection`, `agent-preset/selected`, `sandbox/mode`, `approval/policy`).
   The one-shot `mirror_session_to_hermes` tool still works. Hermes can watch the
   JSONL files or subscribe to `GET /mcp/collab/session-stream?session_id=<sid>`
   for live events.
9. **Real-time SSE event stream (v0.3.0 F1)** — `GET /mcp/collab/stream?task_id=…`
   emits a `text/event-stream` of lifecycle / step / token / amend / followup /
   interrupt events for a continuable task. Use `since_seq=N` to replay buffered
   events (ring buffer 1000/channel, 5s terminal hold + GC, 15s heartbeat).
10. **Outbox file rotation (v0.3.4 F2)** — `usage.jsonl` / `session-mirror/<sid>.jsonl`
    rotate when over size limit; `heartbeat/` + `memory-suggest/` files move to
    `<dir>/archive/YYYY-MM-DD/` after age; purge after retention window.
    DSH-side `rotate_outbox_now` tool + automatic hourly timer.
11. **Live dispatch status (v0.3.4 F4)** — `dispatch_status` (JSON-RPC + DSH-side tool)
    returns live continuable children with status / tokens / recent audit entries.
    `dispatch_tail` (JSON-RPC) reads session events for a live child.
    `get_dispatch` gains `task_id` / `kind` / `since_ts` / `until_ts` filters + `live_continuable` enrichment.
12. **Write-behind outbox queue (v0.3.4 E2)** — `appendUsage` / `appendSessionEvent` /
    `writeMemorySuggestion` enqueue and a periodic timer (default 5s) drains
    the queue with one `appendFileSync` per file per flush (per-bucket retry,
    queue cap). Heartbeat carries `outbox_queue_depth` + `outbox_flush_runs`
    + caller-provided `last_dispatch_latency_ms` + `dsh_version`.

## Locations

- Hermes data home: `$HERMES_HOME` or `LOCALAPPDATA/hermes` on Windows
  (`C:\Users\<user>\AppData\Local\hermes\`). Note: `~/.hermes/` is the Edge
  browser profile, NOT this — do not confuse.
- Hermes session archives: `<Hermes_home>/sessions/request_dump_*.json`
  (Anthropic-API format; one JSON per request attempt, multiple per session).
- Hermes SOUL/persona: `<Hermes_home>/SOUL.md`, `<Hermes_home>/memories/MEMORY.md`,
  `<Hermes_home>/config.yaml`.
- Shared conversation record: `~/.dsh/hermes-inbox/session.jsonl` (Hermes writes
  via scripts/hermes-push.mjs; DSH reads/writes via the two hermes_inbox tools).
- DSH audit + continuation state: `~/.dsh/dsh-hermes-link/audit.jsonl`,
  `~/.dsh/dsh-hermes-link/continuables.sqlite`.

## Tool reference (callable from a DSH session)

| Tool | Purpose |
|---|---|
| `list_hermes_sessions` | Read-only enumeration of Hermes session archives with mtime/size/title hints. |
| `import_hermes_session` | Convert one archive to a live DSH session via `ctx.sessions.create(id, { seed, meta })`. Idempotent on session id. |
| `load_hermes_persona` | Inject Hermes persona into current session. `scope: all\|soul\|memory\|config`. |
| `load_hermes_project_memory` | cwd-scoped Hermes MEMORY.md loader. Returns ONLY lines whose context matches `agent.session.header.cwd`. Empty when no Hermes state.db session matches. |
| `consult_hermes` | Async file-based question to Hermes. v0.2.2: reply file MUST carry the secret suffix `<ticket>-<secret>.json`; legacy `<ticket>.json` is accepted only when `HERMES_LINK_TRUST_LEGACY=1`. |
| `mirror_session_to_hermes` | Opt-in V4 mirror (v0.2.2). Walks the current DSH session's events, redacts API keys / tokens / passwords / PEM / JWTs by default (`redact: false` to opt out), appends to `Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl`. NOT automatic. |
| `session_mirror` | Automatic V4 mirror control (v0.6.0). `action=enable` starts writing every new event of this DSH session to `Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl` with redaction; `action=disable` stops (durable opt-out - the policy will not silently re-enable it); `action=status` reports state, including the resolved `policy`, whether the enable was `auto`, and how many events the echo/noise guard skipped. Auto-enable is governed by `HERMES_LINK_MIRROR_POLICY` (default `scoped`). |
| `hermes_inbox` | Read the shared conversation record (`tail`/`format` params). |
| `hermes_inbox_append` | Append a turn to the shared record so Hermes sees it next session-start. |
| `hermes_clear_injected` | Audit-only: report how many Hermes turns were auto-injected into THIS session by an older dsh-hermes-link / hermes-foundation version, and point the user at "open a new session" (DSH Session.events are append-only / deep-frozen and cannot be retroactively removed). |
| `hermes_link_doctor` | v0.6.2: run the runtime self-check from inside the session (heartbeat freshness, whether enabled mirrors still advance, consult backlog with ages, amend writability, outbox state, bridge installed, and v0.6.5 channel `signals`). Same module as `npx hermes-link-doctor` and `GET /mcp/collab/doctor`; `json=true` returns the raw report. |
| `hermes_link_status` | v0.6.9: the one-glance status -- one line per channel (Hermes notifications, session import, session mirror, consult), the counters since load (including consult token usage), and the next action when something is off. Cheaper and friendlier than `hermes_link_doctor` when the question is just "is it working?"; `json=true` returns the structured object. |
| `session_mirror` (scope actions) | v0.6.2: `action=projects` / `add-project` / `remove-project` (`path=<dir>`) edit the plugin-owned scope file `<DSH_HOME>/dsh-hermes-link/mirror-projects.json`, which keeps local paths in scope when the project key Hermes recorded is stale. Written as bare UTF-8 and applied to the NEXT event — no restart. |

## HTTP (Hermes-side)

- `POST /mcp/collab` — JSON-RPC 2.0. Tools: `dispatch_task` (one-shot/continuable),
  `dispatch_followup`, `dispatch_interrupt`, `dispatch_list`, `dispatch_get`,
  `get_dispatch`; methods `initialize`, `ping`, `tools/list`. Spec at
  `dispatch-spec.schema.json`.
- `GET  /mcp/collab/health` — liveness (never auth-gated).
- `GET  /mcp/collab/sessions`, `POST /mcp/collab/import`, `GET /mcp/collab/persona`,
  `POST /mcp/collab/consult`, `POST /mcp/collab/memory-suggest`.
- `GET  /mcp/collab/session-stream` (v0.6.0) — SSE feed of newly mirrored DSH session events for `?session_id=<sid>` (since_seq / timeout_ms supported).
- `GET  /mcp/collab/session-mirror/status` (v0.6.0) — mirror state for one or all sessions. Returns `policy` (resolved policy + `extra_projects`) and `decisions` (per-session verdict + reason) so "why is nothing mirrored?" is answerable; `?session_id=` adds that session's `decision`.
- `GET  /mcp/collab/hermes-outbox/status` (v0.6.0 C1) — Hermes→DSH notification consumer state: watched dirs + executed/duplicate/rejected/failed counters, `last_error`, `pending_retries`.
- `GET  /mcp/collab/doctor` (v0.6.0 D) — runtime self-check as JSON: heartbeat freshness, mirror policy + whether enabled mirrors still advance, consult backlog with ages, amend writability, outbox state, whether the Hermes-side bridge is installed, and (v0.6.5) a `signals` check with what each channel has actually done. Same module as `npm run doctor`, plus the live in-process state.
- `GET  /mcp/collab/stream` (v0.3.4 F1) — `text/event-stream` of real-time events
  for a continuable task. Query params: `task_id` (required), `since_seq`
  (default 0), `timeout_ms` (default 0 = no auto-close). Bearer auth same as main routes.
- `dispatch_subscribe` JSON-RPC tool — discovery helper that returns the SSE URL.
- `npx hermes-link-consult-admin [--purge-expired [--apply]]` (v0.6.9) -- consult inbox status, and the opt-in cleanup of tickets the TTL sweep has already marked abandoned (they used to sit there forever, keeping the doctor's backlog warning alive with no way to clear it).
- `GET /mcp/collab/metrics` (v0.3.4 F6) — Prometheus text exposition format (text/plain; version=0.0.4). Returns 24 counters + 9 gauges (v0.6.9 adds `hermes_link_consult_tokens_total{kind}`) (v0.6.0 adds `hermes_link_mirror_policy_auto_enabled_total`, `hermes_link_mirror_policy_auto_skipped_total`, `hermes_link_mirror_events_skipped_total` and the `hermes_link_mirror_policy_info` gauge). Bearer auth same as main routes. Suitable for Prometheus / Grafana Agent scraping at 15s intervals.
- `dispatch_dry_run` JSON-RPC tool (v0.3.4 F5) — pre-flight estimator. Returns estimated prompt/output tokens + would_block_on + warnings. Heuristic (chars/4). Use before dispatch_task to validate token budgets and surface unknown skills without spawning a sub-agent.
- Auth: when env `HERMES_LINK_TOKEN` is set, all `/mcp/collab*` routes except
  `/health` require `Authorization: Bearer <token>`.

## File protocols (Hermes Home/inbox/dsh/)

| Path | Direction | Purpose |
|---|---|---|
| `consult/<ts>-<uuid>.json` (carries `reply_secret`) → `consult-reply/<ticket>-<secret>.json` + `consult/<ticket>.answered.json` | DSH→Hermes→DSH | D2 consult (v0.2.2 secret suffix required). The reply is deleted when a consult consumes it, so the `answered` marker is the durable evidence the TTL sweep and the channel health check read (v0.6.4); answered by the Hermes-side `dsh-link` plugin, or by hand. |
| `dispatch-result/<task_id>.json` | DSH→Hermes | D1 task result + tokens |
| `amend/<ts>-<task_id>-<nonce>.json` | Hermes→DSH | H4 mid-task amendment (v0.2.2 nonce required) |
| `heartbeat/{ts}.json`, `heartbeat/latest.json` | DSH→Hermes | D3 heartbeat (60s) |
| `usage.jsonl` | DSH→Hermes | D6 per-task usage |
| `memory-suggest/<ts>.json` | DSH→Hermes | D7 memory suggestion |
| `consult/<ticket>.expired.json` | DSH (marker) | v0.6.0 (B6): written beside a ticket that got no reply within 24h, so the backlog is explicit/countable. The ticket itself is kept — a late reply is still accepted. |
| `session-mirror/<dsh_session_id>.jsonl` | DSH→Hermes | V4 session mirror (v0.6.0: automatic under `HERMES_LINK_MIRROR_POLICY=scoped` for a matching project, or explicit via `session_mirror`; v0.2.2 one-shot via `mirror_session_to_hermes`; always redacted; `hermes-*` sessions + noise events never written; SSE at `/mcp/collab/session-stream?session_id=<sid>`) |

Each mirror line is `{"ts":<ms>,"cursor":<dsh event seq>,"source":"dsh","origin_session_id":"<dsh sid>","event":{...}}`
(v0.6.0 C2/C3). **Resume without rescanning**: keep the last line's `cursor` and ask
`GET /mcp/collab/session-stream?session_id=<sid>&since_seq=<cursor>` — the SSE broker uses
"seq > sinceSeq" semantics, so `cursor` is exactly the argument to pass. `source` +
`origin_session_id` let either side skip whatever it wrote itself.

### File protocols (Hermes Home/outbox/hermes/) — v0.6.0 (C1)

Bridge plugin (v0.6.3, both directions since v0.6.4): `npx hermes-link-install-hermes-plugin` copies
`hermes-plugin/dsh-link` into `<Hermes Home>/plugins/dsh-link/` — the documented out-of-tree plugin
location — and Hermes loads it with `hermes plugins enable dsh-link` (effective on the next session).

- **outbox half**: `on_session_end` → one `import` per Hermes turn end, a `notify` when the turn failed or
  was interrupted, and `/dsh-notify <message>` for a human-written message.
- **consult half**: a background poller answers `inbox/dsh/consult/` tickets with `ctx.llm.complete(...)`
  and writes `consult-reply/<ticket>-<secret>.json` + `<ticket>.answered.json` (the durable marker DSH
  uses once the reply file has been consumed). `/dsh-consult [n]` drains on demand; config knobs:
  `plugins.entries.dsh-link.consult.{enabled,interval_seconds,ttl_hours,max_tokens,max_per_cycle,system_prompt}`.
  Tickets older than `ttl_hours` are left to DSH's own expiry sweep.

Hermes must be restarted after installing (plugins are discovered at start-up). `GET /mcp/collab/doctor`
reports whether the bridge is present.

| Path | Direction | Purpose |
|---|---|---|
| `<name>.json`, `task-event/<name>.json` → `done/` | Hermes→DSH | Proactive notification (planned in `docs/DSH-HERMES-LINK-PLAN.md:95`, implemented v0.6.0). Payload: `{ "id": "<unique>", "source": "hermes", "kind": "import" \| "notify" \| "ping", "session_id"?: "<hermes sid, required for import>", "task_id"?: "...", "payload"?: {...} }`. `id` is the idempotency key: a redelivery is archived as `done/duplicate-*` and NEVER re-executed, including after a DSH restart. `kind:"import"` runs the importer (`payload.workspace` overrides the cwd). `source:"dsh"` is our own echo and is never executed. Malformed / missing-id / unsupported-kind / bad-payload files are parked in `done/` with a matching prefix; a delivery that fails is retried in place (default 3 attempts) and then parked as `done/failed-*`. Inspect with `GET /mcp/collab/hermes-outbox/status`. |