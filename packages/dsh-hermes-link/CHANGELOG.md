# @tianbuyu-wwx/dsh-hermes-link

> **Versions 0.3.1, 0.3.2, 0.3.3, and 0.3.4 were documented in the monorepo CHANGELOG (`../../CHANGELOG.md`) but never published to npm. See the "Published-vs-documented version map (2026-08-26)" section there. Use `0.3.5` (or later) for the consolidating release.**

## 0.4.0

### Minor Changes

- - Add opt-in automatic DSH session mirror (V4 opt-in): new `session_mirror` tool with `enable` / `disable` / `status`, default OFF, per-session persistence, and shared secret redaction.
  - Add Hermes real-time session sync / session-projection: `GET /mcp/collab/session-stream` SSE feed, `GET /mcp/collab/session-mirror/status`, and `mirror_status` in `list_hermes_sessions` / `GET /mcp/collab/sessions`.
  - Add `scripts/test-session-mirror.mjs`, extend smoke/import/e2e coverage, and add `session_mirror` to docs/skill/readme.

## 0.2.6

### Patch Changes

- fe4d389: fix(import): preserve Hermes AI replies and tool calls in OpenAI-style dumps
