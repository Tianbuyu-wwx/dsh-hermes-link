#!/usr/bin/env node
// scripts/test-hermes-outbox-consumer.mjs
//
// C1/C2/C3 (v0.6.0) - the reverse direction Hermes -> DSH.
//
// C1: Hermes Home/outbox/hermes/**.json is consumed, executed, and archived into
//     done/ -- with the amend-watcher conventions (everything leaves the scan
//     set except a delivery that still has retries left).
// C2: every mirrored JSONL line carries an explicit `cursor` (the DSH event seq)
//     so Hermes can resume with since_seq instead of rescanning the file.
// C3: (source,id) is remembered across restarts, and a notification written by
//     DSH itself (source=dsh) is never executed.
//
// Cases: notify / import / duplicate / restart-dedupe / echo / malformed /
//        missing-id / unknown-kind / bad-payload / retry-then-park /
//        nested task-event dir / non-json ignored / mirror cursor+provenance.

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'packages', 'dsh-hermes-link')
const {
  createHermesOutboxConsumer,
  validateNotification,
  SUPPORTED_KINDS,
  DEFAULT_MAX_ATTEMPTS,
} = await import(pathToFileURL(join(pkg, 'services', 'hermes-outbox-consumer.mjs')).href)
const { createOutbox } = await import(pathToFileURL(join(pkg, 'services', 'outbox.mjs')).href)

let passed = 0, failed = 0
async function t(name, fn) {
  try { await fn(); console.log('  ok ' + name); passed++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); failed++ }
}

const OLD_DSH_HOME = process.env.DSH_HOME

function makeEnv() {
  const hermesHome = mkdtempSync(join(tmpdir(), 'dsh-hl-ob-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-hl-ob-state-'))
  process.env.DSH_HOME = dshHome
  return {
    hermesHome,
    dshHome,
    outboxDir: join(hermesHome, 'outbox', 'hermes'),
    doneDir: join(hermesHome, 'outbox', 'hermes', 'done'),
    cleanup() {
      if (OLD_DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = OLD_DSH_HOME
      for (const d of [hermesHome, dshHome]) { try { rmSync(d, { recursive: true, force: true }) } catch (_e) { /* best-effort */ } }
    },
  }
}

const writeNotification = (dir, name, payload) => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  return p
}
const makeConsumer = (env, extra = {}) => createHermesOutboxConsumer({
  hermesHome: env.hermesHome,
  autoStart: false,                    // no timers/watchers in tests
  importer: extra.importer,
  broker: extra.broker,
  metrics: extra.metrics,
  maxAttempts: extra.maxAttempts,
  retryWindowMs: extra.retryWindowMs,
})
const doneNames = (env) => { try { return readdirSync(env.doneDir) } catch { return [] } }
const fakeImporter = (results) => {
  const calls = []
  return {
    calls,
    async importSession(sessionId, opts) {
      calls.push({ sessionId, opts })
      const r = results ? results[Math.min(calls.length - 1, results.length - 1)] : 'created'
      return r === 'created' || r === 'already_imported'
        ? { status: r, sessionId: 'hermes-' + sessionId }
        : { status: typeof r === 'string' ? r : 'import_failed', error: 'boom' }
    },
  }
}

// -----------------------------------------------------------------------------
// the pure validation matrix
// -----------------------------------------------------------------------------

await t('validate: kind + id + source are enforced', () => {
  assert.deepEqual(SUPPORTED_KINDS, ['import', 'notify', 'ping'])
  assert.equal(validateNotification(null).archiveAs, 'malformed')
  assert.equal(validateNotification([]).archiveAs, 'malformed')
  assert.equal(validateNotification({ kind: 'notify' }).archiveAs, 'no-id')
  assert.equal(validateNotification({ id: 'x'.repeat(300), kind: 'notify' }).archiveAs, 'no-id')
  assert.equal(validateNotification({ id: 'a', source: 'DSH', kind: 'notify' }).reason, 'echo_source_dsh')
  assert.equal(validateNotification({ id: 'a' }).reason, 'missing_kind')
  assert.equal(validateNotification({ id: 'a', kind: 'launch-missiles' }).archiveAs, 'unsupported')
  assert.equal(validateNotification({ id: 'a', kind: 'import' }).archiveAs, 'bad-payload')
  const ok = validateNotification({ id: ' a ', kind: 'IMPORT', session_id: ' s1 ' })
  assert.equal(ok.ok, true)
  assert.deepEqual([ok.value.id, ok.value.kind, ok.value.session_id, ok.value.source], ['a', 'import', 's1', 'hermes'])
})

