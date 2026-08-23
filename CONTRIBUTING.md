# Contributing to dsh-hermes-link

Thanks for your interest in `dsh-hermes-link`. This document covers the day-to-day development workflow. The **public API** (Hermes-side JSON-RPC + DSH-side Cordis tool surface) is treated as a hard contract — every change is gated by the test suites under `scripts/`.

## Code of Conduct

By participating, you agree to abide by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Reporting bugs / requesting features

Use GitHub Issues with the templates under `.github/ISSUE_TEMPLATE/`. **Security** issues go through GitHub Security Advisories — see [SECURITY.md](SECURITY.md).

## Development setup

### Requirements

- **Node ≥ 20** (matches `.nvmrc`)
- **pnpm** recommended (project uses `pnpm-lock.yaml` conventions; `npm` works for ad-hoc testing)
- **DeepSeek Harness** (DSH) installed locally — the `scripts/import-check.mjs` smoke test asserts the host packages `@deepseek-ai/dsh-*` are resolvable.
- Optional: **Hermes Agent** installed locally (under `%LOCALAPPDATA%\hermes` on Windows or `~/.local/share/hermes` on POSIX) for end-to-end testing against `POST /mcp/collab`.

### Clone & link

```sh
git clone https://github.com/Tianbuyu-wwx/dsh-hermes-link.git
cd dsh-hermes-link
npm install          # or pnpm install
```

### Link into your DSH profile

```sh
dsh plugin --profile web add ./packages/dsh-hermes-link
# restart dsh web
```

Or — for fast iteration without restarting DSH — inject via `dsh-super-injector`:

```sh
dev_inject_plugin ./packages/dsh-hermes-link
dev_reload_package dsh-hermes-link  # if available; otherwise restart
```

> The converter at `packages/dsh-hermes-link/import/request-dump-to-events.mjs` is **cache-busted** via `?v=${Date.now()}` on every load, so it picks up edits without reloading. Static-imported modules (`index.mjs`, `tools/*.mjs`, `import/import-hermes-session.mjs`) require either a DSH restart or an injector reload.

## Running the test suite

```sh
npm test
```

This runs the 12-case suite end-to-end (≈200 assertions, takes a few seconds). Individual targets:

```sh
npm run test:converter   # request-dump-to-events: turn envelope + round-trip
npm run test:dispatch    # dispatch spec validator
npm run test:services    # outbox / continuations / audit / project-memory
npm run test:security    # amend nonce + consult secret + foundation policy + mirror opt-in
npm run test:hardening   # K.1–K.5 + v0.2.3 hardening
npm run test:consult     # consult client protocol + timeout
npm run test:imports     # 19-module full-load smoke test (requires DSH on disk)
npm run test:install     # verify-install.mjs (29 install-state checks)
npm run test:smoke       # smoke-test.mjs (77 static + syntax assertions)
```

All scripts must pass before opening a PR.

### E2E against a live DSH

```sh
node scripts/smoke-e2e.mjs   # full dispatch/followup/amend/audit round-trip
```

This requires a running `dsh web` on `127.0.0.1:3080` and writes audit/usage/heartbeat to `Hermes Home/inbox/dsh/`.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

- Types: `feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `perf` / `security`
- Scopes (examples): `converter` / `import` / `dispatch` / `tools` / `audit` / `security` / `docs` / `ci`
- Breaking changes: append `!` after the type/scope and add a `BREAKING CHANGE:` footer.

Examples:

```
fix(converter): emit turn envelope with turn=1 so DSH persistence validator accepts imported sessions
feat(dispatch): add dispatch_probe zero-cost tool-name probe
security(import): reject cwd pointing at Windows/POSIX system roots
```

## Versioning & releases

We use [changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset        # add a .changeset/*.md describing your change
pnpm changeset version # bump version + update CHANGELOG.md
git add -A && git commit -m "v0.2.5 release prep"
git push
# release.yml picks up on main-merge → npm publish + GitHub Release
```

Emergency bypass (don't use unless you know what you're doing):

```sh
node scripts/version-bump.mjs 0.2.5   # bumps VERSION constants + package.json
git add -A && git commit -m "v0.2.5 emergency bump"
git tag v0.2.5 && git push --tags
npm publish --workspace=packages/dsh-hermes-link --access public
```

## Branching & review

- `main` is the only long-lived branch. Trunk-based development.
- Feature branches: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Squash-merge feature branches into `main` with the Conventional Commit subject as the merge title.
- All PRs need **1 reviewer**. Security-sensitive changes (anything in `services/audit`, `services/hermes-inbox`, `tools/import-hermes-session`, security-model changes) need a **second** reviewer.
- CI must be green: 12-case suite + the GitHub Actions matrix (windows / ubuntu / macos × Node 20 / 22).

## Pull request template

See `.github/PULL_REQUEST_TEMPLATE.md`. The template asks for:

- What changed and why
- Linked issue (or "none")
- Test plan (which `npm run test:*` you ran)
- Security considerations (if touching a security boundary)
- Documentation impact (which docs/*.md need updates)

## Coding style

- `.editorconfig` defines the basics: LF line endings, 2-space indent, UTF-8.
- ESM-only (`"type": "module"` in every `package.json`). No CommonJS.
- `import { x } from 'y'` style; no default exports of functions across module boundaries (named exports only).
- Prefer `node:fs` / `node:path` / `node:url` over the legacy variants.
- Doc-comment every public surface (function, class, Cordis tool definition, schema).
- No commented-out code in committed files — use `git rm` for retired code instead.

## Documentation style

- `README.md` is canonical English. `README.zh.md` is a faithful mirror — keep them in lockstep when either changes.
- `docs/*.md` is technical detail. Use Markdown headings, fenced code blocks (with language hints), and tables for structured comparisons.
- Avoid future tense; write as if the feature is already shipping.
- Reference source paths as `packages/dsh-hermes-link/services/foo.mjs` (clickable in Web-rendered READMEs).

## Testing philosophy

- **Unit tests are non-negotiable.** Every public function or Cordis handler must have at least one direct test.
- **Integration tests exercise the file protocol end-to-end.** Don't mock the file system unless necessary.
- **Smoke tests catch obvious regressions.** `scripts/smoke-test.mjs` is a belt-and-suspenders safety net.
- **The 19-module import-check guards against accidental dependency drift** — if a contributor removes an `import` from `index.mjs` without updating the smoke list, this test catches it.

## Getting help

- Open a GitHub Discussion for design questions.
- Tag `@Tianbuyu-wwx` on a PR for review or to bump priority.
- For security-sensitive questions, route through GitHub Security Advisories, not public issues.