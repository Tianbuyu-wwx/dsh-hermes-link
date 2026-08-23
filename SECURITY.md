# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x (latest 0.2.4) | ✅ active |
| 0.1.x | ❌ end-of-life — upgrade to 0.2.x |

## Reporting a vulnerability

**Please do not file public GitHub Issues for security problems.**

Use **GitHub Security Advisories** on this repository (Security tab → "Report a vulnerability"). This routes the report privately to the maintainers.

If GitHub Advisories is unavailable or you require a non-GitHub channel, email **security@<your-domain>** (replace with the maintainer's contact — see `package.json` author URL).

A maintainer will acknowledge within **72 hours** and aim for a fix-or-mitigation plan within **14 days** for high-severity issues.

## Threat model

`hermes-link` mediates between two trust boundaries: a **Hermes Agent** process running as the orchestrator and a **DeepSeek Harness** process running as the runtime. The bridge is exposed on `127.0.0.1:3080/mcp/collab*` by default and runs at the same privilege level as the host DSH.

### What we defend against

- **Cross-project context pollution** — Hermes' global MEMORY or session.jsonl injecting unrelated projects into DSH sessions.
- **Adversary writes to Hermes Home filesystems** — `amend/*`, `consult-reply/*`, `consult/*`, `dispatch-result/*`, `session-mirror/*`.
- **Compromised Hermes state.db** — poisoned `cwd` pointing at a system directory.
- **Side-channel secret leakage** in the V4 session mirror (cookies, API keys, JWTs, PEM, session ids).
- **Cross-process impersonation** — anyone who can write to Hermes' filesystem pretending to be Hermes.

### What we do NOT defend against

- **Hermes running as root / Administrator.** The bridge runs at the host privilege level; trust Hermes first.
- **DSH running with `danger-full-access` sandbox.** That's a deployment choice outside the bridge.
- **DSH's webserver exposed to the public internet.** Bind to loopback; use `dsh web --trusted-host` for LAN.
- **Compromise of npm or GitHub Releases distribution channels.** Pin versions and verify hashes.

## Security boundaries (cumulative)

| Layer | Boundary | Since |
|---|---|---|
| 1 | Main-session auto-injection of Hermes turns into DSH **disabled** | v0.2.1 |
| 2 | `consult-reply` filenames require `<ticket>-<secret>.json` secret suffix | v0.2.2 |
| 3 | `amend` filenames require `<ts>-<task_id>-<nonce>.json` nonce suffix | v0.2.2 |
| 4 | Dispatched sub-agent foundation is **SOUL-only**; MEMORY is explicit opt-in per dispatch or per current session | v0.2.2 |
| 5 | V4 session-mirror is **opt-in** (no longer auto-mirrors every event); default `redact: true` strips cookies / API keys / JWTs / PEM / session_ids | v0.2.2 + v0.2.3 |
| 6 | `import_hermes_session` cwd safety: rejects 17 Windows/POSIX system roots + null byte + >1024 chars + non-absolute paths | v0.2.3 |
| 7 | Mirror filename >200 chars → sha1(12 hex) tail truncation | v0.2.3 |
| 8 | Redact regex extended with cookie / set-cookie / session_id | v0.2.3 |
| 9 | Imported session turn envelope starts at 1 (not 0); `turn:0` would fail DSH persistence validation | v0.2.4 |
| 10 | Corrupt-imported sessions auto-detect + auto-remove + auto-rebuild (no more `already_imported` stuck state on bad data) | v0.2.4 |

Full walk-through with code references: [docs/security-model.md](docs/security-model.md).

## Bearer authentication

When `HERMES_LINK_TOKEN` is set, every `/mcp/collab*` route except `GET /mcp/collab/health` requires `Authorization: Bearer <token>`. **Default is open.** Setting the token is strongly recommended for any deployment that runs on a multi-user host or exposes DSH to a LAN.

## File protocol trust boundaries

`Hermes Home/inbox/dsh/` contains files written by DSH (consumed by Hermes) and files written by Hermes (consumed by DSH). The two write-channels are protected by **different** mechanisms:

- **DSH → Hermes**: `dispatch-result/<task_id>.json`, `consult/<ts>-<uuid>.json`, `heartbeat/*`, `usage.jsonl`, `memory-suggest/*`, `session-mirror/<sid>.jsonl` (opt-in). These are NOT authenticated — anyone with write access to `Hermes Home` can impersonate DSH.
- **Hermes → DSH**: `consult-reply/<ticket>-<secret>.json` (secret bound), `amend/<ts>-<task_id>-<nonce>.json` (nonce bound). These ARE authenticated by the secret/nonce returned in the matching outbox payload.

`HERMES_LINK_TRUST_LEGACY=1` weakens the consult-reply authentication by accepting the legacy two-segment name. **Do not enable in production.** It's intended for migration windows only.

## Sandbox integration

`hermes-link` itself does not enforce sandbox policies — it relies on DSH's sandbox services. The dispatched sub-agent inherits the parent agent's sandbox profile (default `workspace-write + ask`). A deployment that grants Hermes a `danger-full-access` sub-agent should treat that as an explicit, audited decision.

## What to include in a vulnerability report

- Title and short description
- Reproduction steps (minimal)
- Affected versions (which `0.2.x` releases?)
- Impact assessment (what can an attacker do?)
- Any known mitigations or workarounds you've discovered

The maintainer will coordinate CVE assignment and disclosure timing.