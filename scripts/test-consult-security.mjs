#!/usr/bin/env node
// scripts/test-consult-security.mjs
// Unit tests for the v0.2.2 consult reply_secret protocol.
// Covers:
//   - reply at <ticket>-<secret>.json (correct format) → replied
//   - reply at <ticket>.json (legacy) without HERMES_LINK_TRUST_LEGACY → pending
//   - reply at <ticket>.json WITH HERMES_LINK_TRUST_LEGACY=1 → replied (legacy)
//   - reply at <ticket>-wrongsecret.json → pending (treated as missing)

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const consultUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'consult-hermes.mjs')).href
const { createConsultClient } = await import(consultUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-consult-sec-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

async function tick(ms) { return new Promise((r) => setTimeout(r, ms)) }

t('case 1: secret-suffixed reply is accepted; secret is exposed in payload', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 1000, pollMs: 25 })
    const inboxDir = client.inboxDir
    const replyDir = client.replyDir
    // Start consult WITHOUT dropping a reply yet; grab the ticket + secret from the
    // inbox payload.
    let consultPromise
    const start = Date.now()
    consultPromise = client.consult('sec-probe', { task: 'x' }, 1500)
    let found = null
    for (let i = 0; i < 200 && !found; i++) {
      const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
      if (files.length) found = files[0]
      else await tick(10)
    }
    assert.ok(found, 'inbox file written')
    const inbox = JSON.parse(readFileSync(join(inboxDir, found), 'utf8'))
    assert.equal(typeof inbox.reply_secret, 'string', 'payload carries reply_secret')
    assert.ok(inbox.reply_secret.length > 0, 'reply_secret is non-empty')
    assert.equal(inbox.ticket.length, 36, 'ticket is a UUID')

    // Drop a reply at the secret-suffixed name → consult replies.
    writeFileSync(join(replyDir, `${inbox.ticket}-${inbox.reply_secret}.json`), JSON.stringify({ answer: 'ok-secret' }), 'utf8')
    const r = await consultPromise
    assert.equal(r.status, 'replied')
    assert.equal(r.reply, 'ok-secret')
    assert.equal(r.reply_kind, 'secret')
    assert.ok(Date.now() - start < 1500, 'reply received well within timeout')
  } finally { cleanup() }
})

t('case 2: reply with wrong secret suffix is treated as missing (pending)', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 250, pollMs: 25 })
    const inboxDir = client.inboxDir
    const replyDir = client.replyDir
    const consultPromise = client.consult('wrongsecret', {}, 400)
    let found = null
    for (let i = 0; i < 200 && !found; i++) {
      const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
      if (files.length) found = files[0]
      else await tick(10)
    }
    const inbox = JSON.parse(readFileSync(join(inboxDir, found), 'utf8'))
    // Drop a reply with a WRONG secret suffix.
    writeFileSync(join(replyDir, `${inbox.ticket}-not-the-real-secret.json`), JSON.stringify({ answer: 'spoofed' }), 'utf8')
    const r = await consultPromise
    // Should NOT have returned replied (wrong secret → treated as missing).
    assert.notEqual(r.status, 'replied')
    assert.equal(r.status, 'pending')
  } finally { cleanup() }
})

t('case 3: legacy <ticket>.json is REJECTED by default (security on)', async () => {
  const { home, cleanup } = makeHome()
  try {
    const client = createConsultClient({ hermesHome: home, timeoutMs: 250, pollMs: 25 })
    const inboxDir = client.inboxDir
    const replyDir = client.replyDir
    const consultPromise = client.consult('legacy-default', {}, 400)
    let found = null
    for (let i = 0; i < 200 && !found; i++) {
      const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
      if (files.length) found = files[0]
      else await tick(10)
    }
    const inbox = JSON.parse(readFileSync(join(inboxDir, found), 'utf8'))
    // Drop a legacy-format reply (no secret suffix).
    writeFileSync(join(replyDir, `${inbox.ticket}.json`), JSON.stringify({ answer: 'legacy-spoof' }), 'utf8')
    const r = await consultPromise
    assert.notEqual(r.status, 'replied', 'default mode rejects legacy reply files')
  } finally { cleanup() }
})

t('case 4: HERMES_LINK_TRUST_LEGACY=1 enables legacy fallback (escape valve)', async () => {
  const old = process.env.HERMES_LINK_TRUST_LEGACY
  process.env.HERMES_LINK_TRUST_LEGACY = '1'
  try {
    const { home, cleanup } = makeHome()
    try {
      const client = createConsultClient({ hermesHome: home, timeoutMs: 500, pollMs: 25 })
      const inboxDir = client.inboxDir
      const replyDir = client.replyDir
      const consultPromise = client.consult('legacy-optin', {}, 800)
      let found = null
      for (let i = 0; i < 200 && !found; i++) {
        const files = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
        if (files.length) found = files[0]
        else await tick(10)
      }
      const inbox = JSON.parse(readFileSync(join(inboxDir, found), 'utf8'))
      writeFileSync(join(replyDir, `${inbox.ticket}.json`), JSON.stringify({ answer: 'legacy-ok' }), 'utf8')
      const r = await consultPromise
      assert.equal(r.status, 'replied')
      assert.equal(r.reply, 'legacy-ok')
      assert.equal(r.reply_kind, 'legacy')
    } finally { cleanup() }
  } finally {
    if (old === undefined) delete process.env.HERMES_LINK_TRUST_LEGACY
    else process.env.HERMES_LINK_TRUST_LEGACY = old
  }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)