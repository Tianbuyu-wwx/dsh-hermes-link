// http/jsonrpc-handlers.mjs
//
// v0.3.0 - split out of http/dispatch.mjs (E1 refactor). Owns:
//   - handleRpc: the top-level JSON-RPC dispatcher for POST /mcp/collab
//   - initialize / ping / notifications/initialized / tools/list
//   - dispatch_probe (zero-cost tool-name validation)
//   - get_dispatch (read audit.jsonl tail)
//   - tools/call fan-out to handleDispatchTask / handleDispatchFollowup / etc.

import schema from '../dispatch-spec.schema.json' with { type: 'json' }
import { readAuditLines } from '../services/audit.mjs'
import { mcpError, mcpResult } from './_util.mjs'
import { handleDispatchTask } from './dispatch-task.mjs'
import {
  handleDispatchFollowup,
  handleDispatchInterrupt,
  handleDispatchList,
  handleDispatchGet,
} from './dispatch-control.mjs'

const VERSION = '0.3.0'

export async function handleRpc(ctx, body, deps) {
  const id     = body && body.id
  const method = body && body.method
  const params = body && body.params

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-hermes-link', version: VERSION },
    })
  }
  if (method === 'ping') {
    return mcpResult(id, {
      ok: true,
      version: VERSION,
      hermes_home: deps.hermesHome,
      importer_ready: !!deps.importer,
      persona_ready: !!deps.personaLoader,
      consult_ready: !!deps.consultClient,
      continuable_registry: deps.continuations ? 'on' : 'off',
      active_dispatchers: deps.dispatcherCount ? deps.dispatcherCount() : 0,
    })
  }
  if (method === 'notifications/initialized') {
    return null
  }
  if (method === 'tools/list') {
    return mcpResult(id, { tools: buildToolsList() })
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'dispatch_task') {
      const out = await handleDispatchTask(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_probe') {
      return handleProbe(ctx, id, args)
    }
    if (name === 'dispatch_followup') {
      const out = await handleDispatchFollowup(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_interrupt') {
      const out = await handleDispatchInterrupt(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_list') {
      const out = await handleDispatchList(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_get') {
      const out = await handleDispatchGet(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'get_dispatch') {
      const limit = Number(args.limit) || 20
      const lines = readAuditLines(limit)
      return mcpResult(id, { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }] })
    }
    if (name === 'dispatch_subscribe') {
      // v0.3.0 F1: discovery helper - returns the SSE URL the caller should GET.
      const taskId = args && typeof args.task_id === 'string' ? args.task_id : ''
      if (!taskId) return mcpError(id, 'E_INVALID_SPEC', 'task_id required')
      const sinceSeq  = Number.isInteger(args && args.since_seq)  ? args.since_seq  : 0
      const timeoutMs = Number.isInteger(args && args.timeout_ms) ? args.timeout_ms : 0
      const url = '/mcp/collab/stream?task_id=' + encodeURIComponent(taskId) + '&since_seq=' + sinceSeq + '&timeout_ms=' + timeoutMs
      return mcpResult(id, {
        content: [{ type: 'text', text: 'Open SSE stream at: ' + url + '\nAuthorization: Bearer <token> required (same as /mcp/collab).' }],
        metadata: { transport: 'sse', url, since_seq: sinceSeq, timeout_ms: timeoutMs, note: 'GET is canonical; this tool only describes it.' },
      })
    }
    return mcpError(id, 'E_UNKNOWN_TOOL', 'unknown tool: ' + name)
  }
  return mcpError(id, 'E_UNKNOWN_METHOD', 'unknown method: ' + method)
}

function buildToolsList() {
  return [
    {
      name: 'dispatch_task',
      description: 'Hermes-side entry: spawn a focused sub-agent. mode=one-shot returns the final result; mode=continuable returns child_id for ongoing followup.',
      inputSchema: {
        type: 'object',
        required: schema.required,
        additionalProperties: schema.additionalProperties,
        properties: schema.properties,
      },
    },
    {
      name: 'dispatch_followup',
      description: 'Send more content to a continuable child and await its next reply. Returns the reply text + token usage.',
      inputSchema: {
        type: 'object',
        required: ['child_id', 'content'],
        additionalProperties: false,
        properties: {
          child_id: { type: 'string', minLength: 1, maxLength: 128 },
          content: { type: 'array', minItems: 1, items: { type: 'object' } },
          deadline_ms: { type: 'integer', minimum: 1000, maximum: 600000, default: 60000 },
        },
      },
    },
    {
      name: 'dispatch_interrupt',
      description: 'Interrupt a continuable child. Idempotent. No-op if child already ended.',
      inputSchema: {
        type: 'object',
        required: ['child_id'],
        additionalProperties: false,
        properties: {
          child_id: { type: 'string', minLength: 1, maxLength: 128 },
          reason: { type: 'string', maxLength: 256 },
        },
      },
    },
    {
      name: 'dispatch_list',
      description: 'List known continuable children (SQLite-backed) with live-status augmentation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
    },
    {
      name: 'dispatch_get',
      description: 'Read the live session event log for a child agent (in-process only).',
      inputSchema: {
        type: 'object',
        required: ['child_id'],
        additionalProperties: false,
        properties: {
          child_id: { type: 'string', minLength: 1, maxLength: 128 },
          since: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 },
        },
      },
    },
    {
      name: 'dispatch_probe',
      description: 'Zero-cost tool-name probe: validates a skill/tool name against the live dsh global tool catalog without spawning an agent. Returns the full known-tools list on miss.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { skill: { type: 'string', minLength: 1, maxLength: 128, description: 'tool name to validate' } },
      },
    },
    {
      name: 'get_dispatch',
      description: 'Read the dsh-hermes-link audit log (last N entries, default 20).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', default: 20, minimum: 1, maximum: 500 } },
      },
    },
    {
      name: 'dispatch_subscribe',
      description: 'v0.3.0 F1: discovery helper. Returns the SSE URL the caller should GET for real-time event streaming on a continuable task. The actual stream is at /mcp/collab/stream (text/event-stream).',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        additionalProperties: false,
        properties: {
          task_id:    { type: 'string', minLength: 1, maxLength: 128 },
          since_seq:  { type: 'integer', minimum: 0, maximum: 1e9, default: 0 },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, default: 0 },
        },
      },
    },
  ]
}

function handleProbe(ctx, id, args) {
  const probeName = args && typeof args.skill === 'string' && args.skill ? args.skill : ''
  if (!probeName) return mcpError(id, 'E_INVALID_SPEC', 'invalid spec: missing required field: skill')
  let names = null
  try {
    let view = null
    try { view = ctx.tools.view() } catch {}
    if ((!view || !view.restrictableNames) && ctx.tools.view) {
      try { view = ctx.tools.view({}) } catch {}
    }
    if (view && view.restrictableNames) names = [...view.restrictableNames].sort()
  } catch {}
  if (!names) {
    return mcpError(id, 'E_TOOL_CATALOG_UNAVAILABLE', 'tools.view().restrictableNames not readable in this dsh build')
  }
  if (names.includes(probeName)) {
    return mcpResult(id, { content: [{ type: 'text', text: 'ok: tool "' + probeName + '" is known (' + names.length + ' global tools)' }] })
  }
  return mcpError(id, 'E_DISPATCH_FAILED',
    'unknown tool "' + probeName + '"; known global tools (' + names.length + '): ' + names.join(', '))
}
