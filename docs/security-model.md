# Security Model

`dsh-hermes-link` is a Cordis bundle that lives inside a DeepSeek Harness (DSH) web process and bridges two trust boundaries: a **Hermes Agent** process (the orchestrator) and the **DSH process** (the runtime). The bridge is exposed on `127.0.0.1:3080/mcp/collab*` by default.

This document walks through each defensive layer in the order they were added, with the file references and trust boundaries they enforce.

## Trust boundaries at a glance

```
+---------------------------+        +---------------------------+
|  Hermes Agent             |        |  DeepSeek Harness (DSH)   |
|  (orchestrator)           |        |  (web profile, this repo) |
|                           |  <-->  |                           |
|  writes:                  |  HTTP  |  Cordis bundle dsh-hermes-link|
|   - amend/<ts>-…-nonce    |  127.0 |   - HTTP routes /mcp/collab* |
|   - consult-reply/<t>-s   |   .0.1 |   - 8 Cordis tools       |
|                           |   :3080|   - importer, watcher, … |
|  reads:                   |        |                           |
|   - dispatch-result/…     |        |  writes:                   |
|   - consult/<ts>-…-secret |        |   - dispatch-result/…     |
|   - heartbeat/*           |        |   - consult/<ts>-…-secret |
|   - usage.jsonl            |        |   - heartbeat/*           |
|   - memory-suggest/<ts>   |        |   - usage.jsonl            |
|   - session-mirror/<sid>  |        |   - memory-suggest/<ts>   |
|                           |        |   - session-mirror/<sid>  |
+---------------------------+        +---------------------------+
```

## Layer 0 — Trust placement

DSH runs at the same privilege level as the host. The bridge runs **inside** the DSH process — anything dsh-hermes-link reads or writes is at host-privilege. **Trust Hermes first.** If Hermes runs as `root` / `Administrator`, the bridge inherits that.

DSH's sandbox (`workspace-write + ask` by default) does not restrict the bridge. The dispatched sub-agent inherits the parent's sandbox profile; **a deployment that wants to constrain dispatched sub-agents must constrain Hermes first.**

DSH's webserver binds to `127.0.0.1:3080` by default. **Do not expose it to the public internet** without `dsh web --trusted-host` and a TLS reverse proxy. The bearer token (`HERMES_LINK_TOKEN`) defends LAN, not WAN.

## Layer 1 (v0.2.1) — Disable main-session auto-injection

**Code**: [`packages/dsh-hermes-link/index.mjs`](../packages/dsh-hermes-link/index.mjs), `agent/session-start` hook.

**What it does**: On a fresh DSH session, do not auto-inject Hermes turns from `~/.dsh/hermes-inbox/session.jsonl` into the new session's event log.

**Threat it defends**: The shared Hermes/DSH conversation record is **project-agnostic** — `hermes-push.mjs` writes to it without a cwd tag. Auto-injection let a Hermes session for project B leak into a DSH session for project A. Once written, `Session.events` is append-only / deep-frozen — there is no rollback.

**What it allows**: Users can still read Hermes turns on demand via the `hermes_inbox` tool (returns markdown, no event-log side effect).

**Audit affordance**: `hermes_clear_injected` reports the count of pre-v0.2.1 auto-injected turns in the current session and points at "open a new session" — there is no other remediation.

## Layer 2 (v0.2.2 S1) — V4 session-mirror is opt-in

**Code**: [`packages/dsh-hermes-link/tools/mirror-session-to-hermes.mjs`](../packages/dsh-hermes-link/tools/mirror-session-to-hermes.mjs) replaces the previous `ctx.on('session/event', …)` hook.

**What it does**: Removes the auto-every-event mirror hook. The mirror tool is **only** invoked when a user calls `mirror_session_to_hermes` (or a Hermes-side dispatch chooses to mirror).

**Threat it defends**: A pre-v0.2.2 DSH session was being written into Hermes's default store on every event — including user inputs and tool calls. Switching projects would write project A's content into project B's Hermes index.

**Companion** (v0.2.3 K.5): `redactEvent()` strips 10+ secret patterns before writing — `cookie`, `set-cookie`, `session_id`, plus `api_key`, `password`, `token`, `bearer`, JWT, AWS keys, PEM blocks. Default `redact: true`; pass `redact: false` only with intent.

## Layer 3 (v0.2.2 S2) — H4 amend nonce

**Code**: [`packages/dsh-hermes-link/services/continuations.mjs`](../packages/dsh-hermes-link/services/continuations.mjs) (nonce generation + validation); [`packages/dsh-hermes-link/services/amend-watcher.mjs`](../packages/dsh-hermes-link/services/amend-watcher.mjs) (filename parser).