// -----------------------------------------------------------------------------
// C1: consumption + archiving
// -----------------------------------------------------------------------------

await t('notify: executed, archived into done/, published on the broker', async () => {
  const env = makeEnv()
  try {
    const published = []
    const c = makeConsumer(env, { broker: { publish: (ch, msg) => published.push([ch, msg]) } })
    writeNotification(env.outboxDir, 'n1.json', { id: 'n-1', source: 'hermes', kind: 'notify', task_id: 't-9', payload: { hello: 'world' } })
    const r = await c.scanOnce()
    assert.equal(r.scanned, 1)
    assert.equal(c.stats().executed, 1)
    assert.deepEqual(doneNames(env), ['n1.json'], 'the file left the scan set')
    assert.equal(existsSync(join(env.outboxDir, 'n1.json')), false)
    assert.equal(published.length, 1)
    assert.equal(published[0][0], 'hermes-outbox')
    assert.equal(published[0][1].data.id, 'n-1')
    c.dispose()
  } finally { env.cleanup() }
})

await t('import: drives the importer once and archives the notification', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const c = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'i1.json', { id: 'i-1', kind: 'import', session_id: '20260916_120000_abc123' })
    await c.scanOnce()
    assert.equal(importer.calls.length, 1)
    assert.equal(importer.calls[0].sessionId, '20260916_120000_abc123')
    assert.equal(c.stats().executed, 1)
    assert.deepEqual(doneNames(env), ['i1.json'])
    c.dispose()
  } finally { env.cleanup() }
})

await t('a UTF-8 BOM (PowerShell Set-Content / Notepad) does not reject the file', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const c = makeConsumer(env, { importer })
    mkdirSync(env.outboxDir, { recursive: true })
    writeFileSync(join(env.outboxDir, 'bom.json'), '\uFEFF' + JSON.stringify({ id: 'bom-1', kind: 'import', session_id: 's-bom' }), 'utf8')
    await c.scanOnce()
    assert.equal(importer.calls.length, 1, 'a BOM is an accident, not corruption')
    assert.equal(c.stats().executed, 1)
    assert.equal(c.stats().archived, 0)
    assert.deepEqual(doneNames(env), ['bom.json'])
    c.dispose()
  } finally { env.cleanup() }
})

await t('import: a workspace hint in the payload is forwarded to the importer', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['already_imported'])
    const c = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'i2.json', { id: 'i-2', kind: 'import', session_id: 's-2', payload: { workspace: 'E:/tmp/proj' } })
    await c.scanOnce()
    assert.deepEqual(importer.calls[0].opts, { workspace: 'E:/tmp/proj' })
    c.dispose()
  } finally { env.cleanup() }
})

await t('nested task-event/ is scanned (the layout the plan promises)', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const c = makeConsumer(env, { importer })
    writeNotification(join(env.outboxDir, 'task-event'), 't1.json', { id: 't-1', kind: 'import', session_id: 's-3' })
    await c.scanOnce()
    assert.equal(importer.calls.length, 1)
    assert.deepEqual(doneNames(env), ['task-event__t1.json'])
    c.dispose()
  } finally { env.cleanup() }
})

await t('non-json files and the done/ dir itself are ignored', async () => {
  const env = makeEnv()
  try {
    const c = makeConsumer(env, { importer: fakeImporter() })
    mkdirSync(env.outboxDir, { recursive: true })
    writeFileSync(join(env.outboxDir, 'README.txt'), 'not a notification', 'utf8')
    writeNotification(env.doneDir, 'already-processed.json', { id: 'old', kind: 'notify' })
    const r = await c.scanOnce()
    assert.equal(r.scanned, 0)
    assert.equal(c.stats().executed, 0)
    assert.equal(existsSync(join(env.doneDir, 'already-processed.json')), true, 'done/ is never reprocessed')
    c.dispose()
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// C3: idempotency
// -----------------------------------------------------------------------------

await t('duplicate id: executed once, the redelivery is archived as duplicate-*', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const c = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'd1.json', { id: 'same-id', kind: 'import', session_id: 's-4' })
    writeNotification(env.outboxDir, 'd2.json', { id: 'same-id', kind: 'import', session_id: 's-4' })
    await c.scanOnce()
    assert.equal(importer.calls.length, 1, 'the second delivery must not re-import')
    assert.equal(c.stats().duplicates, 1)
    assert.equal(doneNames(env).filter((n) => n.startsWith('duplicate-')).length, 1)
    c.dispose()
  } finally { env.cleanup() }
})

