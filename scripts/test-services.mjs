#!/usr/bin/env node
// scripts/test-services.mjs
// Unit tests for hermes-link services/outbox.mjs (D3/D6/D7/V4),
// services/continuations.mjs (P2-10 registry) and services/audit.mjs (D4).
// No DSH runtime required — temp dirs only, plus node:sqlite.

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outboxUrl  = pathToFileURL(join(root, 'packages', 'hermes-link', 'services', 'outbox.mjs')).href
const contUrl    = pathToFileURL(join(root, 'packages', 'hermes-link', 'services', 'continuations.mjs')).href
const auditUrl   = pathToFileURL(join(root, 'packages', 'hermes-link', 'services', 'audit.mjs')).href
const memUrl     = pathToFileURL(join(root, 'packages', 'hermes-link', 'services', 'hermes-project-memory.mjs')).href
const { createOutbox } = await import(outboxUrl)
const { openContinuations, waitForNextReply, validateAmendNonce } = await import(contUrl)
const { appendAudit, readAuditLines, auditPath, stateDir } = await import(auditUrl)
const { buildProjectMemorySlice } = await import(memUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-link-svc-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

// -- outbox -------------------------------------------------------------------

t('outbox D3: heartbeat writes latest.json with seq', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    const hb = ob.startHeartbeat(999999, { version: 'hermes-link/0.2' }) // no auto-fire
    const latest = join(home, 'inbox', 'dsh', 'heartbeat', 'latest.json')
    assert.ok(existsSync(latest), 'latest.json exists after immediate beat')
    const rec = JSON.parse(readFileSync(latest, 'utf8'))
    assert.equal(rec.kind, 'heartbeat')
    assert.equal(rec.seq, 1)
    assert.equal(hb.lastSeq(), 1)
    hb.stop()
  } finally { cleanup() }
})

t('outbox D6: appendUsage appends JSONL lines', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    ob.appendUsage({ kind: 'dispatch', task_id: 'a', tokens_used: 1 })
    ob.appendUsage({ kind: 'dispatch', task_id: 'b', tokens_used: 2 })
    const lines = readFileSync(join(home, 'inbox', 'dsh', 'usage.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]).task_id, 'b')
  } finally { cleanup() }
})

t('outbox D7: writeMemorySuggestion writes file with payload', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    const r = ob.writeMemorySuggestion({ text: 'remember X', tags: ['dsh'] })
    assert.equal(r.ok, true)
    const files = readdirSync(join(home, 'inbox', 'dsh', 'memory-suggest')).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 1)
    const rec = JSON.parse(readFileSync(join(home, 'inbox', 'dsh', 'memory-suggest', files[0]), 'utf8'))
    assert.equal(rec.text, 'remember X')
  } finally { cleanup() }
})

t('outbox V4: appendSessionEvent writes mirror JSONL (skips nothing here)', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    ob.appendSessionEvent('sess-1', { type: 'user/message', seq: 0 })
    ob.appendSessionEvent('sess-1', { type: 'assistant/message', seq: 1 })
    const lines = readFileSync(join(home, 'inbox', 'dsh', 'session-mirror', 'sess-1.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).event.type, 'user/message')
  } finally { cleanup() }
})

// -- continuations ------------------------------------------------------------

t('continuations: register → get/getByTaskId/list → update → reopen persists', () => {
  const state = mkdtempSync(join(tmpdir(), 'hermes-link-cont-'))
  try {
    const c1 = openContinuations(state)
    c1.register({
      child_id: 'child-1', task_id: 't-1', parent_agent_id: 'p-1', workspace: '',
      model: 'deepseek-v4-flash', model_tier: 'flash', skill: 'read',
      created_at: 1000, last_seen: 1000, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-1' },
    })
    assert.equal(c1.get('child-1').task_id, 't-1')
    assert.equal(c1.getByTaskId('t-1').child_id, 'child-1')
    assert.equal(c1.count(), 1)
    const listed = c1.list({ limit: 10 })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].is_live, true)
    c1.update('child-1', { status: 'idle', stop_reason: 'awaiting_next' })
    c1.close()

    // Reopen: registry must survive.
    const c2 = openContinuations(state)
    assert.equal(c2.count(), 1, 'registry persisted across reopen')
    assert.equal(c2.getByTaskId('t-1').status, 'idle')
    c2.close()
  } catch (e) { throw e } finally { try { rmSync(state, { recursive: true, force: true }) } catch {} }
})

// -- audit --------------------------------------------------------------------

t('audit: append + readAuditLines roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-link-audit-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    appendAudit({ kind: 'dispatch', task_id: 'x1' })
    appendAudit({ kind: 'consult', ticket: 'y2' })
    appendAudit({ kind: 'dispatch', task_id: 'x3' })
    assert.ok(existsSync(auditPath()))
    const lines = readAuditLines(20)
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[2]).task_id, 'x3')
    const tail1 = readAuditLines(1)
    assert.equal(JSON.parse(tail1[0]).task_id, 'x3')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

// -- continuations v0.2.2: amend_nonce round-trip ----------------------------

t('continuations v0.2.2: register mints amend_nonce, persists across reopen, validates', () => {
  const state = mkdtempSync(join(tmpdir(), 'hermes-link-cont-nonce-'))
  try {
    const c1 = openContinuations(state)
    const auto = c1.generateAmendNonce()
    assert.ok(auto.length === 32, 'default nonce is 32 hex chars')
    c1.register({
      child_id: 'c-n1', task_id: 't-n1', parent_agent_id: 'p-1', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1000, last_seen: 1000, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-n1' },
    })
    const stored = c1.get('c-n1').amendNonce
    assert.ok(stored.length === 32, 'register persisted a fresh nonce')
    assert.ok(c1.validateAmendNonce('t-n1', stored))
    assert.ok(!c1.validateAmendNonce('t-n1', 'bogus'))
    c1.close()
    const c2 = openContinuations(state)
    assert.equal(c2.get('c-n1').amendNonce, stored, 'amend_nonce survives reopen')
    c2.close()
  } finally { try { rmSync(state, { recursive: true, force: true }) } catch {} }
})

