#!/usr/bin/env node
// scripts/test-amend-security.mjs
// Unit tests for the v0.2.2 amend filename + nonce protocol.
// Covers:
//   - valid three-segment filename (ts-task-nonce) with matching nonce → delivered
//   - mismatched filename nonce → rejected_nonce (file moved to done/bad-nonce-*)
//
// Note: this test mocks ctx.agents / ctx.subagents enough to exercise the
// filename parsing + nonce validation paths without a live DSH runtime.

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const amendWatcherUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'amend-watcher.mjs')).href
const continuationsUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'continuations.mjs')).href
const { createAmendWatcher } = await import(amendWatcherUrl)
const { openContinuations } = await import(continuationsUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-amend-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

/**
 * Build a minimal ctx that records followup calls instead of spawning real
 * sub-agents. Returns a counter so tests can assert a delivery happened.
 */
function makeMockCtx(taskId, childId) {
  const calls = []
  return {
    calls,
    ctx: {
      agents: {
        get(id) { return id === 'parent-A' ? { id: 'parent-A' } : null },
      },
      subagents: {
        async followup(_parent, id, content, opts) {
          calls.push({ id, content, opts })
          return 'msg-id'
        },
      },
    },
    pickParentAgent() { return { id: 'parent-A' } },
  }
}

t('case 1: legacy two-segment filename is rejected_legacy, never delivered', async () => {
  const { home, cleanup } = makeHome()
  try {
    const continuations = openContinuations(join(home, 'state'))
    continuations.register({
      child_id: 'child-1', task_id: 't-1', parent_agent_id: 'parent-A', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-1' },
    })
    const { ctx, calls, pickParentAgent } = makeMockCtx()
    const w = createAmendWatcher({ hermesHome: home, ctx, continuations, pickParentAgent })
    const amendDir = join(home, 'inbox', 'dsh', 'amend')
    const legacyFile = join(amendDir, `1700000000000-t-1.json`)
    writeFileSync(legacyFile, JSON.stringify({ task_id: 't-1', content: [{ type: 'text', text: 'legacy amend' }] }), 'utf8')
    await w.deliver(legacyFile)
    assert.equal(calls.length, 0, 'no followup call for legacy file')
    assert.ok(!existsSync(legacyFile), 'legacy file moved aside')
    assert.equal(w.stats.rejected_legacy, 1, 'rejected_legacy counter incremented')
    w.dispose(); continuations.close()
  } finally { cleanup() }
})

t('case 2: three-segment filename with wrong nonce is rejected_nonce, never delivered', async () => {
  const { home, cleanup } = makeHome()
  try {
    const continuations = openContinuations(join(home, 'state'))
    const realNonce = continuations.generateAmendNonce()
    continuations.register({
      child_id: 'child-2', task_id: 't-2', parent_agent_id: 'parent-A', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-2' }, amendNonce: realNonce,
    })
    const { ctx, calls, pickParentAgent } = makeMockCtx()
    const w = createAmendWatcher({ hermesHome: home, ctx, continuations, pickParentAgent })
    const amendDir = join(home, 'inbox', 'dsh', 'amend')
    const badNonceFile = join(amendDir, `1700000001000-t-2-deadbeefcafebabe.json`)
    writeFileSync(badNonceFile, JSON.stringify({ task_id: 't-2', content: [{ type: 'text', text: 'evil amend' }] }), 'utf8')
    await w.deliver(badNonceFile)
    assert.equal(calls.length, 0, 'no followup call with wrong nonce')
    assert.equal(w.stats.rejected_nonce, 1, 'rejected_nonce counter incremented')
    assert.equal(w.stats.delivered, 0)
    w.dispose(); continuations.close()
  } finally { cleanup() }
})

t('case 3: filename task_id mismatch with body task_id is rejected', async () => {
  const { home, cleanup } = makeHome()
  try {
    const continuations = openContinuations(join(home, 'state'))
    const realNonce = continuations.generateAmendNonce()
    continuations.register({
      child_id: 'child-3', task_id: 't-3', parent_agent_id: 'parent-A', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-3' }, amendNonce: realNonce,
    })
    const { ctx, calls, pickParentAgent } = makeMockCtx()
    const w = createAmendWatcher({ hermesHome: home, ctx, continuations, pickParentAgent })
    const amendDir = join(home, 'inbox', 'dsh', 'amend')
    // filename says t-3, body says t-OTHER
    const badFile = join(amendDir, `1700000002000-t-3-${realNonce}.json`)
    writeFileSync(badFile, JSON.stringify({ task_id: 't-OTHER', content: [{ type: 'text', text: 'spoof' }] }), 'utf8')
    const r = await w.deliver(badFile)
    assert.equal(calls.length, 0, 'no followup for task_id mismatch')
    assert.equal(r.status, 'rejected_task_id_mismatch')
    w.dispose(); continuations.close()
  } finally { cleanup() }
})

t('case 4: valid three-segment filename with matching nonce IS delivered', async () => {
  const { home, cleanup } = makeHome()
  try {
    const continuations = openContinuations(join(home, 'state'))
    const realNonce = continuations.generateAmendNonce()
    continuations.register({
      child_id: 'child-4', task_id: 't-4', parent_agent_id: 'parent-A', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-4' }, amendNonce: realNonce,
    })
    const { ctx, calls, pickParentAgent } = makeMockCtx()
    const w = createAmendWatcher({ hermesHome: home, ctx, continuations, pickParentAgent })
    const amendDir = join(home, 'inbox', 'dsh', 'amend')
    const goodFile = join(amendDir, `1700000003000-t-4-${realNonce}.json`)
    writeFileSync(goodFile, JSON.stringify({ task_id: 't-4', content: [{ type: 'text', text: 'go-north' }] }), 'utf8')
    const r = await w.deliver(goodFile)
    assert.equal(r.status, 'delivered')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].id, 'child-4')
    assert.equal(w.stats.delivered, 1)
    assert.equal(w.stats.rejected_nonce, 0)
    assert.equal(w.stats.rejected_legacy, 0)
    w.dispose(); continuations.close()
  } finally { cleanup() }
})

t('case 5: continuations.validateAmendNonce enforces exact match', () => {
  const { home, cleanup } = makeHome()
  try {
    const continuations = openContinuations(join(home, 'state'))
    const nonce = continuations.generateAmendNonce()
    assert.notEqual(nonce, '')
    continuations.register({
      child_id: 'child-5', task_id: 't-5', parent_agent_id: 'parent-A', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-5' }, amendNonce: nonce,
    })
    assert.equal(continuations.validateAmendNonce('t-5', nonce), true)
    assert.equal(continuations.validateAmendNonce('t-5', 'wrong'), false)
    assert.equal(continuations.validateAmendNonce('t-OTHER', nonce), false)
    assert.equal(continuations.validateAmendNonce('', nonce), false)
    assert.equal(continuations.validateAmendNonce('t-5', ''), false)
    continuations.close()
  } finally { cleanup() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)