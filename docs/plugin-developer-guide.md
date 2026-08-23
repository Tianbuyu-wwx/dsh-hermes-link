# Plugin Developer Guide — for Hermes-side gateway developers

This guide is for the developer implementing the **Hermes side** of the bridge. If you're implementing a Hermes-side gateway that calls `dsh-hermes-link` over `POST /mcp/collab`, or one that reads from / writes to `Hermes Home/inbox/dsh/`, this document tells you exactly what shape to produce.

A reference implementation lives at [`scripts/hermes-gateway-demo.py`](../scripts/hermes-gateway-demo.py) — standalone Python poller demonstrating the consult-reply reader + amend writer + legacy fallback.

---

## 1. Authentication

If `HERMES_LINK_TOKEN` is set on the DSH side, every `/mcp/collab*` route except `GET /mcp/collab/health` requires:

```
Authorization: Bearer <token>
```

Hermes-side gateway config:

```yaml
mcp_servers:
  dsh-bridge:
    url: http://127.0.0.1:3080/mcp/collab
    headers:
      Authorization: "Bearer ${HERMES_LINK_TOKEN}"
```

If the token is unset on the DSH side, the bridge is open. Production deployments should always set the token.

---

## 2. JSON-RPC 2.0 envelope

```
POST /mcp/collab
Content-Type: application/json
```

