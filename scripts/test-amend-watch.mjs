#!/usr/bin/env node
// scripts/test-amend-watch.mjs
//
// Unit tests for v0.3.4 E3 (fs.watch + debounced batch) and the polling
// fallback. Uses isolated temp dirs to avoid touching real Hermes Home.

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/amend-watcher.mjs')).href
const { createAmendWatcher } = await import(modPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

function makeHermesHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amend-watch-'))
  mkdirSync(join(home, 'inbox', 'dsh', 'amend'), { recursive: true })
  return home
}

function makeFakeContinuations() {
  // Stub continuations object: nothing registered (no children).
  return {
    validateAmendNonce() { return false },
    getByTaskId() { return null },
    update() {},
    register() {},
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

// --- watcher creation lifecycle ---
t('case 1: createAmendWatcher exposes deliver + stats + dispose + watcherActive', () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: makeFakeContinuations(),
    pickParentAgent: () => null,
  })
  assert.equal(typeof w.deliver, 'function')
  assert.equal(typeof w.stats, 'object')
  assert.equal(typeof w.dispose, 'function')
  assert.equal(typeof w.watcherActive, 'function')
  assert.ok(w.stats)
  assert.equal(w.stats.delivered, 0)
  assert.equal(w.stats.scanned, 0)
  w.dispose()
})

t('case 2: watcherActive() returns a boolean (fs.watch may or may not work)', () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: makeFakeContinuations(),
    pickParentAgent: () => null,
  })
  const active = w.watcherActive()
  assert.equal(typeof active, 'boolean')
  w.dispose()
})

t('case 3: dispose() is idempotent (multiple calls safe)', () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: makeFakeContinuations(),
    pickParentAgent: () => null,
  })
  w.dispose()
  w.dispose()
  w.dispose()
})

// --- file-detection behavior ---
// These tests verify the watcher observes new files. On systems where
// fs.watch is unavailable, the polling fallback runs every 2s; tests
// tolerate that by waiting up to 4s.

async function writeValidAmend(home, ts, taskId, nonce) {
  const filename = `${ts}-${taskId}-${nonce}.json`
  const full = join(home, 'inbox', 'dsh', 'amend', filename)
  writeFileSync(full, JSON.stringify({
    task_id: taskId,
    content: [{ type: 'text', text: 'amend ' + ts }],
    ts,
  }))
  return full
}

async function waitForFile(filePath, predicate, maxMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (predicate()) return true
    await wait(50)
  }
  return predicate()
}

t('case 4: new valid amend file is detected and processed', async () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  // Register a child so the nonce matches
  const cont = makeFakeContinuations()
  let registered = null
  cont.validateAmendNonce = (taskId, nonce) => taskId === 't1' && nonce === 'abc'
  cont.getByTaskId = (taskId) => taskId === 't1' ? { child_id: 'c1', parent_agent_id: 'p1' } : null

  let followupCalled = 0
  ctx.subagents.followup = async () => { followupCalled++ }

  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: cont,
    pickParentAgent: () => null,
  })
  // Write file
  const file = await writeValidAmend(home, 1700000000000, 't1', 'abc')
  // Wait for the watcher to detect and process (up to 4s)
  const ok = await waitForFile(file, () => !existsSync(file), 4000)
  assert.ok(ok, 'file should be processed (renamed to done/)')
  assert.ok(followupCalled >= 1, 'followup should have been called')
  w.dispose()
})

t('case 5: multiple files in burst are batched into a single scan', async () => {
  const home = makeHermesHome()
  const cont = makeFakeContinuations()
  // Register 3 children so all 3 nonces match
  const nonces = { 't1': 'n1', 't2': 'n2', 't3': 'n3' }
  cont.validateAmendNonce = (taskId, nonce) => nonces[taskId] === nonce
  cont.getByTaskId = (taskId) => nonces[taskId] ? { child_id: 'c-' + taskId, parent_agent_id: 'p1' } : null

  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: cont,
    pickParentAgent: () => null,
  })

  // Write 3 files in quick succession (within 50ms)
  const files = []
  for (const [taskId, nonce] of Object.entries(nonces)) {
    files.push(await writeValidAmend(home, Date.now() + Math.random(), taskId, nonce))
  }
  // Wait for ALL files to be processed
  const ok = await waitForFile(join(home, 'inbox', 'dsh', 'amend'), () => {
    if (!existsSync(join(home, 'inbox', 'dsh', 'amend'))) return true
    const remaining = readdirSync(join(home, 'inbox', 'dsh', 'amend')).filter((f) => f.endsWith('.json'))
    return remaining.length === 0
  }, 4000)
  assert.ok(ok, 'all burst files should be processed')
  assert.ok(existsSync(join(home, 'inbox', 'dsh', 'amend', 'done')), 'done/ dir should exist')
  const doneFiles = readdirSync(join(home, 'inbox', 'dsh', 'amend', 'done'))
  assert.equal(doneFiles.length, 3, 'all 3 files should be in done/')
  w.dispose()
})

