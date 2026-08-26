#!/usr/bin/env node
// scripts/test-sse-broker.mjs
//
// Unit tests for services/sse-broker.mjs. Uses a minimal mock HTTP response
// object so the test runs without spinning up a real server.

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const brokerPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/sse-broker.mjs')).href
const { createSseBroker } = await import(brokerPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

/** Minimal mock of node:http.ServerResponse. */
function mockRes() {
  const res = {
    writes: [],
    headers: null,
    _closed: false,
    closed() { return res._closed },
    writeHead(s, h) { res.headers = { status: s, ...h } },
    write(chunk) { res.writes.push(String(chunk)); return !res._closed },
    end() { res._closed = true },
    on(_ev, cb) { /* 'close' handler - tests call .close() explicitly */ setImmediate(cb) },
  }
  return res
}

// --- basic pub/sub ---
t('case 1: publish + subscribe delivers events in order', () => {
  const b = createSseBroker({ ringSize: 10 })
  b.attachTask('t1', { child_id: 'c1' })
  const res = mockRes()
  b.subscribe('t1', res)
  b.publish('t1', { kind: 'lifecycle', data: { status: 'started' } })
  b.publish('t1', { kind: 'step', data: { type: 'assistant/message' } })
  const body = res.writes.join('')
  assert.ok(body.includes('event: lifecycle'))
  assert.ok(body.includes('event: step'))
  assert.ok(body.includes('"seq":0'))
  assert.ok(body.includes('"seq":1'))
  assert.ok(body.includes('"task_id":"t1"'))
})

t('case 2: SSE headers are set correctly', () => {
  const b = createSseBroker()
  b.attachTask('t2')
  const res = mockRes()
  b.subscribe('t2', res)
  assert.equal(res.headers.status, 200)
  assert.ok(res.headers['content-type'].includes('text/event-stream'))
  assert.ok(res.headers['content-type'].includes('charset=utf-8'))
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform')
  assert.equal(res.headers['x-accel-buffering'], 'no')
})

t('case 3: unknown task_id returns 200 + single not_found event then closes', () => {
  const b = createSseBroker()
  const res = mockRes()
  const sub = b.subscribe('nope', res)
  assert.equal(sub, null)
  assert.equal(res.headers.status, 200)
  assert.ok(res.writes[0].includes('event: not_found'))
  assert.ok(res.closed())
})

t('case 3b: subscribe without since_seq replays buffered events including seq 0', () => {
  const b = createSseBroker()
  b.attachTask('t3b')
  b.publish('t3b', { kind: 'lifecycle', data: { status: 'started' } })
  const res = mockRes()
  b.subscribe('t3b', res) // no sinceSeq -> should replay from the beginning
  const body = res.writes.join('')
  assert.ok(body.includes('event: lifecycle'))
  assert.ok(body.includes('"status":"started"'))
  assert.ok(body.includes('"seq":0'))
})

// --- since_seq replay ---
t('case 4: since_seq replays buffered events > N', () => {
  const b = createSseBroker()
  b.attachTask('t4')
  for (let i = 0; i < 5; i++) b.publish('t4', { kind: 'step', data: { i } })
  const res = mockRes()
  b.subscribe('t4', res, { sinceSeq: 2 })
  const body = res.writes.join('')
  assert.ok(body.includes('"seq":3'))
  assert.ok(body.includes('"seq":4'))
  assert.ok(!body.includes('"seq":0'))
  assert.ok(!body.includes('"seq":2'))
})

t('case 5: since_seq older than ring emits overflow event', () => {
  const b = createSseBroker({ ringSize: 3 })
  b.attachTask('t5')
  for (let i = 0; i < 10; i++) b.publish('t5', { kind: 'step', data: { i } })
  // ring now holds seq 7, 8, 9 (oldest 7)
  const res = mockRes()
  b.subscribe('t5', res, { sinceSeq: 0 })
  const body = res.writes.join('')
  assert.ok(body.includes('event: overflow'))
  assert.ok(body.includes('"oldest_seq":7'))
  assert.ok(body.includes('"seq":7'))
  assert.ok(body.includes('"seq":9'))
})

t('case 5b: since_seq > 0 with empty ring emits overflow(reason=ring_empty)', () => {
  const b = createSseBroker({ ringSize: 100 })
  b.attachTask('t5b')
  const res = mockRes()
  b.subscribe('t5b', res, { sinceSeq: 5 })
  const body = res.writes.join('')
  assert.ok(body.includes('event: overflow'))
  assert.ok(body.includes('"reason":"ring_empty"'))
})

// --- subscribers ---
t('case 6: multiple subscribers all receive events', () => {
  const b = createSseBroker()
  b.attachTask('t6')
  const r1 = mockRes(), r2 = mockRes()
  b.subscribe('t6', r1)
  b.subscribe('t6', r2)
  b.publish('t6', { kind: 'lifecycle', data: { status: 'ok' } })
  assert.ok(r1.writes.join('').includes('"status":"ok"'))
  assert.ok(r2.writes.join('').includes('"status":"ok"'))
})

t('case 7: detachTask closes subscribers with lifecycle/closed event', () => {
  const b = createSseBroker()
  b.attachTask('t7')
  const res = mockRes()
  b.subscribe('t7', res)
  assert.equal(res.closed(), false)
  b.detachTask('t7', 'completed')
  const body = res.writes.join('')
  assert.ok(body.includes('"status":"closed"'))
  assert.ok(body.includes('"reason":"completed"'))
})

// --- backpressure ---
t('case 8: slow consumer (write returns false) gets dropped', () => {
  const b = createSseBroker()
  b.attachTask('t8')
  let callCount = 0
  const res = {
    headers: null,
    writeHead() {},
    write() { callCount++; return false },   // always backpressured
    end() {},
    on() {},
  }
  b.subscribe('t8', res)
  b.publish('t8', { kind: 'lifecycle', data: { status: 'x' } })
  b.publish('t8', { kind: 'lifecycle', data: { status: 'y' } })
  assert.ok(b.stats().droppedSlowClients >= 1)
  assert.ok(callCount >= 1)
})

// --- heartbeat ---
t('case 9: heartbeat frames are emitted on interval', async () => {
  const b = createSseBroker({ heartbeatMs: 50 })
  b.attachTask('t9')
  const res = mockRes()
  b.subscribe('t9', res)
  await new Promise(r => setTimeout(r, 180))
  const body = res.writes.join('')
  const beats = (body.match(/: heartbeat/g) || []).length
  assert.ok(beats >= 2, 'expected >=2 heartbeats, got ' + beats)
})

// --- stats ---
t('case 10: stats reflect activity', () => {
  const b = createSseBroker()
  b.attachTask('t10a')
  b.attachTask('t10b')
  b.publish('t10a', { kind: 'step' })
  b.publish('t10a', { kind: 'step' })
  b.publish('t10b', { kind: 'lifecycle' })
  const s = b.stats()
  assert.equal(s.channels, 2)
  assert.equal(s.published, 3)
  assert.equal(s.droppedSlowClients, 0)
})

// --- destroy ---
t('case 11: close() clears all channels and closes subscribers', () => {
  const b = createSseBroker()
  b.attachTask('t11')
  const res = mockRes()
  b.subscribe('t11', res)
  assert.equal(b.stats().channels, 1)
  b.close()
  assert.equal(b.stats().channels, 0)
  assert.ok(res.closed())
})

// --- re-attach after terminal ---
t('case 12: re-attach after detach clears terminalAt and resumes', () => {
  const b = createSseBroker()
  b.attachTask('t12')
  b.detachTask('t12', 'completed')
  b.attachTask('t12', { reattached: true })
  b.publish('t12', { kind: 'lifecycle', data: { status: 'resumed' } })
  const s = b.stats()
  assert.ok(s.published >= 2, 'expected at least 2 publishes (closed + resumed), got ' + s.published)
})

t('case 13: isAttached returns correct state', () => {
  const b = createSseBroker()
  assert.equal(b.isAttached('nope'), false)
  b.attachTask('here')
  assert.equal(b.isAttached('here'), true)
  b.detachTask('here', 'completed')
  // still attached during the 5s hold window
  assert.equal(b.isAttached('here'), true)
})

t('case 14: timeoutMs auto-closes the subscription', async () => {
  const b = createSseBroker({ heartbeatMs: 60_000 })  // disable heartbeat for this test
  b.attachTask('t14')
  const res = mockRes()
  const sub = b.subscribe('t14', res, { timeoutMs: 80 })
  assert.ok(sub)
  await new Promise(r => setTimeout(r, 160))
  assert.ok(res.closed(), 'subscription should auto-close after timeoutMs')
})

t('case 15: subscriber close() detaches from channel', () => {
  const b = createSseBroker()
  b.attachTask('t15')
  const res = mockRes()
  const sub = b.subscribe('t15', res)
  assert.equal(b.stats().total_subscribers, 1)
  sub.close()
  assert.equal(b.stats().total_subscribers, 0)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
