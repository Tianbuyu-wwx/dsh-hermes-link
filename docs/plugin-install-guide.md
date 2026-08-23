# Plugin Install Guide — three ways to install hermes-link

Pick the path that matches your workflow. All three end up with `hermes-link` running inside your DSH web profile.

---

## Path 1 — From dsh-market (recommended for most users)

`dsh-market` is a community-curated registry hosted at `awesome-dsh-plugin.com`. Once `hermes-link` is listed there, users install it with a few clicks.

### Prerequisites

- DSH installed (`dsh --version` ≥ 0.1.0-rc.6)
- dsh-market plugin installed in your profile: `dsh plugin --profile web add dshmarket`

### Install

1. Open DSH web (e.g. `dsh --profile web`, defaults to `127.0.0.1:3080`).
2. Settings → **Plugin Market**.
3. Search `hermes-link`.
4. Click the card → confirm install source (npm: `@Tianbuyu-wwx/hermes-link`).
5. Watch live progress; the plugin goes live after a page refresh.

### Verify

```sh
curl -s http://127.0.0.1:3080/mcp/collab/health | jq
```

Expected:

```json
{
  "ok": true,
  "version": "0.2.4",
  "hermes_home": "...",
  "importer_ready": true,
  "persona_ready": true,
  "consult_ready": true,
  "continuable_registry": "on",
  "auth": "open",
  "foundation_slice_chars": 1234,
  "active_dispatchers": 0
}
```

### Update / disable / uninstall

All three are handled by `dsh-market`'s Plugin tab:
- **Update**: per-plugin check (npm version vs installed).
- **Hot disable**: writes `disabled: true` to the profile's `cordis.patch.yml`; HMR re-composes within ~1s.
- **Uninstall**: two-step confirm.

---

## Path 2 — From npm directly

If you don't use `dsh-market`, install via the official `dsh plugin` command, which delegates to pnpm:

```sh
dsh plugin --profile web add @Tianbuyu-wwx/hermes-link
```

Then restart `dsh web`. Verify as in Path 1.

### Update / uninstall

```sh
dsh plugin --profile web update hermes-link    # or: update @Tianbuyu-wwx/hermes-link
dsh plugin --profile web remove @Tianbuyu-wwx/hermes-link
```

### Disable (without uninstalling)

Edit `~/.dsh/profiles/web/cordis.patch.yml` and set:

```yaml
- id: hermes-link
  disabled: true
```

Or via `dsh-market`'s hot-disable button.

---

## Path 3 — From a local checkout (developer loop)

If you're hacking on `hermes-link` itself (or want to pin to a specific commit):

```sh
git clone https://github.com/Tianbuyu-wwx/hermes-link.git
cd hermes-link
dsh plugin --profile web add ./packages/hermes-link
```

DSH creates a `node_modules/hermes-link` junction pointing at `packages/hermes-link` in your checkout. Edits to the checkout take effect depending on how hermes-link loads each module:

- **`packages/hermes-link/import/request-dump-to-events.mjs`** is loaded via cache-busting (`?v=${Date.now()}`) on every `importer.importSession()` call — edits are picked up immediately.
- **Other modules** (`index.mjs`, `tools/*.mjs`, `import/import-hermes-session.mjs`) are statically imported by `index.mjs`. Changes take effect on the **next DSH restart**, or after a hot reload via `dsh-super-injector`:

  ```sh
  dev_reload_package hermes-link  # if dsh-super-injector is mounted
  ```

### Iterate

```sh
npm test              # 12-case suite, ~200 assertions
npm run test:e2e      # node scripts/smoke-e2e.mjs — needs a running dsh web
```

---

## Configuration

### `~/.dsh/hermes-inbox/session.jsonl`

This is the shared Hermes/DSH conversation record. Hermes writes turns via `hermes-push.mjs`; DSH reads via the `hermes_inbox` tool. The format spec is in [`sharing-conventions.md`](sharing-conventions.md).

### `~/.dsh/hermes-link/audit.jsonl`

