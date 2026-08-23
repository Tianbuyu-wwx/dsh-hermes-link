// tools/mirror-session-to-hermes.mjs
//
// v0.2.2 — opt-in V4 session mirror.
//
// Replaces v0.2.0/v0.2.1's automatic session/event → Hermes mirror hook. The
// hook is gone from index.mjs; this tool only runs when the user (or model on
// their explicit request) calls it. Use to hand a DSH session over to Hermes
// after the fact, e.g. when the user says "give this DSH conversation to
// Hermes" or "let Hermes see what we did here".
//
// redact=true (default) walks the text-bearing fields of the event payload
// and replaces common secret patterns (API keys, AWS keys, private keys,
// generic key=value pairs) with [REDACTED] before writing the JSONL line.
// redact=false emits verbatim — only for cases the caller has already audited.

import { defineTool } from '@deepseek-ai/dsh-tools'

const TEXT_FIELDS = new Set([
  'text', 'content', 'input', 'output', 'result',
  'description', 'prompt', 'error', 'stderr', 'stdout',
  'reason', 'note', 'message',
])

const SECRET_PATTERNS = [
  // OpenAI / Anthropic / generic API keys
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-or-[A-Za-z0-9_-]{20,}/g,
  // Google API key
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // GitHub PAT / fine-grained
  /\bghp_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access keys
  /\bAKIA[A-Z0-9]{16}/g,
  // PEM private keys (whole block)
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  // Generic key/secret/token/password/cookie assignments (best-effort).
  // v0.2.3 (K.5) added `cookie` so `Cookie: session=xyz` is redacted.
  /(\b(?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth|authorization|cookie|session[_-]?id|set[_-]?cookie)["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
  // Set-Cookie / Cookie header values (defense-in-depth for raw `Cookie: abc=...`)
  /(?:^|[\s;,])(?:cookie|set-cookie)\s*[:=]\s*([^\s"',;]+)/gi,
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

function redactText(t) {
  let out = String(t)
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (m, prefix) => prefix ? prefix + '[REDACTED]' : '[REDACTED]')
  }
  return out
}

export function redactEvent(event) {
  if (!event || typeof event !== 'object') return { event, redacted_blocks: 0 }
  let redactedBlocks = 0
  const cloned = JSON.parse(JSON.stringify(event))
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (typeof v === 'string' && TEXT_FIELDS.has(k)) {
        const before = v
        const after = redactText(v)
        if (after !== before) {
          node[k] = after
          redactedBlocks++
        }
      } else if (typeof v === 'object' && v !== null) {
        walk(v)
      }
    }
  }
  if (cloned.data) walk(cloned.data)
  return { event: cloned, redacted_blocks: redactedBlocks }
}

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