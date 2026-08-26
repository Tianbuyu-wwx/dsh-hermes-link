---
'@tianbuyu-wwx/dsh-hermes-link': patch
---

v0.3.5: SSE first-event replay fix + workspace-aware Hermes imports + e2e integration

### Added
- Imported Hermes sessions now land in the original workspace: when state.db has no usable cwd/git_repo_root, the importer infers the original working directory from cd tool calls in the request dump (most frequent existing safe directory).
- Existing hermes-workspace sessions with no DSH-side post-import activity are automatically rebuilt under the inferred/known workspace on the next import/sync.

### Fixed
- SSE stream missed the first buffered event (seq 0): sse-broker.subscribe() now defaults sinceSeq to -1 for fresh subscribers, and /mcp/collab/stream omitting since_seq starts from the beginning.

### Tests
- scripts/test-sse-broker.mjs: added case 3b. Total 17 passing.
- scripts/test-e2e-integration.mjs: 22 end-to-end cases, wired into root and package npm test.
- scripts/test-workspace-infer.mjs: 2 cases (dump inference + safe workspace migration), wired into npm test.
