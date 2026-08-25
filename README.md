# dsh-hermes-link

[![npm version](https://img.shields.io/npm/v/@Tianbuyu-wwx/dsh-hermes-link)](https://www.npmjs.com/package/@Tianbuyu-wwx/dsh-hermes-link)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue)](https://github.com/dsh-market/awesome-dsh-plugin)

> Bidirectional bridge between **Hermes Agent** and **DeepSeek Harness (DSH)**. Hermes dispatches focused tasks (one-shot or continuable) via JSON-RPC over `POST /mcp/collab`; DSH spawns sub-agents, returns real measured tokens, and lets you **continue any Hermes session as a native DSH session in the sidebar**.

---

## Table of contents

- [Why dsh-hermes-link exists](#why-dsh-hermes-link-exists)
- [Features](#features)
- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [License](#license)
- [Related docs](#related-docs)

---

## Why dsh-hermes-link exists

Hermes is an *agent*-*orch-estrator* — it plans the work, picks the skill, loads the knowledge slice. DSH is a *coding-runtime* — it runs sub-agents, edits files, runs shells, talks to LLMs. Each tool does its job well in isolation; the question was always how to make them *one system* without dragging each one's concerns into the other.

Earlier we ran this as three separate plugins (`hermes-foundation`, `hermes-oneshot-arbitrate`, `hermes-dispatch-bridge`). That triad is now archived under `dsh-hermes` with an `archive/hermes-legacy-2026-08-22` tag — `dsh-hermes-link` is the single plugin that replaced them, and this repository is the home of that replacement.

---

## Features

### Agent-communication line (Hermes → DSH)

- **`POST /mcp/collab`** — JSON-RPC 2.0 endpoint Hermes posts to.
  - `dispatch_task` with `mode: one-shot | continuable`. Continuable children are durable across DSH restarts (SQLite-backed).
  - `dispatch_followup` / `dispatch_interrupt` / `dispatch_list` / `dispatch_get` / `get_dispatch`.
  - `dispatch_probe` — zero-cost tool-name validation against `ctx.tools.view().restrictableNames` so Hermes doesn't burn an LLM turn on a typo.
  - `dispatch_subscribe` (v0.3.0) — discovery helper that returns the SSE URL.
  - **`get_dispatch`** — read `audit.jsonl` for the most recent entries.
- **`GET /mcp/collab/stream` (v0.3.0 F1)** — `text/event-stream` of real-time events for a continuable task (lifecycle / step / token / amend / followup / interrupt). Bearer-auth, `?task_id=...&since_seq=N&timeout_ms=N`.
- **Bearer auth** via `HERMES_LINK_TOKEN` env (open by default).
- **H4 amend nonce** (v0.2.2+): amend files must be named `<ts>-<task_id>-<nonce>.json`; nonce returned in `dispatch_task` metadata.
- **Consult reply_secret** (v0.2.2+): reply files must be named `<ticket>-<secret>.json`; secret returned in the consult payload.
- **Persona envelope**: SOUL injected (v0.2.2+); `include_project_memory: true` opts in cwd-scoped MEMORY; encoding rules prevent CJK mojibake; sentinel strings are never paraphrased.
- **Real measured tokens**: `ctx.tokenMeter.measure(run.localAgent)` populates `tokens_used` on the dispatched result — no more `null` in dispatch-result.

### User-view line (DSH → Hermes)

| Tool | Purpose |
|---|---|
| `list_hermes_sessions` | enumerate Hermes archives enriched with title/model/cwd from Hermes `state.db` |
| `import_hermes_session` | convert a Hermes archive to a live DSH session — **click-to-resume** |
| `load_hermes_persona` | inject Hermes SOUL.md + config into the current session (v0.2.3: no longer reads MEMORY.md) |
| `load_hermes_project_memory` | cwd-scoped Hermes MEMORY.md loader (matches only this project's Hermes sessions) |
| `consult_hermes` | ask Hermes a question (file-based async; reply must carry secret suffix since v0.2.2) |
| `mirror_session_to_hermes` | opt-in V4 mirror with secret-pattern redaction (v0.2.2; cookies / JWTs / API keys / set-cookie / session_id redacted) |
| `hermes_inbox` / `hermes_inbox_append` | read / append to the shared conversation record (`~/.dsh/hermes-inbox/session.jsonl`) |
| `hermes_clear_injected` | audit-only: count turns auto-injected by an older hermes-foundation/dsh-hermes-link version, point at "open a new session" |

### Auto-loop

- **Startup auto-sync** imports every Hermes session into DSH.
- **fs-watcher** polls `Hermes Home/sessions/` and re-syncs on new dumps.
- **Import format compatibility**: the converter accepts both Anthropic-style content blocks and OpenAI-compatible request dumps (`assistant.content` string + `assistant.tool_calls[]` + `role: 'tool'` results), so Hermes AI replies and tool calls are preserved in imported DSH sessions.
- **heartbeat** (60s), **usage** (per-task), **memory-suggest** all run in the background.
- **amend watcher** (H4 nonce-bound) delivers mid-task amendments from Hermes to running continuable children.
- **Hermes Home auto-detect**: `HERMES_HOME` env → `%LOCALAPPDATA%\hermes` on Windows → `~/.local/share/hermes` on POSIX.

### Security boundaries

| Risk | Mitigation | Since |
|---|---|---|
| Cross-project context pollution (Hermes injects project-A dialogue into DSH's project-B session) | main-session auto-injection disabled; MEMORY.md not broadcast; project-memory only matches cwd | v0.2.1 + v0.2.2 + v0.2.3 |
| Adversary writes `amend/*` to hijack a running sub-agent | nonce-bound filename (`<ts>-<task_id>-<nonce>.json`) | v0.2.2 |
| Adversary writes `consult-reply/*` to impersonate Hermes | secret-bound filename (`<ticket>-<secret>.json`) | v0.2.2 |
| Dispatched sub-agent inherits global MEMORY notes from unrelated projects | foundation = SOUL-only; `include_project_memory: true` is explicit opt-in per dispatch | v0.2.2 |
| Hermes state.db poisoned cwd → `C:\Windows\System32` | `isSafeCwd()` rejects 17 system roots + null byte + >1024 chars | v0.2.3 |
| Mirror filename >200 chars triggers `ENAMETOOLONG` silent failure | sha1(12 hex) tail truncation with preserved uniqueness | v0.2.3 |
| Mirror leaks cookie / set-cookie / session_id | redact regex list expanded to 10+ secret shapes | v0.2.3 |
| Imported sessions resume-unusable (`turn:0` events fail DSH persistence validator) | turn envelope rewritten to start at 1; corrupt artifacts auto-removed and rebuilt | v0.2.4 |

See [docs/security-model.md](docs/security-model.md) for the full layered model.

---

## Quickstart

### Install from dsh-market (recommended)

```sh
# 1. Make sure dsh-market is installed in your profile
dsh plugin --profile web add dshmarket

# 2. Restart dsh web, open Settings → Plugin Market, search "dsh-hermes-link", one-click install
```

### Install from npm directly

```sh
dsh plugin --profile web add @Tianbuyu-wwx/dsh-hermes-link
```

### Install from a local checkout (dev loop)

```sh
git clone https://github.com/Tianbuyu-wwx/dsh-hermes-link.git
cd dsh-hermes-link
dsh plugin --profile web add ./packages/dsh-hermes-link
```

Then restart `dsh web`. Open Hermes-config.yaml (`%LOCALAPPDATA%\hermes\config.yaml` on Windows) and add:

```yaml
mcp_servers:
  dsh-bridge:
    url: http://127.0.0.1:3080/mcp/collab
```

Optionally set `HERMES_LINK_TOKEN` in your DSH env to require a `Bearer` header (off by default).

### Verify

```sh
node scripts/verify-install.mjs
```

Then in DSH:

```
/mcp/collab/health → { ok: true, version: "0.2.4", importer_ready: true, persona_ready: true, consult_ready: true, auth: "open|bearer-required", continuable_registry: "on", foundation_slice_chars: 1234, active_dispatchers: 0 }
```

---

## Architecture

```
                Hermes (orchestrator)
                      │
        config.yaml mcp_servers.dsh-bridge
                      ▼
        POST /mcp/collab (JSON-RPC 2.0)
        dispatch_task / followup / interrupt / list / get
        dispatch_probe / get_dispatch
                                          ┌──────────────────────────────────────┐
                                          │ dsh-hermes-link (Cordis bundle)          │
                                          │   ├─ HTTP routes /mcp/collab*        │
                                          │   │   ├─ POST /mcp/collab (RPC)       │
                                          │   │   ├─ GET  /mcp/collab/health      │
                                          │   │   ├─ GET  /mcp/collab/sessions   │
                                          │   │   ├─ POST /mcp/collab/import     │
                                          │   │   ├─ POST /mcp/collab/import-all │
                                          │   │   ├─ POST /mcp/collab/rename-all │
                                          │   │   ├─ GET  /mcp/collab/persona    │
                                          │   │   ├─ POST /mcp/collab/consult    │
                                          │   │   └─ POST /mcp/collab/memory-suggest │
                                          │   ├─ services/                       │
                                          │   │   ├─ importer            request-dump → DSH SessionEvent[] │
                                          │   │   ├─ watcher             fs-poll Hermes Home/sessions/ │
                                          │   │   ├─ personaLoader       SOUL / MEMORY / config        │
                                          │   │   ├─ consultClient       file-based Hermes consult      │
                                          │   │   ├─ outbox              D3/D6/D7 + V4 mirror (opt-in)  │
                                          │   │   ├─ continuations       continuable child registry     │
                                          │   │   ├─ amendWatcher        H4 nonce-bound delivery        │
                                          │   │   ├─ audit               D4 audit JSONL                 │
                                          │   │   └─ hermes-project-memory cwd-scoped MEMORY (opt-in)    │
                                          │   └─ tools/                          │
                                          │       ├─ list_hermes_sessions                       │
                                          │       ├─ import_hermes_session                      │
                                          │       ├─ load_hermes_persona                        │
                                          │       ├─ load_hermes_project_memory                 │
                                          │       ├─ consult_hermes                             │
                                          │       ├─ mirror_session_to_hermes                   │
                                          │       ├─ hermes_inbox / hermes_inbox_append          │
                                          │       └─ hermes_clear_injected                      │
                                          └──────────────────────────────────────┘
                                          │
        DSH→Hermes files                  v                  Hermes→DSH files
        ──────────────                                       ──────────────
        dispatch-result/<task_id>.json                  amend/<ts>-<task_id>-<nonce>.json
        consult/<ts>-<uuid>.json (reply_secret)        consult-reply/<ticket>-<secret>.json
        heartbeat/{ts}.json + latest.json              (Hermes writes; DSH verifies)
        usage.jsonl
        memory-suggest/<ts>.json
        session-mirror/<sid>.jsonl  (opt-in via mirror_session_to_hermes)
```

See [docs/](docs/) for component-level details.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HERMES_HOME` | auto-detected (`%LOCALAPPDATA%\hermes` on Windows, `~/.local/share/hermes` on POSIX) | Hermes data root |
| `HERMES_LINK_TOKEN` | unset | When set, every `/mcp/collab*` (except `/health`) requires `Authorization: Bearer <token>` |
| `HERMES_LINK_TRUST_LEGACY` | unset (`0`) | When set (`1`), legacy `<ticket>.json` consult-reply is accepted alongside the v0.2.2 `<ticket>-<secret>.json` |

---

## Security model

[docs/security-model.md](docs/security-model.md) walks through each layer in detail. TL;DR — every cross-project channel is explicit opt-in; every cross-process channel is authenticated; no `null` tokens, no unbounded system paths, no unredacted cookie/secret leakage.

Report vulnerabilities privately via **GitHub Security Advisories** on this repo. See [SECURITY.md](SECURITY.md).

---

## Roadmap

| | Item | Status |
|---|---|---|
| ✅ | L1/L2/L3 three-pack → single `dsh-hermes-link` plugin | shipped 2026-08-20 |
| ✅ | v0.1 → v0.2: full bidirectional + continuable + amend nonce + mirror opt-in + foundation SOUL-only | shipped 2026-08-21 |
| ✅ | v0.2.1: disable main-session auto-injection; `hermes_clear_injected` audit | shipped 2026-08-21 |
| ✅ | v0.2.2: S1–S4 (mirror opt-in / amend nonce / consult secret / project memory opt-in) | shipped 2026-08-21 |
| ✅ | v0.2.3: K.1–K.5 (persona SOUL-only / cwd whitelist / mirror filename cap / redact cookie+session_id) | shipped 2026-08-22 |
| ✅ | v0.2.4: turn envelope fix + corrupt-artifact auto-rebuild + tool output schema normalization + open-source | shipped 2026-08-22 |
| ✅ | v0.3.0: SSE realtime stream (F1) + error codes registry (E9) + HTTP layer split into 4 files (E1) | shipped 2026-08-25 |
| ⏭ | Reverse tunnel (cross-machine / firewall traversal) | reserved |
| ⏭ | SSE real-time stream | reserved |
| ⏭ | File rotation for `session.jsonl` / mirror / usage | suggested (Hermes-side cron) |

---

## FAQ

**Q: Does Hermes need to upgrade anything to talk to dsh-hermes-link v0.2.2+?**
Yes. The amend nonce + consult reply_secret protocols are breaking changes. See [docs/hermes-upgrade-v0.2.2.md](docs/hermes-upgrade-v0.2.2.md) and the reference gateway in `scripts/hermes-gateway-demo.py`.

**Q: I imported a Hermes session — it shows in the sidebar but I can't open it.**
That's the v0.2.4 bug (turn:0 envelope failing DSH persistence validator) — fixed in v0.2.4 by bumping `turn/start..turn/end` to 1 and auto-rebuilding corrupt artifacts. Update to v0.2.4 (auto-recovery runs on next sync) or `dsh plugin update dsh-hermes-link`.

**Q: My `import_hermes_session` returns "invalid output" before v0.2.4.**
Same issue — fixed by declaring `firstUserSnippet` / `model` / `attach` in the tool output schema and normalizing nullable fields. Update to v0.2.4.
**Q: I imported a Hermes session, but only my messages appear — Hermes AI replies and tool calls are missing.**
That was an import-converter bug for OpenAI-compatible Hermes dumps (`assistant.content` as string + `assistant.tool_calls[]` + `role: 'tool'` results). It is fixed in the current working tree: re-import the session (delete the persisted `hermes-*` DSH session first, then run `import_hermes_session` / auto-sync) to get `assistant/message`, `tool/call`, and `tool/result` events back.

**Q: What's the difference between `consult_hermes` and Hermes' own consult?**
Both end up at Hermes. `consult_hermes` is a DSH tool that any user can call inside their session; `dispatch_task` is the agent-comm RPC that Hermes initiates. They share the file-based reply protocol but live on different routes (`POST /mcp/collab/consult` vs `POST /mcp/collab`).

**Q: Why not just one plugin instead of three (`hermes-foundation / -oneshot-arbitrate / -dispatch-bridge`)?**
That's exactly what v0.2.0 did — those three are archived under `dsh-hermes` with tag `archive/hermes-legacy-2026-08-22`. Single-plugin form is less bookkeeping and easier to reason about; dsh-hermes-link is that consolidation.

---

## License

MIT © 2026 Tianbuyu-wwx — see [LICENSE](LICENSE).

---

## Related docs

- [docs/security-model.md](docs/security-model.md) — full layered security model
- [docs/plugin-developer-guide.md](docs/plugin-developer-guide.md) — for Hermes-side gateway developers
- [docs/plugin-install-guide.md](docs/plugin-install-guide.md) — three install paths
- [docs/dispatch-spec.md](docs/dispatch-spec.md) — JSON-RPC wire protocol
- [docs/hermes-upgrade-v0.2.2.md](docs/hermes-upgrade-v0.2.2.md) — breaking-change upgrade guide for Hermes
- [docs/delivery-v0.6.0-20260821.md](docs/delivery-v0.6.0-20260821.md) — release notes (historical)
- [CHANGELOG.md](CHANGELOG.md) — version history
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow
- [SECURITY.md](SECURITY.md) — vulnerability disclosure policy
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards