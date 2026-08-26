// tools/list-hermes-sessions.mjs
//
// V1 tool: enumerate Hermes session archives (read-only) from the DSH
// session itself — the same data GET /mcp/collab/sessions exposes.

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createListHermesSessionsTool({ importer, sessionMirror }) {
  return defineTool({
    name: 'list_hermes_sessions',
    description: 'List Hermes Agent session archives (latest dump per session), newest first, enriched with title/model/cwd from Hermes state.db and v0.4.0 mirror sync status. Read-only. Use when the user asks what Hermes sessions exist or wants to continue an old Hermes conversation.',
    parameters: {
      limit: { type: 'integer', description: 'Max sessions to return (default 50, max 500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          sessions: {
            type: 'array', required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      if (!importer) return { count: 0, sessions: [], error: 'importer not available' }
      const limit = Number(args.limit) || 50
      const list = await importer.list({ limit: Math.min(Math.max(limit, 1), 500) })
      return { count: list.length, sessions: list.map((s) => ({
        session_id: s.session_id,
        title: s.title,
        mtime: s.mtime,
        message_count: s.message_count,
        first_user_snippet: s.first_user_snippet,
        model: s.model,
        cwd: s.cwd,
        size_bytes: s.size_bytes,
        // v0.4.0: imported DSH session id is `hermes-<session_id>`; this is
        // the status of mirroring that DSH session back to Hermes.
        mirror_status: sessionMirror ? sessionMirror.status('hermes-' + s.session_id) : null,
      })) }
    },
  })
}