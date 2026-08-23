// services/outbox.mjs
//
// DSH → Hermes file outbox inside Hermes Home (D3/D5/D6/D7 + V4), as planned
// in docs/HERMES-LINK-PLAN.md §2:
//
//   Hermes Home/inbox/dsh/
//     heartbeat/{ts}.json + latest.json     (D3 heartbeat)
//     usage.jsonl                            (D6 usage records per task)
//     memory-suggest/{ts}.json               (D7 memory suggestions)
//     session-mirror/{dsh_session_id}.jsonl  (V4 DSH session mirror)
//
// All writers are best-effort and never throw. Hermes-side pickup is the
// user's responsibility (Hermes gateway or cron).

import { mkdirSync, writeFileSync, appendFileSync, existsSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** Create the outbox service rooted at Hermes Home. */
export function createOutbox({ hermesHome }) {
  const root = join(hermesHome, 'inbox', 'dsh')
  const heartbeatDir  = join(root, 'heartbeat')
  const usagePath     = join(root, 'usage.jsonl')
  const suggestDir    = join(root, 'memory-suggest')
  const mirrorDir     = join(root, 'session-mirror')
  ensureDir(root); ensureDir(heartbeatDir); ensureDir(suggestDir); ensureDir(mirrorDir)

  let heartbeatTimer = null
  let heartbeatSeq = 0

  /** D3: write a heartbeat record (once immediately, then every intervalMs). */
  function startHeartbeat(intervalMs = 60_000, meta = {}) {
    const beat = () => {
      heartbeatSeq++
      const ts = Date.now()
      const payload = {
        seq: heartbeatSeq,
        ts,
        iso: new Date(ts).toISOString(),
        source: 'dsh',
        kind: 'heartbeat',
        version: meta.version || 'hermes-link/0.2',
        pid: process.pid,
        uptime_ms: process.uptime() * 1000,
      }
      atomicWriteJson(join(heartbeatDir, `${ts}.json`), payload)
      atomicWriteJson(join(heartbeatDir, 'latest.json'), payload)
    }
    beat()
    heartbeatTimer = setInterval(beat, intervalMs)
    heartbeatTimer.unref?.()
    return {
      stop() { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null },
      lastSeq: () => heartbeatSeq,
    }
  }

  /** D6: append one usage record (per dispatched task / consult). */
  function appendUsage(rec) {
    try {
      const line = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        source: 'dsh',
        kind: 'usage',
        ...rec,
      }
      appendFileSync(usagePath, JSON.stringify(line) + '\n', 'utf8')
      return true
    } catch (e) {
      console.error('[hermes-link] usage append failed:', e && e.message || e)
      return false
    }
  }

  /** D7: write one memory suggestion for Hermes to consider. */
  function writeMemorySuggestion(suggestion) {
    try {
      const ts = Date.now()
      const payload = {
        ts,
        iso: new Date(ts).toISOString(),
        source: 'dsh',
        kind: 'memory-suggest',
        ...suggestion,
      }
      atomicWriteJson(join(suggestDir, `${ts}.json`), payload)
      return { ok: true, ts }
    } catch (e) {
      console.error('[hermes-link] memory-suggest write failed:', e && e.message || e)
      return { ok: false, error: String(e && e.message || e) }
    }
  }

  /** V4: append one DSH session event to the Hermes-visible mirror (JSONL). */
  function appendSessionEvent(sessionId, event) {
    try {
      // v0.2.3 (K.3) — bound the filename length. sanitize first, then if still
      // longer than 200 chars (Windows MAX_PATH minus room for `<dir>\` + `.jsonl`)
      // hash the tail so collisions stay negligible.
      let safeId = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
      if (safeId.length > 200) {
        const head = safeId.slice(0, 184)
        const tail = createHash('sha1').update(safeId).digest('hex').slice(0, 12)
        safeId = `${head}_${tail}`
      }
      const path = join(mirrorDir, `${safeId}.jsonl`)
      appendFileSync(path, JSON.stringify({ ts: Date.now(), event }) + '\n', 'utf8')
      return true
    } catch (e) {
      // log once per direction — mirror is best-effort
      if (!mirrorErrors.has(String(sessionId))) {
        mirrorErrors.add(String(sessionId))
        console.error('[hermes-link] session-mirror append failed for', sessionId, ':', e && e.message || e)
      }
      return false
    }
  }
  const mirrorErrors = new Set()

  return {
    root, heartbeatDir, usagePath, suggestDir, mirrorDir,
    startHeartbeat, appendUsage, writeMemorySuggestion, appendSessionEvent,
  }
}

function ensureDir(d) {
  try { mkdirSync(d, { recursive: true }) } catch {}
}

function atomicWriteJson(path, obj) {
  try {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(obj, null, 2))
    try {
      renameSync(tmp, path)
    } catch {
      // Windows: destination may be briefly locked; fall back to direct write
      writeFileSync(path, readFileSync(tmp))
      try { unlinkSync(tmp) } catch {}
    }
  } catch (e) {
    console.error('[hermes-link] outbox write failed:', path, e && e.message || e)
  }
}