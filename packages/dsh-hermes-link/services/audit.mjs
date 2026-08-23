// services/audit.mjs
//
// D4 (audit): append-only JSONL audit log for dsh-hermes-link dispatch activity.
// Location: ~/.dsh/dsh-hermes-link/audit.jsonl (hermes-view-dsh.mjs reads it).

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stateDir() {
  return join(dshHome(), 'dsh-hermes-link')
}

export function auditPath() {
  return join(stateDir(), 'audit.jsonl')
}

/** Append one audit record. Best-effort, never throws. */
export function appendAudit(rec) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(auditPath(), JSON.stringify(rec) + '\n', 'utf8')
  } catch (e) {
    console.error('[dsh-hermes-link] audit append failed:', e && e.message || e)
  }
}

/** Read the last `limit` audit lines. */
export function readAuditLines(limit = 20) {
  try {
    const txt = readFileSync(auditPath(), 'utf8').trim()
    if (!txt) return []
    const all = txt.split('\n')
    return all.slice(-limit)
  } catch { return [] }
}