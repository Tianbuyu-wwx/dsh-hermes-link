#!/usr/bin/env node
// scripts/test-metrics-integration.mjs
//
// Integration smoke test for v0.3.2 F6: the metrics registry can be
// populated via real-world usage and the serialize() output is valid
// Prometheus text. This complements scripts/test-metrics.mjs (which tests
// the registry in isolation) by exercising the actual increment paths
// we use across services.

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const metricsPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/metrics.mjs')).href
const { createMetricsRegistry } = await import(metricsPath)
const { createMetricCollector } = await import(pathToFileURL(join(root, 'packages/dsh-hermes-link/services/metric-collector.mjs')).href)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

// --- shape contract: every metric a Prometheus scraper might bind to ---
const SHAPE = {
  counters: [
    { name: 'hermes_link_dispatch_total',                  labels: ['mode', 'status'] },
    { name: 'hermes_link_followup_total',                  labels: ['status'] },
    { name: 'hermes_link_interrupt_total',                 labels: ['status'] },
    { name: 'hermes_link_consult_total',                   labels: ['status'] },
    { name: 'hermes_link_import_total',                    labels: ['status'] },
    { name: 'hermes_link_amend_total',                     labels: ['result'] },
    { name: 'hermes_link_amend_rejected_legacy_total',     labels: [] },
    { name: 'hermes_link_outbox_flush_runs_total',         labels: [] },
    { name: 'hermes_link_outbox_dropped_queue_full_total', labels: [] },
    { name: 'hermes_link_outbox_dropped_retries_total',     labels: [] },
    { name: 'hermes_link_outbox_session_mirror_errors_total', labels: [] },
    { name: 'hermes_link_outbox_memory_suggest_total',     labels: [] },
    { name: 'hermes_link_outbox_usage_total',              labels: [] },
    { name: 'hermes_link_outbox_session_events_total',     labels: [] },
    { name: 'hermes_link_audit_appends_total',             labels: [] },
    { name: 'hermes_link_continuables_registered_total',    labels: [] },
  ],
  gauges: [
    { name: 'hermes_link_continuable_children',   labels: ['status'] },
    { name: 'hermes_link_outbox_queue_depth',      labels: [] },
    { name: 'hermes_link_outbox_items_queued',     labels: [] },
    { name: 'hermes_link_active_dispatchers',      labels: [] },
    { name: 'hermes_link_sse_clients',             labels: [] },
    { name: 'hermes_link_sse_channels',            labels: [] },
    { name: 'hermes_link_uptime_seconds',          labels: [] },
    { name: 'hermes_link_build_info',              labels: ['version'] },
  ],
}

function makeRegisteredRegistry() {
  const m = createMetricsRegistry()
  for (const { name, labels } of SHAPE.counters) m.registerCounter(name, 'help', labels)
  for (const { name, labels } of SHAPE.gauges)   m.registerGauge(name, 'help', labels)
  return m
}

// --- shape completeness ---
t('case 1: all 16 canonical counters are registerable', () => {
  const m = createMetricsRegistry()
  for (const { name, labels } of SHAPE.counters) {
    try { m.registerCounter(name, 'help', labels) } catch (e) {
      throw new Error(`failed to register ${name}: ${e.message}`)
    }
  }
  const registered = m.metrics().map((d) => d.name)
  for (const { name } of SHAPE.counters) {
    assert.ok(registered.includes(name), `${name} not registered`)
  }
})

t('case 2: all 8 canonical gauges are registerable', () => {
  const m = createMetricsRegistry()
  for (const { name, labels } of SHAPE.gauges) {
    try { m.registerGauge(name, 'help', labels) } catch (e) {
      throw new Error(`failed to register ${name}: ${e.message}`)
    }
  }
  const registered = m.metrics().map((d) => d.name)
  for (const { name } of SHAPE.gauges) {
    assert.ok(registered.includes(name), `${name} not registered`)
  }
})

