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
    description: 'Opt-in switch for automatic DSH session mirroring to Hermes (V4). Default OFF. action=enable starts redacting + appending every new event of the current DSH session to Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl; action=disable stops; action=status reports the current state. When enabling, set backfill=true to also mirror existing events already in this session (redacted by default).',
    parameters: {
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'status'],
        description: 'enable = turn on automatic mirroring for this session, disable = turn it off, status = read current mirror state.',
      },
      session_id: { type: 'string', description: 'Optional DSH session id. Defaults to the current agent session.' },
      backfill: { type: 'boolean', description: 'When enabling, also mirror the events already in the session (default false).' },
      redact: { type: 'boolean', description: 'Used only for backfill; automatic mirroring always redacts. Default true.' },
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
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute(args, exec) {
      const agent = exec && exec.agent
      const sessionId = args.session_id || (agent && agent.session && agent.session.id)
      if (!sessionId) {
        return { ok: false, action: args.action || 'status', note: 'no live agent/session available', status: null }
      }
      if (!sessionMirror) {
        return { ok: false, action: args.action || 'status', note: 'session mirror service not available', status: null }
      }
      const action = args.action || 'status'
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