Hermes-side ops may want to tail this for visibility. See [plugin-developer-guide.md § 10](plugin-developer-guide.md).

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HERMES_HOME` | auto-detect | Hermes data root (see below) |
| `HERMES_LINK_TOKEN` | unset | When set, requires `Authorization: Bearer <token>` for all `/mcp/collab*` (except `/health`) |
| `HERMES_LINK_TRUST_LEGACY` | unset | When set (`1`), accepts legacy two-segment consult reply filenames. **Migration windows only.** |

### Hermes Home auto-detect

DSH-side `hermes-link` auto-detects Hermes Home in this order:

1. `$HERMES_HOME` env var (if it exists on disk)
2. Windows: `%LOCALAPPDATA%\hermes\`
3. POSIX: `~/.local/share/hermes/`

> **Note**: `~/.hermes/` is the Edge browser profile — **not** Hermes data. Don't confuse them.

---

## Troubleshooting

### `import_hermes_session` returns "invalid output"

Pre-v0.2.4 only. Fixed by updating to v0.2.4 (the tool output schema normalizes nullable fields).

### Imported sessions appear in the sidebar but open-to-resume fails

Pre-v0.2.4 the converter emitted `turn: 0` events that DSH persistence validator rejects as `malformed pre-react-loop turn/end`. Fixed in v0.2.4 (turn: 1 + auto-rebuild for corrupt artifacts). Update to v0.2.4 and the next auto-sync rebuilds them.

To force-rebuild right now:

```sh
node scripts/verify-install.mjs  # confirms install state
```

### Hermes-side gateway sees `unknown tool` on `dispatch_probe`

`dispatch_probe` reads `ctx.tools.view().restrictableNames`. The list depends on which DSH preset your sub-agent mounts. Confirm the `skill` name matches what `tools/list` returns.

### `amend` files silently ignored

Filename must be exactly three segments: `<ts>-<task_id>-<nonce>.json`. Mismatched or two-segment filenames archive to `done/legacy-*` and never deliver.

Confirm you wrote the nonce from the **original** `dispatch_task mode=continuable` response into your gateway's amend path table, and use that exact nonce in the filename.

### `consult-reply/*` ignored

Filename must be `<ticket>-<secret>.json`. The `secret` must match the `reply_secret` returned in the outbox payload. Without the secret suffix, the reply is ignored even if `ticket` matches.

If your gateway is on pre-v0.2.2 protocol, set `HERMES_LINK_TRUST_LEGACY=1` on the DSH side. **Migration only.**

### Bearer token rejected despite correct token

Make sure the `Authorization` header value is exactly `Bearer <token>` — case-sensitive, single space, no extra whitespace. Set on the Hermes-side gateway's MCP server config:

```yaml
mcp_servers:
  dsh-bridge:
    url: http://127.0.0.1:3080/mcp/collab
    headers:
      Authorization: "Bearer ${HERMES_LINK_TOKEN}"
```

If `HERMES_LINK_TOKEN` on the DSH side is unset, no token is required — the bridge is open. Production should set the token; LAN-only can opt out.

### Auto-sync / watcher not picking up new Hermes sessions

`hermes-link` watches `<Hermes Home>/sessions/request_dump_*.json` with a 60s poll. The watcher triggers an importer sync on any new file. Confirm `<Hermes Home>` is correctly detected (see Hermes Home auto-detect above) and that the user running DSH has read permission.

To trigger an immediate sync:

```sh
node scripts/import-check.mjs   # 19-module full-load smoke
```

Or manually invoke the importer (DSH session):

```
list_hermes_sessions  # confirm Hermes sees them
import_hermes_session { hermesSessionId: "..." }
```

### "Why is my install pointing at the wrong path?"

`packages/hermes-link/cordis.patch.yml` is the dshmarket-loadable patch file. If your local checkout has a stale one, re-copy from the source:

```sh
git checkout -- packages/hermes-link/cordis.patch.yml
```

---

## Uninstall

```sh
dsh plugin --profile web remove @Tianbuyu-wwx/hermes-link
```

Or via `dsh-market`. Both clean up:

- `~/.dsh/profiles/web/node_modules/@Tianbuyu-wwx/hermes-link` (junction)
- `cordis.patch.yml` row
- `audit.jsonl` / `continuables.sqlite` left in place (operator archives separately)

Imported Hermes sessions remain in `~/.dsh/sessions/` — deleting them is operator's choice.