// --- realistic increment patterns ---
t('case 3: simulate dispatch_task lifecycle', () => {
  const m = makeRegisteredRegistry()
  // one-shot path
  m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'started' })
  m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'ok' })
  m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'error' })
  // continuable path
  m.inc('hermes_link_dispatch_total', { mode: 'continuable', status: 'started' })
  m.inc('hermes_link_dispatch_total', { mode: 'continuable', status: 'spawned' })
  m.inc('hermes_link_dispatch_total', { mode: 'continuable', status: 'completed' })
  m.inc('hermes_link_dispatch_total', { mode: 'continuable', status: 'error' })
  const t = m.serialize()
  assert.ok(t.includes('hermes_link_dispatch_total{mode="one-shot",status="started"} 1'))
  assert.ok(t.includes('hermes_link_dispatch_total{mode="continuable",status="completed"} 1'))
})

t('case 4: simulate amend delivery outcomes', () => {
  const m = makeRegisteredRegistry()
  // 5 delivered, 2 rejected_nonce, 1 rejected_legacy, 1 failed_deliver
  for (let i = 0; i < 5; i++) m.inc('hermes_link_amend_total', { result: 'delivered' })
  for (let i = 0; i < 2; i++) m.inc('hermes_link_amend_total', { result: 'rejected_nonce' })
  m.inc('hermes_link_amend_total', { result: 'rejected_legacy' })
  m.inc('hermes_link_amend_total', { result: 'failed_deliver' })
  m.inc('hermes_link_amend_rejected_legacy_total')  // monotonic
  const t = m.serialize()
  assert.ok(t.includes('hermes_link_amend_total{result="delivered"} 5'))
  assert.ok(t.includes('hermes_link_amend_total{result="rejected_nonce"} 2'))
  assert.ok(t.includes('hermes_link_amend_total{result="rejected_legacy"} 1'))
  assert.ok(t.includes('hermes_link_amend_total{result="failed_deliver"} 1'))
  assert.ok(t.includes('hermes_link_amend_rejected_legacy_total 1'))
})

t('case 5: simulate outbox queue depth over time', () => {
  const m = makeRegisteredRegistry()
  // simulate queue going up and back down
  m.set('hermes_link_outbox_queue_depth', 0)
  assert.ok(m.serialize().includes('hermes_link_outbox_queue_depth 0'))
  m.set('hermes_link_outbox_queue_depth', 50)
  assert.ok(m.serialize().includes('hermes_link_outbox_queue_depth 50'))
  m.set('hermes_link_outbox_queue_depth', 12)
  assert.ok(m.serialize().includes('hermes_link_outbox_queue_depth 12'))
})

t('case 6: build_info gauge carries the version label', () => {
  const m = makeRegisteredRegistry()
  m.set('hermes_link_build_info', 1, { version: '0.3.2' })
  const t = m.serialize()
  assert.ok(t.includes('hermes_link_build_info{version="0.3.2"} 1'))
})

t('case 7: continuable children gauge per status', () => {
  const m = makeRegisteredRegistry()
  m.set('hermes_link_continuable_children', 3, { status: 'idle' })
  m.set('hermes_link_continuable_children', 1, { status: 'running' })
  m.set('hermes_link_continuable_children', 5, { status: 'completed' })
  m.set('hermes_link_continuable_children', 0, { status: 'error' })
  const t = m.serialize()
  assert.ok(t.includes('hermes_link_continuable_children{status="idle"} 3'))
  assert.ok(t.includes('hermes_link_continuable_children{status="running"} 1'))
  assert.ok(t.includes('hermes_link_continuable_children{status="completed"} 5'))
  assert.ok(t.includes('hermes_link_continuable_children{status="error"} 0'))
})

// --- output format conformance ---
t('case 8: text output is valid UTF-8 and ends with newline', () => {
  const m = makeRegisteredRegistry()
  m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'ok' })
  const text = m.serialize()
  assert.ok(text.endsWith('\n'), 'must end with newline')
  // no BOM
  assert.equal(text.charCodeAt(0), 0x23, 'first char must be #')
})

t('case 9: HELP and TYPE lines always appear for every metric', () => {
  const m = makeRegisteredRegistry()
  m.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'ok' })
  const t = m.serialize()
  for (const { name } of SHAPE.counters) {
    assert.ok(t.includes('# HELP ' + name), name + ' missing HELP')
    assert.ok(t.includes('# TYPE ' + name + ' counter'), name + ' missing TYPE counter')
  }
  for (const { name } of SHAPE.gauges) {
    assert.ok(t.includes('# HELP ' + name), name + ' missing HELP')
    assert.ok(t.includes('# TYPE ' + name + ' gauge'), name + ' missing TYPE gauge')
  }
})

