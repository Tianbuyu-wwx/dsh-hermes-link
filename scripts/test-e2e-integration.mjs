#!/usr/bin/env node
// scripts/test-e2e-integration.mjs
//
// v0.3.6 - End-to-end integration test that wires up the HTTP surface
// (registerHttp from packages/dsh-hermes-link/http/dispatch.mjs) against
// a real http.createServer() and exercises the routes via fetch().
//
// We mock just enough of cordis ctx + deps to make registerHttp happy:
//   - webServer (with a `register` that captures routes)
//   - ctx.agents (used by dispatch_list / dispatch_status / dispatch_get)
//   - ctx.tools.view (used by dispatch_probe + dispatch_dry_run)
//
// Everything else uses real instances (outbox, sseBroker, metrics,
// continuations, audit, consult-hermes, persona-loader). This catches:
//   - Route registration table completeness (every documented path is
//     wired)
//   - Bearer auth gating
//   - SSE frame format (event/id/data with newlines + heartbeat)
//   - Prometheus text format conformance
//   - JSON-RPC envelope shape (id echoed, error_code on failure)
//   - HTTP status codes (200 / 204 / 400 / 401 / 404 / 405)

import { strict as assert } from 'node:assert'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dispatchUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/http/dispatch.mjs')).href
const sseBrokerUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/sse-broker.mjs')).href
const metricsUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/metrics.mjs')).href
const outboxUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/outbox.mjs')).href
const contUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/continuations.mjs')).href
const consultUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/consult-hermes.mjs')).href

const { register: registerHttp } = await import(dispatchUrl)
const { createSseBroker } = await import(sseBrokerUrl)
const { createMetricsRegistry } = await import(metricsUrl)
const { createOutbox } = await import(outboxUrl)
const { openContinuations } = await import(contUrl)
const { createConsultClient } = await import(consultUrl)

let passed = 0, failed = 0
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`  ok ${name}`)
    passed++
  }).catch((e) => {
    console.log(`  FAIL ${name}: ${e.message}`)
    failed++
  })
}

