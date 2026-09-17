// tools/session-mirror-control.mjs
//
// v0.4.0 - opt-in control for the automatic DSH -> Hermes session mirror.
//
// This is the explicit switch the user asked for: nothing is mirrored by
// default. Call `session_mirror` with action=enable to start mirroring the
// current DSH session's events to
// Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl (redacted), and
// action=disable to stop. action=status reports the current state.

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createSessionMirrorControlTool({ sessionMirror }) {
  return defineTool({
    name: 'session_mirror',
    description: 'Opt-in switch for automatic DSH session mirroring to Hermes (V4). Default OFF. action=enable starts redacting + appending every new event of the current DSH session to Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl; action=disable stops; action=status reports the current state. When enabling, set backfill=true to also mirror existing events already in this session (redacted by default). action=projects / add-project / remove-project manage the plugin-owned scope file (<DSH_HOME>/dsh-hermes-link/mirror-projects.json) that keeps local paths in scope when the project key Hermes recorded is stale; changes apply to the NEXT event without restarting DSH.',
    parameters: {
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'status', 'projects', 'add-project', 'remove-project'],
        description: 'enable = turn on automatic mirroring for this session, disable = turn it off, status = read current mirror state, projects = show the scope lists, add-project / remove-project = edit the plugin-owned scope file.',
      },
      session_id: { type: 'string', description: 'Optional DSH session id. Defaults to the current agent session.' },
      backfill: { type: 'boolean', description: 'When enabling, also mirror the events already in the session (default false).' },
      redact: { type: 'boolean', description: 'Used only for backfill; automatic mirroring always redacts. Default true.' },
      path: { type: 'string', description: 'For add-project / remove-project: the local project directory (absolute path recommended). Case and separators are matched insensitively.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          note: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
          projects: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute(args, exec) {
      const action = args.action || 'status'
      // Scope-file actions need no live session: they edit configuration, not a
      // session's mirror state.
      if (action === 'projects' || action === 'add-project' || action === 'remove-project') {
        if (!sessionMirror || typeof sessionMirror.listProjects !== 'function') {
          return { ok: false, action, note: 'session mirror service not available', status: null }
        }
        try {
          if (action === 'projects') {
            const p = sessionMirror.listProjects()
            return { ok: true, action, note: 'in-scope projects: ' + p.merged.length + ' (' + p.file.length + ' from the scope file)', status: p, projects: p.file_raw }
          }
          if (action === 'add-project') {
            const r = sessionMirror.addProject(args.path)
            if (!r.ok) return { ok: false, action, note: r.error, status: r, projects: r.file_raw }
            return { ok: true, action, note: 'added to the mirror scope: ' + r.added + ' (applies to the next event, no restart needed)', status: r, projects: r.file_raw }
          }
          const r = sessionMirror.removeProject(args.path)
          return { ok: true, action, note: 'removed from the mirror scope: ' + r.removed, status: r, projects: r.file_raw }
        } catch (e) {
          return { ok: false, action, note: 'scope file action failed: ' + (e && e.message || e), status: null }
        }
      }
      const agent = exec && exec.agent
      const sessionId = args.session_id || (agent && agent.session && agent.session.id)
      if (!sessionId) {
        return { ok: false, action: args.action || 'status', note: 'no live agent/session available', status: null }
      }
      if (!sessionMirror) {
        return { ok: false, action: args.action || 'status', note: 'session mirror service not available', status: null }
      }
      try {
        if (action === 'enable') {
          const events = args.backfill && agent && agent.session ? (agent.session.events || []) : undefined
          const status = sessionMirror.enable(sessionId, {
            events,
            redact: args.redact !== false,
          })
          return {
            ok: true,
            action,
            note: events && events.length ? `mirror enabled; backfilled ${events.length} existing events` : 'mirror enabled for future events',
            status,
          }
        }
        if (action === 'disable') {
          const status = sessionMirror.disable(sessionId)
          return { ok: true, action, note: 'mirror disabled; no further events will be written', status }
        }
        const status = sessionMirror.status(sessionId)
        return { ok: true, action, note: status.enabled ? 'mirror is ON' : 'mirror is OFF (default)', status }
      } catch (e) {
        return { ok: false, action, note: 'session mirror action failed: ' + (e && e.message || e), status: null }
      }
    },
  })
}