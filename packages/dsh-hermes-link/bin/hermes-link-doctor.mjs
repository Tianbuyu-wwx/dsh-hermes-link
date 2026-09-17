#!/usr/bin/env node
// bin/hermes-link-doctor.mjs
//
// D (v0.6.0) -- "hermes-link doctor": a one-shot runtime self-check.
// SHIPPED WITH THE PACKAGE (v0.6.1): exposed as the `hermes-link-doctor` bin,
// so an npm install can run it without cloning the repository. The repo's
// scripts/hermes-link-doctor.mjs is a thin wrapper around this file.
//
// WHY: the three silently broken channels the 2026-09-15 audit uncovered were
// all invisible to source reading -- three consult tickets three weeks stale, a
// session-mirror directory holding only archive/, 145 imported sessions whose
// model selection no adapter could serve. They are only visible by MEASURING.
// This CLI measures the filesystem (and, with --url, the live plugin).
//
// USAGE
//   npx hermes-link-doctor                                 # filesystem probe
//   npx hermes-link-doctor --url http://127.0.0.1:3080     # + live policy/consumer state
//   npx hermes-link-doctor --json                          # machine readable
//   npx hermes-link-doctor --strict                        # warnings fail the exit code
//   npx hermes-link-doctor --pin-scan                      # also read every imported session (slow)
//
// EXIT: 0 = no failures (warnings ok unless --strict), 1 = failures, 2 = bad usage.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve inside the package (bin/ and services/ are siblings), NOT from the
// repository root: this file ships in the tarball, where no repo root exists.
const here = dirname(fileURLToPath(import.meta.url))
const { runDoctor, renderDoctor, parsePrometheus } = await import(pathToFileURL(join(here, '..', 'services', 'doctor.mjs')).href)

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const argOf = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : d }

const hermesHome = argOf('--hermes-home', process.env.HERMES_HOME ||
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes'))
const dshHome = argOf('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'))
const asJson = has('--json')
const strict = has('--strict')
const url = argOf('--url', null)
const pinScan = has('--pin-scan')

/** Locate a host-provided @deepseek-ai package (npx cache / global npm). */
function findDshPackage(name) {
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'AppData', 'Roaming', 'npm', 'node_modules'))
  roots.push(join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node_modules'))
  for (const r of roots) {
    let entries = []
    try { entries = readdirSync(r) } catch { continue }
    for (const e of entries) {
      for (const p of [join(r, e, 'node_modules', '@deepseek-ai', name), join(r, '@deepseek-ai', name)]) {
        if (existsSync(join(p, 'lib', 'index.js'))) return p
      }
    }
  }
  return null
}

/**
 * Slow, opt-in check: does every imported session end with a routable
 * model/selection? (v0.6.0 fixed the 145 that did not; this catches a relapse.)
 */
async function scanImportedPins(sessionsRoot) {
  const cordisPath = findDshPackage('cordis')
  const jsonlPath = findDshPackage('dsh-session-persistence-jsonl')
  if (!cordisPath || !jsonlPath) return { error: 'no @deepseek-ai host checkout found (set nothing; run inside the DSH machine)' }
  const { Context } = await import(pathToFileURL(join(cordisPath, 'lib', 'index.js')).href)
  const { default: JsonlSessionPersistence } = await import(pathToFileURL(join(jsonlPath, 'lib', 'index.js')).href)
  const backends = {
    zstd: new JsonlSessionPersistence(new Context(), { root: sessionsRoot, compression: 'zstd' }),
    plain: new JsonlSessionPersistence(new Context(), { root: sessionsRoot, compression: 'none' }),
  }
  let projects = []
  try { projects = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return { error: 'sessions root unreadable: ' + sessionsRoot } }
  const ids = []
  for (const p of projects) {
    if (!p.isDirectory()) continue
    let sessions = []
    try { sessions = readdirSync(join(sessionsRoot, p.name), { withFileTypes: true }) } catch { continue }
    for (const s of sessions) if (s.isDirectory() && s.name.startsWith('hermes-')) ids.push(s.name)
  }
  const missing = []
  let scanned = 0
  for (const id of ids) {
    let backend = backends.zstd
    let handle = null
    try {
      handle = await backend.open(id, 'read')
    } catch (_e) {
      try { handle = await backends.plain.open(id, 'read'); backend = backends.plain } catch (_e2) { continue }
    }
    try {
      const slice = await handle.read(0)
      const events = (slice && slice.events) || []
      scanned++
      // Fold DSH's own projection rule (session-controller
      // applyModelSelectionProjection) instead of peeking at the tail: a repaired
      // session that has since been opened has extra lifecycle events after its
      // pin and is still perfectly routable.
      let lastUsed = null
      let pending = null
      for (const e of events) {
        if (e && e.type === 'model/selection' && e.data) { pending = e.data; continue }
        if (!e || e.type !== 'request/header') continue
        const config = e.data && e.data.header && e.data.header.config
        if (!config) continue
        lastUsed = { provider: config.provider || null, model: config.model || null }
        if (pending && pending.provider === lastUsed.provider && pending.model === lastUsed.model) pending = null
      }
      const effective = pending || lastUsed
      const pinned = !!effective && !!effective.provider && effective.provider !== 'dsh-hermes-link'
      if (!pinned) missing.push(id)
    } catch (_e) { /* unreadable artifact: not a pin problem, skip */ }
    finally { try { await handle.close() } catch (_e) { /* ignore */ } }
  }
  return { scanned, missing }
}

