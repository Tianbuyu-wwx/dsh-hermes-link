// tools/rotate-outbox-now.mjs
//
// v0.3.1 (F2) - DSH-side Cordis tool that forces an immediate outbox file
// rotation pass (size-based + age-based archive + purge). Hermes cron can
// schedule this hourly to avoid unbounded growth.
//
// Contract fix (v0.6.0 line): the definition must go through `defineTool` and
// declare `output: { schema, render }` — `ctx.tools.register()` rejects raw
// tool objects without an output declaration (the old `{ output,
// outputRenderer, render }` return shape is not a tool contract). Uses the same
// defineTool DSL as the sibling tools in this package.

import { defineTool } from '@deepseek-ai/dsh-tools'

function summarize(result) {
  return [
    '[dsh-hermes-link rotate_outbox_now]',
    'archived.heartbeat=' + result.archived.heartbeat,
    'archived.memory_suggest=' + result.archived.memorySuggest,
    'archived.session_mirror=' + result.archived.sessionMirror,
    'rotated.usage=' + (result.rotated.usage || '(no rotation)'),
    'rotated.session_mirror=' + Object.keys(result.rotated.sessionMirror).length + ' file(s)',
    'purged.heartbeat=' + result.purged.heartbeat,
    'purged.memory_suggest=' + result.purged.memorySuggest,
    'purged.usage=' + result.purged.usage,
    'purged.session_mirror=' + result.purged.sessionMirror,
  ].join('\n')
}

export function createRotateOutboxNowTool({ outboxRotation }) {
  return defineTool({
    name: 'rotate_outbox_now',
    description: 'v0.3.1 F2: force an immediate outbox file rotation pass. ' +
      'Rotates usage.jsonl / session-mirror/<sid>.jsonl when over size limit; ' +
      'archives heartbeat/ + memory-suggest/ files older than archiveAfterDays; ' +
      'purges archive/ entries older than purgeAfterDays. Returns a structured summary.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
        },
      },
      render(_args, value) {
        if (value && value.ok === false) {
          return [{ type: 'text', text: 'rotation failed: ' + (value.note || 'unknown error') }]
        }
        return [{ type: 'text', text: summarize(value.result) }]
      },
    },
    async execute(_args, _ctx) {
      if (!outboxRotation || typeof outboxRotation.rotateNow !== 'function') {
        return { ok: false, note: 'outbox rotation not initialized', result: null }
      }
      try {
        const result = await outboxRotation.rotateNow()
        return { ok: true, note: 'rotation pass complete', result }
      } catch (e) {
        return { ok: false, note: String(e && e.message || e), result: null }
      }
    },
  })
}