All methods use JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": "hermes-req-001",
  "method": "dispatch_task",
  "params": {
    "task_id": "...",
    "skill": "...",
    "task": "...",
    "...": "..."
  }
}
```

Use `tools/list` to discover the available RPC methods and their schemas.

---

## 3. `dispatch_task` — the primary entry point

`tools/call dispatch_task` with these fields:

| Field | Required | Type | Notes |
|---|---|---|---|
| `task_id` | yes | string | Hermes-generated; used for `dispatch-result/<task_id>.json` filename |
| `skill` | yes | string | The DSH tool name the sub-agent is allowed (see `dispatch_probe`) |
| `task` | yes | string | The natural-language task description |
| `args` | no | object | Tool-specific arguments |
| `mode` | no | `"one-shot"` \| `"continuable"` | Default `"one-shot"` |
| `model_tier` | no | `"flash"` \| `"pro"` \| `"vision"` | Default `"flash"` |
| `provider` | no | `"spawn"` \| `"fork"` | Default: `"spawn"` for one-shot, `"fork"` for continuable |
| `deadline_ms` | no | integer (1000-600000) | Default 60000 |
| `max_tokens` | no | integer | Sub-agent token cap |
| `knowledge_subset` | no | array | Inject custom knowledge slices |
| `include_project_memory` | no | boolean | Default `false`. When true, `cwd`-matched MEMORY.md block is added to persona envelope |
| `shared_history_n` | no | integer (0-50) | Number of parent agent turns to include |
| `system` | no | string | Optional system prompt override |

`mode: continuable` additionally returns `child_id` and `amend_nonce` (32 hex chars). See §5.

### Example

```json
{
  "jsonrpc": "2.0",
  "id": "hermes-req-001",
  "method": "tools/call",
  "params": {
    "name": "dispatch_task",
    "arguments": {
      "task_id": "session-20260820-abc-001",
      "skill": "browser_navigate",
      "task": "Navigate to https://example.com and capture the page title.",
      "mode": "continuable",
      "deadline_ms": 30000
    }
  }
}
```

---

## 4. `dispatch_probe` — zero-cost skill validation

`tools/call dispatch_probe { skill: "..." }` checks `ctx.tools.view().restrictableNames` without spawning a sub-agent.

Returns:
- **Hit**: `{ content: [{ type: "text", text: "ok: tool \"<name>\" is known (N global tools)" }] }`
- **Miss**: error code -32011 with the full list of known tool names in the message

Use it before `dispatch_task` to validate a Hermes-side tool name without burning an LLM turn.

---

## 5. Continuable sub-agents (`mode: continuable`)

When `dispatch_task` is called with `mode: continuable`, DSH returns:

```json
{
  "content": [{ "type": "text", "text": "[dsh-hermes-link v0.2.4] continuable child_id=<child_id> ... amend filename pattern: <ts>-<task_id>-<amend_nonce>.json ..." }],
  "metadata": {
    "v0_2_status": "continuable_started",
    "task_id": "...",
    "child_id": "...",
    "message_id": "...",
    "parent_agent_id": "...",
    "mode": "continuable",
    "amend_nonce": "32-hex-string",     // <-- STORE THIS
    "amend_filename_pattern": "<ts>-<task_id>-<amend_nonce>.json"
  }
}
```

Hermes-side **must** record `amend_nonce` per child_id (in SQLite, Redis, etc.) — the nonce is the only credential for the amend file path.

### `dispatch_followup`

```json
{
  "name": "dispatch_followup",
  "arguments": {
    "child_id": "<child_id>",
    "content": [
      { "type": "text", "text": "follow-up message" }
    ],
    "deadline_ms": 60000
  }
}
```

Returns the child's reply + `tokens_used`.

### `dispatch_interrupt`

```json
{ "name": "dispatch_interrupt", "arguments": { "child_id": "...", "reason": "user-cancelled" } }
```

Idempotent. No-op if child already ended.

### `dispatch_list` / `dispatch_get`

```json
{ "name": "dispatch_list", "arguments": { "limit": 50 } }
{ "name": "dispatch_get",  "arguments": { "child_id": "...", "since": 0, "limit": 1000 } }
```

---

## 6. Amend file protocol (Hermes → DSH)

Hermes writes mid-task amendments to:

```
Hermes Home/inbox/dsh/amend/<ts>-<task_id>-<amend_nonce>.json
```

Filename rules:
- Three segments separated by `-`
- `<ts>` is the timestamp suffix (free-form, but must be ASCII-safe)
- `<task_id>` must match the original `dispatch_task` task_id
- `<amend_nonce>` must equal the nonce from the dispatch response

File body:

```json
{
  "kind": "amend",
  "task_id": "...",
  "child_id": "...",
  "content": [
    { "type": "text", "text": "the amendment" }
  ]
}
```

`dsh-hermes-link`'s `amendWatcher` validates the nonce against the SQLite continuations registry and **only delivers** on a match. Mismatches and legacy two-segment names auto-archive to `done/`.

### Reference

```python
# scripts/hermes-gateway-demo.py (paraphrased)
def write_amend(task_id, amend_nonce, content):
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    path = AMEND_DIR / f"{ts}-{task_id}-{amend_nonce}.json"
    path.write_text(json.dumps({
        "kind": "amend", "task_id": task_id,
        "content": content,
    }))
```

---

## 7. Consult protocol (DSH → Hermes)

`tools/call consult_hermes` (or `POST /mcp/collab/consult`) writes a consult payload:

```
Hermes Home/inbox/dsh/consult/<ts>-<uuid>.json
```

```json
{
  "ticket": "<uuid>",
  "reply_secret": "16-hex-string",   // <-- STORE THIS
  "prompt": "...",
  "context": { "...": "..." },
  "ts": "<timestamp>"
}
```

Hermes-side gateway **must** encode the reply filename with the secret suffix:

```
Hermes Home/inbox/dsh/consult-reply/<ticket>-<reply_secret>.json
```

DSH polls, matches `ticket + secret`, and returns the reply. Mismatched secret or missing secret suffix → consult reply is silently ignored.

Reply body:

```json
{
  "ticket": "<uuid>",
  "status": "replied",
  "reply": "..."
}
```

### Reference

```python
def write_reply(ticket, reply_secret, reply_text):
    path = CONSULT_REPLY_DIR / f"{ticket}-{reply_secret}.json"
    path.write_text(json.dumps({
        "ticket": ticket, "status": "replied", "reply": reply_text,
    }))