**What it does**: `dispatch_task mode=continuable` returns `amend_nonce` (32 hex chars) in the response metadata. Amend files written by Hermes must be named `<ts>-<task_id>-<nonce>.json`; the watcher parses the filename, validates the nonce against the SQLite continuations registry, and **only delivers** if it matches.

**Threat it defends**: An adversary who can write to `Hermes Home/inbox/dsh/amend/*` could otherwise impersonate Hermes and steer a running sub-agent. The nonce is only learnable by the original `dispatch_task` response consumer (Hermes gateway).

**Legacy mode**: Two-segment filenames (`<ts>-<task_id>.json`) auto-archive to `done/legacy-*` and are counted as `rejected_legacy` — they are never delivered.

## Layer 4 (v0.2.2 S3) — Consult reply_secret

**Code**: [`packages/dsh-hermes-link/services/consult-hermes.mjs`](../packages/dsh-hermes-link/services/consult-hermes.mjs).

**What it does**: `consult(prompt, ctx, timeoutMs)` generates a 16-hex `reply_secret`, writes it into the consult inbox payload, and matches `consult-reply/<ticket>-<secret>.json` (the secret is encoded by the gateway from the outbox payload before writing the reply).

**Threat it defends**: Same as Layer 3 — write-access to Hermes Home should not let an adversary impersonate Hermes.

**Legacy escape hatch**: `HERMES_LINK_TRUST_LEGACY=1` re-accepts the two-segment `<ticket>.json` filename. **Migration windows only.** The intent is to give operators a short bridge to upgrade Hermes-side poller code without downtime; the flag is off-by-default and never appropriate for production.

## Layer 5 (v0.2.2 S4) — Foundation slice is SOUL-only

**Code**: [`packages/dsh-hermes-link/index.mjs`](../packages/dsh-hermes-link/index.mjs), `buildFoundationSlice(hermesHome)`.

**What it does**: The persona envelope sent to every dispatched sub-agent contains **only `Hermes Home/SOUL.md`** — capped at 4096 chars. `MEMORY.md` is **never** broadcast.

**Threat it defends**: `MEMORY.md` aggregates notes across all Hermes sessions — typically one project's notes would steer an unrelated project's sub-agent. This was the worst pre-v0.2.2 cross-project pollution vector.

**Opt-in**: A dispatch can set `include_project_memory: true` to additionally inject the **cwd-matched** slice of `MEMORY.md` (Layer 6). Otherwise it's plain SOUL.

## Layer 6 (v0.2.2 S4) — Cwd-scoped project-memory

**Code**: [`packages/dsh-hermes-link/services/hermes-project-memory.mjs`](../packages/dsh-hermes-link/services/hermes-project-memory.mjs); [`packages/dsh-hermes-link/tools/load-hermes-project-memory.mjs`](../packages/dsh-hermes-link/tools/load-hermes-project-memory.mjs).

**What it does**: Read `MEMORY.md`, match its embedded cwd tags against `agent.session.header.cwd`. **Only the contiguous block tagged with that cwd is returned.** No match → empty result.

**Threat it defends**: Hermes's `MEMORY.md` is a single file holding multiple projects' notes. Even with explicit opt-in (Layer 5), the wrong MEMORY block would pollute the sub-agent.

**Complement**: `load_hermes_project_memory` exposes the same loader to the **DSH-side** session (no dispatch involved).

## Layer 7 (v0.2.3 K.2) — Cwd safety on import

**Code**: [`packages/dsh-hermes-link/import/import-hermes-session.mjs`](../packages/dsh-hermes-link/import/import-hermes-session.mjs), `isSafeCwd(p)`.

**What it does**: When importing a Hermes session, the session's `cwd` (read from Hermes `state.db`) is validated against:

