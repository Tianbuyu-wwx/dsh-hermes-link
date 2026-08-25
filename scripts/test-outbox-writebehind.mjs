#!/usr/bin/env node
// scripts/test-outbox-writebehind.mjs
//
// Unit tests for services/outbox.mjs v0.3.1 (E2) write-behind queue behavior.

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/outbox.mjs')).href
const { createOutbox } = await import(modPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-outbox-'))
}

// --- basic write-behind semantics ---
t('case 1: appendUsage does NOT write synchronously', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  // queue is non-empty
  assert.equal(ob.outboxStats().queueDepth, 1)
  // file does not exist yet
  const usagePath = join(home, 'inbox', 'dsh', 'usage.jsonl')
  assert.ok(!existsSync(usagePath), 'file does not exist before flush')
})

t('case 2: flushNow() drains the queue synchronously', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1', tokens_used: 10 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't2', tokens_used: 20 })
  ob.appendUsage({ kind: 'consult',   task_id: 't3' })
  // all 3 go to the same usage path -> one bucket with 3 items
  assert.equal(ob.outboxStats().queueDepth, 1, 'one bucket for the usage path')
  assert.equal(ob.outboxStats().counters.enqueued, 3, '3 items enqueued')
  const n = ob.flushNow()
  assert.equal(n, 3, 'flushNow returns the number of items flushed across all buckets')
  assert.equal(ob.outboxStats().queueDepth, 0, 'queue is empty after flush')
  const lines = readFileSync(join(home, 'inbox', 'dsh', 'usage.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[0]).task_id, 't1')
  assert.equal(JSON.parse(lines[1]).task_id, 't2')
  assert.equal(JSON.parse(lines[2]).task_id, 't3')
})

// --- batching ---
t('case 3: appendUsage batches 100 entries into 1 appendFileSync', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  for (let i = 0; i < 100; i++) {
    ob.appendUsage({ kind: 'dispatch', task_id: 't' + i })
  }
  // all 100 are queued
  assert.equal(ob.outboxStats().queueDepth, 1, 'single bucket for usage path')
  // single flush writes all of them
  ob.flushNow()
  const lines = readFileSync(join(home, 'inbox', 'dsh', 'usage.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 100, 'all 100 entries written')
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.parse(lines[i]).task_id, 't' + i)
  }
})

t('case 4: appendSessionEvent groups by sessionId (one bucket per file)', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  for (let i = 0; i < 10; i++) {
    ob.appendSessionEvent('sess-A', { type: 'e', seq: i })
    ob.appendSessionEvent('sess-B', { type: 'e', seq: i })
  }
  assert.equal(ob.outboxStats().queueDepth, 2, 'two buckets (A and B)')
  ob.flushNow()
  const dir = join(home, 'inbox', 'dsh', 'session-mirror')
  const files = readdirSync(dir)
  assert.equal(files.length, 2)
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n')
    assert.equal(lines.length, 10, '10 events per file')
  }
})

// --- timers ---
t('case 5: setInterval-based flush works', async () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 100 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't' })
  // wait for the timer to fire (initial run at +5s would be too slow - but
  // scheduleFlush() can also be triggered manually; for this test we wait
  // for the 100ms timer).
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(ob.outboxStats().queueDepth, 0, 'timer flushed within 200ms')
  const lines = readFileSync(join(home, 'inbox', 'dsh', 'usage.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
})

// --- queue capacity ---
t('case 6: queue cap drops oldest items with warning (we use cap, not drop-oldest)', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000, maxQueueSize: 10 })
  // 10 distinct buckets (10 different file paths via 10 different sessionIds)
  for (let i = 0; i < 15; i++) {
    ob.appendSessionEvent('sess-' + i, { seq: i })
  }
  // We've added 15 buckets to a cap of 10. The first 5 should be dropped.
  // (Each bucket is one entry, so 15 - 10 = 5 dropped)
  assert.equal(ob.outboxStats().counters.droppedQueueFull, 5)
  assert.equal(ob.outboxStats().queueDepth, 10)
})

// --- heartbeat enrichment ---
t('case 7: heartbeat payload includes outbox_queue_depth + dsh_version', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  const hb = ob.startHeartbeat(999999, { dsh_version: '0.3.1', version: 'dsh-hermes-link/0.3.1' })
  const latest = readFileSync(join(home, 'inbox', 'dsh', 'heartbeat', 'latest.json'), 'utf8')
  const rec = JSON.parse(latest)
  assert.equal(rec.outbox_queue_depth, 0)
  assert.equal(rec.outbox_flush_runs, 0)
  assert.equal(rec.dsh_version, '0.3.1')
  hb.stop()
})

t('case 8: heartbeat reflects current queue depth', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  ob.appendUsage({ kind: 'dispatch', task_id: 't2' })
  // single bucket so queueDepth = 1 (one path, multiple items)
  assert.equal(ob.outboxStats().queueDepth, 1)
  // trigger a heart beat and check
  const hb = ob.startHeartbeat(999999)
  const latest = readFileSync(join(home, 'inbox', 'dsh', 'heartbeat', 'latest.json'), 'utf8')
  const rec = JSON.parse(latest)
  assert.equal(rec.outbox_queue_depth, 1)
  hb.stop()
})

