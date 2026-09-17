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

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS    = 500
/** B6 (v0.6.0): a ticket unanswered for this long is reported as backlog. */
export const DEFAULT_TICKET_TTL_MS = 24 * 60 * 60 * 1000
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
      version: 'dsh-hermes-link/0.2.2',
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
    return { status: 'pending', ticket, hint: `Hermes gateway did not reply within ${timeoutHint}ms. File: ${path} (secret suffix required since dsh-hermes-link v0.2.2).` }
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
      console.error('[dsh-hermes-link] writeResult failed:', e && e.message || e)
    }
  }

  /** Test/diagnostic helper: list reply files for inspection. */
  function listReplyFiles() {
    try { return readdirSync(replyDir).filter((f) => f.endsWith('.json')) } catch { return [] }
  }

  /** Any reply file naming this ticket: <ticket>-<secret>.json or <ticket>.json. */
  function findReply(ticket) {
    let files = []
    try { files = readdirSync(replyDir) } catch { return null }
    for (const f of files) if (f === ticket + '.json' || f.startsWith(ticket + '-')) return f
    // The reply file is DELETED when a consult consumes it, so a consumed ticket
    // would look unanswered forever (and the TTL sweep would keep marking it).
    // Hermes' dsh-link plugin leaves <ticket>.answered.json behind for exactly
    // this: it is the durable "this one was answered" evidence.
    try { if (existsSync(join(inboxDir, ticket + '.answered.json'))) return ticket + '.answered.json' } catch (_e) { /* best-effort */ }
    return null
  }

  /**
   * B6 (v0.6.0) - consult backlog sweep.
   *
   * A ticket Hermes never answered used to sit in inbox/dsh/consult/ forever
   * with nothing anywhere reporting it: the audit found three 2026-08-21
   * tickets still there three weeks later, and the only way to notice was to
   * list the directory by hand. This sweep stamps a NON-DESTRUCTIVE
   * `<ticket>.expired.json` marker beside a stale ticket, which makes the
   * backlog explicit, countable (hermes_link_consult_expired_total) and
   * reportable by the doctor. The ticket itself is never deleted -- a late
   * reply is still a valid reply, and consumeReply() still accepts it.
   *
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {boolean} [opts.apply] false = report only (the doctor's mode)
   * @param {number} [opts.now]
   * @returns {{scanned:number, open:number, replied:number, stale:object[], expired:object[]}}
   */
  function sweepStaleTickets({ ttlMs = DEFAULT_TICKET_TTL_MS, apply = true, now = Date.now() } = {}) {
    const out = { scanned: 0, open: 0, replied: 0, stale: [], expired: [] }
    let entries = []
    try { entries = readdirSync(inboxDir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.endsWith('.expired.json')) continue
      // A marker is evidence, not a ticket: counting it here would double-count the
      // ticket it belongs to (findReply() already reports that one as replied).
      if (e.name.endsWith('.answered.json')) continue
      out.scanned++
      const payload = readJsonSafe(join(inboxDir, e.name))
      const ticket = payload && payload.ticket ? String(payload.ticket) : null
      const ts = payload && Number.isFinite(payload.ts)
        ? payload.ts
        : (() => { const m = /^(\d{10,})/.exec(e.name); return m ? Number(m[1]) : null })()
      const ageMs = Number.isFinite(ts) ? now - ts : null
      if (ticket && findReply(ticket)) { out.replied++; continue }
      if (ageMs == null || ageMs <= ttlMs) { out.open++; continue }
      const entry = { file: e.name, ticket, age_ms: ageMs }
      out.stale.push(entry)
      const marker = join(inboxDir, (ticket || e.name.replace(/\.json$/, '')) + '.expired.json')
      if (existsSync(marker)) { out.expired.push({ ...entry, marker, already_marked: true }); continue }
      if (!apply) { out.expired.push({ ...entry, marker, would_write: true }); continue }
      try {
        atomicWriteJson(marker, {
          ticket,
          ts: now,
          source: 'dsh',
          kind: 'consult-expired',
          expired_at: now,
          age_ms: ageMs,
          ticket_file: e.name,
          note: 'no reply within ttl; ticket kept so a late reply is still accepted',
        })
        out.expired.push({ ...entry, marker, already_marked: false })
      } catch (_e) { /* best-effort: a failed marker must not break the plugin */ }
    }
    return out
  }

  /**
   * v0.6.2 - is the consult channel actually alive?
   *
   * The audit found three tickets that had been sitting unanswered for three
   * weeks, and every later `consult_hermes` call still waited its full timeout
   * (15s) before reporting "pending" -- the user paid 15 seconds per attempt to
   * discover what the filesystem already knew. This reads the same evidence the
   * doctor does and classifies the channel.
   *
   * Evidence used: open tickets (age <= ttl), stale tickets (age > ttl, no reply
   * yet), the newest reply file on disk, and the expiry markers the sweep leaves.
   * A reply file is DELETED when a consult consumes it, so "no reply files" is
   * only meaningful together with "stale tickets exist".
   *
   * @returns {{verdict:'healthy'|'degraded'|'dead', open:number, stale:number, expired_markers:number, oldest_stale_ms:number|null, last_reply_at:number|null, note:string}}
   */
  function channelHealth({ now = Date.now(), ttlMs = DEFAULT_TICKET_TTL_MS, deadAfterMs = 3 * 24 * 60 * 60 * 1000 } = {}) {
    let entries = []
    try { entries = readdirSync(inboxDir, { withFileTypes: true }) } catch { entries = [] }
    let open = 0
    let stale = 0
    let markers = 0
    let oldest = null
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      if (e.name.endsWith('.expired.json')) { markers++; continue }
      if (e.name.endsWith('.answered.json')) { open++; continue }   // answered, awaiting no one
      const payload = readJsonSafe(join(inboxDir, e.name))
      const ts = payload && Number.isFinite(payload.ts)
        ? payload.ts
        : (() => { const m = /^(\d{10,})/.exec(e.name); return m ? Number(m[1]) : null })()
      const ageMs = Number.isFinite(ts) ? now - ts : null
      const ticket = payload && payload.ticket ? String(payload.ticket) : null
      if (ticket && findReply(ticket)) { open++; continue }
      if (ageMs != null && ageMs > ttlMs) {
        stale++
        if (oldest == null || ageMs > oldest) oldest = ageMs
      } else open++
    }
    // Evidence that Hermes ANSWERS, in both forms it leaves behind: an unconsumed
    // reply file, and the durable <ticket>.answered.json marker the dsh-link plugin
    // writes (a consumed reply is deleted, so the marker is the only lasting proof).
    let lastReplyAt = null
    let answeredMarkers = 0
    let replies = []
    try { replies = readdirSync(replyDir, { withFileTypes: true }) } catch { replies = [] }
    for (const r of replies) {
      if (!r.isFile() || !r.name.endsWith('.json')) continue
      try {
        const st = statSync(join(replyDir, r.name))
        if (lastReplyAt == null || st.mtimeMs > lastReplyAt) lastReplyAt = st.mtimeMs
      } catch (_e) { /* skip */ }
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.answered.json')) continue
      answeredMarkers++
      try {
        const st = statSync(join(inboxDir, e.name))
        if (lastReplyAt == null || st.mtimeMs > lastReplyAt) lastReplyAt = st.mtimeMs
      } catch (_e) { /* skip */ }
    }
    const answerIsRecent = lastReplyAt != null && (now - lastReplyAt) <= deadAfterMs
    // Abandoned tickets (already marked expired, or simply old) must not keep the
    // channel classified as dead once it demonstrably answers: that would make the
    // consult pre-flight trim every future call to 2s forever.
    const verdict = stale > 0 ? (answerIsRecent ? 'degraded' : 'dead') : 'healthy'
    const ageText = lastReplyAt == null ? 'any recorded time' : Math.round((now - lastReplyAt) / 3600000) + 'h'
    const note = verdict === 'healthy'
      ? open + ' open ticket(s), no backlog'
      : verdict === 'degraded'
        ? stale + ' abandoned ticket(s), but Hermes answered ' + ageText + ' ago (markers: ' + answeredMarkers + ')'
        : stale + ' stale ticket(s) and no answer for ' + ageText +
          ' -- the Hermes gateway/poller is probably not consuming ' + inboxDir
    return { verdict, open, stale, expired_markers: markers, answered_markers: answeredMarkers, oldest_stale_ms: oldest, last_reply_at: lastReplyAt, note }
  }

  return { consult, writeResult, inboxDir, replyDir, resultDir, listReplyFiles, sweepStaleTickets, findReply, channelHealth }
}

