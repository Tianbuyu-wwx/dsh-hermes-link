// services/redact.mjs
//
// Shared secret-pattern redaction for DSH -> Hermes session mirrors.
// Extracted from tools/mirror-session-to-hermes.mjs so both the one-shot
// mirror tool and the v0.4.0 opt-in automatic mirror use the same scrubber.
//
// redact=true walks the text-bearing fields of the event payload and replaces
// common secret patterns (API keys, AWS keys, private keys, generic key=value
// pairs, cookies, JWTs) with [REDACTED] before writing the JSONL line.

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

export function redactText(t) {
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