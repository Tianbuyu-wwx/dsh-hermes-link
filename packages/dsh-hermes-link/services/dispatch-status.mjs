// services/dispatch-status.mjs
//
// v0.3.1 (F4) - Build a "dispatch status" snapshot from multiple sources:
//   - continuations SQLite (durable child registry, survives restart)
//   - audit.jsonl (recent dispatch/followup/consult events, append-only)
//   - ctx.agents.get(child_id) (is the child currently live in this process?)
//   - ctx.tokenMeter.measure(agent.session) (current token usage snapshot)
//
// Used by both the JSON-RPC dispatch_status method and the DSH-side
// dispatch_status tool. Read-only; no side effects.

import { readFileSync } from 'node:fs'

/**
 * Read the last N audit lines (default 500). Returns parsed objects.
 * @param {string} auditPath  absolute path to audit.jsonl
 * @param {number} [maxLines]
 * @returns {Array<object>}
 */
export function readAuditRecords(auditPath, maxLines = 500) {
  try {
    const txt = readFileSync(auditPath, 'utf8')
    if (!txt.trim()) return []
    const lines = txt.trim().split('\n').slice(-maxLines)
    const out = []
    for (const line of lines) {
      try { out.push(JSON.parse(line)) } catch (_e) {}
    }
    return out
  } catch (_e) {
    return []
  }
}

/**
 * Filter audit records by optional criteria.
 * @param {Array<object>} records
 * @param {object} filters   { task_id?, kind?, since_ts?, until_ts? }
 * @returns {Array<object>}
 */
export function filterAuditRecords(records, filters) {
  filters = filters || {}
  return records.filter((r) => {
    if (filters.task_id && r.task_id !== filters.task_id) return false
    if (filters.kind && r.kind !== filters.kind) return false
    if (filters.since_ts && Number(r.ts) < filters.since_ts) return false
    if (filters.until_ts && Number(r.ts) > filters.until_ts) return false
    return true
  })
}

/**
 * Build a snapshot of live continuable children.
 *
 * @param {object} deps
 * @param {object} deps.continuations  from openContinuations()
 * @param {object} [deps.ctx]           Cordis ctx (used for ctx.agents.get / ctx.tokenMeter)
 * @param {object} [deps.auditPath]     path to audit.jsonl (optional, for recent-audit merge)
 * @param {object} [opts]
 * @param {string} [opts.task_id]       filter to a specific task
 * @param {number} [opts.include_audit_recent]  number of recent audit entries per child (default 5)
 * @returns {{
 *   children: Array<{
 *     task_id, child_id, parent_agent_id, model, model_tier, skill,
 *     status, stop_reason, created_at, last_seen, is_live,
 *     amend_nonce?, audit_recent?: Array,
 *     tokens?: { total_tokens, surface_tokens, projected_tokens }
 *   }>,
 *   total: number, generated_at: number
 * }}
 */
export function buildDispatchStatus(deps, opts) {
  opts = opts || {}
  const includeAuditRecent = Number.isInteger(opts.include_audit_recent) ? opts.include_audit_recent : 5
  const taskIdFilter = opts.task_id || null

  const cont = deps.continuations
  const ctx  = deps.ctx
  const auditPath = deps.auditPath

  let rows = []
  if (cont && typeof cont.list === 'function') {
    const limit = taskIdFilter ? 50 : 200
    rows = cont.list({ limit })
    if (taskIdFilter) rows = rows.filter((r) => r.task_id === taskIdFilter)
  }

  // Enrich with live status + tokens + recent audit
  let auditByTask = null
  if (includeAuditRecent > 0 && auditPath) {
    const recs = readAuditRecords(auditPath, 500)
    auditByTask = new Map()
    for (const r of recs) {
      const tid = r.task_id
      if (!tid) continue
      if (!auditByTask.has(tid)) auditByTask.set(tid, [])
      const arr = auditByTask.get(tid)
      arr.push(r)
      if (arr.length > includeAuditRecent) arr.shift()
    }
  }

  const out = []
  for (const row of rows) {
    const child = {
      task_id: row.task_id,
      child_id: row.child_id,
      parent_agent_id: row.parent_agent_id,
      workspace: row.workspace || null,
      model: row.model,
      model_tier: row.model_tier,
      skill: row.skill,
      status: row.status,
      stop_reason: row.stop_reason || null,
      created_at: row.created_at,
      last_seen: row.last_seen,
      mode: row.mode,
      is_live: !!(ctx && ctx.agents && ctx.agents.get && ctx.agents.get(row.child_id)),
    }
    // Optional token snapshot for live agents
    if (ctx && ctx.agents && ctx.agents.get && child.is_live) {
      try {
        const agent = ctx.agents.get(row.child_id)
        if (ctx.tokenMeter && ctx.tokenMeter.measure && agent && agent.session) {
          const m = ctx.tokenMeter.measure(agent.session)
          child.tokens = {
            total_tokens: m.totalTokens,
            surface_tokens: m.surfaceTokens,
            projected_tokens: m.projectedTokens,
            pressure_tokens: m.pressureTokens,
            baseline: m.baseline,
          }
        }
      } catch (_e) {
        // measurement failure is non-fatal
      }
    }
    // Recent audit entries for this task (if requested)
    if (auditByTask) {
      const recent = auditByTask.get(row.task_id) || []
      child.audit_recent = recent
    }
    out.push(child)
  }

  return {
    total: out.length,
    generated_at: Date.now(),
    children: out,
  }
}

/**
 * Read the tail of a live child's session event log. Mirrors dispatch_get.
 *
 * @param {object} ctx             Cordis ctx (ctx.agents.get)
 * @param {string} childId
 * @param {object} [opts]          { since?, limit? }
 * @returns {{ ok: boolean, child_id?: string, total_events?: number, returned?: number, events?: Array, error_code?: string, hint?: string }}
 */
export function readChildSessionTail(ctx, childId, opts) {
  opts = opts || {}
  const agent = ctx && ctx.agents && ctx.agents.get ? ctx.agents.get(childId) : null
  if (!agent) {
    return {
      ok: false,
      error_code: 'E_UNKNOWN_CHILD',
      hint: 'child_id is not live in this dsh process (it may have ended or never existed here)',
      child_id: childId,
    }
  }
  const events = (agent.session && agent.session.events) || []
  const since = Number.isInteger(opts.since) ? Math.max(0, opts.since) : 0
  const limit = Number.isInteger(opts.limit) ? Math.min(opts.limit, 1000) : events.length
  const tail = events.slice(since, since + limit)
  return {
    ok: true,
    child_id: childId,
    task_id: agent.session && agent.session.header && agent.session.header.task_id || null,
    total_events: events.length,
    returned: tail.length,
    since,
    limit,
    events: tail,
  }
}
