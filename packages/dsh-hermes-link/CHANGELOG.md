# @tianbuyu-wwx/dsh-hermes-link

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
