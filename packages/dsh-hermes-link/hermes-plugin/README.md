# hermes-plugin/dsh-bridge — the Hermes half of the reverse channel

`Hermes Home/outbox/hermes/` was promised by `docs/DSH-HERMES-LINK-PLAN.md` ("Hermes 给 DSH 的主动通知")
and the DSH-side consumer shipped in v0.6.0 (`services/hermes-outbox-consumer.mjs`, verified live).
Nothing on the Hermes side ever wrote a file, so the channel was a consumer with no producer.
This plugin is that producer.

## Install

```bash
npx hermes-link-install-hermes-plugin            # copies this directory into <Hermes Home>/plugins/dsh-bridge
npx hermes-link-install-hermes-plugin --dry-run  # show the target without writing
```

Then **restart Hermes** (plugins are discovered at start-up). Confirm with:

```bash
curl http://127.0.0.1:3080/mcp/collab/hermes-outbox/status   # DSH side: consumed/archived counters
ls "%LOCALAPPDATA%\hermes\outbox\hermes"                  # produced notifications
```

## What it emits

| Trigger | Kind | Effect on the DSH side |
|---|---|---|
| every Hermes turn end (`on_session_end`) | `import` | the session is imported/refreshed immediately instead of waiting for DSH's own dump watcher |
| a failed or interrupted turn | `notify` | also published on DSH's `hermes-outbox` SSE channel |
| `/dsh-notify <message>` | `notify` | a human-driven message into the same channel |
| plugin load | `notify` | `producer_ready` ping, so "no notifications" can be told apart from "no producer" |

Every file is archived by DSH into `outbox/hermes/done/` with an outcome prefix
(`duplicate-`, `malformed-`, `unsupported-`, `failed-`), so a bad file is never rescanned forever.

## Contract, in one place

```json
{
  "id": "<unique>",                 // idempotency key: a redelivery is archived, never re-executed
  "source": "hermes",               // "dsh" would be treated as this side's own echo and skipped
  "kind": "import" | "notify" | "ping",
  "session_id": "<hermes session>", // required for kind=import
  "created_at": 1789650000000,
  "payload": { "event": "turn_end", "turn_id": 7, "failed": false, "...": "..." }
}
```

Written atomically (`tmp` + `os.replace`) as **bare UTF-8**: a BOM makes `JSON.parse` refuse the file,
and that exact trap already cost this project a debugging round on the DSH side.