await t('restart: the consumed-id ledger survives, so a redelivery stays a no-op', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const first = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'r1.json', { id: 'restart-id', kind: 'import', session_id: 's-5' })
    await first.scanOnce()
    first.dispose()
    assert.equal(importer.calls.length, 1)

    const second = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'r2.json', { id: 'restart-id', kind: 'import', session_id: 's-5' })
    await second.scanOnce()
    assert.equal(importer.calls.length, 1, 'the ledger must survive dispose()/reconstruction')
    assert.equal(second.stats().duplicates, 1)
    second.dispose()
  } finally { env.cleanup() }
})

await t('echo: source=dsh is never executed', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['created'])
    const c = makeConsumer(env, { importer })
    writeNotification(env.outboxDir, 'e1.json', { id: 'echo-1', source: 'dsh', kind: 'import', session_id: 's-6' })
    await c.scanOnce()
    assert.equal(importer.calls.length, 0)
    assert.equal(c.stats().archived, 1)
    assert.ok(doneNames(env).some((n) => n.startsWith('echo-')), 'archived with an echo- prefix')
    c.dispose()
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// failure handling
// -----------------------------------------------------------------------------

await t('malformed / missing id / unsupported kind / bad payload are all parked', async () => {
  const env = makeEnv()
  try {
    const c = makeConsumer(env, { importer: fakeImporter() })
    writeNotification(env.outboxDir, 'm1.json', '{ this is not json')
    writeNotification(env.outboxDir, 'm2.json', { kind: 'notify' })
    writeNotification(env.outboxDir, 'm3.json', { id: 'k-1', kind: 'left-pad' })
    writeNotification(env.outboxDir, 'm4.json', { id: 'k-2', kind: 'import' })
    await c.scanOnce()
    const names = doneNames(env)
    assert.ok(names.some((n) => n.startsWith('malformed-')), 'malformed JSON -> malformed-*')
    assert.ok(names.some((n) => n.startsWith('no-id-')), 'missing id -> no-id-*')
    assert.ok(names.some((n) => n.startsWith('unsupported-')), 'unknown kind -> unsupported-*')
    assert.ok(names.some((n) => n.startsWith('bad-payload-')), 'import without session_id -> bad-payload-*')
    assert.equal(names.length, 4, 'every rejected file left the scan set')
    assert.equal(c.stats().executed, 0)
    c.dispose()
  } finally { env.cleanup() }
})

await t('transient failure: retried in place, then parked as failed-* after maxAttempts', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['import_failed'])
    const c = makeConsumer(env, { importer, maxAttempts: 2, retryWindowMs: 0 })   // no time budget: park as soon as attempts run out
    const p = writeNotification(env.outboxDir, 'f1.json', { id: 'f-1', kind: 'import', session_id: 's-7' })

    await c.scanOnce()
    assert.equal(existsSync(p), true, 'attempt 1 keeps the file for a retry')
    assert.equal(doneNames(env).length, 0)
    assert.equal(c.stats().failed, 1)
    assert.equal(c.stats().pending_retries, 1)

    await c.scanOnce()
    assert.equal(existsSync(p), false, 'attempt 2 (== maxAttempts) parks it')
    assert.ok(doneNames(env).some((n) => n.startsWith('failed-')), 'parked as failed-*')
    assert.equal(c.stats().pending_retries, 0)
    assert.match(c.stats().last_error, /boom/)
    c.dispose()
  } finally { env.cleanup() }
})

