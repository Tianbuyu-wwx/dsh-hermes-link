// services/error-codes.mjs
//
// v0.3.0 (E9) - centralized error code registry for dsh-hermes-link.
// v0.5.0 (B1) - +E_TOKEN_BUDGET_EXCEEDED for pre-flight / real-dispatch budget gates.
//
// Each code carries:
//   - the JSON-RPC code number (preserves the wire-level value used pre-v0.3.0
//     so existing Hermes clients keep working)
//   - a short message (the canonical phrasing - extra context goes in the
//     data field)
//   - a hint (one-line remediation for the caller / Hermes-side developer)
//
// The mcpError helper here is the SINGLE source of truth for error envelopes.
// Existing call sites migrated from local mcpError() helpers in http/* to use
// this module. The http/_util.mjs mcpError is kept as a thin re-export shim.

export const ErrorCodes = {
  // ---- 32xxx: link-specific ----
  E_AUTH_REQUIRED: {
    code: -32001,
    message: 'unauthorized: missing or invalid Authorization: Bearer <token>',
    hint: 'set HERMES_LINK_TOKEN in DSH env to enable auth; supply Bearer header at caller',
  },
  E_DUPLICATE_TASK_ID: {
    code: -32004,
    message: 'duplicate task_id',
    hint: 'reuse the original child_id via dispatch_followup / dispatch_interrupt instead of dispatch_task again',
  },
  E_NO_LIVE_AGENT: {
    code: -32005,
    message: 'no live parent agent available',
    hint: 'a DSH session must be running for dispatch to spawn a sub-agent',
  },
  E_SPAWN_FAILED: {
    code: -32010,
    message: 'subagent spawn failed',
    hint: 'check dsh-side logs; common cause: toolFilter denied, persona envelope too large, model unavailable',
  },
  E_DISPATCH_FAILED: {
    code: -32011,
    message: 'dispatch failed',
    hint: 'check audit.jsonl for the original error; common cause: deadline exceeded, run.result threw',
  },
  E_UNKNOWN_CHILD: {
    code: -32012,
    message: 'unknown child_id (not in continuation registry)',
    hint: 'list children with dispatch_list; restart-bound orphans stay in SQLite but are not live',
  },
  E_TOOL_CATALOG_UNAVAILABLE: {
    code: -32020,
    message: 'tool catalog unavailable',
    hint: 'tools.view().restrictableNames not readable in this dsh build - dispatch_probe is unsupported',
  },
  E_TOKEN_BUDGET_EXCEEDED: {
    code: -32021,
    message: 'token budget exceeded',
    hint: 'call dispatch_dry_run with the same args to see estimated vs max budget; raise max_prompt_tokens/max_total_tokens or trim the prompt',
  },

  // ---- 326xx / 327xx: standard JSON-RPC ----
  E_UNKNOWN_METHOD: {
    code: -32601,
    message: 'unknown method',
    hint: 'see tools/list for the supported set',
  },
  E_UNKNOWN_TOOL: {
    code: -32601,
    message: 'unknown tool',
    hint: 'see tools/list for the supported set',
  },
  E_INVALID_SPEC: {
    code: -32602,
    message: 'invalid spec',
    hint: 'see dispatch-spec.schema.json for the field surface',
  },
  E_INTERNAL: {
    code: -32603,
    message: 'internal error',
    hint: 'check dsh-side logs for the stack trace',
  },
  E_PARSE_ERROR: {
    code: -32700,
    message: 'parse error',
    hint: 'body must be valid JSON-RPC 2.0',
  },
  E_INVALID_REQUEST: {
    code: -32600,
    message: 'invalid request',
    hint: 'method/path combo not allowed',
  },
}

/**
 * Build a JSON-RPC 2.0 error response.
 * @param {string|number|null} id        JSON-RPC request id (may be null on parse failure)
 * @param {string} codeName              one of ErrorCodes keys (e.g. 'E_DUPLICATE_TASK_ID')
 * @param {string} [extra]              appended to message (kept short - full context goes in data)
 * @param {object} [data]                additional structured fields (error_code, hint auto-included)
 * @returns {{jsonrpc:string, id:any, error:{code:number, message:string, data:object}}}
 */
export function mcpError(id, codeName, extra, data) {
  const def = ErrorCodes[codeName]
  if (!def) {
    throw new Error('[dsh-hermes-link] unknown error code: ' + codeName +
      ' (must be one of: ' + Object.keys(ErrorCodes).join(', ') + ')')
  }
  const baseData = { error_code: codeName, hint: def.hint }
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: def.code,
      message: extra ? `${def.message}: ${extra}` : def.message,
      data: data ? Object.assign(baseData, data) : baseData,
    },
  }
}

/**
 * Build a JSON-RPC 2.0 success response.
 * @param {string|number|null} id
 * @param {any} result
 */
export function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}