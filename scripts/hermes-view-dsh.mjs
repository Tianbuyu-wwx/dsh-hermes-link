// scripts/hermes-view-dsh.mjs — Hermes-side view of dsh's records.
// Default cross-end sync: Hermes calls this to see what dsh has been
// doing (audit log, continuable-child registry, recent dispatch results).

import { readFileSync, existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// hermes-link state (consolidated plugin; old dispatch-bridge paths retired).
const AUDIT_PATH = join(DSH_HOME, 'hermes-link', 'audit.jsonl')
const SQLITE_PATH = join(DSH_HOME, 'hermes-link', 'continuables.sqlite')
const INBOX_LATEST = join(DSH_HOME, 'hermes-inbox', 'latest.md')

const mode = process.argv[2] || 'all'

function fmtSize(n) {
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB'
  return (n / 1024 / 1024).toFixed(2) + 'MB'
}

function tailAudit(n) {
  if (!existsSync(AUDIT_PATH)) return []
  try {
    const lines = readFileSync(AUDIT_PATH, 'utf8').trim().split('\n')
    return lines.slice(-n).map((l) => JSON.parse(l))
  } catch (e) {
    return [{ error: 'parse failed: ' + e.message }]
  }
}

function listChildren() {
  if (!existsSync(SQLITE_PATH)) return []
  try {
    const db = new DatabaseSync(SQLITE_PATH, { readOnly: true })
    // v0.2.2 — include amend_nonce so Hermes can name its amend files.
    return db.prepare(
      'SELECT child_id, task_id, parent_agent_id, model, skill, status, stop_reason, mode, ' +
      'created_at, last_seen, amend_nonce FROM continuable_children ORDER BY created_at DESC',
    ).all()
  } catch (e) {
    // Pre-v0.2.2 schema: amend_nonce column may not exist on older DBs.
    try {
      const db = new DatabaseSync(SQLITE_PATH, { readOnly: true })
      return db.prepare(
        'SELECT child_id, task_id, parent_agent_id, model, skill, status, stop_reason, mode, ' +
        'created_at, last_seen FROM continuable_children ORDER BY created_at DESC',
      ).all()
    } catch (e2) {
      return [{ error: 'sqlite read failed: ' + e2.message }]
    }
  }
}

function readInbox() {
  if (!existsSync(INBOX_LATEST)) return null
  try {
    const st = statSync(INBOX_LATEST)
    return {
      size: st.size,
      mtime: st.mtime.toISOString(),
      content: readFileSync(INBOX_LATEST, 'utf8'),
    }
  } catch (e) {
    return { error: 'inbox read failed: ' + e.message }
  }
}

function emit(section, data) {
  console.log('=== ' + section + ' ===')
  if (data === null) { console.log('(none)'); return }
  if (typeof data === 'string') { console.log(data); return }
  if (Array.isArray(data)) {
    if (data.length === 0) { console.log('(empty)'); return }
    for (const r of data) console.log(JSON.stringify(r))
    return
  }
  console.log(JSON.stringify(data, null, 2))
}

function audit_summary() {
  if (!existsSync(AUDIT_PATH)) return { exists: false }
  const st = statSync(AUDIT_PATH)
  const lines = tailAudit(1000)
  const byStatus = {}
  for (const r of lines) {
    const s = r.status || 'unknown'
    byStatus[s] = (byStatus[s] || 0) + 1
  }
  return {
    path: AUDIT_PATH,
    size: fmtSize(st.size),
    mtime: st.mtime.toISOString(),
    total_lines: lines.length,
    by_status: byStatus,
  }
}

if (mode === 'audit' || mode === 'all') {
  emit('audit summary', audit_summary())
  if (mode === 'all') emit('audit tail (last 5)', tailAudit(5))
}
if (mode === 'children' || mode === 'all') {
  emit('continuable children', listChildren())
}
if (mode === 'inbox' || mode === 'all') {
  emit('hermes-inbox (latest DSH sees)', readInbox())
}
