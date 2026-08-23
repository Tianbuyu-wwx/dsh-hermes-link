// tools/import-hermes-session.mjs
//
// V2 tool: import one Hermes session archive as a live DSH session with full
// historical context. Idempotent on session_id.

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createImportHermesSessionTool({ importer }) {
  return defineTool({
    name: 'import_hermes_session',
    description: 'Import a Hermes session as a DSH session: the request_dump archive is converted to DSH events and persisted as a new session (id "hermes-<session_id>") so the user can continue the conversation in DSH. Idempotent — re-importing is a no-op. Use when the user wants to "continue" an old Hermes conversation.',
    parameters: {
      hermesSessionId: {
        type: 'string',
        required: true,
        description: 'Hermes session id (see list_hermes_sessions).',
      },
      workspace: {
        type: 'string',
        description: 'Optional absolute working directory override for the imported session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          hermesSessionId: { type: 'string', required: true },
          sessionId: { type: 'string' },
          eventCount: { type: 'integer' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          firstUserSnippet: { type: 'string' },
          model: { type: 'string' },
          attach: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      if (!importer) return { status: 'error', hermesSessionId: args.hermesSessionId, note: 'importer not available' }
      const r = await importer.importSession(args.hermesSessionId, {
        workspace: typeof args.workspace === 'string' && args.workspace ? args.workspace : undefined,
      })
      // Normalize the importer's raw result to the declared output shape:
      // nullable fields are dropped (undefined members never reach JSON), so
      // the schema's exact-property contract holds for every status branch.
      return {
        status: r.status,
        hermesSessionId: r.hermesSessionId,
        ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
        ...(Number.isInteger(r.eventCount) ? { eventCount: r.eventCount } : {}),
        ...(typeof r.title === 'string' ? { title: r.title } : {}),
        ...(typeof r.cwd === 'string' ? { cwd: r.cwd } : {}),
        ...(typeof r.firstUserSnippet === 'string' ? { firstUserSnippet: r.firstUserSnippet } : {}),
        ...(typeof r.model === 'string' ? { model: r.model } : {}),
        ...(typeof r.attach === 'string' ? { attach: r.attach } : {}),
        ...(typeof r.note === 'string' ? { note: r.note } : {}),
      }
    },
  })
}