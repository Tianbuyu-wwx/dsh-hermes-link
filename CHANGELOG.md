# Changelog

All notable changes to **hermes-link** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: Pre-v0.2 versions lived in the `dsh-hermes` monorepo (`packages/hermes-link/`) alongside the deprecated `hermes-foundation / -oneshot-arbitrate / -dispatch-bridge` triad. The history below is mirrored from that repository's `docs/delivery-v0.6.0-20260821.md`.

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
- Public release: split from `dsh-hermes` monorepo to `github.com/Tianbuyu-wwx/hermes-link`, MIT-licensed, npm-scoped `@Tianbuyu-wwx/hermes-link`, dshmarket-ready.

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
- `hermes_clear_injected` audit tool — counts how many turns were auto-injected by an older hermes-foundation/hermes-link version; points at "open a new session" (DSH `Session.events` is append-only / deep-frozen).

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