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

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