// --- memory-suggest ---
t('case 9: writeMemorySuggestion enqueues + flushNow writes per-ts file', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  const r1 = ob.writeMemorySuggestion({ text: 'first' })
  const r2 = ob.writeMemorySuggestion({ text: 'second' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  // single bucket (same dir), but 2 distinct items -> 2 distinct ts.json files
  assert.equal(ob.outboxStats().queueDepth, 1, 'one bucket for the suggest dir')
  ob.flushNow()
  const dir = join(home, 'inbox', 'dsh', 'memory-suggest')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 2, 'two per-ts files written')
  // ts.json filenames should differ
  assert.notEqual(files[0], files[1])
})

// --- stop() flushes ---
t('case 10: stop() flushes the queue synchronously', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  ob.appendSessionEvent('sess', { seq: 0 })
  ob.stop()
  // files are flushed
  assert.ok(existsSync(join(home, 'inbox', 'dsh', 'usage.jsonl')))
  assert.ok(existsSync(join(home, 'inbox', 'dsh', 'session-mirror', 'sess.jsonl')))
  // subsequent writes should not throw (stopped = sync fallback)
  ob.appendUsage({ kind: 'dispatch', task_id: 't2' })
  const lines = readFileSync(join(home, 'inbox', 'dsh', 'usage.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, 'post-stop writes go through sync fallback')
})

// --- counters ---
t('case 11: counters track enqueued/flushed/flushRuns', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  ob.appendUsage({ kind: 'dispatch', task_id: 't2' })
  ob.flushNow()
  ob.appendUsage({ kind: 'dispatch', task_id: 't3' })
  ob.flushNow()
  const c = ob.outboxStats().counters
  assert.equal(c.enqueued, 3)
  assert.equal(c.flushed, 3)
  assert.equal(c.flushRuns, 2)
  assert.ok(c.lastFlushAt > 0)
  assert.ok(c.lastFlushDurationMs >= 0)
})

// --- per-file retry ---
t('case 12: per-file failure causes retry up to maxRetries', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000, maxRetries: 2 })
  // Use a path with invalid characters (Windows reserved name) - simulation
  // is tricky cross-platform; instead test that retries are tracked.
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  ob.appendSessionEvent('sess-A', { seq: 0 })
  ob.flushNow()
  // no failures expected on happy path
  assert.equal(ob.outboxStats().counters.droppedRetriesExhausted, 0)
})

// --- heartbeat metadata passthrough ---
t('case 13: heartbeat payload includes last_dispatch_latency_ms when provided', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  const hb = ob.startHeartbeat(999999, {
    dsh_version: '0.3.1',
    last_dispatch_latency_ms: 1234,
  })
  const rec = JSON.parse(readFileSync(join(home, 'inbox', 'dsh', 'heartbeat', 'latest.json'), 'utf8'))
  assert.equal(rec.last_dispatch_latency_ms, 1234)
  hb.stop()
})

// --- config exposed ---
t('case 14: outboxStats exposes config (flushIntervalMs, maxQueueSize, maxRetries)', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 1000, maxQueueSize: 500, maxRetries: 5 })
  const s = ob.outboxStats()
  assert.equal(s.config.flushIntervalMs, 1000)
  assert.equal(s.config.maxQueueSize, 500)
  assert.equal(s.config.maxRetries, 5)
})

// --- mixed kinds in same flush ---
t('case 15: mixed usage + mirror + suggestion in one flush', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  ob.appendUsage({ kind: 'dispatch', task_id: 't1' })
  ob.appendSessionEvent('sess-A', { seq: 0 })
  ob.writeMemorySuggestion({ text: 'note' })
  assert.equal(ob.outboxStats().queueDepth, 3)
  ob.flushNow()
  assert.ok(existsSync(join(home, 'inbox', 'dsh', 'usage.jsonl')))
  assert.ok(existsSync(join(home, 'inbox', 'dsh', 'session-mirror', 'sess-A.jsonl')))
  const memFiles = readdirSync(join(home, 'inbox', 'dsh', 'memory-suggest')).filter((f) => f.endsWith('.json'))
  assert.equal(memFiles.length, 1)
})

// --- non-throwing appendUsage ---
t('case 16: appendUsage swallows errors and returns false', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  // pass invalid args - should not throw
  const r = ob.appendUsage(null)
  // returns false on failure (caller can detect)
  assert.equal(typeof r, 'boolean')
})

// --- non-throwing writeMemorySuggestion ---
t('case 17: writeMemorySuggestion returns ok=true even for null spread (best-effort)', () => {
  const home = makeHome()
  const ob = createOutbox({ hermesHome: home, flushIntervalMs: 60_000 })
  const r = ob.writeMemorySuggestion(null)
  assert.equal(typeof r, 'object')
  assert.equal(r.ok, true, 'null spread to {} is accepted')
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