```

### Legacy compatibility

If your gateway was written against pre-v0.2.2 (replies as `<ticket>.json`), set `HERMES_LINK_TRUST_LEGACY=1` on the DSH side. **Migration windows only** — do not enable in production.

---

## 8. Dispatch-result files (DSH → Hermes)

DSH writes dispatch results to:

```
Hermes Home/inbox/dsh/dispatch-result/<task_id>.json
```

```json
{
  "task_id": "...",
  "status": "completed" | "error" | "blocked" | "max-tokens" | "interrupted",
  "output": "...",
  "tokens_used": 1234,        // REAL measured, not null
  "surface_tokens": 1100,
  "elapsed_ms": 5678,
  "skill": "...",
  "model": "...",
  "error": "..."               // when status is "error"
}
```

`tokens_used` is populated from `ctx.tokenMeter.measure(run.localAgent)` — pre-v0.2 this was `null`.

---

## 9. Persona envelope (what your sub-agent sees)

Each `dispatch_task` produces a DSH sub-agent with:

```
1. Hermes SOUL (≤4096 chars)            [always]
2. Hermes project-memory (cwd-matched MEMORY.md block)  [if include_project_memory: true]
3. Task envelope:
     task_id / skill / task / args / knowledge_subset /
     model_tier / mode / provider / shared_history_n
4. Parent shared history (last N turns)  [if shared_history_n > 0]
5. Encoding rules (v0.2.3+):
     - CJK mojibake: don't guess-reconstruct; quote raw text verbatim
     - Sentinel strings / IDs: copy verbatim, never paraphrase
```

The sub-agent's tool catalog is restricted to a single tool — the one named in `args.skill`. Use `dispatch_probe` to verify the tool name before dispatching.

---

## 10. Audit log

DSH writes to `~/.dsh/dsh-hermes-link/audit.jsonl` for every dispatch / consult / import. Hermes-side may want to tail this for ops visibility:

```json
{"ts":"2026-08-22T10:00:00Z","status":"completed","task_id":"...","skill":"...","model":"...","mode":"one-shot","elapsed_ms":12345,"real_tokens":{"total_tokens":1100,"surface_tokens":1000,"projected_tokens":1100,"pressure_tokens":1100,"baseline":0}}
```

Use `tools/call get_dispatch {limit: N}` to query it from Hermes.

---

## 11. Schema discovery

`tools/list` returns the full schema (JSON-Schema draft-07 dialect). Each method's `inputSchema` describes the `arguments` shape for `tools/call`.

The HTTP variant `POST /mcp/collab` with `method: "tools/list"` returns the same catalog (raw `dispatch_spec.schema.json` is in [`packages/dsh-hermes-link/dispatch-spec.schema.json`](../packages/dsh-hermes-link/dispatch-spec.schema.json) for reference).

---

## 12. Reference implementation

[`scripts/hermes-gateway-demo.py`](../scripts/hermes-gateway-demo.py) — standalone Python poller that:
- reads `Hermes Home/inbox/dsh/consult/<ts>-<uuid>.json` for new prompts
- writes `consult-reply/<ticket>-<reply_secret>.json` replies
- writes `amend/<ts>-<task_id>-<amend_nonce>.json` mid-task amendments
- supports `HERMES_LINK_TRUST_LEGACY=1` migration mode

Copy-paste ready for a real Hermes-side gateway. The protocol is intentionally simple — if you can tail a directory, you can be a Hermes-side gateway.

---

## 13. What the bridge does NOT do

- It does **not** evaluate your `task` text for safety — that's Hermes's responsibility.
- It does **not** provide file locking on `Hermes Home/inbox/dsh/*` — last writer wins.
- It does **not** rate-limit dispatch frequency. Hermes-side should add its own rate limiter if needed.
- It does **not** archive `dispatch-result/*` or `usage.jsonl` — Hermes-side should consume and rotate.