t('continuations v0.2.2: caller-supplied amendNonce is honored (test/seam)', () => {
  const state = mkdtempSync(join(tmpdir(), 'hermes-link-cont-supply-'))
  try {
    const c = openContinuations(state)
    c.register({
      child_id: 'c-n2', task_id: 't-n2', parent_agent_id: 'p-1', workspace: '',
      model: 'm', model_tier: 'flash', skill: 'read',
      created_at: 1, last_seen: 1, status: 'started', stop_reason: null, mode: 'continuable',
      initialSpec: { task_id: 't-n2' },
      amendNonce: 'deadbeef'.repeat(4),
    })
    assert.equal(c.get('c-n2').amendNonce, 'deadbeefdeadbeefdeadbeefdeadbeef')
    c.close()
  } finally { try { rmSync(state, { recursive: true, force: true }) } catch {} }
})

t('continuations v0.2.2: pre-v0.2.2 DB schema is upgraded (ALTER ADD COLUMN)', async () => {
  const state = mkdtempSync(join(tmpdir(), 'hermes-link-cont-upgrade-'))
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(state, 'continuables.sqlite'))
    db.exec(`CREATE TABLE continuable_children (
      child_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_agent_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      model TEXT NOT NULL,
      model_tier TEXT NOT NULL,
      skill TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      mode TEXT NOT NULL DEFAULT 'continuable',
      initial_spec TEXT
    )`)
    db.prepare(`INSERT INTO continuable_children
      (child_id, task_id, parent_agent_id, workspace, model, model_tier, skill, created_at, last_seen, status, stop_reason, mode, initial_spec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'old-1', 't-old', 'p-1', '', 'm', 'flash', 'read',
      1, 1, 'idle', null, 'continuable', null,
    )
    db.close()

    // Now reopen with the v0.2.2 openContinuations — should ALTER gracefully.
    const c = openContinuations(state)
    const entry = c.get('old-1')
    assert.equal(entry.amendNonce, '', 'legacy row has empty amendNonce (DEFAULT)')
    assert.ok(!c.validateAmendNonce('t-old', 'any-nonce'), 'validateAmendNonce rejects for empty entry.amendNonce (defense in depth)')
    c.close()
  } finally { try { rmSync(state, { recursive: true, force: true }) } catch {} }
})

// -- hermes-project-memory v0.2.2 --------------------------------------------

t('project-memory: cwd match returns MEMORY.md lines; cwd miss returns empty', async () => {
  const { home, cleanup } = makeHome()
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'state.db'))
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, title TEXT)`)
    db.prepare(`INSERT INTO sessions (id, cwd, model, title) VALUES (?, ?, ?, ?)`).run(
      's-1', 'E:\\projects\\alpha', 'm', 'alpha'
    )
    db.prepare(`INSERT INTO sessions (id, cwd, model, title) VALUES (?, ?, ?, ?)`).run(
      's-2', 'E:\\projects\\beta',  'm', 'beta'
    )
    db.close()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'memories', 'MEMORY.md'), [
      '# Memory',
      '',
      '## Project alpha',
      'alpha uses TypeScript with strict settings.',
      'alpha has a CI pipeline on GitHub Actions.',
      '',
      '## Project beta',
      'beta is a Rust service for invoice parsing.',
      'beta deploys via Docker.',
      '',
    ].join('\n'), 'utf8')

    const alphaSlice = await buildProjectMemorySlice(home, 'E:\\projects\\alpha')
    assert.ok(alphaSlice.includes('alpha uses TypeScript'), 'alpha slice present')
    assert.ok(alphaSlice.includes('CI pipeline'), 'alpha CI line present')
    assert.ok(!alphaSlice.includes('Rust service'), 'beta content NOT leaked')
    assert.ok(!alphaSlice.includes('Docker'), 'beta deploy line NOT leaked')

    const betaSlice = await buildProjectMemorySlice(home, 'E:\\projects\\beta')
    assert.ok(betaSlice.includes('Rust service'))
    assert.ok(!betaSlice.includes('TypeScript with strict'))

    // cwd that matches NO Hermes state.db session → empty.
    const miss = await buildProjectMemorySlice(home, 'E:\\projects\\gamma')
    assert.equal(miss, '', 'unknown cwd returns empty (no leakage)')
  } finally { cleanup() }
})

t('project-memory: cwd case + trailing-slash normalization matches', async () => {
  const { home, cleanup } = makeHome()
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'state.db'))
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, title TEXT)`)
    db.prepare(`INSERT INTO sessions (id, cwd, model, title) VALUES (?, ?, ?, ?)`).run(
      's-x', 'E:\\Projects\\Foo', 'm', 'foo'
    )
    db.close()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'memories', 'MEMORY.md'), 'foo-specific line here.\n', 'utf8')

    const a = await buildProjectMemorySlice(home, 'E:\\projects\\foo')
    assert.ok(a.includes('foo-specific'), 'case-insensitive cwd matches')
    const b = await buildProjectMemorySlice(home, 'E:\\Projects\\Foo\\')
    assert.ok(b.includes('foo-specific'), 'trailing-slash normalization matches')
  } finally { cleanup() }
})

t('project-memory: missing state.db returns empty (no crash)', async () => {
  const { home, cleanup } = makeHome()
  try {
    const out = await buildProjectMemorySlice(home, 'C:\\anywhere')
    assert.equal(out, '')
  } finally { cleanup() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)