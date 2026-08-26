---
name: dsh-hermes-link
description: Hermes ↔ DSH bidirectional link. Use when the user wants to import a Hermes session into DSH, load Hermes persona (SOUL + config), load Hermes memory scoped to the current working directory, dispatch a task to a DSH sub-agent (one-shot or continuable), amend a running sub-agent, push a result to / consult Hermes from DSH, or see Hermes's conversation record in DSH. The plugin does NOT auto-inject Hermes turns into the current session (v0.3.4), does NOT auto-mirror DSH sessions to Hermes (v0.2.2), and does NOT auto-load Hermes MEMORY.md (v0.2.3); all cross-project channels are explicit opt-in only.
when_to_use: |
  The dsh-hermes-link plugin connects DSH to a Hermes Agent installation. DSH-side
  tools (callable from this session):
    - list_hermes_sessions         — enumerate Hermes session archives (JSON dumps in Hermes Home/sessions/)
    - import_hermes_session        — convert a Hermes session archive to a live DSH session, seed it with full history
    - load_hermes_persona          — load Hermes SOUL.md + relevant config slices into the current session (v0.2.3: NO LONGER reads MEMORY.md)
    - load_hermes_project_memory   — cwd-scoped Hermes MEMORY.md loader (matches ONLY this project's Hermes sessions)
    - consult_hermes               — ask Hermes a question (file-based async; secret-suffixed reply required since v0.2.2)
    - mirror_session_to_hermes     — opt-in V4 session mirror with secret-pattern redaction (v0.2.2; cookies + JWTs + API keys covered since v0.2.3)
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
8. **Opt-in V4 session mirror + heartbeat + usage + memory-suggest** — DSH writes
   `Hermes Home/inbox/dsh/heartbeat/{ts}.json`, `usage.jsonl`,
   `memory-suggest/<ts>.json` automatically. The **session-mirror** is opt-in via
   the `mirror_session_to_hermes` tool (with secret-pattern redaction).
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
| `hermes_inbox` | Read the shared conversation record (`tail`/`format` params). |
| `hermes_inbox_append` | Append a turn to the shared record so Hermes sees it next session-start. |
| `hermes_clear_injected` | Audit-only: report how many Hermes turns were auto-injected into THIS session by an older dsh-hermes-link / hermes-foundation version, and point the user at "open a new session" (DSH Session.events are append-only / deep-frozen and cannot be retroactively removed). |

## HTTP (Hermes-side)

- `POST /mcp/collab` — JSON-RPC 2.0. Tools: `dispatch_task` (one-shot/continuable),
  `dispatch_followup`, `dispatch_interrupt`, `dispatch_list`, `dispatch_get`,
  `get_dispatch`; methods `initialize`, `ping`, `tools/list`. Spec at
  `dispatch-spec.schema.json`.
- `GET  /mcp/collab/health` — liveness (never auth-gated).
- `GET  /mcp/collab/sessions`, `POST /mcp/collab/import`, `GET /mcp/collab/persona`,
  `POST /mcp/collab/consult`, `POST /mcp/collab/memory-suggest`.
- `GET  /mcp/collab/stream` (v0.3.4 F1) — `text/event-stream` of real-time events
  for a continuable task. Query params: `task_id` (required), `since_seq`
  (default 0), `timeout_ms` (default 0 = no auto-close). Bearer auth same as main routes.
- `dispatch_subscribe` JSON-RPC tool — discovery helper that returns the SSE URL.
- `GET /mcp/collab/metrics` (v0.3.4 F6) — Prometheus text exposition format (text/plain; version=0.0.4). Returns 16 counters + 8 gauges. Bearer auth same as main routes. Suitable for Prometheus / Grafana Agent scraping at 15s intervals.
- `dispatch_dry_run` JSON-RPC tool (v0.3.4 F5) — pre-flight estimator. Returns estimated prompt/output tokens + would_block_on + warnings. Heuristic (chars/4). Use before dispatch_task to validate token budgets and surface unknown skills without spawning a sub-agent.
- Auth: when env `HERMES_LINK_TOKEN` is set, all `/mcp/collab*` routes except
  `/health` require `Authorization: Bearer <token>`.

## File protocols (Hermes Home/inbox/dsh/)

| Path | Direction | Purpose |
|---|---|---|
| `consult/<ts>-<uuid>.json` (carries `reply_secret`) → `consult-reply/<ticket>-<secret>.json` | DSH→Hermes→DSH | D2 consult (v0.2.2 secret suffix required) |
| `dispatch-result/<task_id>.json` | DSH→Hermes | D1 task result + tokens |
| `amend/<ts>-<task_id>-<nonce>.json` | Hermes→DSH | H4 mid-task amendment (v0.2.2 nonce required) |
| `heartbeat/{ts}.json`, `heartbeat/latest.json` | DSH→Hermes | D3 heartbeat (60s) |
| `usage.jsonl` | DSH→Hermes | D6 per-task usage |
| `memory-suggest/<ts>.json` | DSH→Hermes | D7 memory suggestion |
| `session-mirror/<dsh_session_id>.jsonl` | DSH→Hermes | V4 session mirror (v0.2.2 OPT-IN only via `mirror_session_to_hermes` tool) |