#!/usr/bin/env node
// scripts/test-consult-client.mjs
// Unit tests for packages/dsh-hermes-link/services/consult-hermes.mjs.
// No DSH runtime required — pure file protocol in temp dirs.
//
// Regression coverage for the v0.2 fix: the per-call `timeout_ms` override
// must actually be honored (previously the third argument was dropped and
// every consult waited the 30s client default).

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const consultPath = join(root, 'packages', 'dsh-hermes-link', 'services', 'consult-hermes.mjs')
const { createConsultClient } = await import(pathToFileURL(consultPath).href)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-consult-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

async function tick(ms) { return new Promise((r) => setTimeout(r, ms)) }

// -- case 1: reply arrives in time → replied + reply file consumed ----------
t('case 1: reply before timeout → status=replied, reply file removed', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 5000, pollMs: 20 })
    const ticketPromise = client.consult('what is 2+2?').then((r) => r)
    // Wait for the inbox file to appear, then drop a reply.
    const inboxDir = client.inboxDir
    let found = null
    for (let i = 0; i < 200 && !found; i++) {
      const files = require('node:fs').readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
      if (files.length) found = files[0]
      else await tick(10)
    }
    assert.ok(found, 'consult inbox file was written')
    const ticket = JSON.parse(readFileSync(join(inboxDir, found), 'utf8')).ticket
    writeFileSync(join(client.replyDir, `${ticket}.json`), JSON.stringify({ ticket, answer: '4' }), 'utf8')
    const result = await ticketPromise
    assert.equal(result.status, 'replied')
    assert.equal(result.reply, '4')
    assert.equal(existsSync(join(client.replyDir, `${ticket}.json`)), false, 'reply file consumed')
  } finally { cleanup() }
})

// -- case 2: no reply → pending after the client default timeout ------------
t('case 2: no reply → status=pending (client default timeout)', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 150, pollMs: 20 })
    const result = await client.consult('nobody home?')
    assert.equal(result.status, 'pending')
    assert.ok(result.ticket)
    assert.ok(result.hint.includes('150ms'), 'hint reports the effective timeout')
  } finally { cleanup() }
})

// -- case 3: REGRESSION — per-call timeout override is honored --------------
t('case 3: timeoutOverride < client default → returns pending fast', async () => {
  const { home, cleanup } = makeHome()
  try {
    // Client default is huge (10s); the per-call override must win.
    const client = createConsultClient({ hermesHome: home, timeoutMs: 10_000, pollMs: 20 })
    const started = Date.now()
    const result = await client.consult('fast pending?', {}, 200)
    const elapsed = Date.now() - started
    assert.equal(result.status, 'pending')
    assert.ok(elapsed < 3000, `override honored (elapsed=${elapsed}ms)`)
    assert.ok(result.hint.includes('200ms'), 'hint reports the 200ms override')
  } finally { cleanup() }
})

// -- case 4: writeResult → dispatch-result/<task_id>.json -------------------
t('case 4: writeResult writes dispatch-result file', () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home })
    client.writeResult({ task_id: 't-001', status: 'ok', output: 'done', tokens_used: 12 })
    const p = join(home, 'inbox', 'dsh', 'dispatch-result', 't-001.json')
    assert.ok(existsSync(p), 'result file exists')
    let rec = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(rec.task_id, 't-001')
    assert.equal(rec.output, 'done')
    assert.equal(rec.source, 'dsh')
    assert.equal(rec.tokens_used, 12)
    // Subsequent write for the same task_id overwrites (idempotent).
    client.writeResult({ task_id: 't-001', status: 'ok', output: 'again', tokens_used: 14 })
    rec = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(rec.output, 'again')
    assert.equal(rec.tokens_used, 14)
  } finally { cleanup() }
})

// -- case 5: corrupt reply → status=error ------------------------------------
t('case 5: corrupt reply JSON → status=error', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 3000, pollMs: 20 })
    const promise = client.consult('corrupt?')
    const inboxDir = client.inboxDir
    let found = null
    for (let i = 0; i < 200 && !found; i++) {
      const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
      if (files.length) found = files[0]
      else await tick(10)
    }
    assert.ok(found, 'consult inbox file was written')
    const ticket = JSON.parse(readFileSync(join(inboxDir, found), 'utf8')).ticket
    writeFileSync(join(client.replyDir, `${ticket}.json`), '{not json', 'utf8')
    const result = await promise
    assert.equal(result.status, 'error')
    assert.ok(result.error.includes('reply_parse_failed'))
  } finally { cleanup() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)