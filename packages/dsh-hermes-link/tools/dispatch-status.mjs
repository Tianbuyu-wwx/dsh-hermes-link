// tools/dispatch-status.mjs
//
// v0.3.1 (F4) - DSH-side Cordis tool: returns a snapshot of live continuable
// children (status, tokens, recent audit) so the user can see what Hermes-
// dispatched tasks are doing in real time, from their DSH session.

import { buildDispatchStatus } from '../services/dispatch-status.mjs'
import { auditPath } from '../services/audit.mjs'

export function createDispatchStatusTool({ continuations, ctx }) {
  return {
    name: 'dispatch_status',
    description: 'v0.3.1 F4: list live continuable dispatch children (status, tokens, recent audit entries). ' +
      'Optional task_id filter scopes to a single task. Used to inspect what Hermes-dispatched tasks are running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id:              { type: 'string', minLength: 1, maxLength: 128, description: 'filter to one task' },
        include_audit_recent: { type: 'integer', minimum: 0, maximum: 50, default: 5, description: 'audit entries per child' },
      },
    },
    async execute(args, _ctx) {
      const taskId = args && typeof args.task_id === 'string' ? args.task_id : null
      const includeAudit = Number.isInteger(args && args.include_audit_recent) ? args.include_audit_recent : 5
      const status = buildDispatchStatus(
        { continuations, ctx, auditPath: auditPath() },
        { task_id: taskId, include_audit_recent: includeAudit },
      )
      const text = JSON.stringify(status, null, 2)
      return {
        output: status,
        outputRenderer: async () => text,
        render: () => text,
      }
    },
  }
}
