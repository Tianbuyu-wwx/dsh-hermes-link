// services/continuations.mjs
//
// Durable registry for continuable dispatch children (P2-10). SQLite-backed
// (survives dsh restart), same shape as the retired hermes-dispatch-bridge
// v0.3 `continuable_children` table. Also provides waitForNextReply — the
// polling bridge between ctx.subagents.followup() and a child's turn/end.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'

/**
 * Open (create if needed) the continuations state DB.
 * @param {string} stateDir directory (~/.dsh/hermes-link)
 * @returns {object} { db, register, update, get, list, count, waitForNextReply }
 */
export function openContinuations(stateDir) {
  try { mkdirSync(stateDir, { recursive: true }) } catch {}
  const db = new DatabaseSync(join(stateDir, 'continuables.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS continuable_children (
      child_id        TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL,
      parent_agent_id TEXT NOT NULL,
      workspace       TEXT NOT NULL,
      model           TEXT NOT NULL,
      model_tier      TEXT NOT NULL,
      skill           TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_seen       INTEGER NOT NULL,
      status          TEXT NOT NULL,
      stop_reason     TEXT,
      mode            TEXT NOT NULL DEFAULT 'continuable',
      initial_spec    TEXT
    );
    CREATE INDEX IF NOT EXISTS cc_parent_idx ON continuable_children(parent_agent_id);
    CREATE INDEX IF NOT EXISTS cc_task_idx   ON continuable_children(task_id);
  `)
  // v0.2.2: amend_nonce column — generated on register, used by amend-watcher
  // to verify the file actually came from this dispatch (defense against
  // arbitrary processes that can write to Hermes Home/inbox/dsh/amend/).
  // Safe ALTER: a fresh DB has the column already (next CREATE-TEXT migration);
  // existing DBs from v0.2.x need this ADD COLUMN, which is idempotent
  // under try/catch because the second run trips "duplicate column".
  try {
    db.exec(`ALTER TABLE continuable_children ADD COLUMN amend_nonce TEXT NOT NULL DEFAULT ''`)
  } catch (e) { /* column already exists or pre-0.2.2 schema — fine */ }

  const registry = new Map()

  /** v0.2.2 — 32 hex-char nonce returned in dispatch_task metadata so Hermes
   *  can name its amend files uniquely per child. */
  function generateAmendNonce() {
    try { return randomBytes(16).toString('hex') } catch { return '' }
  }

  function register(entry) {
    const amendNonce = (typeof entry.amendNonce === 'string' && entry.amendNonce.length > 0)
      ? entry.amendNonce
      : generateAmendNonce()
    const e = { ...entry, amendNonce }
    registry.set(e.child_id, { ...e, lastSeq: 0 })
    db.prepare(`INSERT OR REPLACE INTO continuable_children
      (child_id, task_id, parent_agent_id, workspace, model, model_tier, skill, created_at, last_seen, status, stop_reason, mode, initial_spec, amend_nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        e.child_id,
        e.task_id,
        e.parent_agent_id,
        e.workspace || '',
        e.model,
        e.model_tier,
        e.skill,
        e.created_at,
        e.last_seen,
        e.status,
        e.stop_reason || null,
        e.mode,
        JSON.stringify(e.initialSpec || null),
        e.amendNonce,
    )
  }

  /**
   * Verify a candidate amend file's nonce against the registered child for
   * `taskId`. The amend file must carry a nonce matching the one DSH minted
   * at dispatch time — anything else is treated as a tampered or off-path
   * write and rejected.
   * @param {string} taskId
   * @param {string} nonce
   * @returns {boolean}
   */
  function validateAmendNonce(taskId, nonce) {
    if (!taskId || !nonce) return false
    const entry = getByTaskId(taskId)
    if (!entry || !entry.amendNonce) return false
    return entry.amendNonce === nonce
  }

  function update(childId, fields) {
    const entry = registry.get(childId)
    if (!entry) return
    Object.assign(entry, fields)
    entry.last_seen = Date.now()
    db.prepare(`UPDATE continuable_children SET last_seen = ?, status = ?, stop_reason = ? WHERE child_id = ?`).run(
      entry.last_seen, entry.status, entry.stop_reason || null, childId,
    )
  }

  function get(childId) { return registry.get(childId) }

  /** Look up a continuable child by its task_id (the Hermes-facing key). */
  function getByTaskId(taskId) {
    for (const entry of registry.values()) {
      if (entry.task_id === taskId) return entry
    }
    const row = db.prepare('SELECT * FROM continuable_children WHERE task_id = ? LIMIT 1').get(taskId)
    return row ? registryRowToEntry(row) : null
  }

  function list({ limit = 50 } = {}) {
    const rows = db.prepare(
      'SELECT child_id, task_id, parent_agent_id, model, model_tier, skill, created_at, last_seen, status, stop_reason, mode FROM continuable_children ORDER BY created_at DESC LIMIT ?',
    ).all(limit)
    return rows.map((r) => ({ ...r, is_live: registry.has(r.child_id) }))
  }

  function count() { return registry.size }

  function close() { try { db.close() } catch {} }

  // Load existing rows at startup so continuations survive dsh restart.
  for (const row of db.prepare('SELECT * FROM continuable_children').all()) {
    registry.set(row.child_id, registryRowToEntry(row))
  }

  return { db, register, update, get, getByTaskId, list, count, close, waitForNextReply, validateAmendNonce, generateAmendNonce }
}

function registryRowToEntry(r) {
  return {
    child_id: r.child_id,
    task_id: r.task_id,
    parent_agent_id: r.parent_agent_id,
    workspace: r.workspace,
    model: r.model,
    model_tier: r.model_tier,
    skill: r.skill,
    created_at: r.created_at,
    last_seen: r.last_seen,
    status: r.status,
    stop_reason: r.stop_reason,
    mode: r.mode,
    initialSpec: r.initial_spec ? JSON.parse(r.initial_spec) : null,
    amendNonce: r.amend_nonce || '',
    lastSeq: 0,
  }
}

// -----------------------------------------------------------------------------
// waitForNextReply — resolve when the child's event log advances past a turn/end
// (ported from hermes-dispatch-bridge v0.3, SSE parts removed).
// -----------------------------------------------------------------------------

export async function waitForNextReply(ctx, childId, beforeSeq, signal) {
  return new Promise((resolve, reject) => {
    let resolved = false
    const onAbort = () => {
      if (resolved) return
      resolved = true
      clearInterval(poll)
      reject(new Error('wait aborted: deadline'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    const poll = setInterval(() => {
      if (resolved) return
      try {
        const agent = ctx.agents.get(childId)
        const session = agent ? agent.session : ctx.sessions.get(childId)
        if (!session) return // waiting for cold-resume to materialize
        const events = session.events
        for (let i = beforeSeq; i < events.length; i++) {
          const e = events[i]
          if (e && e.type === 'turn/end') {
            let lastAssistant = null
            for (let j = beforeSeq; j <= i; j++) {
              if (events[j] && events[j].type === 'assistant/message') lastAssistant = events[j]
            }
            resolved = true
            clearInterval(poll)
            signal.removeEventListener('abort', onAbort)
            return resolve({
              turn_end: e,
              last_assistant: lastAssistant,
              assistant_content: lastAssistant
                ? lastAssistant.data && lastAssistant.data.message && lastAssistant.data.message.content
                : null,
              events_tail: events.slice(Math.max(0, beforeSeq), i + 1),
            })
          }
        }
      } catch (e) {
        resolved = true
        clearInterval(poll)
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    }, 200)
  })
}