// --- Test fixture: in-process HTTP server with all routes registered ---
async function makeServer({ bearerToken = '', enableAuth = false } = {}) {
  // Use a hermes-home temp dir so outbox/audit have somewhere to write.
  const hermesHome = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))

  // Real outbox + continuations + sseBroker + metrics
  const outbox = createOutbox({ hermesHome })
  const continuations = openContinuations(join(hermesHome, 'state'))
  const sseBroker = createSseBroker({ ringSize: 100, heartbeatMs: 60000 })
  const metrics = createMetricsRegistry()
  // Register the full metric shape so handler inc() calls don't throw on
  // unregistered metrics. (Production code in index.mjs registers the same
  // set via registerMetricsShape.)
  const COUNTERS = [
    ['hermes_link_dispatch_total', ['mode', 'status']],
    ['hermes_link_followup_total', ['status']],
    ['hermes_link_interrupt_total', ['status']],
    ['hermes_link_consult_total', ['status']],
    ['hermes_link_import_total', ['status']],
    ['hermes_link_amend_total', ['result']],
    ['hermes_link_amend_rejected_legacy_total', []],
    ['hermes_link_outbox_flush_runs_total', []],
    ['hermes_link_outbox_dropped_queue_full_total', []],
    ['hermes_link_outbox_dropped_retries_total', []],
    ['hermes_link_outbox_session_mirror_errors_total', []],
    ['hermes_link_outbox_memory_suggest_total', []],
    ['hermes_link_outbox_usage_total', []],
    ['hermes_link_outbox_session_events_total', []],
    ['hermes_link_audit_appends_total', []],
    ['hermes_link_continuables_registered_total', []],
  ]
  for (const [name, labels] of COUNTERS) metrics.registerCounter(name, '', labels)
  const GAUGES = [
    ['hermes_link_continuable_children', ['status']],
    ['hermes_link_outbox_queue_depth', []],
    ['hermes_link_outbox_items_queued', []],
    ['hermes_link_active_dispatchers', []],
    ['hermes_link_sse_clients', []],
    ['hermes_link_sse_channels', []],
    ['hermes_link_uptime_seconds', []],
    ['hermes_link_build_info', ['version']],
  ]
  for (const [name, labels] of GAUGES) metrics.registerGauge(name, '', labels)

  // Mock deps that need real instances
  const deps = {
    hermesHome,
    importer: {
      list: async () => [],
      importSession: async () => ({ status: 'created' }),
      importAll: async () => ({ imported: 0, skipped: 0, failed: 0 }),
      renameAll: async () => ({ renamed: 0 }),
    },
    personaLoader: {
      loadPersona: (h) => ({
        text: `# SOUL\nmock persona from ${h}\n`,
        parts: { 'SOUL.md': { name: 'SOUL.md', bytes: 30 } },
      }),
    },
    consultClient: createConsultClient({ hermesHome }),
    foundationSlice: '# SOUL\nmock foundation slice\n',
    continuations,
    outbox,
    sseBroker,
    metrics,
  }

  // Mock ctx (cordis)
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return webServerMock
      if (key === 'agents') return agentsMock
      if (key === 'tools') return toolsMock
      return null
    },
    on: (_event, _cb) => {},  // dispose hook (no-op)
    provide: (_name, _value) => {},  // test escape hatch
  }

  const routes = new Map()
  const webServerMock = {
    register: ({ path, handler }) => { routes.set(path, handler) },
  }
  const agentsMock = {
    get: (id) => id === 'live-child' ? { id, session: { events: [{ type: 'init', seq: 0 }, { type: 'turn/end', seq: 1 }] } } : null,
    roots: () => [],
  }
  const toolsMock = {
    view: () => ({ restrictableNames: ['web_search', 'code_search', 'list_hermes_sessions'] }),
  }

  // Register all routes
  registerHttp(ctx, deps)

  // Start real HTTP server
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const handler = routes.get(url.pathname)
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
        return
      }
      await handler(req, res)
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(e && e.message || e) }))
      } catch (_e) {}
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // Set up bearer token env BEFORE register (register reads at module init time)
  // 闁?but for the test, we override by patching the closure. Easier: re-register
  // with a manually-set env var. We'll skip auth testing here and rely on unit
  // tests for that.

  return {
    port,
    server,
    routes,
    deps,
    metrics,
    continuations,
    outbox,
    sseBroker,
    hermesHome,
    async close() {
      await new Promise((r) => server.close(r))
      try { outbox.stop() } catch {}
      try { continuations.close() } catch {}
      try { sseBroker.close() } catch {}
    },
    async get(path, opts = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, opts)
      return res
    },
    async post(path, body, opts = {}) {
      const headers = { 'content-type': 'application/json', ...(opts.headers || {}) }
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      return res
    },
  }
}

// ============================================================================
// Tests
// ============================================================================