const token = argOf('--token', process.env.HERMES_LINK_TOKEN || '')
const authHeaders = token ? { authorization: 'Bearer ' + token } : undefined

let live = null
let signalsFromMetrics = null
if (url) {
  const base = url.replace(/\/+$/, '')
  try {
    const res = await fetch(base + '/mcp/collab/doctor', authHeaders ? { headers: authHeaders } : undefined)
    if (res.ok) live = await res.json()
    else console.warn('[doctor] live probe returned HTTP ' + res.status + ' (continuing with the filesystem probe)')
  } catch (e) {
    console.warn('[doctor] live probe failed: ' + (e && e.message || e) + ' (continuing with the filesystem probe)')
  }
  // The in-process probe runs the same module with the registry, so it carries the
  // signals; without it (older plugin, or auth refused) read /metrics directly.
  const liveSignals = live && Array.isArray(live.checks) ? live.checks.find((c) => c && c.id === 'signals') : null
  if (!liveSignals) {
    try {
      const res = await fetch(base + '/mcp/collab/metrics', authHeaders ? { headers: authHeaders } : undefined)
      if (res.ok) signalsFromMetrics = parsePrometheus(await res.text())
      else console.warn('[doctor] metrics probe returned HTTP ' + res.status + ' (signals omitted)')
    } catch (e) {
      console.warn('[doctor] metrics probe failed: ' + (e && e.message || e) + ' (signals omitted)')
    }
  } else {
    signalsFromMetrics = liveSignals.data || null
  }
}

const report = await runDoctor({
  hermesHome,
  dshHome,
  live: live ? { mirrorPolicy: live.checks && live.checks.find((c) => c.id === 'mirror_policy') ? null : null } : null,
  scanImportedPins: pinScan ? scanImportedPins : null,
})

if (live) {
  // The live probe already ran the same checks in-process: keep its richer
  // decisions, and note that it exists.
  report.checks.push({
    id: 'live_probe',
    status: 'ok',
    title: 'live plugin probe',
    detail: url + ' answered (policy + consumer state came from the running plugin)',
  })
}

if (signalsFromMetrics) {
  // Replace whatever the filesystem-only pass produced: the live numbers win.
  report.checks = report.checks.filter((c) => c.id !== 'signals')
  report.checks.push({
    id: 'signals',
    status: 'ok',
    title: 'channel signals (live)',
    detail: 'dispatch=' + (signalsFromMetrics.hermes_link_dispatch_total || 0) +
      ' import=' + (signalsFromMetrics.hermes_link_import_total || 0) +
      ' consult=' + (signalsFromMetrics.hermes_link_consult_total || 0) +
      ' mirror_enabled=' + (signalsFromMetrics.hermes_link_mirror_policy_auto_enabled_total || 0) +
      ' outbox=' + (signalsFromMetrics.hermes_link_hermes_outbox_total || 0) +
      ' consult_expired=' + (signalsFromMetrics.hermes_link_consult_expired_total || 0),
    data: signalsFromMetrics,
  })
}

if (!pinScan) {
  report.checks.push({
    id: 'imported_model_pin',
    status: 'ok',
    title: 'imported session model pins',
    detail: 'skipped (pass --pin-scan to read every imported session; ~minutes on 145 sessions)',
  })
}

if (asJson) console.log(JSON.stringify(report, null, 2))
else console.log(renderDoctor(report))

const failures = report.summary.fail
const warnings = report.summary.warn
process.exit(failures > 0 ? 1 : (strict && warnings > 0 ? 1 : 0))
