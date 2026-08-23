// scripts/probe-hermes-session-meta.mjs (v2)
// Cross-reference request_dump session_ids against state.db sessions table
// (cwd / model / title / git_repo_root) to prove the linkage.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2] || (process.env.LOCALAPPDATA || '') + '\\hermes'
const dbPath = join(home, 'state.db')
const dumpDir = join(home, 'sessions')

// 1. collect all request_dump session ids
const dumpIds = new Set()
for (const f of readdirSync(dumpDir)) {
  if (!f.startsWith('request_dump_') || !f.endsWith('.json')) continue
  try {
    const dump = JSON.parse(readFileSync(join(dumpDir, f), 'utf8'))
    if (dump.session_id) dumpIds.add(dump.session_id)
  } catch {}
}
console.log(`request_dump session ids: ${dumpIds.size}`)

// 2. query state.db sessions
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(`SELECT id, cwd, model, title, git_repo_root, git_branch, started_at, ended_at, archived, hidden FROM sessions`).all()

console.log(`state.db sessions rows: ${rows.length}`)
console.log('')
console.log('=== dump id -> state.db row (cwd/model/title) ===')
let matched = 0, missing = 0
for (const id of dumpIds) {
  const row = rows.find((r) => String(r.id) === id || String(r.id).endsWith(':' + id) || String(r.id).startsWith(id))
  if (row) {
    matched++
    console.log(`${id}`)
    console.log(`  cwd= ${row.cwd}   model= ${row.model}   title= ${(row.title || '').slice(0, 50)}`)
    console.log(`  git_repo_root= ${row.git_repo_root}  branch= ${row.git_branch}  archived= ${row.archived}  hidden= ${row.hidden}`)
  } else {
    missing++
    console.log(`${id}  -> (no state.db row)`)
  }
}
console.log('')
console.log(`matched: ${matched}  missing: ${missing}`)

// 3. also print state.db rows that have NO dump (the extra 58)
console.log('')
console.log('=== state.db sessions without request_dump (extra) ===')
const dumpArray = [...dumpIds]
for (const r of rows) {
  const id = String(r.id)
  const inDumps = dumpArray.some((d) => id === d || id.endsWith(':' + d) || id.startsWith(d))
  if (!inDumps && !r.hidden) {
    console.log(`  ${id.slice(0, 60)}  cwd=${r.cwd}  model=${r.model}  title=${(r.title || '').slice(0, 30)}`)
  }
}
db.close()