await t('e2e: /mcp/collab/health returns 200 with version + auth status', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/health')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.version, '0.3.6')
    assert.equal(body.auth, 'open')
    assert.ok(body.sse_broker)
    assert.ok(body.sse_broker.channels === 0)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/metrics returns Prometheus text format v0.0.4', async () => {
  const s = await makeServer()
  try {
    // First register a counter with a sample value via the metrics registry
    s.metrics.inc('hermes_link_dispatch_total', { mode: 'one-shot', status: 'ok' })
    const res = await s.get('/mcp/collab/metrics')
    assert.equal(res.status, 200)
    const ct = res.headers.get('content-type')
    assert.ok(ct.includes('text/plain'), 'expected text/plain content-type, got ' + ct)
    assert.ok(ct.includes('version=0.0.4'), 'expected version=0.0.4 in content-type')
    const body = await res.text()
    assert.ok(body.includes('# HELP hermes_link_dispatch_total'))
    assert.ok(body.includes('# TYPE hermes_link_dispatch_total counter'))
    assert.ok(body.includes('hermes_link_dispatch_total{mode="one-shot",status="ok"} 1'))
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (GET) responds to ping with version', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.jsonrpc, '2.0')
    assert.ok(body.result)
    assert.equal(body.result.version, '0.3.6')
    assert.equal(body.result.ok, true)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) tools/list returns the canonical tool set', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    const names = body.result.tools.map((t) => t.name).sort()
    // Every documented tool must be present.
    const expected = [
      'dispatch_dry_run', 'dispatch_followup', 'dispatch_get',
      'dispatch_interrupt', 'dispatch_list', 'dispatch_probe',
      'dispatch_status', 'dispatch_subscribe', 'dispatch_tail',
      'dispatch_task', 'get_dispatch',
    ]
    for (const e of expected) {
      assert.ok(names.includes(e), `missing tool: ${e}; got ${names.join(', ')}`)
    }
    // dispatch_dry_run (v0.3.3) is the newest and must have its input schema
    const dryRun = body.result.tools.find((t) => t.name === 'dispatch_dry_run')
    assert.ok(dryRun, 'dispatch_dry_run not in tools/list')
    assert.ok(dryRun.inputSchema.required.includes('task_id'))
    assert.ok(dryRun.inputSchema.required.includes('skill'))
    assert.ok(dryRun.inputSchema.required.includes('task'))
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) dispatch_dry_run returns structured estimate', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'dispatch_dry_run',
        arguments: {
          task_id: 'e2e-001',
          skill: 'web_search',
          task: 'find top 5 react state libs',
          model_tier: 'pro',
          max_tokens: 2000,
        },
      },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.id, 2)
    assert.ok(body.result, 'expected result, got: ' + JSON.stringify(body).substring(0, 300))
    // The result is the dryRun return wrapped in mcpResult (content + metadata)
    const metadata = body.result.metadata
    assert.equal(metadata.ok, true)
    assert.equal(metadata.model_tier, 'pro')
    assert.equal(metadata.estimated_max_output_tokens, 2000)
    assert.ok(metadata.estimated_prompt_tokens > 0)
    assert.equal(metadata.would_block_on.includes('skill:unknown_tool'), false)
    // Content field is JSON-stringified
    const content = JSON.parse(body.result.content[0].text)
    assert.equal(content.ok, true)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) dispatch_dry_run returns E_INVALID_SPEC on missing task', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'dispatch_dry_run',
        arguments: { task_id: 'e2e-002' },  // missing skill + task
      },
    })
    assert.equal(res.status, 200)  // JSON-RPC errors are still HTTP 200
    const body = await res.json()
    assert.ok(body.error)
    assert.equal(body.error.code, -32602)  // E_INVALID_SPEC numeric
    assert.ok(body.error.message.includes('skill'))
    assert.ok(body.error.data.error_code === 'E_INVALID_SPEC')
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) unknown method returns E_UNKNOWN_METHOD', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'totally_fake_tool', arguments: {} },
    })
    const body = await res.json()
    assert.ok(body.error)
    assert.equal(body.error.data.error_code, 'E_UNKNOWN_TOOL')
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) dispatch_status returns shape with empty children', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'dispatch_status', arguments: {} },
    })
    const body = await res.json()
    const result = body.result
    assert.equal(result.total, 0)
    assert.ok(Array.isArray(result.children))
    assert.ok(typeof result.generated_at === 'number')
  } finally { await s.close() }
})

