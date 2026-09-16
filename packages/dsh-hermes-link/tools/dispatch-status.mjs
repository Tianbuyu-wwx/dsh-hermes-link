// tools/dispatch-status.mjs
//
// v0.3.1 (F4) - DSH-side Cordis tool: returns a snapshot of live continuable
// children (status, tokens, recent audit) so the user can see what Hermes-
// dispatched tasks are doing in real time, from their DSH session.
//
// Contract fix (v0.6.0 line): same repair as rotate-outbox-now.mjs — the tool
// must be built with `defineTool` and declare `output: { schema, render }`,
// otherwise `ctx.tools.register()` throws and every tool registered after it in
// index.mjs is skipped as well.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildDispatchStatus } from '../services/dispatch-status.mjs'
import { auditPath } from '../services/audit.mjs'

export function createDispatchStatusTool({ continuations, ctx }) {
  return defineTool({
    name: 'dispatch_status',
    description: 'v0.3.1 F4: list live continuable dispatch children (status, tokens, recent audit entries). ' +
      'Optional task_id filter scopes to a single task. Used to inspect what Hermes-dispatched tasks are running.',
    parameters: {
      task_id: { type: 'string', description: 'filter to one task (max 128 chars)' },
      include_audit_recent: { type: 'integer', default: 5, description: 'audit entries per child (0-50)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          children: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
          task_id: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, _ctx) {
      const taskId = args && typeof args.task_id === 'string' ? args.task_id : null
      const includeAudit = Number.isInteger(args && args.include_audit_recent) ? args.include_audit_recent : 5
      return buildDispatchStatus(
        { continuations, ctx, auditPath: auditPath() },
        { task_id: taskId, include_audit_recent: includeAudit },
      )
    },
  })
}
