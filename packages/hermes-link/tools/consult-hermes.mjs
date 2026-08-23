// tools/consult-hermes.mjs
//
// D2 tool: ask Hermes a question through the file consult channel.
// Returns the answer when Hermes replies in time; otherwise a pending hint.

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createConsultHermesTool({ consultClient }) {
  return defineTool({
    name: 'consult_hermes',
    description: 'Ask Hermes a question (sync wait, file-based channel). Hermes must have its gateway/poller running to pick up the request and drop a reply; otherwise this returns a pending hint after timeout_ms. Use when you need Hermes\'s judgement (writing tone, scope discipline, project knowledge that lives in Hermes memory) and the answer cannot be derived locally.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The specific consult request. Be precise about what you are deciding and what you already checked.',
      },
      context: {
        type: 'object',
        // dsh defineTool DSL requires explicit additionalProperties on nested objects.
        additionalProperties: true,
        description: 'Optional task context (task_id, last_tool_calls, …).',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Max wait in ms (default 15000, max 120000).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    async execute(args) {
      if (!consultClient) return '[consult_hermes unavailable]'
      const timeoutMs = Number.isInteger(args.timeout_ms)
        ? Math.min(Math.max(args.timeout_ms, 1000), 120000)
        : 15000
      const started = Date.now()
      const result = await consultClient.consult(args.prompt, args.context || {}, timeoutMs)
      const elapsed = Date.now() - started
      if (result.status === 'replied') {
        return 'Hermes reply (' + elapsed + 'ms):\n' + (result.reply || '(empty)')
      }
      if (result.status === 'pending') {
        return '[consult_hermes pending] ' + (result.hint || 'Hermes did not reply in time') +
          '\n(hint: start the Hermes gateway, or retry later — the ticket stays in the consult inbox.)'
      }
      return '[consult_hermes error] ' + (result.error || result.status)
    },
  })
}