function ensureDir(d) {
  try { mkdirSync(d, { recursive: true }) } catch {}
}

function atomicWriteJson(path, obj) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
}

// BOM-tolerant: Windows tooling (PowerShell Set-Content, Notepad) writes UTF-8
// with a BOM and JSON.parse refuses it -- same live finding as the outbox consumer.
/**
 * v0.6.2 - how long should a consult wait, given the channel's health?
 *
 * A dead channel must not cost the caller the full timeout every single time.
 * An EXPLICIT timeout_ms is the user overriding that judgement, so it is always
 * honoured; the default path is trimmed to `deadChannelTimeoutMs`.
 *
 * @param {object} args
 * @param {{verdict: string, note: string}} args.health
 * @param {number} args.requestedMs
 * @param {boolean} args.explicit  caller passed timeout_ms
 * @param {number} [args.deadChannelTimeoutMs]
 * @returns {{timeoutMs: number, warning: string|null}}
 */
export function planConsultTimeout({ health, requestedMs, explicit, deadChannelTimeoutMs = 2000 } = {}) {
  const requested = Number.isInteger(requestedMs) && requestedMs > 0 ? requestedMs : 15000
  if (!health || health.verdict !== 'dead' || explicit) return { timeoutMs: requested, warning: null }
  return {
    timeoutMs: Math.min(requested, deadChannelTimeoutMs),
    warning: 'consult channel looks DEAD (' + health.note + '): waiting only ' +
      Math.min(requested, deadChannelTimeoutMs) + 'ms instead of ' + requested +
      'ms. Pass timeout_ms explicitly to override, or start the Hermes gateway.',
  }
}

function readJsonSafe(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
  } catch { return null }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }