# @tianbuyu-wwx/dsh-hermes-link

## 0.6.0

### Minor Changes

- d41d1ec: feat(budget): real tokenizer + token-budget gates for `dispatch_task` (B1)
  
  Adds a real-LLM-tokenizer path to `dispatch_dry_run` and `dispatch_task`
  that lets the Hermes side reason about token cost in the same units
  the model charges for, instead of a chars / 4 heuristic.
  
  ### What ships in v0.5.0
  
  - **Real tokenizer** (`services/tokenizer.mjs`): lazy-loads `gpt-tokenizer`
    v4 (default `o200k_base`, with `cl100k_base` fallback via subpath import).
    Gracefully degrades to the chars / 4 heuristic if the package is missing
    or fails to load — no plugin crashes if `gpt-tokenizer` is somehow absent.
    - `countTokens(s)` sync, accepts string/null/undefined.
    - `countTokensParts(parts)` sum helper for multi-piece prompts.
    - `tokenizerStatus()` / `tokenizerImpl()` for diagnostics.
  - **`buildDispatchDryRun` upgrades** (already proven v0.3.3 shape preserved):
    - `estimated_prompt_tokens` now uses the real tokenizer instead of
      `ceil(chars / 4)`. CJK / emoji / mixed input is counted accurately.
    - `prompt_chars` keeps the legacy `ENVELOPE_OVERHEAD_CHARS + sum` formula
      so callers comparing against v0.3.3 metrics still see the same number.
    - New fields on the result: `tokenizer: { impl, status }` and
      `budget: { model_tier, prompt_budget, output_cap, over_prompt_budget,
      over_total_budget, max_prompt_tokens?, max_total_tokens?,
      error_code_on_block }` so downstream consumers have everything they
      need to render dashboards / pass to the HTTP layer.
  - **Hard budget gates** (new error code in `services/error-codes.mjs`):
    - `E_TOKEN_BUDGET_EXCEEDED` (JSON-RPC `-32021`).
    - Caller-supplied `max_prompt_tokens` / `max_total_tokens` now populate
      `would_block_on` (`'prompt_tokens_exceeds_max'` /
      `'total_tokens_exceeds_max'`) and surface the error code via
      `result.budget.error_code_on_block`.
    - Tier-aware warnings (`prompt_very_large` / `prompt_above_tier_budget`)
      based on real tokens, not heuristic chars / 4.
  
  ### Wire format additions (back-compat)
  
  `dispatch-spec.schema.json` accepts three new optional fields on the
  dispatch spec:
    - `max_prompt_tokens` — integer, hard cap on prompt tokens.
    - `max_total_tokens` — integer, hard cap on prompt + output tokens.
    - `include_tokenizer_diagnostics` — boolean (default false); when true,
      the `dispatch_dry_run` response exposes `tokenizer = { impl, status }`
      so the Hermes caller can detect heuristic fallback.
  
  Hermes clients that don't supply these new fields continue to behave
  exactly as before — only the `estimated_prompt_tokens` accuracy improves.
  
  ### Tests
  
  - New `scripts/test-token-budget.mjs` (19 cases): tokenizer counts,
    fall-back, dry-run fields, budget gates, error code surface.
  - `scripts/test-dispatch-dry-run.mjs` (cases 9 + 19 updated for real
    token counts; 30/30 passing).
  - `scripts/test-error-codes.mjs` (12/12 passing; `E_TOKEN_BUDGET_EXCEEDED`
    reachable from dry-run output).
  
  ### Dependencies
  
  - `gpt-tokenizer@^4.0.0` (16 KB unpacked, wasm-free, pure JS).

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