await t('import with no importer mounted fails loudly and keeps retries bounded', async () => {
  const env = makeEnv()
  try {
    const c = makeConsumer(env, { maxAttempts: 1, retryWindowMs: 0 })
    writeNotification(env.outboxDir, 'n1.json', { id: 'no-imp', kind: 'import', session_id: 's-8' })
    await c.scanOnce()
    assert.match(c.stats().last_error, /importer unavailable/)
    assert.ok(doneNames(env).some((n) => n.startsWith('failed-')))
    c.dispose()
    assert.ok(DEFAULT_MAX_ATTEMPTS >= 1)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// C2: the mirror line contract Hermes resumes from
// -----------------------------------------------------------------------------

await t('mirror lines carry cursor + source + origin_session_id (the resume contract)', async () => {
  const env = makeEnv()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    assert.equal(ob.appendSessionEvent('session-abc', { type: 'assistant/message', seq: 41, time: 1, data: { content: [] } }), true)
    assert.equal(ob.appendSessionEvent('session-abc', { type: 'assistant/message', seq: 42, time: 2, data: { content: [] } }), true)
    ob.flushNow()
    const file = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror', 'session-abc.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].cursor, 41, 'cursor is the DSH event seq Hermes resumes from')
    assert.equal(lines[1].cursor, 42)
    assert.equal(lines[0].source, 'dsh')
    assert.equal(lines[0].origin_session_id, 'session-abc')
    assert.equal(lines[1].event.seq, 42, 'the raw event is still there for existing readers')
    assert.ok(lines[1].cursor >= lines[0].cursor, 'cursor never goes backwards within a file')
    assert.equal(typeof lines[0].ts, 'number')
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// The Hermes-side producer: installer + the contract it must keep
// -----------------------------------------------------------------------------

await t('producer: the installer copies the plugin into <hermes home>/plugins', async () => {
  const env = makeEnv()
  try {
    const home = join(env.dshHome, 'fake-hermes-home')
    mkdirSync(home, { recursive: true })
    const installer = join(root, 'packages', 'dsh-hermes-link', 'bin', 'hermes-link-install-hermes-plugin.mjs')
    // stdio:'ignore' keeps this sandbox-friendly (piped child stdio is blocked here).
    const r = spawnSync(process.execPath, [installer, '--hermes-home', home], { stdio: 'ignore' })
    assert.equal(r.status, 0, 'installer exited ' + r.status)
    assert.equal(existsSync(join(home, 'plugins', 'dsh-link', 'plugin.yaml')), true)
    assert.equal(existsSync(join(home, 'plugins', 'dsh-link', '__init__.py')), true)

    const dry = spawnSync(process.execPath, [installer, '--hermes-home', join(env.dshHome, 'nope')], { stdio: 'ignore' })
    assert.equal(dry.status, 2, 'a missing Hermes home is a usage error, not a silent success')
  } finally { env.cleanup() }
})

await t('bridge: the Hermes plugin keeps both contracts DSH depends on', () => {
  const dir = join(root, 'packages', 'dsh-hermes-link', 'hermes-plugin', 'dsh-link')
  const yaml = readFileSync(join(dir, 'plugin.yaml'), 'utf8')
  const py = readFileSync(join(dir, '__init__.py'), 'utf8')
  assert.match(yaml, /^name:\s*dsh-link$/m)
  assert.match(yaml, /on_session_end/, 'the manifest must declare the hook it registers')
  assert.match(py, /def register\(ctx\)/)
  assert.match(py, /register_hook\("on_session_end"/)
  assert.match(py, /register_command\("dsh-notify"/)
  // bare UTF-8 (never a BOM -- JSON.parse on the DSH side refuses one) + atomic drop
  assert.match(py, /encode\("utf-8"\)/)
  // Reading tolerates a BOM written by other tooling; WRITING must never add one.
  assert.match(py, /read_text\(encoding="utf-8-sig"\)/, 'reads tolerate foreign BOMs')
  assert.doesNotMatch(py, /write[^\n]*utf-8-sig/, 'writes must never add a BOM')
  assert.match(py, /os\.replace\(/, 'files must appear atomically')
  for (const kind of ['import', 'notify']) assert.match(py, new RegExp('"' + kind + '"'), 'kind ' + kind + ' is part of the protocol')
  // the consult half: answer tickets through the host LLM facade and leave the
  // durable marker DSH relies on once the reply file has been consumed
  assert.match(py, /register_command\("dsh-consult"/)
  // v0.6.8: an import notification is only written when the importer can read the
  // session (a dump exists) -- otherwise every turn of a sub-agent session parks a
  // guaranteed `not_found` in done/.
  assert.match(py, /def has_dump\(session_id: str\)/)
  assert.match(py, /if has_dump\(session_id\):/)
  assert.match(py, /ctx\.llm\.complete\(/)
  assert.match(py, /reply_secret/)
  assert.match(py, /\.["']?\)?\s*%\s*ticket_id|answered\.json/, 'the answered marker is written next to the ticket')
})

await t('consult: an answered marker counts as answered after the reply is consumed', async () => {
  const env = makeEnv()
  try {
    const { createConsultClient } = await import(pathToFileURL(join(pkg, 'services', 'consult-hermes.mjs')).href)
    const client = createConsultClient({ hermesHome: env.hermesHome })
    const ticket = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const oldTs = Date.now() - 30 * 24 * 3600 * 1000
    writeNotification(client.inboxDir, oldTs + '-' + ticket + '.json', { ticket, ts: oldTs, kind: 'consult', prompt: 'old' })
    mkdirSync(client.inboxDir, { recursive: true })
    writeFileSync(join(client.inboxDir, ticket + '.answered.json'), JSON.stringify({ ticket, kind: 'consult-answered' }), 'utf8')

    const sweep = client.sweepStaleTickets({ apply: false })
    assert.equal(sweep.stale.length, 0, 'an answered ticket is not backlog')
    assert.equal(sweep.replied, 1)

    const health = client.channelHealth()
    assert.equal(health.verdict, 'healthy')
    assert.equal(health.answered_markers, 1)
    assert.equal(typeof health.last_reply_at, 'number')

    // A separate abandoned ticket plus that recent answer = degraded, never dead.
    const other = 'ffffffff-1111-2222-3333-444444444444'
    writeNotification(client.inboxDir, oldTs + '-' + other + '.json', { ticket: other, ts: oldTs, kind: 'consult' })
    const degraded = client.channelHealth()
    assert.equal(degraded.verdict, 'degraded')
    assert.equal(degraded.stale, 1)
    assert.match(degraded.note, /abandoned ticket\(s\), but Hermes answered/)
  } finally { env.cleanup() }
})

await t('consumer: a file that vanished before it could be read is not an error', async () => {
  const env = makeEnv()
  try {
    const c = makeConsumer(env, { importer: fakeImporter() })
    const r = await c.handleFile(join(env.outboxDir, 'never-existed.json'), 'never-existed.json')
    assert.equal(r.outcome, 'gone')
    assert.equal(c.stats().last_error, null, 'a benign race must not stick in last_error')
    assert.equal(c.stats().gone, 1)
    c.dispose()
  } finally { env.cleanup() }
})

await t('retry window: attempts alone no longer park a "not yet" failure', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['import_failed'])
    // maxAttempts 1 + a 30-minute budget: one failure must NOT park the file.
    const c = makeConsumer(env, { importer, maxAttempts: 1, retryWindowMs: 30 * 60 * 1000 })
    const p = writeNotification(env.outboxDir, 'w1.json', { id: 'w-1', kind: 'import', session_id: 's-w' })
    await c.scanOnce()
    assert.equal(existsSync(p), true, 'the dump may still be on its way')
    assert.equal(c.stats().pending_retries, 1)
    assert.equal(c.stats().failed, 1)
    assert.equal(doneNames(env).length, 0)
    c.dispose()

    // Same file, but the record says the wait started an hour ago: now it parks.
    const statePath = join(env.dshHome, 'dsh-hermes-link', 'hermes-outbox-consumed.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.attempts['w1.json'] = { n: 5, first: Date.now() - 60 * 60 * 1000 }
    writeFileSync(statePath, JSON.stringify(state), 'utf8')

    const c2 = makeConsumer(env, { importer, maxAttempts: 1, retryWindowMs: 30 * 60 * 1000 })
    await c2.scanOnce()
    assert.equal(existsSync(p), false, 'both budgets spent -> parked')
    assert.ok(doneNames(env).some((n) => n.startsWith('failed-')), 'parked as failed-*')
    assert.equal(c2.stats().pending_retries, 0)
    c2.dispose()
  } finally { env.cleanup() }
})

await t('retry window: an old numeric attempt record is still understood', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['import_failed'])
    mkdirSync(join(env.dshHome, 'dsh-hermes-link'), { recursive: true })
    writeFileSync(join(env.dshHome, 'dsh-hermes-link', 'hermes-outbox-consumed.json'),
      JSON.stringify({ version: 1, consumed: {}, attempts: { 'old.json': 2 } }), 'utf8')
    writeNotification(env.outboxDir, 'old.json', { id: 'old-1', kind: 'import', session_id: 's-old' })
    const c = makeConsumer(env, { importer, maxAttempts: 3, retryWindowMs: 30 * 60 * 1000 })
    await c.scanOnce()
    assert.equal(c.stats().pending_retries, 1, 'the legacy number is upgraded, not dropped')
    assert.equal(c.stats().archived, 0, 'and it does not park on the first failure')
    c.dispose()
  } finally { env.cleanup() }
})

await t('last_error clears once a notification succeeds again', async () => {
  const env = makeEnv()
  try {
    const importer = fakeImporter(['import_failed', 'created'])
    const c = makeConsumer(env, { importer, maxAttempts: 5, retryWindowMs: 60 * 60 * 1000 })
    writeNotification(env.outboxDir, 'l1.json', { id: 'l-1', kind: 'import', session_id: 's-l' })
    await c.scanOnce()
    assert.match(c.stats().last_error, /boom/, 'the failure is reported')
    await c.scanOnce()
    assert.equal(c.stats().last_error, null, 'a resolved failure must not keep the doctor warning')
    assert.equal(c.stats().executed, 1)
    c.dispose()
  } finally { env.cleanup() }
})

await t('consult purge: only marked-abandoned tickets go, evidence stays', async () => {
  const env = makeEnv()
  try {
    const { createConsultClient } = await import(pathToFileURL(join(pkg, 'services', 'consult-hermes.mjs')).href)
    const client = createConsultClient({ hermesHome: env.hermesHome })
    mkdirSync(client.inboxDir, { recursive: true })
    const old = Date.now() - 30 * 24 * 3600 * 1000
    const abandoned = 'aaaaaaaa-0000-0000-0000-000000000001'
    const answered = 'bbbbbbbb-0000-0000-0000-000000000002'
    const fresh = 'cccccccc-0000-0000-0000-000000000003'
    writeNotification(client.inboxDir, old + '-' + abandoned + '.json', { ticket: abandoned, ts: old, kind: 'consult', prompt: 'old' })
    writeFileSync(join(client.inboxDir, abandoned + '.expired.json'), '{}', 'utf8')
    writeNotification(client.inboxDir, old + '-' + answered + '.json', { ticket: answered, ts: old, kind: 'consult', prompt: 'old but answered' })
    writeFileSync(join(client.inboxDir, answered + '.answered.json'), '{}', 'utf8')
    writeNotification(client.inboxDir, Date.now() + '-' + fresh + '.json', { ticket: fresh, ts: Date.now(), kind: 'consult', prompt: 'live' })

    const dry = client.purgeExpiredTickets({ apply: false })
    assert.equal(dry.candidates.length, 1, 'only the marked-abandoned ticket qualifies')
    assert.equal(dry.candidates[0].ticket, abandoned)
    assert.equal(existsSync(join(client.inboxDir, old + '-' + abandoned + '.json')), true, 'a dry run deletes nothing')
    assert.ok(dry.skipped.some((s) => s.reason === 'still_open'), 'a live ticket is never touched')
    assert.ok(dry.skipped.some((s) => s.reason === 'has_reply_or_marker'))

    const applied = client.purgeExpiredTickets({ apply: true })
    assert.equal(applied.purged.length, 1)
    assert.equal(existsSync(join(client.inboxDir, old + '-' + abandoned + '.json')), false)
    assert.equal(existsSync(join(client.inboxDir, abandoned + '.expired.json')), false, 'the stale marker goes with it')
    assert.equal(existsSync(join(client.inboxDir, old + '-' + answered + '.json')), true, 'answered evidence stays')
    assert.equal(existsSync(join(client.inboxDir, Date.now() + '-' + fresh + '.json')), false, 'the live ticket is untouched (name uses its own ts)')
  } finally { env.cleanup() }
})

console.log('')
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
