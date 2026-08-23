// services/consult-hermes.mjs
//
// D2: write a consult request to Hermes Home/inbox/dsh/consult/<ts>.json,
// then poll Hermes Home/inbox/dsh/consult-reply/<ticket>-<secret>.json.
//
// v0.2.2: the reply path now embeds a per-call `reply_secret` (16 hex chars)
// that DSH mints and shares with Hermes in the consult payload. Any process
// that can write to the reply dir but does not know the secret cannot forge
// a reply — closing the v0.2.0/v0.2.1 attack surface where a guessable UUID
// was the only routing key. Hermes-side pickup must read the secret from
// the consult inbox payload and name the reply file accordingly. Legacy
// two-segment filenames (`<ticket>.json` without the secret) are rejected
// by default; set `HERMES_LINK_TRUST_LEGACY=1` to accept them too.

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS    = 500
const TRUST_LEGACY       = process.env.HERMES_LINK_TRUST_LEGACY === '1'

/**
 * @param {object} deps
 * @param {string} deps.hermesHome
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.pollMs]
 */
export function createConsultClient({ hermesHome, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = {}) {
  const inboxDir    = join(hermesHome, 'inbox', 'dsh', 'consult')
  const replyDir    = join(hermesHome, 'inbox', 'dsh', 'consult-reply')
  const resultDir   = join(hermesHome, 'inbox', 'dsh', 'dispatch-result')
  ensureDir(inboxDir)
  ensureDir(replyDir)
  ensureDir(resultDir)

  /**
   * Synchronous wrapper: POST a consult, await reply up to timeoutMs.
   * v0.2.2: the reply must land at `<replyDir>/<ticket>-<secret>.json`. Hermes
   * picks up `secret` from the consult inbox payload.
   * @param {string} prompt
   * @param {object} [ctx]  optional task context (task_id, last_tool_calls, …)
   * @param {number|null} [timeoutOverride] per-call timeout in ms.
   * @returns {Promise<{ status:'replied'|'pending'|'error', reply?: string, ticket?: string, error?: string }>}
   */
  async function consult(prompt, ctx = {}, timeoutOverride = null) {
    const ticket = randomUUID()
    const secret = (() => { try { return randomBytes(8).toString('hex') } catch { return '' } })()
    const ts = Date.now()
    const path = join(inboxDir, `${ts}-${ticket}.json`)
    const payload = {
      ticket,
      ts,
      source: 'dsh',
      kind: 'consult',
      prompt,
      context: ctx,
      // Hermes-side pickup must read this and name the reply file as
      // <ticket>-<secret>.json. Without the secret suffix, the reply is
      // ignored (or, with HERMES_LINK_TRUST_LEGACY=1, accepted as legacy).
      reply_secret: secret,
      version: 'hermes-link/0.2.2',
    }
    try {
      atomicWriteJson(path, payload)
    } catch (e) {
      return { status: 'error', error: 'inbox_write_failed: ' + (e && e.message || e) }
    }
    const effectiveTimeout = Number.isInteger(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : timeoutMs
    const deadline = Date.now() + effectiveTimeout
    const timeoutHint = effectiveTimeout
    while (Date.now() < deadline) {
      // Preferred: secret-suffixed filename (v0.2.2+)
      const secretPath = join(replyDir, `${ticket}-${secret}.json`)
      if (existsSync(secretPath)) {
        return consumeReply(secretPath, ticket, 'secret')
      }
      // Legacy: only when HERMES_LINK_TRUST_LEGACY=1
      if (TRUST_LEGACY) {
        const legacyPath = join(replyDir, `${ticket}.json`)
        if (existsSync(legacyPath)) {
          return consumeReply(legacyPath, ticket, 'legacy')
        }
      }
      await sleep(pollMs)
    }
    return { status: 'pending', ticket, hint: `Hermes gateway did not reply within ${timeoutHint}ms. File: ${path} (secret suffix required since hermes-link v0.2.2).` }
  }

  function consumeReply(path, ticket, kind) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      try { unlinkSync(path) } catch {}
      return {
        status: 'replied',
        reply: raw.answer || raw.text || '',
        ticket,
        reply_kind: kind,
      }
    } catch (e) {
      return { status: 'error', error: 'reply_parse_failed: ' + (e && e.message || e), ticket, reply_kind: kind }
    }
  }

  /**
   * Write a task-result record to Hermes' inbox. Best-effort; never throws.
   * @param {object} result
   * @param {string} result.task_id
   * @param {'ok'|'error'} result.status
   * @param {string} [result.output]
   * @param {number} [result.tokens_used]
   * @param {string} [result.error]
   */
  function writeResult(result) {
    if (!result || !result.task_id) return
    const path = join(resultDir, `${result.task_id}.json`)
    try {
      atomicWriteJson(path, { ...result, ts: Date.now(), source: 'dsh' })
    } catch (e) {
      console.error('[hermes-link] writeResult failed:', e && e.message || e)
    }
  }

  /** Test/diagnostic helper: list reply files for inspection. */
  function listReplyFiles() {
    try { return readdirSync(replyDir).filter((f) => f.endsWith('.json')) } catch { return [] }
  }

  return { consult, writeResult, inboxDir, replyDir, resultDir, listReplyFiles }
}

function ensureDir(d) {
  try { mkdirSync(d, { recursive: true }) } catch {}
}

function atomicWriteJson(path, obj) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }