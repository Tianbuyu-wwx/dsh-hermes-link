#!/usr/bin/env node
// scripts/test-doctor.mjs
//
// D (v0.6.0) - the doctor + the consult backlog sweep (B6).
//
// The point of the doctor is that it REPORTS the two failure shapes the audit
// found by hand: consult tickets sitting unanswered for weeks, and an "enabled"
// session mirror that has stopped growing. Both are measured here against
// synthetic homes with controlled mtimes.

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'packages', 'dsh-hermes-link')
const { runDoctor, renderDoctor, DOCTOR_TTLS } = await import(pathToFileURL(join(pkg, 'services', 'doctor.mjs')).href)
const { createConsultClient, DEFAULT_TICKET_TTL_MS, planConsultTimeout } = await import(pathToFileURL(join(pkg, 'services', 'consult-hermes.mjs')).href)

let passed = 0, failed = 0
async function t(name, fn) {
  try { await fn(); console.log('  ok ' + name); passed++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); failed++ }
}

function fixture({ heartbeat = true } = {}) {
  const hermesHome = mkdtempSync(join(tmpdir(), 'dsh-hl-doc-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-hl-doc-state-'))
  // A running plugin is the normal case: without it every other channel is
  // frozen, and the doctor says so (covered by its own case below).
  if (heartbeat) {
    mkdirSync(join(hermesHome, 'inbox', 'dsh', 'heartbeat'), { recursive: true })
    writeFileSync(join(hermesHome, 'inbox', 'dsh', 'heartbeat', 'latest.json'), JSON.stringify({ ts: Date.now(), pid: 4242 }), 'utf8')
  }
  return {
    hermesHome, dshHome,
    cleanup() { for (const d of [hermesHome, dshHome]) { try { rmSync(d, { recursive: true, force: true }) } catch (_e) { /* best-effort */ } } },
  }
}
const writeJson = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); return p }
const age = (p, ms) => { const s = (Date.now() - ms) / 1000; utimesSync(p, s, s) }
const check = (report, id) => report.checks.find((c) => c.id === id)

// -----------------------------------------------------------------------------

await t('heartbeat: missing dir -> fail, fresh -> ok, silent for 10m -> warn', async () => {
  const f = fixture({ heartbeat: false })
  try {
    let r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(check(r, 'heartbeat').status, 'fail')

    const beat = writeJson(join(f.hermesHome, 'inbox', 'dsh', 'heartbeat', 'latest.json'), { ts: Date.now(), pid: 4242 })
    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(check(r, 'heartbeat').status, 'ok')
    assert.match(check(r, 'heartbeat').detail, /last pid 4242/)

    // A stalled plugin writes BOTH an old ts and an old mtime; latest.json's ts
    // is authoritative, so the fixture must age the payload too.
    writeJson(beat, { ts: Date.now() - 10 * 60 * 1000, pid: 4242 })
    age(beat, 10 * 60 * 1000)
    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(check(r, 'heartbeat').status, 'warn')
    assert.match(check(r, 'heartbeat').hint, /not running/)
  } finally { f.cleanup() }
})

await t('consult: stale tickets are reported with their age, fresh ones are not', async () => {
  const f = fixture()
  try {
    const consultDir = join(f.hermesHome, 'inbox', 'dsh', 'consult')
    const oldTs = Date.now() - 26 * 24 * 3600 * 1000
    writeJson(join(consultDir, oldTs + '-t-old-1.json'), { ticket: 't-old-1', ts: oldTs, source: 'dsh', kind: 'consult', prompt: 'probe from audit' })
    writeJson(join(consultDir, (oldTs + 1000) + '-t-old-2.json'), { ticket: 't-old-2', ts: oldTs + 1000, source: 'dsh', kind: 'consult' })
    writeJson(join(consultDir, Date.now() + '-t-fresh.json'), { ticket: 't-fresh', ts: Date.now(), source: 'dsh', kind: 'consult' })

    const r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    const c = check(r, 'consult')
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /2 ticket\(s\) older than 24h/)
    assert.match(c.detail, /oldest 26d/)
    assert.equal(c.data.stale.length, 2)
    assert.equal(r.summary.fail, 0)
  } finally { f.cleanup() }
})

await t('consult: a replied ticket is not backlog', async () => {
  const f = fixture()
  try {
    const oldTs = Date.now() - 30 * 24 * 3600 * 1000
    writeJson(join(f.hermesHome, 'inbox', 'dsh', 'consult', oldTs + '-t-1.json'), { ticket: 't-1', ts: oldTs, kind: 'consult' })
    writeJson(join(f.hermesHome, 'inbox', 'dsh', 'consult-reply', 't-1-abcdef0123456789.json'), { answer: 'late but valid' })
    const r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(check(r, 'consult').status, 'ok')
  } finally { f.cleanup() }
})

