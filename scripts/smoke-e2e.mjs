#!/usr/bin/env node
// scripts/smoke-e2e.mjs
// End-to-end smoke against a RUNNING DSH instance with hermes-link v0.2
// loaded (run after `dsh` restart). Exercises every major surface:
//   health / sessions / persona / import / dispatch one-shot /
//   dispatch continuable + followup + get / consult (timeout honored) /
//   memory-suggest / audit tail / H4 amend file delivery.
//
// Usage: node scripts/smoke-e2e.mjs [baseUrl] [taskSkill] [taskText]
// Env:   HERMES_LINK_TOKEN — attached as Bearer when set.

const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const TASK_SKILL = process.argv[3] || 'pwsh'
const TASK_TEXT = process.argv[4] || 'Run the pwsh tool with a trivial command that prints "hermes-link-e2e-ok" and return its output verbatim.'

const TOKEN = process.env.HERMES_LINK_TOKEN || ''
const authHeaders = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}

let failed = 0
const results = []

function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`)
  if (!ok) failed++
}

async function jget(path) {
  const r = await fetch(BASE + path, { headers: authHeaders })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function jpost(path, payload, timeoutMs = 120000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: r.status, body }
  } finally { clearTimeout(t) }
}
function rpc(method, params) {
  return jpost('/mcp/collab', { jsonrpc: '2.0', id: 'e2e-' + Date.now(), method, params })
}

const taskId1 = 'e2e-' + Date.now() + '-one'
const taskId2 = 'e2e-' + Date.now() + '-cont'

const started = Date.now()
console.log('=== hermes-link v0.2 e2e smoke  base=' + BASE + ' ===\n')

// 1. health
try {
  const { status, body } = await jget('/mcp/collab/health')
  report('health', status === 200 && body && body.ok === true && body.version === '0.2.0',
    'version=' + (body && body.version) + ' continuable=' + (body && body.continuable_registry) + ' auth=' + (body && body.auth))
} catch (e) { report('health', false, e.message) }
if (failed > 0 && results[0].name === 'health') {
  console.log('\n[ABORT] hermes-link v0.2 not live yet — restart dsh first.')
  process.exit(1)
}

// 2. sessions list
try {
  const { status, body } = await jget('/mcp/collab/sessions?limit=3')
  report('sessions list', status === 200 && Array.isArray(body.sessions), 'count=' + (body.count) + ' first=' + (body.sessions[0] && body.sessions[0].session_id))
} catch (e) { report('sessions list', false, e.message) }

// 3. persona
try {
  const r = await fetch(BASE + '/mcp/collab/persona?scope=soul', { headers: authHeaders })
  const text = await r.text()
  report('persona?scope=soul', r.status === 200 && text.includes('SOUL'), text.slice(0, 60).replace(/\n/g, ' '))
} catch (e) { report('persona', false, e.message) }

// 4. import (first listed session)
let importedId = null
try {
  const { body: listBody } = await jget('/mcp/collab/sessions?limit=1')
  const sid = listBody.sessions[0] && listBody.sessions[0].session_id
  if (sid) {
    const { status, body } = await jpost('/mcp/collab/import', { hermesSessionId: sid })
    report('import ' + sid, status === 200 && (body.status === 'created' || body.status === 'already_imported'),
      'status=' + (body && body.status) + ' events=' + (body && body.eventCount) + ' title=' + (body && body.title))
    if (body && body.status === 'created') importedId = body.sessionId
  } else report('import', false, 'no session listed')
} catch (e) { report('import', false, e.message) }

// 5. dispatch one-shot
let oneShotOutput = ''
try {
  const { status, body } = await rpc('tools/call', {
    name: 'dispatch_task',
    arguments: { task_id: taskId1, skill: TASK_SKILL, task: TASK_TEXT, max_tokens: 1024, deadline_ms: 90000 },
  })
  const meta = body && body.result && body.result.metadata
  oneShotOutput = (body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text) || ''
  report('dispatch one-shot', status === 200 && !!meta && meta.status !== 'error',
    'status=' + (meta && meta.status) + ' tokens=' + (meta && meta.tokens_used) + ' d1=' + (meta && meta.d1))
} catch (e) { report('dispatch one-shot', false, e.message) }

// 6. dispatch continuable + followup + get
let childId = null
try {
  const { status, body } = await rpc('tools/call', {
    name: 'dispatch_task',
    arguments: { task_id: taskId2, skill: TASK_SKILL, task: 'Reply with the single word: ready', mode: 'continuable', max_tokens: 512, deadline_ms: 30000 },
  })
  const res = body && body.result
  childId = res && res.metadata && res.metadata.child_id
  report('dispatch continuable start', status === 200 && !!childId, 'child_id=' + childId)
} catch (e) { report('dispatch continuable start', false, e.message) }

if (childId) {
  try {
    const { status, body } = await rpc('tools/call', {
      name: 'dispatch_followup',
      arguments: { child_id: childId, content: [{ type: 'text', text: 'Now reply with the single word: done' }], deadline_ms: 60000 },
    })
    const text = (body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text) || ''
    report('dispatch_followup', status === 200 && text.includes('done'), 'elapsed=' + (body.result && body.result.metadata && body.result.metadata.elapsed_ms))
  } catch (e) { report('dispatch_followup', false, e.message) }
  try {
    const { status, body } = await rpc('tools/call', { name: 'dispatch_get', arguments: { child_id: childId, limit: 5 } })
    report('dispatch_get', status === 200 && !!body.result, 'events=' + (body.result && JSON.parse(body.result.content[0].text).total_events))
  } catch (e) { report('dispatch_get', false, e.message) }
  try {
    const { status, body } = await rpc('tools/call', { name: 'dispatch_interrupt', arguments: { child_id: childId, reason: 'e2e done' } })
    report('dispatch_interrupt', status === 200, 'result=' + ((body && body.result && body.result.content && body.result.content[0].text) || '').slice(0, 60))
  } catch (e) { report('dispatch_interrupt', false, e.message) }
  // H4 amend: drop an amend file at the Hermes inbox, wait for watcher pickup.
  try {
    const { writeFileSync, mkdirSync, existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { homedir } = await import('node:os')
    const hermesHome = process.env.HERMES_HOME || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
    const amendDir = join(hermesHome, 'inbox', 'dsh', 'amend')
    mkdirSync(amendDir, { recursive: true })
    const file = join(amendDir, `e2e-${Date.now()}-${taskId2}.json`)
    writeFileSync(file, JSON.stringify({ task_id: taskId2, content: [{ type: 'text', text: 'amend-ok' }], ts: Date.now() }), 'utf8')
    await new Promise((r) => setTimeout(r, 6000))
    const doneDir = join(amendDir, 'done')
    const delivered = existsSync(doneDir) && readdirSync(doneDir).some((f) => f.includes(taskId2))
    report('H4 amend delivery', delivered, 'file→done/' + (delivered ? '✓' : '✗'))
  } catch (e) { report('H4 amend delivery', false, e.message) }
} else {
  report('dispatch_followup', false, 'no child_id')
  report('dispatch_get', false, 'no child_id')
  report('dispatch_interrupt', false, 'no child_id')
  report('H4 amend delivery', false, 'no child_id')
}

// 7. consult — timeout honored (must return ≈ timeout_ms, not 30s)
try {
  const ts = Date.now()
  const { status, body } = await jpost('/mcp/collab/consult', { prompt: 'e2e consult probe', timeout_ms: 1500 }, 20000)
  const elapsed = Date.now() - ts
  report('consult timeout honored', status === 202 && body.status === 'pending' && elapsed < 15000,
    'status=' + (body && body.status) + ' elapsed=' + elapsed + 'ms')
} catch (e) { report('consult timeout honored', false, e.message) }

// 8. memory-suggest
try {
  const { status, body } = await jpost('/mcp/collab/memory-suggest', { text: 'e2e smoke ran ok', tags: ['e2e'] })
  report('memory-suggest', status === 200 && body && body.ok === true)
} catch (e) { report('memory-suggest', false, e.message) }

// 9. audit tail
try {
  const { status, body } = await rpc('tools/call', { name: 'get_dispatch', arguments: { limit: 5 } })
  const text = (body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text) || ''
  report('get_dispatch (audit)', status === 200 && text.length > 0, 'lines=' + text.split('\n').length)
} catch (e) { report('get_dispatch (audit)', false, e.message) }

// 10. auth gate (only meaningful when a token is configured)
if (TOKEN) {
  try {
    const r = await fetch(BASE + '/mcp/collab/sessions?limit=1')
    report('auth gate rejects no-token', r.status === 401, 'status=' + r.status)
  } catch (e) { report('auth gate', false, e.message) }
}

console.log('')
console.log(`Total: ${results.length}  Passed: ${results.length - failed}  Failed: ${failed}  (${Math.round((Date.now() - started) / 1000)}s)`)
process.exit(failed === 0 ? 0 : 1)