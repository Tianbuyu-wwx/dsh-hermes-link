# dsh-hermes-link Documentation Index

This index points at every document in this repository. If you're new here, read [README.md](../README.md) first, then come back here for depth.

## Public-facing

| Doc | Audience |
|---|---|
| [README.md](../README.md) | Everyone — features, quickstart, architecture, FAQ |
| [README.zh.md](../README.zh.md) | Chinese mirror of README |
| [CHANGELOG.md](../CHANGELOG.md) | Everyone — what changed in each release |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contributors — dev setup, commit conventions, PR workflow |
| [SECURITY.md](../SECURITY.md) | Reporters + maintainers — disclosure policy, threat model |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community — behavior standards |

## Technical depth

| Doc | Audience |
|---|---|
| [security-model.md](security-model.md) | Maintainers + security reviewers — every layer of the trust boundary, with code refs |
| [plugin-developer-guide.md](plugin-developer-guide.md) | **Hermes-side gateway developers** — JSON-RPC wire protocol, file protocol, persona envelope, foundation slice limits |
| [plugin-install-guide.md](plugin-install-guide.md) | DSH users — three install paths (dsh-market / npm / git), configuration, troubleshooting |
| [dispatch-spec.md](dispatch-spec.md) | Wire-level reference for `POST /mcp/collab` JSON-RPC methods + schema |

## Historical

| Doc | Notes |
|---|---|
| [delivery-v0.6.0-20260821.md](delivery-v0.6.0-20260821.md) | v0.6.0 release notes (v0.1 → v0.2.3 detailed delivery; v0.2.4 hotfix section appended) |
| [hermes-upgrade-v0.2.2.md](hermes-upgrade-v0.2.2.md) | Breaking-change upgrade guide for Hermes-side gateways |
| [hotfix-20260820.md](hotfix-20260820.md) | Original "can sync but cannot continue" bug report & resolution log |
| [sharing-conventions.md](sharing-conventions.md) | Internal — `~/.dsh/hermes-inbox/session.jsonl` format spec |
| `delivery-v0.2.0..v0.5.0-20260820.md` | Pre-v0.2 three-pack history (hermes-foundation / hermes-oneshot-arbitrate / hermes-dispatch-bridge). Archived — these packages are deprecated; `dsh-hermes` holds the legacy code with tag `archive/hermes-legacy-2026-08-22` |

## Design specs

| Doc | Audience |
|---|---|
| [superpowers/specs/2026-08-22-dsh-hermes-link-open-source-design.md](superpowers/specs/2026-08-22-dsh-hermes-link-open-source-design.md) | Maintainers — the open-source + dshmarket release design spec |

## Quick links

- **Hermes-side gateway reference implementation**: [`scripts/hermes-gateway-demo.py`](../scripts/hermes-gateway-demo.py) — standalone Python poller that implements the consult reply + amend writer.
- **Hermes ↔ DSH file protocol**: see [SECURITY.md § "File protocol trust boundaries"](../SECURITY.md) for the security model; see [plugin-developer-guide.md](plugin-developer-guide.md) for the wire-level details.
- **Audit log location**: `~/.dsh/dsh-hermes-link/audit.jsonl` (host process).