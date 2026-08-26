// http/jsonrpc-handlers.mjs
//
// v0.3.0 - split out of http/dispatch.mjs (E1 refactor). Owns:
//   - handleRpc: the top-level JSON-RPC dispatcher for POST /mcp/collab
//   - initialize / ping / notifications/initialized / tools/list
//   - dispatch_probe (zero-cost tool-name validation)
//   - get_dispatch (read audit.jsonl tail)
//   - tools/call fan-out to handleDispatchTask / handleDispatchFollowup / etc.

import schema from '../dispatch-spec.schema.json' with { type: 'json' }
import { readAuditLines, auditPath as _auditPath } from '../services/audit.mjs'
import { buildDispatchStatus, readChildSessionTail, filterAuditRecords, readAuditRecords } from '../services/dispatch-status.mjs'
import { buildDispatchDryRun } from '../services/dispatch-dry-run.mjs'
import { mcpError, mcpResult } from './_util.mjs'
import { handleDispatchTask } from './dispatch-task.mjs'
import {
  handleDispatchFollowup,
  handleDispatchInterrupt,
  handleDispatchList,
  handleDispatchGet,
} from './dispatch-control.mjs'

const VERSION = '0.3.6'

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
    if (deps.metrics) deps.metrics.inc('hermes_link_dispatch_total', { mode: args.mode === 'continuable' ? 'continuable' : 'one-shot', status: 'started' })
    if (name === 'dispatch_task') {
      const out = await handleDispatchTask(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_probe') {
      return handleProbe(ctx, id, args)
    }
    if (deps.metrics) deps.metrics.inc('hermes_link_followup_total', { status: 'started' })
    if (name === 'dispatch_followup') {
      const out = await handleDispatchFollowup(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (deps.metrics) deps.metrics.inc('hermes_link_interrupt_total', { status: 'started' })
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
      if (deps.metrics) deps.metrics.inc('hermes_link_dispatch_total', { mode: 'read', status: 'audit' })
      // v0.3.1 F4: enhanced with task_id/kind/since_ts/until_ts filters +
      // continuable_children enrichment when available.
      const limit = Number(args.limit) || 20
      const taskIdFilter = typeof args.task_id === 'string' ? args.task_id : null
      const kindFilter  = typeof args.kind === 'string' ? args.kind : null
      const sinceTs = Number.isInteger(args.since_ts) ? args.since_ts : null
      const untilTs = Number.isInteger(args.until_ts) ? args.until_ts : null
      // Parse audit lines (no API change - readAuditLines returns raw strings)
      // For enrichment we parse records.
      const rawLines = readAuditLines(2000)
      const records = []
      for (const line of rawLines) {
        try { records.push(JSON.parse(line)) } catch (_e) {}
      }
      let filtered = records
      if (taskIdFilter || kindFilter || sinceTs || untilTs) {
        filtered = filterAuditRecords(records, { task_id: taskIdFilter, kind: kindFilter, since_ts: sinceTs, until_ts: untilTs })
      }
      filtered = filtered.slice(-limit)
      // Enrich with live continuable metadata when available
      const cont = deps.continuations
      const liveSet = new Set()
      if (cont && typeof cont.list === 'function') {
        for (const c of cont.list({ limit: 200 })) liveSet.add(c.task_id)
      }
      for (const r of filtered) {
        if (r.task_id && liveSet.has(r.task_id)) r.live_continuable = true
      }
      return mcpResult(id, { content: [{ type: 'text', text: filtered.length ? JSON.stringify(filtered, null, 2) : '(empty)' }] })
    }
    if (name === 'dispatch_status') {
      if (deps.metrics) deps.metrics.inc('hermes_link_dispatch_total', { mode: 'read', status: 'status' })
      // v0.3.1 F4: live continuable children snapshot + audit_recent + token snapshot
      const taskIdFilter = typeof args.task_id === 'string' ? args.task_id : null
      const includeAudit = Number.isInteger(args.include_audit_recent) ? args.include_audit_recent : 5
      const status = buildDispatchStatus({
        continuations: deps.continuations,
        ctx,
        auditPath: _auditPath ? _auditPath() : undefined,
      }, { task_id: taskIdFilter, include_audit_recent: includeAudit })
      return mcpResult(id, status)
    }
    if (name === 'dispatch_tail') {
      if (deps.metrics) deps.metrics.inc('hermes_link_dispatch_total', { mode: 'read', status: 'tail' })
      // v0.3.1 F4: last N session events from a live child agent
      const childId = typeof args.child_id === 'string' ? args.child_id : ''
      if (!childId) return mcpError(id, 'E_INVALID_SPEC', 'child_id required')
      const tail = readChildSessionTail(ctx, childId, {
        since: Number.isInteger(args.since) ? args.since : 0,
        limit: Number.isInteger(args.limit) ? args.limit : 200,
      })
      if (!tail.ok) return mcpError(id, tail.error_code, tail.hint || '')
      return mcpResult(id, tail)
    }
    if (name === 'dispatch_dry_run') {
      // v0.3.3 F5: pre-flight estimator (no sub-agent spawned)
      if (deps.metrics) deps.metrics.inc('hermes_link_dispatch_total', { mode: 'dry-run', status: 'requested' })
      const result = buildDispatchDryRun(args, { ctx, foundationSlice: deps.foundationSlice })
      if (!result.ok) {
        return mcpError(id, result.error_code, result.hint)
      }
      return mcpResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        metadata: result,
      })
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
      description: 'v0.3.1 F4: read the dsh-hermes-link audit log with optional filters (task_id, kind, since_ts, until_ts); each entry is enriched with live_continuable when matching a registered child. Default limit 20 (max 500).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit:     { type: 'integer', default: 20, minimum: 1, maximum: 500 },
          task_id:   { type: 'string', minLength: 1, maxLength: 128 },
          kind:      { type: 'string', enum: ['dispatch', 'import', 'consult', 'memory-suggest', 'import-all', 'continuable_started', 'continuable_completed', 'followup_completed', 'interrupted'] },
          since_ts:  { type: 'integer', minimum: 0, description: 'Unix ms; only entries with ts >= since_ts' },
          until_ts:  { type: 'integer', minimum: 0, description: 'Unix ms; only entries with ts <= until_ts' },
        },
      },
    },
    {
      name: 'dispatch_status',
      description: 'v0.3.1 F4: live continuable children snapshot. Returns task_id/child_id/status/tokens + optional recent audit entries. Filterable by task_id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id:              { type: 'string', minLength: 1, maxLength: 128 },
          include_audit_recent: { type: 'integer', default: 5, minimum: 0, maximum: 50 },
        },
      },
    },
    {
      name: 'dispatch_dry_run',
      description: 'v0.3.3 F5: pre-flight estimator for dispatch_task. Returns estimated prompt/output tokens + would_block_on + warnings WITHOUT spawning a sub-agent. Use this before dispatch_task to validate the skill name, check token budget, and surface truncation risks.',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'skill', 'task'],
        additionalProperties: false,
        properties: {
          task_id:         { type: 'string', minLength: 1, maxLength: 128 },
          skill:           { type: 'string', minLength: 1, maxLength: 64 },
          task:            { type: 'string', minLength: 1, maxLength: 8000 },
          args:            { type: 'object' },
          knowledge_subset:{ type: 'array', maxItems: 16, items: { type: 'object' } },
          model_tier:      { type: 'string', enum: ['flash', 'pro', 'vision'], default: 'flash' },
          max_tokens:      { type: 'integer', minimum: 256, maximum: 32000, default: 4000 },
          mode:            { type: 'string', enum: ['one-shot', 'continuable'] },
          provider:        { type: 'string', enum: ['fork', 'spawn'] },
        },
      },
    },
    {
      name: 'dispatch_tail',
      description: 'v0.3.1 F4: last N session events from a live continuable child agent (in-process only). Same shape as dispatch_get but accessible via JSON-RPC.',
      inputSchema: {
        type: 'object',
        required: ['child_id'],
        additionalProperties: false,
        properties: {
          child_id: { type: 'string', minLength: 1, maxLength: 128 },
          since:    { type: 'integer', minimum: 0, default: 0 },
          limit:    { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
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
