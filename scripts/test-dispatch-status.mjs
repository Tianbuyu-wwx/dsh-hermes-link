#!/usr/bin/env node
// scripts/test-dispatch-status.mjs
//
// Unit tests for services/dispatch-status.mjs (v0.3.1 F4).
// Uses an in-memory continuations instance + temp audit file.

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/dispatch-status.mjs')).href
const {
  readAuditRecords, filterAuditRecords,
  buildDispatchStatus, readChildSessionTail,
} = await import(modPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

/** Lightweight in-memory continuations shim matching the SQLite-backed interface. */
function makeFakeContinuations(rows) {
  const map = new Map()
  for (const r of rows) map.set(r.child_id, { ...r })
  return {
    list({ limit = 50 } = {}) {
      return rows.slice(0, limit).map((r) => ({ ...r, is_live: map.has(r.child_id) }))
    },
  }
}

function makeFakeAuditFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  const auditPath = join(dir, 'audit.jsonl')
  writeFileSync(auditPath, '')
  return { dir, auditPath }
}

// --- readAuditRecords ---
t('case 1: readAuditRecords parses JSONL into objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  const p = join(dir, 'audit.jsonl')
  writeFileSync(p, JSON.stringify({ kind: 'dispatch', task_id: 't1' }) + '\n' +
                       JSON.stringify({ kind: 'consult', ticket: 'c1' }) + '\n' +
                       'malformed-line\n')
  const records = readAuditRecords(p)
  assert.equal(records.length, 2, 'malformed line is skipped')
  assert.equal(records[0].kind, 'dispatch')
  assert.equal(records[1].kind, 'consult')
})

t('case 2: readAuditRecords returns empty on missing file', () => {
  const records = readAuditRecords('/no/such/path.jsonl')
  assert.deepEqual(records, [])
})

// --- filterAuditRecords ---
t('case 3: filterAuditRecords by task_id', () => {
  const records = [
    { kind: 'dispatch', task_id: 't1', ts: 100 },
    { kind: 'dispatch', task_id: 't2', ts: 200 },
    { kind: 'consult',  task_id: 't1', ts: 300 },
  ]
  const r = filterAuditRecords(records, { task_id: 't1' })
  assert.equal(r.length, 2)
  assert.ok(r.every((x) => x.task_id === 't1'))
})

t('case 4: filterAuditRecords by kind', () => {
  const records = [
    { kind: 'dispatch', task_id: 't1' },
    { kind: 'consult',  task_id: 't1' },
    { kind: 'dispatch', task_id: 't2' },
  ]
  const r = filterAuditRecords(records, { kind: 'dispatch' })
  assert.equal(r.length, 2)
  assert.ok(r.every((x) => x.kind === 'dispatch'))
})

t('case 5: filterAuditRecords by since_ts + until_ts', () => {
  const records = [
    { kind: 'dispatch', task_id: 't1', ts: 100 },
    { kind: 'dispatch', task_id: 't1', ts: 200 },
    { kind: 'dispatch', task_id: 't1', ts: 300 },
    { kind: 'dispatch', task_id: 't1', ts: 400 },
  ]
  const r = filterAuditRecords(records, { since_ts: 150, until_ts: 350 })
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((x) => x.ts), [200, 300])
})

t('case 6: filterAuditRecords combined filters', () => {
  const records = [
    { kind: 'dispatch', task_id: 't1', ts: 100 },
    { kind: 'consult',  task_id: 't1', ts: 200 },
    { kind: 'dispatch', task_id: 't2', ts: 300 },
  ]
  const r = filterAuditRecords(records, { task_id: 't1', kind: 'dispatch' })
  assert.equal(r.length, 1)
  assert.equal(r[0].ts, 100)
})

// --- buildDispatchStatus ---
t('case 7: buildDispatchStatus returns all children when no filter', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'started', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
    { child_id: 'c2', task_id: 't2', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'idle',    created_at: 110, last_seen: 210, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { dir, auditPath } = makeFakeAuditFile()
  // Provide a ctx that returns live agents for both children
  const ctx = { agents: { get: (id) => (id === 'c1' || id === 'c2') ? { session: {} } : null } }
  const status = buildDispatchStatus({ continuations: cont, ctx, auditPath }, {})
  assert.equal(status.total, 2)
  assert.equal(status.children.length, 2)
  for (const c of status.children) {
    assert.ok(c.task_id)
    assert.ok(c.child_id)
    assert.ok(c.created_at)
    assert.ok(c.last_seen)
    assert.equal(c.is_live, true)
  }
})

t('case 8: buildDispatchStatus filters by task_id', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'started', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
    { child_id: 'c2', task_id: 't2', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'idle',    created_at: 110, last_seen: 210, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { auditPath } = makeFakeAuditFile()
  const status = buildDispatchStatus({ continuations: cont, auditPath }, { task_id: 't1' })
  assert.equal(status.total, 1)
  assert.equal(status.children[0].task_id, 't1')
})