t('case 10: serialize output has no Unicode control characters', () => {
  const m = createMetricsRegistry()
  m.registerCounter('test_total', 'h')
  m.inc('test_total', { kind: 'check' })
  const text = m.serialize()
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // ASCII printable + whitespace only (Prometheus convention)
    if (c < 0x20 && c !== 0x0a) {
      throw new Error(`unexpected control char at pos ${i}: 0x${c.toString(16)}`)
    }
  }
})

// --- v0.6.5: the collector must fill every gauge, and one bad value must not
// --- abort the cycle (that bug reported 0 for uptime/build_info/sse for months)
t('case 15: the collector fills every gauge and survives a non-finite input', () => {
  const m = makeRegisteredRegistry()
  const warnings = []
  const collector = createMetricCollector({
    metrics: m,
    outbox: { outboxStats: () => ({ queueDepth: undefined, counters: { enqueued: 3, flushed: 1, flushRuns: 2 } }) },
    continuations: { list: () => [{ status: 'started' }, { status: 'completed' }] },
    sseBroker: { stats: () => ({ total_subscribers: 2, channels: 1 }) },
    dispatcherCount: () => 3,
    version: '0.0.0-test',
    intervalMs: 60_000,
    logger: { warn: (msg) => warnings.push(msg) },
  })
  const text = m.serialize()
  const stats = collector.stats()
  collector.stop()

  // build_info carries a label only the collector supplies, which is what tells a
  // real set() apart from serialize()'s zero-value placeholder. (uptime can legitimately
  // floor to 0 in a test process that has only been alive for a moment.)
  assert.ok(text.includes('hermes_link_build_info{version="0.0.0-test"} 1'), 'build_info must be set')
  assert.match(text, /hermes_link_uptime_seconds \d+/)
  assert.ok(text.includes('hermes_link_sse_channels 1'), 'sse_channels must be set')
  assert.ok(text.includes('hermes_link_sse_clients 2'))
  assert.ok(text.includes('hermes_link_active_dispatchers 3'))
  assert.ok(text.includes('hermes_link_continuable_children{status="started"} 1'))
  assert.ok(text.includes('hermes_link_outbox_queue_depth 0'), 'a non-finite input becomes 0')
  assert.equal(stats.cycles, 1, 'the initial pass runs')
  assert.deepEqual(stats.failures, {}, 'nothing was rejected')
  assert.deepEqual(warnings, [], 'and nothing warned')

  // Externally-owned totals are counters: the collector may only increment the
  // DELTA it has not exported yet, and the total is monotonic across cycles.
  collector.collectOnce()
  const second = m.serialize()
  collector.stop()
  assert.ok(second.includes('hermes_link_outbox_flush_runs_total 2'), 'first cycle exports the whole total')
  assert.ok(!second.includes('hermes_link_outbox_flush_runs_total 4'), 'the second cycle adds nothing new')
  assert.deepEqual(collector.stats().failures, {}, 'counters are not rejected any more')
})

t('case 16: a rejected metric warns once and never stops the rest of the cycle', () => {
  const m = createMetricsRegistry()          // empty registry: every set() is rejected
  const warnings = []
  const collector = createMetricCollector({
    metrics: m,
    outbox: { outboxStats: () => ({ queueDepth: 1, counters: {} }) },
    version: 'x',
    intervalMs: 60_000,
    logger: { warn: (msg) => warnings.push(msg) },
  })
  collector.collectOnce()                    // second pass must not re-log
  const stats = collector.stats()
  collector.stop()

  const failures = Object.keys(stats.failures)
  assert.ok(failures.length > 3, 'every rejected metric is recorded: ' + failures.length)
  assert.equal(stats.cycles, 2)
  assert.equal(warnings.length, failures.length, 'one warning per metric, not one per cycle')
  assert.match(warnings[0], /is not being updated/)
})

console.log('')
console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
