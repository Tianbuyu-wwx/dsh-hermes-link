#!/usr/bin/env node
// Prune EMPTY workspace registrations from ~/.dsh/storages/workspace.json.
//
// Background: after the single-workspace regroup, all imported Hermes sessions
// live in one 'Hermes' workspace, leaving ~31 registrations that hold no
// sessions (they were created one-per-project-directory by the old importer).
//
// WHY THIS MUST RUN WITH DSH STOPPED
// DSH keeps the workspace registry in memory and rewrites workspace.json on
// every mutation, so an edit made while it is running is simply overwritten.
// The runtime API that would do this correctly is an internal remote
// (@deepseek-ai/dsh-api-workspace-controller#workspace/delete) and is not
// reachable from outside the process.
//
// SAFETY
//  - only removes registrations whose sessionIds array is EMPTY
//  - a workspace that lists even one session is left untouched, whether or not
//    that session still exists on disk
//  - writes a timestamped .bak next to the file before touching it
//  - dry-run by default: pass --apply to write
//
// Usage:  node scripts/prune-empty-workspaces.mjs [--apply] [--file <path>]

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const fileArg = args.indexOf('--file')
const FILE = fileArg !== -1 && args[fileArg + 1]
  ? args[fileArg + 1]
  : join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'storages', 'workspace.json')

if (!existsSync(FILE)) { console.error('not found: ' + FILE); process.exit(2) }
const raw = readFileSync(FILE, 'utf8')
const doc = JSON.parse(raw)
const tables = doc.tables || {}
const ws = tables.workspaces || {}
const all = Object.keys(ws)

const empty = all.filter((id) => (ws[id].sessionIds || []).length === 0)
const kept = all.filter((id) => (ws[id].sessionIds || []).length > 0)

console.log('file     : ' + FILE)
console.log('workspaces: ' + all.length + '   empty: ' + empty.length + '   with sessions: ' + kept.length)
console.log('')
if (empty.length) {
  console.log('empty registrations to remove:')
  for (const id of empty) console.log('  - ' + ws[id].path)
} else {
  console.log('nothing to remove')
}
console.log('')
console.log('kept (they list at least one session):')
for (const id of kept) console.log('  - ' + (ws[id].sessionIds || []).length + 'x  ' + ws[id].path)

if (!apply) {
  console.log('')
  console.log('DRY RUN - nothing written. Re-run with --apply (DSH MUST BE STOPPED).')
  process.exit(0)
}

// keep workspaceIds ordering consistent with the surviving registrations
const g = doc.global || {}
if (Array.isArray(g.workspaceIds)) g.workspaceIds = g.workspaceIds.filter((id) => !empty.includes(id))
for (const id of empty) delete ws[id]
tables.workspaces = ws

const bak = FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(FILE, bak)
const out = JSON.stringify(doc, null, 2) + '\n'
JSON.parse(out)          // must stay valid JSON
writeFileSync(FILE, out, 'utf8')
console.log('')
console.log('removed ' + empty.length + ' empty registration(s)')
console.log('backup  : ' + bak)
