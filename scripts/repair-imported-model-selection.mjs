#!/usr/bin/env node
// repair-imported-model-selection.mjs
//
// Give EVERY already-imported Hermes session a routable model pin.
//
// WHY
//   DSH reads a Session's "current model" from its LAST request/header
//   (dsh-api-session-controller -> selectionFor()). The converter records the
//   originating Hermes model under a synthetic provider -- 'dsh-hermes-link'
//   (request-dump-to-events.mjs) -- and NO LLM adapter serves that provider.
//   The client therefore resolves the Session's selection as unroutable
//   (dsh-client-ui-model-selection: routable=false) and BLOCKS the whole
//   composer: the model and the agent preset/mode both become unchangeable, and
//   a prompt is refused with
//     session/model-unavailable: no adapter serves provider "dsh-hermes-link"
//   New imports are fixed in the importer (a trailing model/selection event is
//   pinned at import time); sessions imported BEFORE that fix need this pass.
//
// WHAT IT DOES (append-only, never rewrites history)
//   Opens each imported session with a WRITE handle and appends ONE
//   `model/selection` event -- the same event DSH appends when a user picks a
//   model for a Session. The historic request/header keeps its Hermes model as
//   provenance; the projection then yields next = pending ?? lastUsed = the
//   served route, which is what clears the block.
//
// SAFETY
//   - dry-run by default; pass --apply to write
//   - copies every artifact it is about to modify into a timestamped backup root
//   - a session already owned by a running DSH (the jsonl backend holds a
//     cross-process write lock) is SKIPPED with a report, never forced
//   - a session whose tail already carries the same provider is SKIPPED
//   - only sessions whose stored header records agentPreset 'hermes-imported'
//     (or an id prefixed 'hermes-') are considered
//
// USAGE
//   node scripts/repair-imported-model-selection.mjs                 # dry run
//   node scripts/repair-imported-model-selection.mjs --apply
//   node scripts/repair-imported-model-selection.mjs --provider X --model Y [--effort Z]
//   node scripts/repair-imported-model-selection.mjs --id hermes-20260710_232907_343d1e --apply
//
// The route defaults to the deployment's own default in ~/.dsh/settings.yaml
// (agent-default-model), which is the same route new imports will pin.

import { readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const APPLY = has('--apply')
const FORCE = has('--force')
const ONLY_ID = argOf('--id', null)
const LIMIT = Number(argOf('--limit', '0')) || 0
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const SESSIONS_ROOT = argOf('--root', join(DSH_HOME, 'sessions'))
const SETTINGS = argOf('--settings', join(DSH_HOME, 'settings.yaml'))
const IMPORTED_PRESET = 'hermes-imported'

/**
 * Read the deployment default route out of settings.yaml. Deliberately a tiny
 * targeted reader rather than a YAML dependency: the file is machine-written
 * and the block is flat.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
function defaultRouteFromSettings(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^agent-default-model:\s*$/.test(l))
  if (start === -1) return null
  const block = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break // next top-level key
    const m = /^\s+([A-Za-z][\w-]*):\s*(.+?)\s*$/.exec(line)
    if (m) block[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  if (!block.provider || !block.model) return null
  return { provider: block.provider, model: block.model, ...(block.reasoningEffort ? { reasoningEffort: block.reasoningEffort } : {}) }
}

const cliProvider = argOf('--provider', null)
const cliModel = argOf('--model', null)
const cliEffort = argOf('--effort', null)
const route = cliProvider && cliModel
  ? { provider: cliProvider, model: cliModel, ...(cliEffort ? { reasoningEffort: cliEffort } : {}) }
  : defaultRouteFromSettings(SETTINGS)

/** Locate a host-provided @deepseek-ai package (npx cache / global npm). */
function findDshPackage(name) {
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node_modules'))
  for (const root of roots) {
    let entries = []
    try { entries = readdirSync(root) } catch { continue }
    for (const e of entries) {
      for (const p of [join(root, e, 'node_modules', '@deepseek-ai', name), join(root, '@deepseek-ai', name)]) {
        if (existsSync(join(p, 'lib', 'index.js'))) return p
      }
    }
  }
  return null
}

/** Every candidate imported session directory: <root>/<projectDir>/<sessionId>/. */
function findImportedArtifacts(root) {
  const found = []
  let projects = []
  try { projects = readdirSync(root, { withFileTypes: true }) } catch { return found }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions = []
    try { sessions = readdirSync(projectDir, { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('hermes-')) continue
      const dir = join(projectDir, session.name)
      const files = readdirSync(dir).filter((f) => f.startsWith('session.'))
      if (files.length === 0) continue
      found.push({ id: session.name, dir, file: join(dir, files[0]), project: project.name })
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

function backup(file, backupRoot) {
  const rel = file.slice(SESSIONS_ROOT.length + 1)
  const target = join(backupRoot, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(file, target)
  return target
}

async function main() {
  if (!route) {
    console.error('no route: pass --provider/--model or give an agent-default-model block in ' + SETTINGS)
    process.exit(2)
  }
  if (!existsSync(SESSIONS_ROOT)) { console.error('sessions root not found: ' + SESSIONS_ROOT); process.exit(2) }

  const cordisPath = findDshPackage('cordis')
  const jsonlPath = findDshPackage('dsh-session-persistence-jsonl')
  if (!cordisPath || !jsonlPath) { console.error('no @deepseek-ai host checkout found; cannot open session artifacts'); process.exit(2) }
  const { Context } = await import(pathToFileURL(join(cordisPath, 'lib', 'index.js')).href)
  const { default: JsonlSessionPersistence } = await import(pathToFileURL(join(jsonlPath, 'lib', 'index.js')).href)

  // One context PER backend: `sessionPersistence` is a service name, so two
  // backends on one context collide ("already registered at <root>").
  const backends = {
    zstd: new JsonlSessionPersistence(new Context(), { root: SESSIONS_ROOT, compression: 'zstd' }),
    plain: new JsonlSessionPersistence(new Context(), { root: SESSIONS_ROOT, compression: 'none' }),
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = join(SESSIONS_ROOT + '-backup-' + stamp)

  const targets = findImportedArtifacts(SESSIONS_ROOT)
    .filter((t) => !ONLY_ID || t.id === ONLY_ID)
    .slice(0, LIMIT > 0 ? LIMIT : undefined)

  console.log('sessions root : ' + SESSIONS_ROOT)
  console.log('route         : ' + route.provider + ' / ' + route.model + (route.reasoningEffort ? ' (effort ' + route.reasoningEffort + ')' : ''))
  console.log('mode          : ' + (APPLY ? 'APPLY (writes)' : 'DRY RUN (nothing is written)'))
  console.log('candidates    : ' + targets.length)
  console.log('')

  const report = { pinned: 0, alreadyPinned: 0, skippedLocked: 0, skippedForeign: 0, notImported: 0, failed: 0 }
  for (const t of targets) {
    const backend = t.file.endsWith('.jsonl') ? backends.plain : backends.zstd
    let handle = null
    try {
      handle = await backend.open(t.id, 'write')
    } catch (e) {
      const msg = String((e && e.message) || e)
      const locked = /already owned|EBUSY|in use|lock/i.test(msg) || /AlreadyOwned/i.test(String(e && e.name))
      console.log((locked ? '  LOCKED  ' : '  FAIL    ') + t.id + '  -> ' + msg.slice(0, 120))
      if (locked) report.skippedLocked++
      else report.failed++
      continue
    }
    try {
      const slice = await handle.read(0)
      const events = (slice && slice.events) || []
      const headerPreset = (handle.header && handle.header.agentPreset) || null
      if (headerPreset !== IMPORTED_PRESET && !t.id.startsWith('hermes-')) {
        report.notImported++
        console.log('  SKIP    ' + t.id + '  (not an imported session: preset=' + String(headerPreset) + ')')
        continue
      }
      const tail = events[events.length - 1]
      const tailProvider = tail && tail.type === 'model/selection' ? tail.data && tail.data.provider : null
      if (!FORCE && tailProvider === route.provider) {
        report.alreadyPinned++
        console.log('  OK      ' + t.id + '  (tail already pins ' + tailProvider + ')')
        continue
      }
      const event = {
        type: 'model/selection',
        seq: events.length,
        time: Date.now(),
        data: { ...route },
      }
      const lastHeader = [...events].reverse().find((e) => e.type === 'request/header')
      const historic = lastHeader ? lastHeader.data.header.config.provider + '/' + lastHeader.data.header.config.model : '(none)'
      if (!APPLY) {
        console.log('  WOULD   ' + t.id + '  events=' + events.length + '  historic=' + historic +
          '  -> pin ' + route.provider + '/' + route.model)
        report.pinned++
        continue
      }
      const saved = backup(t.file, backupRoot)
      await handle.append([event])
      await handle.flush()
      console.log('  PINNED  ' + t.id + '  events=' + events.length + '->' + (events.length + 1) +
        '  historic=' + historic + '  backup=' + saved.slice(SESSIONS_ROOT.length + 1))
      report.pinned++
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/already owned|EBUSY|lock/i.test(msg)) { report.skippedLocked++; console.log('  LOCKED  ' + t.id + '  -> ' + msg.slice(0, 120)) }
      else { report.failed++; console.log('  FAIL    ' + t.id + '  -> ' + msg.slice(0, 160)) }
    } finally {
      try { await handle.close() } catch {}
    }
  }

  console.log('')
  console.log((APPLY ? 'pinned ' : 'would pin ') + report.pinned +
    '  already-ok ' + report.alreadyPinned +
    '  locked ' + report.skippedLocked +
    '  not-imported ' + report.notImported +
    '  failed ' + report.failed)
  if (APPLY && report.pinned > 0) console.log('backup root: ' + backupRoot)
  if (!APPLY) console.log('DRY RUN -- re-run with --apply to write')
  process.exit(report.failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