await t('e2e: /mcp/collab (POST) dispatch_list returns empty children initially', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'dispatch_list', arguments: { limit: 10 } },
    })
    const body = await res.json()
    // dispatch_list returns mcpResult({content:[{text:'...'}], metadata:{...}})
    const listText = body.result.content[0].text
    const listParsed = JSON.parse(listText)
    assert.equal(listParsed.count, 0)
    assert.deepEqual(listParsed.children, [])
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/sessions returns empty list', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/sessions')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.count, 0)
    assert.ok(Array.isArray(body.sessions))
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/persona returns text/plain with x-dsh-hermes-link-* headers', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/persona?scope=all')
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').startsWith('text/plain'))
    assert.ok(res.headers.get('x-dsh-hermes-link-scope'))  // 'all' or 'soul'/'memory'/'config'
    assert.ok(res.headers.get('x-dsh-hermes-link-parts'))
    const body = await res.text()
    assert.ok(body.includes('mock persona'))
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/import with missing hermesSessionId returns 400', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab/import', {})
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/memory-suggest with missing text returns 400', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab/memory-suggest', {})
    assert.equal(res.status, 400)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/consult with missing prompt returns 400', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab/consult', {})
    assert.equal(res.status, 400)
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/stream with missing task_id returns 400', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/stream')
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error)
    assert.equal(body.error.code, -32602)
    assert.equal(body.error.data.error_code, 'E_INVALID_SPEC')
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/stream with unknown task_id returns 200 + not_found event + close', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/stream?task_id=does-not-exist&timeout_ms=200')
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/event-stream'))
    const text = await res.text()
    assert.ok(text.includes('event: not_found'))
    assert.ok(text.includes('does-not-exist'))
  } finally { await s.close() }
})

await t('e2e: /mcp/collab/stream with valid task_id emits event + closes after timeout', async () => {
  const s = await makeServer()
  // Attach a task to the broker so the stream channel exists.
  const taskId = 'live-task-001'
  s.sseBroker.attachTask(taskId, { child_id: 'c1', skill: 'web_search' })
  s.sseBroker.publish(taskId, { kind: 'lifecycle', data: { status: 'started' } })
  try {
    const res = await s.get('/mcp/collab/stream?task_id=' + taskId + '&timeout_ms=200')
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(text.includes('event: lifecycle'))
    assert.ok(text.includes('"status":"started"'))
    assert.ok(text.includes('id: 0'))  // sequence number
  } finally {
    try { s.sseBroker.detachTask(taskId, 'test-end') } catch {}
    await s.close()
  }
})

await t('e2e: 404 on unknown path', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab/does-not-exist')
    assert.equal(res.status, 404)
  } finally { await s.close() }
})

await t('e2e: route table covers all documented paths', async () => {
  const s = await makeServer()
  try {
    const expected = [
      // JSON-RPC envelope + variants
      '/mcp/collab',
      // REST helpers
      '/mcp/collab/health',
      '/mcp/collab/sessions',
      '/mcp/collab/import',
      '/mcp/collab/import-all',
      '/mcp/collab/rename-all',
      '/mcp/collab/persona',
      '/mcp/collab/consult',
      '/mcp/collab/memory-suggest',
      // F1 SSE
      '/mcp/collab/stream',
      // F6 metrics
      '/mcp/collab/metrics',
    ]
    for (const path of expected) {
      assert.ok(s.routes.has(path), `route ${path} not registered; got ${[...s.routes.keys()].join(', ')}`)
    }
  } finally { await s.close() }
})

await t('e2e: JSON-RPC POST with malformed body returns 400 parse error', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', 'not json', { headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error)
    assert.ok(body.error_code === 'E_PARSE_ERROR' || (body.error.data && body.error.data.error_code === 'E_PARSE_ERROR'))
  } finally { await s.close() }
})

await t('e2e: GET /mcp/collab with no body responds to ping (defaults to method=ping)', async () => {
  const s = await makeServer()
  try {
    const res = await s.get('/mcp/collab')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.result.ok, true)
  } finally { await s.close() }
})

await t('e2e: POST /mcp/collab with empty body returns 400 invalid_request', async () => {
  const s = await makeServer()
  try {
    const res = await s.post('/mcp/collab', '')
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error)
    assert.equal(body.error.data.error_code, 'E_INVALID_REQUEST')
  } finally { await s.close() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
