#!/usr/bin/env node
// bin/hermes-link-consult-admin.mjs
//
// v0.6.9 - what the consult inbox actually contains, and the one-time cleanup of
// the tickets nobody will ever answer.
//
// Why it exists: the three tickets the 2026-09-15 audit found had been sitting in
// inbox/dsh/consult/ for three weeks. The TTL sweep correctly refuses to delete
// anything (a late reply must still be accepted, and the marker is what lets the
// health check tell "answered" from "abandoned"), so those tickets kept the
// doctor's backlog warning alive with no way to clear it short of editing files
// by hand.
//
//   npx hermes-link-consult-admin                        # status
//   npx hermes-link-consult-admin --purge-expired        # dry run
//   npx hermes-link-consult-admin --purge-expired --apply

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { createConsultClient } = await import(pathToFileURL(join(here, '..', 'services', 'consult-hermes.mjs')).href)

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

function detectHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local')
    return join(base, 'hermes')
  }
  return join(process.env.XDG_DATA_HOME || join(process.env.HOME || '', '.local', 'share'), 'hermes')
}

const hermesHome = String(argOf('--hermes-home', detectHermesHome()))
const json = process.argv.includes('--json')
const purge = process.argv.includes('--purge-expired')
const apply = process.argv.includes('--apply')

if (!existsSync(hermesHome)) {
  console.error('Hermes home not found: ' + hermesHome + ' (pass --hermes-home <path>)')
  process.exit(2)
}

const client = createConsultClient({ hermesHome })
const health = client.channelHealth()

if (!purge) {
  const result = { hermes_home: hermesHome, inbox: client.inboxDir, health }
  if (json) { console.log(JSON.stringify(result, null, 2)) } else {
    console.log('dsh-hermes-link consult')
    console.log('  hermes home : ' + hermesHome)
    console.log('  inbox       : ' + client.inboxDir)
    console.log('  verdict     : ' + health.verdict)
    console.log('  open=' + health.open + ' stale=' + health.stale +
      ' expired_markers=' + health.expired_markers + ' answered_markers=' + health.answered_markers)
    console.log('  note        : ' + health.note)
    if (health.stale > 0) console.log('  -> ' + health.stale + ' abandoned ticket(s); clear them with --purge-expired --apply')
  }
  process.exit(health.verdict === 'dead' ? 1 : 0)
}

const report = client.purgeExpiredTickets({ apply })
if (json) {
  console.log(JSON.stringify({ hermes_home: hermesHome, ...report, health_after: client.channelHealth() }, null, 2))
} else {
  console.log('dsh-hermes-link consult purge ' + (apply ? '(APPLY)' : '(dry run - pass --apply to delete)'))
  console.log('  scanned    : ' + report.scanned)
  console.log('  candidates : ' + report.candidates.length)
  for (const c of report.candidates) {
    const days = c.age_ms == null ? '?' : Math.round(c.age_ms / 86400000) + 'd'
    console.log('    - ' + c.file + '  (age ' + days + ')')
  }
  if (report.purged.length) console.log('  purged     : ' + report.purged.length + ' ticket(s) + their expiry markers')
  for (const s of report.skipped) console.log('    kept: ' + s.file + ' -- ' + s.reason)
  const after = client.channelHealth()
  console.log('  after      : verdict=' + after.verdict + ' stale=' + after.stale + ' open=' + after.open)
}
process.exit(0)