await t('consult sweep: marks stale tickets non-destructively, is idempotent', async () => {
  const f = fixture()
  try {
    const client = createConsultClient({ hermesHome: f.hermesHome })
    const oldTs = Date.now() - 3 * 24 * 3600 * 1000
    const ticketFile = join(client.inboxDir, oldTs + '-t-sweep.json')
    writeJson(ticketFile, { ticket: 't-sweep', ts: oldTs, kind: 'consult' })
    const now = Date.now()

    const dry = client.sweepStaleTickets({ apply: false, now })
    assert.equal(dry.stale.length, 1)
    assert.equal(dry.expired[0].would_write, true)
    assert.equal(existsSync(join(client.inboxDir, 't-sweep.expired.json')), false, 'report-only mode writes nothing')

    const first = client.sweepStaleTickets({ apply: true, now })
    assert.equal(first.expired.length, 1)
    assert.equal(first.expired[0].already_marked, false)
    const marker = join(client.inboxDir, 't-sweep.expired.json')
    assert.equal(existsSync(marker), true)
    const markerBody = JSON.parse(readFileSync(marker, 'utf8'))
    assert.equal(markerBody.ticket, 't-sweep')
    assert.equal(markerBody.kind, 'consult-expired')
    assert.equal(existsSync(ticketFile), true, 'the ticket itself is never deleted (a late reply is still valid)')

    const second = client.sweepStaleTickets({ apply: true, now })
    assert.equal(second.expired.length, 1)
    assert.equal(second.expired[0].already_marked, true, 'idempotent')
    assert.equal(second.scanned, 1, 'the .expired.json marker is not itself scanned')
  } finally { f.cleanup() }
})

await t('mirror: an enabled session whose file stopped growing is called out', async () => {
  const f = fixture()
  try {
    const mirrorDir = join(f.hermesHome, 'inbox', 'dsh', 'session-mirror')
    const file = writeJson(join(mirrorDir, 'session-a.jsonl'), { ts: 1, cursor: 1, source: 'dsh', origin_session_id: 'session-a', event: { type: 'assistant/message', seq: 1 } })
    writeJson(join(f.dshHome, 'dsh-hermes-link', 'session-mirror-state.json'), { version: 1, sessions: { 'session-a': { session_id: 'session-a', source: 'policy', enabled_at: Date.now() } }, opt_out: {} })

    age(file, 30 * 60 * 1000)
    let r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    let c = check(r, 'mirror_active')
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /enabled but idle/)
    assert.match(c.hint, /stopped growing/)

    age(file, 30 * 1000)
    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    c = check(r, 'mirror_active')
    assert.equal(c.status, 'ok')
    assert.match(c.detail, /all advancing/)
  } finally { f.cleanup() }
})

await t('mirror: enabled sessions with no file at all is the "dead mirror" case', async () => {
  const f = fixture()
  try {
    writeJson(join(f.dshHome, 'dsh-hermes-link', 'session-mirror-state.json'), { version: 1, sessions: { 'session-x': { source: 'policy' }, 'session-y': { source: 'policy' } }, opt_out: {} })
    const r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    const c = check(r, 'mirror_active')
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /2 session\(s\) enabled in state, 0 active/)
    assert.match(c.hint, /HERMES_LINK_MIRROR_PROJECTS/)
  } finally { f.cleanup() }
})

await t('mirror policy: the live policy is reported, and off is a warning', async () => {
  const f = fixture()
  try {
    let r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome, live: { mirrorPolicy: { policy: 'scoped', auto_enabled_sessions: 2, opted_out_sessions: 1, extra_projects: ['e:/x'] } } })
    let c = check(r, 'mirror_policy')
    assert.equal(c.status, 'ok')
    assert.match(c.detail, /policy=scoped/)
    assert.match(c.detail, /extra_projects=1/)

    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome, live: { mirrorPolicy: { policy: 'off', auto_enabled_sessions: 0, opted_out_sessions: 0 } } })
    assert.equal(check(r, 'mirror_policy').status, 'warn')
  } finally { f.cleanup() }
})

await t('outbox: pending retries and a last_error are both surfaced', async () => {
  const f = fixture()
  try {
    let r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(check(r, 'hermes_outbox').status, 'ok')

    writeJson(join(f.dshHome, 'dsh-hermes-link', 'hermes-outbox-consumed.json'), { version: 1, consumed: { 'hermes:a': 1 }, attempts: { 'b.json': 2 } })
    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    const c = check(r, 'hermes_outbox')
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /pending retries=1/)

    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome, live: { outboxStats: { last_error: 'importer unavailable' } } })
    assert.match(check(r, 'hermes_outbox').detail, /last_error=importer unavailable/)
  } finally { f.cleanup() }
})

