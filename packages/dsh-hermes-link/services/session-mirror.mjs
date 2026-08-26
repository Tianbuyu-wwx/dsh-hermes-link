// services/session-mirror.mjs
//
// v0.4.0 - opt-in automatic DSH session mirror (V4 opt-in).
//
// Unlike the one-shot `mirror_session_to_hermes` tool, this service lets a
// user explicitly enable continuous mirroring for a specific DSH session.
// Once enabled, every new session event is:
//   1. redacted with the shared redactor (services/redact.mjs)
//   2. appended to Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl
//   3. published on the session SSE channel (`session:<safe_sid>`) when an
//      sseBroker is supplied, so Hermes can subscribe in real time.
//
// The opt-in is per-session and persisted in
// ~/.dsh/dsh-hermes-link/session-mirror-state.json. Default is OFF for every
// session - no event is mirrored unless the user explicitly enables it.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './audit.mjs'
import { safeSessionId } from './outbox.mjs'
import { redactEvent } from './redact.mjs'

const PERSIST_EVERY_N_EVENTS = 25

export function createSessionMirror({ hermesHome, outbox, sseBroker } = {}) {
  const statePath = join(stateDir(), 'session-mirror-state.json')
  const mirrorDir = join(hermesHome, 'inbox', 'dsh', 'session-mirror')

  let state = loadState()
  function loadState() {
    try {
      if (existsSync(statePath)) {
        const data = JSON.parse(readFileSync(statePath, 'utf8'))
        if (data && data.sessions && typeof data.sessions === 'object') {
          return { sessions: data.sessions }
        }
      }
    } catch (e) {
      console.warn('[dsh-hermes-link] session-mirror state load failed, starting empty:', e && e.message || e)
    }
    return { sessions: {} }
  }

  function persist() {
    try {
      mkdirSync(stateDir(), { recursive: true })
      const tmp = statePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, statePath)
    } catch (e) {
      console.error('[dsh-hermes-link] session-mirror state save failed:', e && e.message || e)
    }
  }

  function recFor(sessionId) {
    const safeId = safeSessionId(sessionId)
    return { safeId, rec: state.sessions[safeId] || null }
  }

  function status(sessionId) {
    const { safeId, rec } = recFor(sessionId)
    const path = join(mirrorDir, `${safeId}.jsonl`)
    let file = null
    try {
      if (existsSync(path)) {
        const st = statSync(path)
        file = {
          size_bytes: st.size,
          mtime_ms: st.mtimeMs,
          updated_at: new Date(st.mtimeMs).toISOString(),
        }
      }
    } catch (_e) { /* best-effort */ }
    return {
      session_id: rec && rec.session_id ? rec.session_id : String(sessionId),
      safe_session_id: safeId,
      enabled: !!rec,
      enabled_at: rec ? rec.enabled_at : null,
      mirror_path: path,
      file_exists: !!file,
      file,
      event_count: rec ? rec.event_count || 0 : 0,
      last_event_at: rec ? rec.last_event_at || null : null,
      redacted_blocks: rec ? rec.redacted_blocks || 0 : 0,
      default_off: true,
    }
  }

  function isEnabled(sessionId) {
    return !!recFor(sessionId).rec
  }

  function enable(sessionId, { events, redact = true } = {}) {
    const { safeId } = recFor(sessionId)
    if (!state.sessions[safeId]) {
      state.sessions[safeId] = {
        session_id: String(sessionId),
        enabled_at: Date.now(),
        event_count: 0,
        redacted_blocks: 0,
        last_event_at: null,
      }
    }
    persist()
    if (sseBroker && typeof sseBroker.attachTask === 'function') {
      sseBroker.attachTask(`session:${safeId}`, {
        kind: 'session-mirror',
        session_id: String(sessionId),
        attached_at: Date.now(),
      })
    }
    if (Array.isArray(events) && events.length > 0) {
      for (const ev of events) {
        const { event: cleaned, redacted_blocks } = redact ? redactEvent(ev) : { event: ev, redacted_blocks: 0 }
        if (outbox && outbox.appendSessionEvent(sessionId, cleaned)) {
          state.sessions[safeId].event_count = (state.sessions[safeId].event_count || 0) + 1
          state.sessions[safeId].redacted_blocks = (state.sessions[safeId].redacted_blocks || 0) + redacted_blocks
          state.sessions[safeId].last_event_at = Date.now()
        }
      }
      persist()
    }
    return status(sessionId)
  }

  function disable(sessionId) {
    const { safeId } = recFor(sessionId)
    delete state.sessions[safeId]
    persist()
    return status(sessionId)
  }

  /** Handle one new session event when automatic mirroring is enabled. */
  function handleEvent(sessionId, event) {
    const { safeId, rec } = recFor(sessionId)
    if (!rec) return false
    // Automatic mirroring always redacts. The one-shot tool can still opt out
    // explicitly when the caller has already audited the payload.
    const { event: cleaned, redacted_blocks } = redactEvent(event)
    let ok = false
    if (outbox) ok = outbox.appendSessionEvent(sessionId, cleaned)
    if (ok) {
      rec.event_count = (rec.event_count || 0) + 1
      rec.redacted_blocks = (rec.redacted_blocks || 0) + redacted_blocks
      rec.last_event_at = Date.now()
      if (rec.event_count % PERSIST_EVERY_N_EVENTS === 0) persist()
      if (sseBroker && typeof sseBroker.attachTask === 'function' && typeof sseBroker.publish === 'function') {
        sseBroker.attachTask(`session:${safeId}`, {
          kind: 'session-mirror',
          session_id: String(sessionId),
        })
        sseBroker.publish(`session:${safeId}`, {
          kind: 'session/event',
          data: {
            session_id: String(sessionId),
            ts: Date.now(),
            event_type: event && event.type || null,
            seq: event && event.seq != null ? event.seq : null,
            redacted_blocks,
          },
        })
      }
    }
    return ok
  }

  function listStatus() {
    return Object.keys(state.sessions)
      .map((safeId) => status(safeId))
      .sort((a, b) => (b.enabled_at || 0) - (a.enabled_at || 0))
  }

  function stop() {
    persist()
  }

  return {
    enable,
    disable,
    status,
    isEnabled,
    handleEvent,
    listStatus,
    statePath,
    stop,
  }
}