- non-absolute path → reject
- contains `\u0000` → reject
- `> 1024` chars → reject
- Windows: `C:\Windows`, `C:\Windows\System32`, `C:\Windows\SysWOW64`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`
- POSIX: `/etc`, `/bin`, `/sbin`, `/usr`, `/var`, `/proc`, `/sys`, `/boot`, `/root`, `/lib`, `/lib64`, `/opt`, `/dev`

If unsafe, `resolveCwd()` substitutes the hermes-workspace fallback (`~/.dsh/hermes-workspace`).

**Threat it defends**: A poisoned Hermes `state.db` (bug or compromise) hands `C:\Windows\System32` as a session cwd. The DSH session header would then anchor there — sub-agent file operations relative to `process.cwd()` would hit system directories.

**What it allows**: A caller-supplied `workspace` parameter (explicit opt-in) is **not** restricted — that's the user's responsibility.

## Layer 8 (v0.2.3 K.3) — Mirror filename truncation

**Code**: [`packages/dsh-hermes-link/services/outbox.mjs`](../packages/dsh-hermes-link/services/outbox.mjs), `appendSessionEvent`.

**What it does**: Session IDs are unvalidated branded strings. When sanitized to a path-safe segment, the resulting filename is capped at 200 chars. Beyond that: head 184 chars + sha1(12 hex) tail.

**Threat it defends**: A long session ID would produce a Windows-260-char filename → `ENAMETOOLONG` → previously swallowed by a try/catch → `mirror_session_to_hermes` *appeared* to succeed but wrote nothing.

## Layer 9 (v0.2.3 K.5) — Redact cookie / set-cookie / session_id

**Code**: [`packages/dsh-hermes-link/tools/mirror-session-to-hermes.mjs`](../packages/dsh-hermes-link/tools/mirror-session-to-hermes.mjs), `redactEvent`.

**What it does**: Extends the redact keyword list to 10+ secret shapes. Adds a Set-Cookie-specific regex (`(?:^|[\s;,])(?:cookie|set-cookie)\s*[:=]\s*([^\s"',;]+)`).

**Threat it defends**: Pre-v0.2.3 mirror leaked `Cookie: session=abc123` and `Set-Cookie: sid=xyz` headers verbatim — session tokens handed to Hermes.

## Layer 10 (v0.2.4) — Turn envelope = 1 (not 0)

**Code**: [`packages/dsh-hermes-link/import/request-dump-to-events.mjs`](../packages/dsh-hermes-link/import/request-dump-to-events.mjs).

**What it does**: The converter emits `turn/start {turn: 1}`, `step/start {turn: 1, step: 0}`, every assistant/tool message envelope with `turn: 1`, `step/end {turn: 1, step: 0}`, and `turn/end {turn: 1, reason: …}`.

**Threat it defends**: DSH persistence validator (`@deepseek-ai/dsh-session-persistence`) rejects `turn/end` with `data.turn < 1` as `malformed pre-react-loop turn/end`. Pre-v0.2.4 imports wrote `turn: 0` everywhere → **every imported session was visible in the sidebar but unresumable** (open-to-resume failed with `SessionPersistenceCorruptionError: contains malformed pre-react-loop turn/end`).

**Companion (also v0.2.4)** — auto-rebuild for already-corrupt artifacts:

**Code**: [`packages/dsh-hermes-link/import/import-hermes-session.mjs`](../packages/dsh-hermes-link/import/import-hermes-session.mjs), `importSession()`.

**What it does**: When `ctx.sessionPersistence.inspect(id)` throws a non-`not-found` error mentioning `failed validation` / `malformed`, remove the on-disk `session.jsonl.zstd` via `listArtifacts()` + `rmSync`, then fall through to `create + append` with the (now-correct) converter. Repairs the previous `already_imported + "persisted but inspect failed"` stuck state.

## Layer 11 (v0.2.4) — Tool output schema normalization

**Code**: [`packages/dsh-hermes-link/tools/import-hermes-session.mjs`](../packages/dsh-hermes-link/tools/import-hermes-session.mjs).

**What it does**: Declares `firstUserSnippet`, `model`, `attach` in the output schema (previously undeclared → `additionalProperties: false` rejection). Execute normalizes nullable fields — drops undefined, keeps only well-typed values.

**Threat it defends**: Pre-v0.2.4 every `import_hermes_session` invocation returned `tool returned invalid output` because the importer's raw response shape didn't match the schema. The session was actually imported on disk — the error was purely on the tool-result validation path.

## Cumulative properties

After all 11 layers, the bridge satisfies:

- **All cross-project channels are explicit opt-in.** No automatic injection, no automatic MEMORY broadcast, no automatic session-mirror.
- **All cross-process channels are authenticated.** Amend = nonce, consult reply = secret, HTTP = optional bearer.
- **No silent failures on filesystem boundaries.** Filename truncation, listArtifacts-based artifact removal, validation-failed artifact rebuild.
- **Token measurements are real, not `null`.** Dispatched sub-agent's `ctx.tokenMeter.measure(run.localAgent)` populates `tokens_used`.

## What we do NOT defend against (out of scope)

- Hermes running as root / Administrator (trust the orchestrator).
- DSH webserver exposed to the public internet without TLS + bearer.
- DSH's `danger-full-access` sandbox (deployment choice).
- Compromise of npm or GitHub Releases distribution channels (pin versions, verify hashes).
- File-protocol race conditions: if two writers race to amend a sub-agent, nonce-matching still validates only one — the loser's write is silently dropped.

## Reporting

See [SECURITY.md](../SECURITY.md) for disclosure channels.