t('case 9: buildDispatchStatus attaches audit_recent when include_audit_recent > 0', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'started', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { dir, auditPath } = makeFakeAuditFile()
  writeFileSync(auditPath, JSON.stringify({ kind: 'dispatch', task_id: 't1', ts: 100, status: 'ok' }) + '\n')
  const status = buildDispatchStatus({ continuations: cont, auditPath }, { include_audit_recent: 5 })
  assert.equal(status.children[0].audit_recent.length, 1)
  assert.equal(status.children[0].audit_recent[0].status, 'ok')
})

t('case 10: buildDispatchStatus skips audit_recent when include_audit_recent = 0', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'started', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { auditPath } = makeFakeAuditFile()
  const status = buildDispatchStatus({ continuations: cont, auditPath }, { include_audit_recent: 0 })
  assert.equal(status.children[0].audit_recent, undefined)
})

t('case 11: buildDispatchStatus without continuations returns empty', () => {
  const { auditPath } = makeFakeAuditFile()
  const status = buildDispatchStatus({ continuations: null, auditPath }, {})
  assert.equal(status.total, 0)
  assert.deepEqual(status.children, [])
})

t('case 12: buildDispatchStatus is_live false when child not in agent map', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'idle', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  // Pass a ctx with no matching agent
  const ctx = { agents: { get: (id) => id === 'other' ? {} : null } }
  const { auditPath } = makeFakeAuditFile()
  const status = buildDispatchStatus({ continuations: cont, ctx, auditPath }, {})
  assert.equal(status.children[0].is_live, false)
})

// --- readChildSessionTail ---
t('case 13: readChildSessionTail returns error_code when child is not live', () => {
  const ctx = { agents: { get: (id) => id === 'c1' ? null : null } }
  const r = readChildSessionTail(ctx, 'c1')
  assert.equal(r.ok, false)
  assert.equal(r.error_code, 'E_UNKNOWN_CHILD')
  assert.ok(r.hint)
})

t('case 14: readChildSessionTail returns events tail from live agent', () => {
  const ctx = {
    agents: {
      get: () => ({
        session: {
          header: { task_id: 't1' },
          events: [
            { type: 'turn/start',  seq: 0 },
            { type: 'user/message', seq: 1 },
            { type: 'turn/end',    seq: 2 },
          ],
        },
      }),
    },
  }
  const r = readChildSessionTail(ctx, 'c1', { since: 1, limit: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.total_events, 3)
  assert.equal(r.returned, 2)
  assert.equal(r.events[0].type, 'user/message')
  assert.equal(r.task_id, 't1')
})

t('case 15: readChildSessionTail respects limit cap', () => {
  const ctx = {
    agents: { get: () => ({ session: { events: Array.from({ length: 5000 }, (_, i) => ({ seq: i })) } }) },
  }
  const r = readChildSessionTail(ctx, 'c1', { limit: 50 })
  assert.equal(r.returned, 50)
  assert.equal(r.events[0].seq, 0)
})

t('case 16: readChildSessionTail handles null ctx safely', () => {
  const r = readChildSessionTail(null, 'c1')
  assert.equal(r.ok, false)
  assert.equal(r.error_code, 'E_UNKNOWN_CHILD')
})

// --- integration with audit ---
t('case 17: buildDispatchStatus merges recent audit (capped at N per task)', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'started', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { auditPath } = makeFakeAuditFile()
  // 10 audit entries for t1
  let content = ''
  for (let i = 0; i < 10; i++) {
    content += JSON.stringify({ kind: 'dispatch', task_id: 't1', ts: 100 + i, seq: i }) + '\n'
  }
  writeFileSync(auditPath, content)
  const status = buildDispatchStatus({ continuations: cont, auditPath }, { include_audit_recent: 3 })
  assert.equal(status.children[0].audit_recent.length, 3)
  // last 3 should be seq 7, 8, 9
  assert.deepEqual(status.children[0].audit_recent.map((e) => e.seq), [7, 8, 9])
})

t('case 18: status JSON.stringify is valid JSON', () => {
  const cont = makeFakeContinuations([
    { child_id: 'c1', task_id: 't1', parent_agent_id: 'p1', model: 'm', model_tier: 'flash', skill: 's', status: 'idle', created_at: 100, last_seen: 200, mode: 'continuable', stop_reason: null, workspace: 'C:\\x' },
  ])
  const { auditPath } = makeFakeAuditFile()
  const status = buildDispatchStatus({ continuations: cont, auditPath }, {})
  // round-trip through JSON
  const text = JSON.stringify(status)
  const parsed = JSON.parse(text)
  assert.equal(parsed.total, status.total)
  assert.deepEqual(parsed.children, status.children)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
