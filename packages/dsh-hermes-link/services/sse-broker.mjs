// services/sse-broker.mjs
//
// v0.3.0 (F1) - Server-Sent Events broker for continuable-dispatch
// observability. Per-task pub-sub with bounded ring buffer (default 1000
// events/channel). Late subscribers can request since_seq=N to replay; if
// N is older than the oldest cached seq, an overflow event is emitted first.
//
// Wire: plain node:http response, text/event-stream. Bearer auth is the
// caller's responsibility (route layer); the broker is transport-agnostic.

const DEFAULT_RING_SIZE   = 1000
const DEFAULT_HEARTBEAT_MS = 15000
const TERMINAL_HOLD_MS    = 5000   // keep channel 5s after terminal status, then GC

/**
 * Create an SSE broker.
 *
 * @param {object} [opts]
 * @param {number} [opts.ringSize=1000]      max events retained per channel
 * @param {number} [opts.heartbeatMs=15000]  heartbeat interval
 * @returns {{
 *   attachTask:    (taskId: string, meta?: object) => void,
 *   detachTask:    (taskId: string, reason?: string) => void,
 *   publish:       (taskId: string, partial: {kind?: string, data?: object}) => boolean,
 *   subscribe:     (taskId: string, res: any, opts?: {sinceSeq?: number, timeoutMs?: number}) => object|null,
 *   stats:         () => {channels: number, total_subscribers: number, published: number, overflows: number, droppedSlowClients: number},
 *   isAttached:    (taskId: string) => boolean,
 *   close:         () => void,
 * }}
 */
export function createSseBroker({
  ringSize    = DEFAULT_RING_SIZE,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  /** task_id -> ChannelState */
  const channels = new Map()
  const counters = { published: 0, overflows: 0, droppedSlowClients: 0 }

  function attachTask(taskId, meta) {
    if (!taskId) return
    if (channels.has(taskId)) {
      const ch = channels.get(taskId)
      ch.terminalAt = null
      if (meta) ch.meta = Object.assign({}, ch.meta, meta)
      return
    }
    channels.set(taskId, {
      meta: Object.assign({ attached_at: Date.now() }, meta || {}),
      ring: [],
      subscribers: new Set(),
      terminalAt: null,
    })
  }

  function detachTask(taskId, reason) {
    const ch = channels.get(taskId)
    if (!ch) return
    ch.terminalAt = Date.now()
    publish(taskId, { kind: 'lifecycle', data: { status: 'closed', reason: reason || 'unspecified' } })
    // schedule GC after TERMINAL_HOLD_MS if no new subscribers arrive
    setTimeout(() => {
      const cur = channels.get(taskId)
      if (cur && cur.terminalAt && Date.now() - cur.terminalAt >= TERMINAL_HOLD_MS && cur.subscribers.size === 0) {
        channels.delete(taskId)
      }
    }, TERMINAL_HOLD_MS)
  }

  function publish(taskId, partial) {
    const ch = channels.get(taskId)
    if (!ch) return false
    const seq = ch.ring.length === 0 ? 0 : ch.ring[ch.ring.length - 1].seq + 1
    const event = {
      kind: (partial && partial.kind) || 'custom',
      ts: Date.now(),
      seq,
      task_id: taskId,
      data: (partial && partial.data) || {},
    }
    ch.ring.push(event)
    if (ch.ring.length > ringSize) ch.ring.shift()
    counters.published++
    for (const sub of [...ch.subscribers]) {
      try {
        if (!sub._write(event)) {
          sub.close()
          counters.droppedSlowClients++
        }
      } catch (_e) {
        sub.close()
        counters.droppedSlowClients++
      }
    }
    return true
  }

  function isAttached(taskId) {
    return channels.has(taskId)
  }

  /**
   * Subscribe to a task's events.
   * - task not found: writes a single not_found event and returns null.
   * - task found: writes SSE headers, replays buffered events (respecting
   *   sinceSeq with overflow detection), installs heartbeat + optional
   *   timeout, and returns a subscription handle with .close().
   */
  function subscribe(taskId, res, opts) {
    opts = opts || {}
    const sinceSeq  = Number.isInteger(opts.sinceSeq)  ? opts.sinceSeq  : 0
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 0

    const ch = channels.get(taskId)
    if (!ch) {
      try {
        res.writeHead(200, sseHeaders())
        res.write('event: not_found\ndata: ' + JSON.stringify({ task_id: taskId }) + '\n\n')
        res.end()
      } catch (_e) {}
      return null
    }

    res.writeHead(200, sseHeaders())

    const sub = {
      _closed: false,
      _heartbeat: null,
      _timeout: null,
      _write(event) {
        if (sub._closed) return false
        try {
          return res.write(formatFrame(event))
        } catch (_e) {
          return false
        }
      },
      close() {
        if (sub._closed) return
        sub._closed = true
        if (sub._heartbeat) { clearInterval(sub._heartbeat); sub._heartbeat = null }
        if (sub._timeout)   { clearTimeout(sub._timeout);   sub._timeout = null }
        ch.subscribers.delete(sub)
        try { res.end() } catch (_e) {}
      },
    }
    ch.subscribers.add(sub)

    // backfill: emit overflow if sinceSeq is older than oldest cached
    if (ch.ring.length > 0) {
      const oldestSeq = ch.ring[0].seq
      if (sinceSeq < oldestSeq - 1) {
        sub._write({
          kind: 'overflow',
          ts: Date.now(),
          seq: sinceSeq,
          task_id: taskId,
          data: { oldest_seq: oldestSeq, requested: sinceSeq },
        })
        counters.overflows++
      }
      for (const event of ch.ring) {
        if (event.seq > sinceSeq) sub._write(event)
      }
    } else if (sinceSeq > 0) {
      sub._write({
        kind: 'overflow',
        ts: Date.now(),
        seq: sinceSeq,
        task_id: taskId,
        data: { oldest_seq: 0, requested: sinceSeq, reason: 'ring_empty' },
      })
      counters.overflows++
    }

    // heartbeat: keep the connection alive through intermediaries
    sub._heartbeat = setInterval(() => {
      if (sub._closed) return
      try { res.write(': heartbeat\n\n') } catch (_e) { sub.close() }
    }, heartbeatMs)

    // optional auto-close
    if (timeoutMs > 0) {
      sub._timeout = setTimeout(() => sub.close(), timeoutMs)
    }

    // client disconnect
    res.on('close', () => sub.close())

    return sub
  }

  function sseHeaders() {
    return {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'x-dsh-hermes-link': 'sse-broker-v0.3.0',
    }
  }

  function formatFrame(event) {
    const lines = []
    if (event.kind) lines.push('event: ' + event.kind)
    lines.push('id: ' + event.seq)
    lines.push('data: ' + JSON.stringify(event))
    return lines.join('\n') + '\n\n'
  }

  function stats() {
    let totalSubs = 0
    for (const ch of channels.values()) totalSubs += ch.subscribers.size
    return {
      channels: channels.size,
      total_subscribers: totalSubs,
      published: counters.published,
      overflows: counters.overflows,
      droppedSlowClients: counters.droppedSlowClients,
    }
  }

  function close() {
    for (const ch of channels.values()) {
      for (const sub of [...ch.subscribers]) sub.close()
    }
    channels.clear()
  }

  return { attachTask, detachTask, publish, subscribe, stats, isAttached, close }
}
