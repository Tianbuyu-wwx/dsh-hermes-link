// tools/mirror-session-to-hermes.mjs
//
// v0.2.2 — one-shot opt-in V4 session mirror.
//
// Use this when the user explicitly asks to hand the current DSH conversation
// to Hermes after the fact. For continuous automatic mirroring, use the new
// v0.4.0 `session_mirror` tool (enable/disable/status).
//
// redact=true (default) walks the text-bearing fields of the event payload
// and replaces common secret patterns (API keys, AWS keys, private keys,
// generic key=value pairs, cookies, JWTs) with [REDACTED] before writing the
// JSONL line. redact=false emits verbatim — only for cases the caller has
// already audited.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { redactEvent } from '../services/redact.mjs'

export { redactEvent } from '../services/redact.mjs'

export function createMirrorSessionToHermesTool({ outbox }) {
  return defineTool({
    name: 'mirror_session_to_hermes',
    description: 'Opt-in: write the current DSH session\'s events to Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl. Unlike v0.2.0/v0.2.1, this is NOT automatic — only runs when invoked. Use when the user wants to hand the current DSH conversation over to Hermes (e.g. "let Hermes see this session"). redact defaults to true (scrubs API keys / tokens / passwords / PEM blocks / JWTs from text fields).',
    parameters: {
      tail: { type: 'integer', description: 'Only mirror the most recent N events (default: all events).' },
      redact: { type: 'boolean', description: 'Scrub common secret patterns before writing (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          session_id: { type: 'string' },
          mirrored: { type: 'integer', required: true },
          total_events: { type: 'integer', required: true },
          tail: { type: 'integer' },
          redacted: { type: 'boolean', required: true },
          redacted_blocks: { type: 'integer', required: true },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute(args, exec) {
      const agent = exec && exec.agent
      if (!agent || !agent.session || !outbox) {
        return { ok: false, session_id: null, mirrored: 0, total_events: 0, tail: 0, redacted: false, redacted_blocks: 0, note: 'no live agent/session available' }
      }
      const events = agent.session.events || []
      const tailN = (args.tail && args.tail > 0) ? Math.min(args.tail, events.length) : events.length
      const slice = events.slice(events.length - tailN)
      const redact = args.redact !== false // default true
      let redactedBlocks = 0
      let mirrored = 0
      for (const ev of slice) {
        const { event: cleaned, redacted_blocks } = redact ? redactEvent(ev) : { event: ev, redacted_blocks: 0 }
        redactedBlocks += redacted_blocks
        if (outbox.appendSessionEvent(agent.session.id, cleaned)) mirrored++
      }
      return {
        ok: true,
        session_id: agent.session.id,
        mirrored,
        total_events: events.length,
        tail: tailN,
        redacted: redact,
        redacted_blocks: redactedBlocks,
        note: 'opt-in only; v0.2.2 removed the automatic session/event mirror hook so unrelated-project sessions no longer leak to Hermes. Use mirror_session_to_hermes intentionally.',
      }
    },
  })
}