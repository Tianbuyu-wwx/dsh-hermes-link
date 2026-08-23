// services/hermes-session-watcher.mjs
//
// V1: watch Hermes Home/sessions/ for new request_dump files; emit a change
// event so the host can refresh sidebar metadata / cache.
//
// Implementation: a polling loop (60s) is more reliable than fs.watch across
// platforms (Hermes dumps 0.5–1.6MB files in a single write, often <1s after
// the request fails — fs.watch on Windows can miss large single-shot writes
// from Python processes). The watcher is best-effort: callers should treat
// stale data as recoverable on the next tick.

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const POLL_INTERVAL_MS = 60_000
const STABLE_SIZE_MS  = 5_000   // file size unchanged for this long = ready

/**
 * @param {string} sessionsDir  Hermes Home/sessions/
 * @returns {EventEmitter} emits:
 *   - 'change'        ({ sessionIds: string[] })  after a stable new/modified file
 *   - 'error'         (err)
 *   - 'snapshot'      (fileList)                  every poll (cheap)
 */
export function createWatcher(sessionsDir) {
  const ee = new EventEmitter()
  if (!existsSync(sessionsDir)) {
    queueMicrotask(() => ee.emit('error', new Error(`sessions dir missing: ${sessionsDir}`)))
    return ee
  }

  /** mtime+size → session_id; maps each seen file. */
  let seen = new Map()
  /** files we've seen but whose size is still growing. */
  const growing = new Map()

  function scanOnce() {
    let entries
    try { entries = readdirSync(sessionsDir) } catch (e) {
      ee.emit('error', e); return
    }
    const seenNow = new Map()
    const seenNewIds = new Set()
    for (const name of entries) {
      if (!name.startsWith('request_dump_') || !name.endsWith('.json')) continue
      const path = join(sessionsDir, name)
      let st
      try { st = statSync(path) } catch { continue }
      if (!st.isFile()) continue
      const key = path
      const sig = `${st.mtimeMs}|${st.size}`
      const prev = seen.get(key)
      seenNow.set(key, sig)
      if (!prev || prev !== sig) {
        const g = growing.get(key)
        if (g && g.sig === sig && (Date.now() - g.since) > STABLE_SIZE_MS) {
          // stable; treat as ready
          growing.delete(key)
          const sid = extractSessionIdFromName(name)
          if (sid) seenNewIds.add(sid)
        } else if (!g) {
          growing.set(key, { sig, since: Date.now() })
        } else {
          // sig changed since we started tracking; reset timer
          growing.set(key, { sig, since: Date.now() })
        }
      } else {
        growing.delete(key)
      }
    }
    // Files that disappeared from disk → remove from seen
    for (const k of seen.keys()) {
      if (!seenNow.has(k)) seen.delete(k)
    }
    seen = seenNow
    if (seenNewIds.size > 0) {
      ee.emit('change', { sessionIds: [...seenNewIds] })
    }
    ee.emit('snapshot', [...seen.entries()].map(([path, sig]) => ({ path, sig })))
  }

  // Initial scan, then interval
  scanOnce()
  const timer = setInterval(scanOnce, POLL_INTERVAL_MS)
  ee.on('close', () => clearInterval(timer))
  // Make it disposable
  ee.dispose = () => { clearInterval(timer); ee.removeAllListeners() }

  return ee
}

function extractSessionIdFromName(name) {
  const m = /^request_dump_([^_]+(?:_[^_]+)*?)_\d{8}_\d{6}_/.exec(name)
  return m ? m[1] : null
}