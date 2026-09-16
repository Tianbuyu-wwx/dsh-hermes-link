// scripts/test-telemetry-resilience.mjs
//
// v0.6.0 (D1) regression guard - telemetry must never break the request path.
//
// Why this test exists: services/metrics.mjs deliberately THROWS on inc()/set()
// of an unregistered metric (asserted by scripts/test-metrics.mjs). The HTTP
// handlers used to call deps.metrics.inc() directly, so ANY metrics-shape
// mismatch - a counter registered in index.mjs but forgotten in a test harness
// or a future embedder - turned a valid JSON-RPC request into E_INTERNAL /
// HTTP 500. That exact failure produced 7 red e2e cases before v0.6.0 shipped.
//
// These cases drive the REAL handleRpc with a metrics registry that throws on
// every single call, and assert the RPC result is unaffected.

import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// fileURLToPath (not URL.pathname) - pathname percent-encodes non-ASCII path
// segments, which breaks on this repo's CJK directory name.
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages', 'dsh-hermes-link')
const utilUrl = pathToFileURL(join(pkg, 'http', '_util.mjs')).href
const rpcUrl = pathToFileURL(join(pkg, 'http', 'jsonrpc-handlers.mjs')).href

const { incMetric, setMetric } = await import(utilUrl)
const { handleRpc } = await import(rpcUrl)

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log('  ok ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); fail++ }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('  ok ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); fail++ }
}

// A registry that reproduces the dangerous contract in the strongest form:
// EVERY inc/set throws, exactly like an unregistered-metric inc does.
const throwingMetrics = {
  inc() { throw new Error('[metrics] inc on unregistered metric: <any>') },
  set() { throw new Error('[metrics] set on unregistered metric: <any>') },
}
const throwingDeps = { metrics: throwingMetrics }

check('case 1: incMetric swallows a throwing metrics registry', () => {
  incMetric(throwingDeps, 'anything_total', { a: 'b' })
})
check('case 2: setMetric swallows a throwing metrics registry', () => {
  setMetric(throwingDeps, 'anything_gauge', 1, { a: 'b' })
})
check('case 3: incMetric tolerates missing / malformed deps', () => {
  incMetric(undefined, 'x')
  incMetric({}, 'x')
  incMetric({ metrics: null }, 'x')
  incMetric({ metrics: {} }, 'x')            // inc is not a function
})
check('case 4: setMetric tolerates missing / malformed deps', () => {
  setMetric(undefined, 'x', 1)
  setMetric({ metrics: {} }, 'x', 1)
})

// Minimal ctx/deps: dispatch_status is a read-only path that reads the audit log
// and the continuable registry, so nothing real gets spawned.
const ctx = {}
function depsWith(metrics) {
  return {
    metrics,
    continuations: { list: () => [], count: () => 0 },
    hermesHome: join(root, 'scripts'),
    bearerKey: '',
  }
}
const rpc = (method, params, deps) => handleRpc(ctx, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, deps)

await checkAsync('case 5: tools/call dispatch_status survives a throwing metrics registry', async () => {
  const out = await rpc('tools/call', { name: 'dispatch_status', arguments: {} }, depsWith(throwingMetrics))
  assert.ok(out, 'expected a response')
  assert.equal(out.error, undefined, 'must not error: ' + JSON.stringify(out.error))
  assert.ok(out.result, 'expected a result')
})

await checkAsync('case 6: unknown tool yields E_UNKNOWN_TOOL, NOT E_INTERNAL (B1 regression signature)', async () => {
  const out = await rpc('tools/call', { name: 'no_such_tool_xyz', arguments: {} }, depsWith(throwingMetrics))
  assert.ok(out && out.error, 'expected a JSON-RPC error object')
  // The machine-readable code lives in data.error_code; the B1 failure mode was
  // this degrading to E_INTERNAL because a metrics inc threw first.
  assert.equal(out.error.data && out.error.data.error_code, 'E_UNKNOWN_TOOL',
    'expected E_UNKNOWN_TOOL, got: ' + JSON.stringify(out.error))
  assert.equal(out.error.code, -32601)
})

await checkAsync('case 6b: error messages do not repeat the registry message (dedup regression)', async () => {
  const cases = [
    ['tools/call', { name: 'no_such_tool_xyz', arguments: {} }, 'unknown tool'],
    ['no_such_method_xyz', { name: 'x', arguments: {} }, 'unknown method'],
    ['tools/call', { name: 'dispatch_tail', arguments: {} }, 'invalid spec'],
  ]
  for (const [method, params, label] of cases) {
    const out = await rpc(method, params, depsWith(throwingMetrics))
    const msg = String(out.error && out.error.message || '')
    assert.ok(msg.startsWith(label + ': '), 'expected "' + label + ': ...", got: "' + msg + '"')
    const rest = msg.slice(label.length + 2)
    assert.ok(!rest.startsWith(label), 'message repeats its own prefix: "' + msg + '"')
    assert.ok(rest.length > 0, 'message lost its detail: "' + msg + '"')
  }
})

await checkAsync('case 7: tools/call dispatch_list survives a throwing metrics registry', async () => {
  const out = await rpc('tools/call', { name: 'dispatch_list', arguments: {} }, depsWith(throwingMetrics))
  assert.ok(out, 'expected a response')
  assert.equal(out.error, undefined, 'must not error: ' + JSON.stringify(out.error))
})

await checkAsync('case 8: initialize works with a throwing metrics registry', async () => {
  const out = await rpc('initialize', null, depsWith(throwingMetrics))
  assert.ok(out && out.result, 'expected initialize result')
  assert.equal(out.result.serverInfo.name, 'dsh-hermes-link')
})

await checkAsync('case 9: a WORKING registry still receives the counters (guard is not a no-op)', async () => {
  const seen = []
  const recording = { inc: (n, l) => seen.push([n, l]), set: () => {} }
  await rpc('tools/call', { name: 'dispatch_status', arguments: {} }, depsWith(recording))
  assert.ok(seen.some(([n]) => n === 'hermes_link_dispatch_total'),
    'expected hermes_link_dispatch_total to be recorded, saw: ' + JSON.stringify(seen))
  assert.ok(seen.some(([n]) => n === 'hermes_link_rate_limit_skipped_total'),
    'expected the unauthenticated-bypass counter to be recorded, saw: ' + JSON.stringify(seen))
})

console.log('')
console.log('Total: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
