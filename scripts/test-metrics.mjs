#!/usr/bin/env node
// scripts/test-metrics.mjs
//
// Unit tests for services/metrics.mjs (v0.3.2 F6).

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/metrics.mjs')).href
const { createMetricsRegistry } = await import(modPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

// --- registration ---
t('case 1: registerCounter + inc + serialize works', () => {
  const m = createMetricsRegistry()
  m.registerCounter('foo_total', 'help text')
  m.inc('foo_total')
  m.inc('foo_total')
  m.inc('foo_total')
  const text = m.serialize()
  assert.ok(text.includes('# HELP foo_total help text'))
  assert.ok(text.includes('# TYPE foo_total counter'))
  assert.ok(text.includes('foo_total 3'))
})

t('case 2: registerGauge + set', () => {
  const m = createMetricsRegistry()
  m.registerGauge('bar_size', 'help')
  m.set('bar_size', 42)
  assert.ok(m.serialize().includes('bar_size 42'))
})

t('case 3: gauge can go up or down (counters cannot)', () => {
  const m = createMetricsRegistry()
  m.registerGauge('g', '')
  m.set('g', 100)
  m.set('g', 50)
  m.set('g', 200)
  assert.equal(m.get('g'), 200)
})

t('case 4: counter rejects set (must use inc)', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '')
  assert.throws(() => m.set('c', 5), /non-gauge/)
})

t('case 5: gauge rejects inc (must use set)', () => {
  const m = createMetricsRegistry()
  m.registerGauge('g', '')
  assert.throws(() => m.inc('g'), /non-counter/)
})

t('case 6: inc on unregistered metric throws', () => {
  const m = createMetricsRegistry()
  assert.throws(() => m.inc('nope'), /unregistered metric/)
})

t('case 7: set rejects non-finite values', () => {
  const m = createMetricsRegistry()
  m.registerGauge('g', '')
  assert.throws(() => m.set('g', NaN), /finite/)
  assert.throws(() => m.set('g', Infinity), /finite/)
})

t('case 8: invalid metric name rejected', () => {
  const m = createMetricsRegistry()
  assert.throws(() => m.registerCounter('1invalid', ''), /invalid metric name/)
  assert.throws(() => m.registerCounter('has-dash', ''), /invalid metric name/)
})

t('case 9: duplicate registration throws', () => {
  const m = createMetricsRegistry()
  m.registerCounter('x', '')
  assert.throws(() => m.registerCounter('x', ''), /duplicate/)
})

// --- labels ---
t('case 10: labels are tracked independently per series', () => {
  const m = createMetricsRegistry()
  m.registerCounter('events_total', '', ['mode', 'status'])
  m.inc('events_total', { mode: 'one-shot', status: 'ok' })
  m.inc('events_total', { mode: 'one-shot', status: 'ok' })
  m.inc('events_total', { mode: 'continuable', status: 'started' })
  const t = m.serialize()
  assert.ok(t.includes('events_total{mode="one-shot",status="ok"} 2'))
  assert.ok(t.includes('events_total{mode="continuable",status="started"} 1'))
})

t('case 11: get returns 0 for unknown label combo', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '', ['kind'])
  m.inc('c', { kind: 'a' })
  assert.equal(m.get('c', { kind: 'a' }), 1)
  assert.equal(m.get('c', { kind: 'b' }), 0)
  assert.equal(m.get('c', {}), 0)
})

t('case 12: label values are escaped (quotes, backslash, newline)', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '', ['k'])
  m.inc('c', { k: 'has "quote"' })
  m.inc('c', { k: 'has\\backslash' })
  m.inc('c', { k: 'has\nnewline' })
  const t = m.serialize()
  assert.ok(t.includes('k="has \\"quote\\""'))
  assert.ok(t.includes('k="has\\\\backslash"'))
  assert.ok(t.includes('k="has\\nnewline"'))
})

t('case 13: missing labels are emitted as empty string', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '', ['x', 'y'])
  m.inc('c', { x: 'a' })  // y missing
  const t = m.serialize()
  assert.ok(t.includes('c{x="a",y=""} 1'))
})

// --- Prometheus text format ---
t('case 14: serialize output is valid Prometheus text v0.0.4', () => {
  const m = createMetricsRegistry()
  m.registerCounter('a_total', 'help a')
  m.registerCounter('b_total', 'help b', ['kind'])
  m.registerGauge('c_gauge', 'help c')
  m.inc('a_total')
  m.inc('b_total', { kind: 'x' }, 5)
  m.set('c_gauge', 99)
  const text = m.serialize()
  // standard format: # HELP, # TYPE, then samples
  assert.ok(text.startsWith('# HELP'))
  assert.ok(text.endsWith('\n'))
  assert.ok(text.includes('# TYPE a_total counter'))
  assert.ok(text.includes('# TYPE b_total counter'))
  assert.ok(text.includes('# TYPE c_gauge gauge'))
  assert.ok(text.includes('a_total 1'))
  assert.ok(text.includes('b_total{kind="x"} 5'))
  assert.ok(text.includes('c_gauge 99'))
})

t('case 15: gauges are emitted even with no samples', () => {
  const m = createMetricsRegistry()
  m.registerGauge('g_empty', 'help')
  const t = m.serialize()
  assert.ok(t.includes('g_empty 0'), 'gauge with no samples defaults to 0')
})

t('case 16: metrics() returns metadata summary', () => {
  const m = createMetricsRegistry()
  m.registerCounter('a_total', 'h1')
  m.registerCounter('b_total', 'h2', ['mode'])
  m.inc('a_total')
  m.inc('b_total', { mode: 'one-shot' })
  const summary = m.metrics()
  assert.equal(summary.length, 2)
  const a = summary.find((s) => s.name === 'a_total')
  assert.equal(a.type, 'counter')
  assert.equal(a.sampleCount, 1)
  const b = summary.find((s) => s.name === 'b_total')
  assert.deepEqual(b.labelNames, ['mode'])
  assert.equal(b.sampleCount, 1)
})

// --- integration-like ---
t('case 17: empty registry produces empty output', () => {
  const m = createMetricsRegistry()
  assert.equal(m.serialize(), '')
})

t('case 18: many distinct label combinations dont lose data', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '', ['kind'])
  for (let i = 0; i < 100; i++) m.inc('c', { kind: 'k' + i })
  const summary = m.metrics().find((s) => s.name === 'c')
  assert.equal(summary.sampleCount, 100)
  // each kind should have count 1
  for (let i = 0; i < 100; i++) {
    assert.equal(m.get('c', { kind: 'k' + i }), 1)
  }
})

t('case 19: counter increment with custom value', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '')
  m.inc('c', {}, 10)
  m.inc('c', {}, 5)
  assert.equal(m.get('c'), 15)
})

t('case 20: empty-string label value is allowed', () => {
  const m = createMetricsRegistry()
  m.registerCounter('c', '', ['k'])
  m.inc('c', { k: '' })
  const t = m.serialize()
  assert.ok(t.includes('c{k=""} 1'))
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
