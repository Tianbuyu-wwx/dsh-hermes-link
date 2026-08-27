# @tianbuyu-wwx/dsh-hermes-link

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
