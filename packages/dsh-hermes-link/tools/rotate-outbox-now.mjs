// tools/rotate-outbox-now.mjs
//
// v0.3.1 (F2) - DSH-side Cordis tool that forces an immediate outbox file
// rotation pass (size-based + age-based archive + purge). Hermes cron can
// schedule this hourly to avoid unbounded growth.

import { mcpError } from '../services/error-codes.mjs'

export function createRotateOutboxNowTool({ outboxRotation }) {
  return {
    name: 'rotate_outbox_now',
    description: 'v0.3.1 F2: force an immediate outbox file rotation pass. ' +
      'Rotates usage.jsonl / session-mirror/<sid>.jsonl when over size limit; ' +
      'archives heartbeat/ + memory-suggest/ files older than archiveAfterDays; ' +
      'purges archive/ entries older than purgeAfterDays. Returns a structured summary.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    async execute(_args, _ctx) {
      if (!outboxRotation || typeof outboxRotation.rotateNow !== 'function') {
        return {
          output: { kind: 'error', error_code: 'E_INTERNAL', message: 'outbox rotation not initialized' },
          outputRenderer: async () => 'outbox rotation not initialized',
          render: () => 'outbox rotation not initialized',
        }
      }
      try {
        const result = await outboxRotation.rotateNow()
        const text = [
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
        return {
          output: { kind: 'success', result },
          outputRenderer: async () => text,
          render: () => text,
        }
      } catch (e) {
        return {
          output: { kind: 'error', error_code: 'E_INTERNAL', message: String(e && e.message || e) },
          outputRenderer: async () => 'rotation failed: ' + (e && e.message || e),
          render: () => 'rotation failed: ' + (e && e.message || e),
        }
      }
    },
  }
}
