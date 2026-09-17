// services/metric-collector.mjs
//
// v0.3.2 F6, extracted from index.mjs and hardened in v0.6.5.
//
// WHY IT MOVED OUT OF index.mjs
//   The inline version wrapped the WHOLE cycle in
//   `try { ... } catch (_e) { /* swallow */ }`. One bad value at the top therefore
//   killed everything below it, silently, on every tick -- and that is exactly what
//   happened: the collector called metrics.set() on
//   `hermes_link_continuables_registered_total`, which is registered as a COUNTER
//   (set() on a counter throws by contract), so `sse_clients`, `sse_channels`,
//   `active_dispatchers`, `uptime_seconds` and `build_info` were never populated.
//   Every scrape reported 0 for all of them, and nothing anywhere said why.
//
//   Now each value goes through safeSet(): non-finite becomes 0, a rejection is
//   recorded per metric name and logged once, and a broken input can no longer abort
//   the rest of the cycle. `stats().failures` is what the doctor would show.
//
// The counter `hermes_link_continuables_registered_total` is NOT set here any more:
// it is a counter, incremented where continuables actually register (index.mjs).

/**
 * @param {object} deps
 * @param {object} deps.metrics         registry from services/metrics.mjs
 * @param {object} [deps.outbox]
 * @param {object} [deps.continuations]
 * @param {object} [deps.sseBroker]
 * @param {Function} [deps.dispatcherCount]
 * @param {string} [deps.version]
 * @param {number} [deps.intervalMs]
 * @param {object} [deps.logger]        console by default; tests pass a sink
 * @returns {{collectOnce: Function, stop: Function, stats: Function}}
 */
export function createMetricCollector({ metrics, outbox, continuations, sseBroker, dispatcherCount, version = 'unknown', intervalMs = 5000, logger = console } = {}) {
  const failures = new Map()
  let cycles = 0

  function recordFailure(name, e) {
    const message = String((e && e.message) || e)
    if (failures.has(name)) return
    failures.set(name, message)
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[dsh-hermes-link] metric collector: ' + name + ' is not being updated: ' + message)
    }
  }

  /** Write one gauge; a bad value is reported once and never aborts the cycle. */
  function safeSet(name, value, labels) {
    try {
      metrics.set(name, Number.isFinite(value) ? value : 0, labels)
    } catch (e) {
      recordFailure(name, e)
    }
  }

  /**
   * Export an externally-owned cumulative total that is registered as a COUNTER.
   *
   * The outbox counts its own flushes/drops, so the collector can only ever
   * increment what GREW since the last cycle -- set() on a counter is a contract
   * violation, and doing exactly that silently aborted every collect cycle since
   * v0.3.2 (uptime/build_info/sse gauges never got written). A total that goes
   * backwards is treated as a fresh start.
   */
  const lastTotals = new Map()
  function bumpTotal(name, total, labels) {
    const value = Number.isFinite(total) ? total : 0
    const previous = lastTotals.get(name) || 0
    lastTotals.set(name, value)
    const delta = value >= previous ? value - previous : value
    if (delta <= 0) return
    try {
      metrics.inc(name, labels, delta)
    } catch (e) {
      recordFailure(name, e)
    }
  }

  function childrenByStatus() {
    const map = {}
    if (!continuations || typeof continuations.list !== 'function') return map
    try {
      for (const row of continuations.list({ limit: 500 })) {
        const status = (row && row.status) || 'unknown'
        map[status] = (map[status] || 0) + 1
      }
    } catch (e) {
      safeSet('hermes_link_continuable_children', 0, { status: 'unknown' })
    }
    return map
  }

  function collectOnce() {
    cycles++
    if (outbox && typeof outbox.outboxStats === 'function') {
      let os = null
      try { os = outbox.outboxStats() } catch (_e) { os = null }
      if (os) {
        safeSet('hermes_link_outbox_queue_depth', os.queueDepth)
        const counters = os.counters || {}
        safeSet('hermes_link_outbox_items_queued', (counters.enqueued || 0) - (counters.flushed || 0))
        // counters, not gauges (see bumpTotal)
        bumpTotal('hermes_link_outbox_flush_runs_total', counters.flushRuns || 0)
        bumpTotal('hermes_link_outbox_dropped_queue_full_total', counters.droppedQueueFull || 0)
        bumpTotal('hermes_link_outbox_dropped_retries_total', counters.droppedRetriesExhausted || 0)
      }
    }
    const children = childrenByStatus()
    const allStatuses = new Set([...Object.keys(children), 'started', 'idle', 'completed', 'error', 'interrupted', 'orphan', 'timeout'])
    for (const status of allStatuses) safeSet('hermes_link_continuable_children', children[status] || 0, { status })
    if (sseBroker && typeof sseBroker.stats === 'function') {
      let ss = null
      try { ss = sseBroker.stats() } catch (_e) { ss = null }
      if (ss) {
        safeSet('hermes_link_sse_clients', ss.total_subscribers || 0)
        safeSet('hermes_link_sse_channels', ss.channels || 0)
      }
    }
    safeSet('hermes_link_active_dispatchers', typeof dispatcherCount === 'function' ? dispatcherCount() : 0)
    safeSet('hermes_link_uptime_seconds', Math.floor(process.uptime()))
    safeSet('hermes_link_build_info', 1, { version })
    return cycles
  }

  const timer = setInterval(collectOnce, intervalMs)
  timer.unref?.()
  collectOnce()

  return {
    collectOnce,
    stop() { clearInterval(timer) },
    stats: () => ({ cycles, failures: Object.fromEntries(failures) }),
  }
}