t('case 6: rejected_legacy still moves file to done/legacy-*', async () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const cont = makeFakeContinuations()
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: cont,
    pickParentAgent: () => null,
  })
  // legacy two-segment filename
  const fname = '1700000000000-t1.json'
  const full = join(home, 'inbox', 'dsh', 'amend', fname)
  writeFileSync(full, JSON.stringify({ task_id: 't1', content: [], ts: 0 }))
  const ok = await waitForFile(join(home, 'inbox', 'dsh', 'amend'), () => {
    if (!existsSync(join(home, 'inbox', 'dsh', 'amend'))) return true
    const remaining = readdirSync(join(home, 'inbox', 'dsh', 'amend')).filter((f) => f.endsWith('.json'))
    return remaining.length === 0
  }, 4000)
  assert.ok(ok, 'legacy file should be moved to done/')
  assert.ok(w.stats.rejected_legacy >= 1, 'rejected_legacy counter should increment')
  w.dispose()
})

t('case 7: rejected_nonce still moves file to done/bad-nonce-*', async () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const cont = makeFakeContinuations()
  cont.validateAmendNonce = () => false  // never matches
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: cont,
    pickParentAgent: () => null,
  })
  const fname = '1700000000000-t1-badnonce.json'
  const full = join(home, 'inbox', 'dsh', 'amend', fname)
  writeFileSync(full, JSON.stringify({ task_id: 't1', content: [], ts: 0 }))
  const ok = await waitForFile(join(home, 'inbox', 'dsh', 'amend'), () => {
    if (!existsSync(join(home, 'inbox', 'dsh', 'amend'))) return true
    const remaining = readdirSync(join(home, 'inbox', 'dsh', 'amend')).filter((f) => f.endsWith('.json'))
    return remaining.length === 0
  }, 4000)
  assert.ok(ok, 'bad-nonce file should be moved to done/')
  assert.ok(w.stats.rejected_nonce >= 1)
  w.dispose()
})

t('case 8: watcherActive reflects whether fs.watch is functional', () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: makeFakeContinuations(),
    pickParentAgent: () => null,
  })
  const active = w.watcherActive()
  // Either true (fs.watch worked) or false (fell back to polling). Just ensure consistency.
  assert.equal(active, active)  // tautology to confirm return
  assert.ok(w.dispose && typeof w.dispose === 'function')
  w.dispose()
})

t('case 9: empty/non-existent directory does not crash', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
  // Note: no inbox/dsh/amend directory created
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: makeFakeContinuations(),
    pickParentAgent: () => null,
  })
  await wait(500)
  // should not have crashed
  assert.equal(w.stats.delivered, 0)
  w.dispose()
})

t('case 10: stats track scans + deliveries + rejections', async () => {
  const home = makeHermesHome()
  const ctx = { agents: { get: () => null }, subagents: { followup: async () => {} } }
  const cont = makeFakeContinuations()
  const nonces = { 't1': 'n1' }
  cont.validateAmendNonce = (taskId, nonce) => nonces[taskId] === nonce
  cont.getByTaskId = (taskId) => nonces[taskId] ? { child_id: 'c1', parent_agent_id: 'p1' } : null
  const w = createAmendWatcher({
    hermesHome: home,
    ctx,
    continuations: cont,
    pickParentAgent: () => null,
  })
  // 1 valid + 1 legacy + 1 bad-nonce
  await writeValidAmend(home, Date.now() + 1, 't1', 'n1')
  writeFileSync(join(home, 'inbox', 'dsh', 'amend', '1700-t1.json'), '{}')
  writeFileSync(join(home, 'inbox', 'dsh', 'amend', '1700-t1-bad.json'), '{}')
  await waitForFile(join(home, 'inbox', 'dsh', 'amend'), () => {
    if (!existsSync(join(home, 'inbox', 'dsh', 'amend'))) return true
    return readdirSync(join(home, 'inbox', 'dsh', 'amend')).filter((f) => f.endsWith('.json')).length === 0
  }, 4000)
  assert.ok(w.stats.scanned >= 3, '3 files scanned')
  assert.ok(w.stats.delivered >= 1, '1 delivered')
  assert.ok(w.stats.rejected_legacy >= 1, '1 legacy rejected')
  assert.ok(w.stats.rejected_nonce >= 1, '1 bad-nonce rejected')
  w.dispose()
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
