// http/dispatch-control.mjs
//
// v0.3.0 - split out of http/dispatch.mjs (E1 refactor). Owns:
//   - handleDispatchFollowup (continuable followup: send content + wait for reply)
//   - handleDispatchInterrupt (interrupt a continuable child)
//   - handleDispatchList (list registered children)
//   - handleDispatchGet (read a live child's session events)
// All handlers return { _error: mcpError } on failure or { content, metadata } on success.
// Caller (jsonrpc-handlers.mjs) wraps results in JSON-RPC envelopes.

import { appendAudit } from '../services/audit.mjs'
import { waitForNextReply } from '../services/continuations.mjs'
import { mcpError } from './_util.mjs'
import { extractOutputText, measureRealTokens, pickParentAgent } from './dispatch-task.mjs'

const VERSION = '0.3.0'

export async function handleDispatchFollowup(ctx, args, deps) {
  const { continuations, outbox } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, 'E_INVALID_SPEC', 'invalid spec: child_id required') }
  const entry = continuations ? continuations.get(childId) : null
  if (!entry) return { _error: mcpError(null, 'E_UNKNOWN_CHILD', 'unknown child_id; not in registry') }
  if (!Array.isArray(args.content) || args.content.length === 0) {
    return { _error: mcpError(null, 'E_INVALID_SPEC', 'invalid spec: content (ContentBlock[]) required') }
  }
  const liveParent = ctx.agents.get(entry.parent_agent_id) || pickParentAgent(ctx)
  if (!liveParent) return { _error: mcpError(null, 'E_NO_LIVE_AGENT', 'no live parent agent available for followup') }

  const deadlineMs = Number.isInteger(args.deadline_ms) ? args.deadline_ms : 60000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('deadline_ms exceeded')), deadlineMs)
  const startedAt = Date.now()

  let messageId
  try {
    messageId = await ctx.subagents.followup(liveParent, childId, args.content, {
      signal: controller.signal,
      source: { kind: 'user' },
    })
  } catch (e) {
    clearTimeout(timer)
    return { _error: mcpError(null, 'E_SPAWN_FAILED', 'followup submit failed: ' + (e && e.message || e)) }
  }

  const reloadedAgent = ctx.agents.get(childId)
  const beforeSeq = reloadedAgent ? reloadedAgent.session.seq : 0

  let reply
  try {
    reply = await waitForNextReply(ctx, childId, beforeSeq, controller.signal)
  } catch (e) {
    clearTimeout(timer)
    if (continuations) continuations.update(childId, { status: 'timeout', stop_reason: 'followup_deadline' })
    return { _error: mcpError(null, 'E_DISPATCH_FAILED', 'followup wait failed: ' + (e && e.message || e), { message_id: String(messageId) }) }
  }

  clearTimeout(timer)
  const finishedAt = Date.now()
  const finalAgent = ctx.agents.get(childId) || reloadedAgent
  const outputText = extractOutputText(reply.assistant_content)
  const realTokens = measureRealTokens(ctx, finalAgent)
  if (continuations) continuations.update(childId, { status: 'idle', stop_reason: 'awaiting_next' })

  appendAudit({
    ts: new Date(finishedAt).toISOString(),
    status: 'followup_completed',
    child_id: childId,
    task_id: entry.task_id,
    parent_agent_id: entry.parent_agent_id,
    message_id: String(messageId),
    elapsed_ms: finishedAt - startedAt,
    output_chars: outputText.length,
    real_tokens: realTokens,
  })
  if (outbox) {
    outbox.appendUsage({
      kind: 'dispatch',
      mode: 'continuable',
      task_id: entry.task_id,
      child_id: childId,
      status: 'ok',
      elapsed_ms: finishedAt - startedAt,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      model: entry.model,
      skill: entry.skill,
    })
  }

  return {
    content: [{
      type: 'text',
      text: [
        '[dsh-hermes-link v' + VERSION + '] followup child_id=' + childId,
        'message_id=' + String(messageId),
        'elapsed_ms=' + (finishedAt - startedAt),
        realTokens ? 'real_tokens: total=' + realTokens.total_tokens : 'real_tokens: (unavailable)',
        '',
        '--- output ---',
        outputText || '(empty)',
      ].join('\n'),
    }],
    metadata: {
      v0_2_status: 'followup_completed',
      child_id: childId,
      task_id: entry.task_id,
      message_id: String(messageId),
      elapsed_ms: finishedAt - startedAt,
      real_tokens: realTokens,
    },
  }
}

export async function handleDispatchInterrupt(ctx, args, deps) {
  const { continuations } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, 'E_INVALID_SPEC', 'invalid spec: child_id required') }
  const entry = continuations ? continuations.get(childId) : null
  if (!entry) return { _error: mcpError(null, 'E_UNKNOWN_CHILD', 'unknown child_id') }
  const agent = ctx.agents.get(childId)
  if (!agent) {
    if (continuations) continuations.update(childId, { status: 'orphan', stop_reason: 'interrupted_not_live' })
    return { content: [{ type: 'text', text: 'child_id=' + childId + ' was not live; marked orphan' }] }
  }
  const parent = ctx.agents.get(entry.parent_agent_id) || pickParentAgent(ctx)
  try {
    ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
  } catch (e) {
    return { _error: mcpError(null, 'E_SPAWN_FAILED', 'interrupt failed: ' + (e && e.message || e)) }
  }
  if (continuations) continuations.update(childId, { status: 'interrupted', stop_reason: 'interrupt_requested' })
  appendAudit({
    ts: new Date().toISOString(),
    status: 'interrupted',
    child_id: childId,
    task_id: entry.task_id,
    reason: args.reason || '(no reason)',
  })
  return {
    content: [{ type: 'text', text: 'interrupted child_id=' + childId + (args.reason ? ' reason=' + args.reason : '') }],
    metadata: { v0_2_status: 'interrupted', child_id: childId },
  }
}

export async function handleDispatchList(ctx, args, deps) {
  const { continuations } = deps
  if (!continuations) return { _error: mcpError(null, 'E_UNKNOWN_CHILD', 'continuation registry not available') }
  const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 200) : 50
  const rows = continuations.list({ limit })
  const enriched = rows.map((r) => ({
    ...r,
    is_live: ctx.agents.get(r.child_id) ? true : false,
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: enriched.length, children: enriched }, null, 2) }],
    metadata: { v0_2_status: 'list_ok', count: enriched.length },
  }
}

export async function handleDispatchGet(ctx, args, deps) {
  const { continuations } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, 'E_INVALID_SPEC', 'invalid spec: child_id required' ) }
  const entry = continuations ? continuations.get(childId) : null
  const agent = ctx.agents.get(childId)
  if (!agent) {
    return { _error: mcpError(null, 'E_UNKNOWN_CHILD', 'child agent not live in current dsh session; dispatch_list shows persisted metadata') }
  }
  const events = agent.session.events
  const since = Number.isInteger(args.since) ? Math.max(0, args.since) : 0
  const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 1000) : events.length
  const tail = events.slice(since, since + limit)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        child_id: childId,
        task_id: entry ? entry.task_id : null,
        parent_agent_id: entry ? entry.parent_agent_id : null,
        session_id: agent.session.id,
        total_events: events.length,
        returned: tail.length,
        events: tail,
      }, null, 2),
    }],
    metadata: { v0_2_status: 'get_ok', child_id: childId, total_events: events.length, returned: tail.length },
  }
}
