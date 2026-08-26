// services/outbox.mjs
//
// DSH 鈫?Hermes file outbox inside Hermes Home (D3/D5/D6/D7 + V4), as planned
// in docs/dsh-hermes-link-PLAN.md 搂2:
//
//   Hermes Home/inbox/dsh/
//     heartbeat/{ts}.json + latest.json     (D3 heartbeat)
//     usage.jsonl                            (D6 usage records per task)
//     memory-suggest/{ts}.json               (D7 memory suggestions)
//     session-mirror/{dsh_session_id}.jsonl  (V4 DSH session mirror)
//
// All writers are best-effort and never throw. Hermes-side pickup is the
// user's responsibility (Hermes gateway or cron).
//
// v0.3.1 (E2) 鈥?write-behind queue. appendUsage / appendSessionEvent /
// writeMemorySuggestion enqueue and a periodic timer batches the writes
// (per-file appendFileSync instead of one per call). Big DSH sessions with
// 1000+ events see ~5-10x throughput improvement. startHeartbeat stays
// sync (timer-driven, low frequency). On dispose, the queue is flushed
// synchronously.

import { mkdirSync, writeFileSync, appendFileSync, existsSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_MAX_QUEUE_SIZE    = 10000
const DEFAULT_MAX_RETRIES       = 3

/** Sanitize a DSH session id into a safe filesystem name for mirror JSONL. */
export function safeSessionId(sessionId) {
  let safeId = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
  if (safeId.length > 200) {
    const head = safeId.slice(0, 184)
    const tail = createHash('sha1').update(safeId).digest('hex').slice(0, 12)
    safeId = `${head}_${tail}`
  }
  return safeId
}

/** Optional metrics sink (set externally). */
function _metricsSink() { /* replaced by setMetricsSink */ }
let metricsSink = null
export function setMetricsSink(m) { metricsSink = m }

/** Create the outbox service rooted at Hermes Home. */
export function createOutbox({
  hermesHome,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxQueueSize    = DEFAULT_MAX_QUEUE_SIZE,
  maxRetries      = DEFAULT_MAX_RETRIES,
} = {}) {
  const root = join(hermesHome, 'inbox', 'dsh')
  const heartbeatDir  = join(root, 'heartbeat')
  const usagePath     = join(root, 'usage.jsonl')
  const suggestDir    = join(root, 'memory-suggest')
  const mirrorDir     = join(root, 'session-mirror')
  ensureDir(root); ensureDir(heartbeatDir); ensureDir(suggestDir); ensureDir(mirrorDir)

  let heartbeatTimer = null
  let heartbeatSeq = 0

  // ---------- write-behind queue ----------
  /** Map<bucketKey, { kind, path, items: Array<{ payload, retries }> }> */
  const queue = new Map()
  let timer = null
  let flushing = false
  let disposed = false
  const counters = {
    enqueued: 0,
    flushed: 0,
    droppedQueueFull: 0,
    droppedRetriesExhausted: 0,
    flushRuns: 0,
    lastFlushAt: null,
    lastFlushDurationMs: 0,
  }

  function scheduleFlush() {
    if (disposed) return
    if (timer || flushing) return
    timer = setTimeout(flush, flushIntervalMs)
    timer.unref?.()
  }

  function enqueue(kind, path, payload) {
    if (disposed) {
      // after dispose: best-effort sync write
      trySyncWrite(kind, path, payload)
      return
    }
    if (queue.size >= maxQueueSize) {
      counters.droppedQueueFull++
      console.warn('[dsh-hermes-link] outbox queue full; dropping entry (kind=' + kind + ')')
      return
    }
    const key = kind + ':' + path
    let bucket = queue.get(key)
    if (!bucket) {
      bucket = { kind, path, items: [] }
      queue.set(key, bucket)
    }
    bucket.items.push({ payload, retries: 0 })
    counters.enqueued++
    scheduleFlush()
  }

  async function flush() {
    if (flushing || disposed) return
    flushing = true
    timer = null
    const t0 = Date.now()
    const snapshot = []
    for (const [k, b] of queue) { snapshot.push(b); queue.delete(k) }
    counters.flushRuns++
    let flushedThisRun = 0
    let droppedThisRun = 0
    try {
      for (const bucket of snapshot) {
        try {
          if (bucket.kind === 'usage') {
            // single appendFileSync with concatenated lines
            const content = bucket.items.map((it) => it.payload).join('')
            appendFileSync(bucket.path, content, 'utf8')
            flushedThisRun += bucket.items.length
          } else if (bucket.kind === 'mirror') {
            // mirror items are { ts, event } objects
            const content = bucket.items.map((it) => JSON.stringify(it.payload) + '\n').join('')
            appendFileSync(bucket.path, content, 'utf8')
            flushedThisRun += bucket.items.length
          } else if (bucket.kind === 'suggestion') {
            // one file per item (each gets its own ts.json)
            for (const it of bucket.items) {
              atomicWriteJson(join(suggestDir, `${it.payload.ts}.json`), it.payload)
              flushedThisRun++
            }
          }
        } catch (e) {
          // retry: re-enqueue items up to maxRetries, then drop
          const retriable = []
          for (const it of bucket.items) {
            if (it.retries < maxRetries) {
              it.retries++
              retriable.push(it)
            } else {
              counters.droppedRetriesExhausted++
              droppedThisRun++
            }
          }
          if (retriable.length > 0 && !disposed) {
            const key = bucket.kind + ':' + bucket.path
            const existing = queue.get(key)
            if (existing) {
              existing.items.unshift(...retriable)
            } else {
              queue.set(key, { kind: bucket.kind, path: bucket.path, items: retriable })
            }
          }
          console.warn('[dsh-hermes-link] outbox flush failed for', bucket.kind, bucket.path, e && e.message || e)
        }
      }
    } finally {
      counters.flushed += flushedThisRun
      counters.lastFlushAt = Date.now()
      counters.lastFlushDurationMs = counters.lastFlushAt - t0
      flushing = false
      if (queue.size > 0) scheduleFlush()
    }
  }

  /** Synchronous fallback writer (used after dispose). */
  function trySyncWrite(kind, path, payload) {
    try {
      if (kind === 'usage' || kind === 'mirror') {
        const line = typeof payload === 'string' ? payload : JSON.stringify(payload) + '\n'
        appendFileSync(path, line, 'utf8')
      } else if (kind === 'suggestion') {
        atomicWriteJson(join(suggestDir, `${payload.ts}.json`), payload)
      }
    } catch (e) {
      // swallow - best-effort
    }
  }

  /** Public flush (synchronous) - for tests / dispose. */
  function flushNow() {
    if (timer) { clearTimeout(timer); timer = null }
    if (queue.size === 0) return 0
    const snapshot = []
    for (const [k, b] of queue) { snapshot.push(b); queue.delete(k) }
    let n = 0
    for (const bucket of snapshot) {
      try {
        if (bucket.kind === 'usage') {
          appendFileSync(bucket.path, bucket.items.map((it) => it.payload).join(''), 'utf8')
          n += bucket.items.length
        } else if (bucket.kind === 'mirror') {
          appendFileSync(bucket.path, bucket.items.map((it) => JSON.stringify(it.payload) + '\n').join(''), 'utf8')
          n += bucket.items.length
        } else if (bucket.kind === 'suggestion') {
          for (const it of bucket.items) {
            atomicWriteJson(join(suggestDir, `${it.payload.ts}.json`), it.payload)
            n++
          }
        }
      } catch (_e) {
        counters.droppedRetriesExhausted += bucket.items.length
      }
    }
    counters.flushed += n
    counters.flushRuns++
    counters.lastFlushAt = Date.now()
    return n
  }

  // ---------- public methods ----------

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
        version: meta.version || 'dsh-hermes-link/0.2',
        pid: process.pid,
        uptime_ms: process.uptime() * 1000,
      }
      // E2: enrich heartbeat with outbox queue depth + last_dispatch_latency_ms
      const extras = {}
      extras.outbox_queue_depth = queue.size
      extras.outbox_flush_runs = counters.flushRuns
      extras.last_dispatch_latency_ms = meta.last_dispatch_latency_ms || null
      extras.dsh_version = meta.dsh_version || null
      Object.assign(payload, extras)
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

  /** D6: append one usage record (per dispatched task / consult). Write-behind. */
  function appendUsage(rec) {
    try {
      const line = JSON.stringify({
        ts: Date.now(),
        iso: new Date().toISOString(),
        source: 'dsh',
        kind: 'usage',
        ...rec,
      }) + '\n'
      enqueue('usage', usagePath, line)
      if (metricsSink) try { metricsSink.inc('hermes_link_outbox_usage_total') } catch (_e) {}
      return true
    } catch (e) {
      console.error('[dsh-hermes-link] usage append failed:', e && e.message || e)
      return false
    }
  }

  let suggestionCounter = 0
  /** D7: write one memory suggestion for Hermes to consider. Write-behind. */
  function writeMemorySuggestion(suggestion) {
    try {
      const ts = Date.now() * 1000 + (++suggestionCounter % 1000)  // ms + counter for sub-ms uniqueness
      const payload = {
        ts,
        iso: new Date(ts).toISOString(),
        source: 'dsh',
        kind: 'memory-suggest',
        ...suggestion,
      }
      enqueue('suggestion', suggestDir, payload)
      if (metricsSink) try { metricsSink.inc('hermes_link_outbox_memory_suggest_total') } catch (_e) {}
      return { ok: true, ts }
    } catch (e) {
      console.error('[dsh-hermes-link] memory-suggest enqueue failed:', e && e.message || e)
      return { ok: false, error: String(e && e.message || e) }
    }
  }

  /** V4: append one DSH session event to the Hermes-visible mirror (JSONL). Write-behind. */
  function appendSessionEvent(sessionId, event) {
    try {
      const safeId = safeSessionId(sessionId)
      const path = join(mirrorDir, `${safeId}.jsonl`)
      const payload = { ts: Date.now(), event }
      enqueue('mirror', path, payload)
      if (metricsSink) try { metricsSink.inc('hermes_link_outbox_session_events_total') } catch (_e) {}
      return true
    } catch (e) {
      if (metricsSink) try { metricsSink.inc('hermes_link_outbox_session_mirror_errors_total') } catch (_e) {}
      // log once per direction - mirror is best-effort
      if (!mirrorErrors.has(String(sessionId))) {
        mirrorErrors.add(String(sessionId))
        console.error('[dsh-hermes-link] session-mirror enqueue failed for', sessionId, ':', e && e.message || e)
      }
      return false
    }
  }

  /** Resolve the mirror JSONL path for a session id (without writing). */
  function mirrorPath(sessionId) {
    return join(mirrorDir, `${safeSessionId(sessionId)}.jsonl`)
  }
  const mirrorErrors = new Set()

  /** Stop the timer + flush the queue synchronously. */
  function stop() {
    disposed = true
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    if (timer) { clearTimeout(timer); timer = null }
    flushNow()
  }

  /** Inspect the queue state (for tests + heartbeats). */
  function outboxStats() {
    return {
      queueDepth: queue.size,
      counters: { ...counters },
      config: { flushIntervalMs, maxQueueSize, maxRetries },
    }
  }

  return {
    root, heartbeatDir, usagePath, suggestDir, mirrorDir,
    startHeartbeat, appendUsage, writeMemorySuggestion, appendSessionEvent,
    mirrorPath, safeSessionId,
    stop, outboxStats, flushNow,
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
    console.error('[dsh-hermes-link] outbox write failed:', path, e && e.message || e)
  }
}