await t('imported model pins: injected scan drives the relapse check', async () => {
  const f = fixture()
  try {
    let r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome, scanImportedPins: async () => ({ scanned: 5, missing: [] }) })
    assert.equal(check(r, 'imported_model_pin').status, 'ok')

    r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome, scanImportedPins: async () => ({ scanned: 5, missing: ['hermes-a', 'hermes-b'] }) })
    const c = check(r, 'imported_model_pin')
    assert.equal(c.status, 'warn')
    assert.match(c.detail, /2\/5 imported session\(s\) have no routable model\/selection/)
    assert.match(c.hint, /repair-imported-model-selection/)
  } finally { f.cleanup() }
})

await t('report shape: summary, ok flag, renderer, and the amend probe', async () => {
  const f = fixture()
  try {
    const r = await runDoctor({ hermesHome: f.hermesHome, dshHome: f.dshHome })
    assert.equal(r.ok, r.summary.fail === 0)
    assert.equal(typeof r.generated_at, 'number')
    assert.ok(r.checks.length >= 7)
    assert.equal(check(r, 'amend_dir').status, 'ok')
    assert.equal(existsSync(join(f.hermesHome, 'inbox', 'dsh', 'amend', '.doctor-probe')), false, 'the probe file is cleaned up')
    const text = renderDoctor(r)
    assert.match(text, /dsh-hermes-link doctor/)
    assert.match(text, /ok, .* warn, .* fail/)
    assert.ok(DOCTOR_TTLS.heartbeatMs > 0 && DEFAULT_TICKET_TTL_MS === 24 * 60 * 60 * 1000)
  } finally { f.cleanup() }
})

await t('consult health: a stale backlog with no reply is DEAD, a reply makes it degraded', async () => {
  const f = fixture()
  try {
    const client = createConsultClient({ hermesHome: f.hermesHome })
    const oldTs = Date.now() - 26 * 24 * 3600 * 1000
    writeJson(join(client.inboxDir, oldTs + '-t-a.json'), { ticket: 't-a', ts: oldTs, kind: 'consult' })

    let h = client.channelHealth()
    assert.equal(h.verdict, 'dead')
    assert.equal(h.stale, 1)
    assert.match(h.note, /gateway/)

    // A reply on disk answers THAT ticket: it stops being backlog, so the channel
    // is healthy again (the reply is simply not consumed yet).
    writeJson(join(client.replyDir, 't-a-abcdef0123456789.json'), { answer: 'ok' })
    h = client.channelHealth()
    assert.equal(h.verdict, 'healthy')
    assert.equal(h.stale, 0)
    assert.equal(typeof h.last_reply_at, 'number')

    // Degraded is the middle state: an older ticket still unanswered while Hermes
    // demonstrably answered something recently.
    const olderTs = Date.now() - 30 * 24 * 3600 * 1000
    writeJson(join(client.inboxDir, olderTs + '-t-b.json'), { ticket: 't-b', ts: olderTs, kind: 'consult' })
    writeJson(join(client.inboxDir, Date.now() + '-t-c.json'), { ticket: 't-c', ts: Date.now(), kind: 'consult' })
    writeJson(join(client.replyDir, 't-c-abcdef0123456789.json'), { answer: 'fresh answer' })
    h = client.channelHealth()
    assert.equal(h.verdict, 'degraded')
    assert.equal(h.stale, 1)
  } finally { f.cleanup() }
})

await t('consult health: an empty inbox is healthy', async () => {
  const f = fixture()
  try {
    const client = createConsultClient({ hermesHome: f.hermesHome })
    const h = client.channelHealth()
    assert.equal(h.verdict, 'healthy')
    assert.equal(h.stale, 0)
    assert.equal(h.last_reply_at, null)
  } finally { f.cleanup() }
})

await t('consult timeout plan: a dead channel waits 2s, an explicit timeout still wins', () => {
  const dead = { verdict: 'dead', note: 'three stale tickets' }
  const healthy = { verdict: 'healthy', note: 'nothing pending' }
  assert.equal(planConsultTimeout({ health: dead, requestedMs: 15000, explicit: false }).timeoutMs, 2000)
  assert.match(planConsultTimeout({ health: dead, requestedMs: 15000, explicit: false }).warning, /DEAD/)
  assert.equal(planConsultTimeout({ health: dead, requestedMs: 15000, explicit: true }).timeoutMs, 15000, 'the caller overrides the judgement')
  assert.equal(planConsultTimeout({ health: dead, requestedMs: 1000, explicit: false }).timeoutMs, 1000, 'never longer than requested')
  assert.equal(planConsultTimeout({ health: healthy, requestedMs: 15000, explicit: false }).timeoutMs, 15000)
  assert.equal(planConsultTimeout({ health: healthy, requestedMs: 15000, explicit: false }).warning, null)
  assert.equal(planConsultTimeout({}).timeoutMs, 15000)
})

console.log('')
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
