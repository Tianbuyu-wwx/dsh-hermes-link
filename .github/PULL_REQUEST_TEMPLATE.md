<!--
Thanks for opening a PR. The intent of this template is to set reviewers up
with enough context to make a quick, informed decision. Fill in what
applies and remove what doesn't.
-->

## What changed

<!-- One- or two-sentence summary. -->

## Why

<!-- What problem does this PR solve? Link to an issue (or "none"). -->

## Surface

<!-- Where the change lives (which files / directories). -->

## Test plan

<!-- Which `npm run test:*` targets you ran locally, and their results. -->

- [ ] `npm run test:converter`  — turn envelope + round-trip
- [ ] `npm run test:dispatch`   — dispatch spec validator
- [ ] `npm run test:services`   — outbox / continuations / audit / project-memory
- [ ] `npm run test:security`   — amend nonce / consult secret / foundation policy / mirror opt-in
- [ ] `npm run test:hardening`  — K.1–K.5
- [ ] `npm run test:consult`    — consult client protocol + timeout
- [ ] `npm run test:imports`    — 19-module full-load (requires DSH host checkout)
- [ ] `npm run test:smoke`      — 77 static + syntax assertions

## Security considerations

<!-- Required if your PR touches any of: -->
<!--  - services/audit/ -->
<!--  - services/hermes-inbox/ -->
<!--  - tools/import-hermes-session.mjs -->
<!--  - import/import-hermes-session.mjs -->
<!--  - import/request-dump-to-events.mjs -->
<!--  - services/consult-hermes.mjs -->
<!--  - SECURITY.md or docs/security-model.md -->
<!--  - /mcp/collab auth or file-protocol trust boundaries -->

If your PR changes any of the above, briefly explain the new behavior and why
it doesn't weaken the existing trust boundary. If you ARE intentionally
relaxing a security boundary (rare), call this out loudly in the PR
description **and** open a tracking issue.

## Documentation impact

<!-- Which docs/*.md, README.md, or README.zh.md sections need to update? -->
<!-- Cross-check against [docs/README.md](docs/README.md) (the doc index). -->

## Changeset

<!-- If your PR affects the published package, run `pnpm changeset` to add a -->
<!-- .changeset/<topic>.md entry. CI's release workflow will fail without one. -->

- [ ] Added `.changeset/<topic>.md` (or N/A — doc-only / no consumer-facing change)