#!/usr/bin/env node
// scripts/smoke-test.mjs
// Static structure check for dsh-hermes-link v0.1.
// No DSH runtime required. Fails loud on missing files or shape issues.

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'packages', 'dsh-hermes-link')

const checks = []
let failed = 0

function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  if (!ok) failed++
}

function mustExist(rel) {
  const p = join(pkg, rel)
  return existsSync(p) && statSync(p).isFile() ? p : null
}

// 1. Required files
const required = [
  'package.json',
  'cordis.patch.yml',
  'index.mjs',
  'dispatch-spec.schema.json',
  'skills/dsh-hermes-link/SKILL.md',
  'import/request-dump-to-events.mjs',
  'import/import-hermes-session.mjs',
  'services/hermes-session-watcher.mjs',
  'services/persona-loader.mjs',
  'services/consult-hermes.mjs',
  'services/hermes-inbox.mjs',
  'services/outbox.mjs',
  'services/redact.mjs',
  'services/session-mirror.mjs',
  'services/continuations.mjs',
  'services/amend-watcher.mjs',
  'services/audit.mjs',
  'services/hermes-project-memory.mjs',
  'http/dispatch.mjs',
  'tools/list-hermes-sessions.mjs',
  'tools/session-mirror-control.mjs',
  'tools/import-hermes-session.mjs',
  'tools/load-hermes-persona.mjs',
  'tools/consult-hermes.mjs',
  'tools/mirror-session-to-hermes.mjs',
  'tools/load-hermes-project-memory.mjs',
]
for (const f of required) {
  check('file exists: ' + f, !!mustExist(f))
}

// 2. package.json fields
const pkgJsonPath = mustExist('package.json')
let pkgJson = null
try {
  pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
} catch (e) {
  check('package.json parses', false, e.message)
}
if (pkgJson) {
  check('package.json name=@tianbuyu-wwx/dsh-hermes-link', pkgJson.name === '@tianbuyu-wwx/dsh-hermes-link', 'name=' + pkgJson.name)
  check('package.json type=module', pkgJson.type === 'module')
  check('package.json main=./index.mjs', pkgJson.main === './index.mjs')
  check('package.json has dsh.bundle.patch', pkgJson.dsh && pkgJson.dsh.bundle && pkgJson.dsh.bundle.patch === './cordis.patch.yml')
}

// 3. cordis.patch.yml shape
const cordisYml = readFileSync(join(pkg, 'cordis.patch.yml'), 'utf8')
check('cordis.patch.yml mentions dsh-hermes-link', /dsh-hermes-link/.test(cordisYml))
check('cordis.patch.yml has insert section', /insert:/.test(cordisYml))

// 4. dispatch-spec.schema.json valid
try {
  const schema = JSON.parse(readFileSync(join(pkg, 'dispatch-spec.schema.json'), 'utf8'))
  check('schema.type=object', schema.type === 'object')
  check('schema.required contains task_id,skill,task',
    Array.isArray(schema.required) &&
    schema.required.includes('task_id') &&
    schema.required.includes('skill') &&
    schema.required.includes('task'))
  check('schema.additionalProperties=false', schema.additionalProperties === false)
} catch (e) {
  check('dispatch-spec.schema.json parses', false, e.message)
}

// 5. index.mjs exports
const indexSrc = readFileSync(join(pkg, 'index.mjs'), 'utf8')
check('index.mjs exports name', /export const name\s*=\s*['"]dsh-hermes-link['"]/.test(indexSrc))
check('index.mjs exports inject', /export const inject\s*=/.test(indexSrc))
check('index.mjs exports apply', /export function apply/.test(indexSrc))
check('index.mjs has detectHermesHome', /detectHermesHome/.test(indexSrc))

// 6. import/request-dump-to-events.mjs shape
const convSrc = readFileSync(join(pkg, 'import/request-dump-to-events.mjs'), 'utf8')
check('converter exports requestDumpToEvents', /export function requestDumpToEvents/.test(convSrc))
check('converter exports groupBySession', /export function groupBySession/.test(convSrc))
check('converter exports walkRequestDumps', /export function\* walkRequestDumps/.test(convSrc))
check('converter emits request/header', /'request\/header'/.test(convSrc))
check('converter emits session/end-seed', /'session\/end-seed'/.test(convSrc))

// 7. SKILL.md
const skillMd = readFileSync(join(pkg, 'skills/dsh-hermes-link/SKILL.md'), 'utf8')
check('SKILL.md mentions dsh-hermes-link', /dsh-hermes-link/.test(skillMd))
check('SKILL.md mentions /mcp/collab', /\/mcp\/collab/.test(skillMd))

// 7b. Hermes-side upgrade deliverable (v0.2.2)
const upgradeDoc = join(root, 'docs', 'hermes-upgrade-v0.2.2.md')
check('docs/hermes-upgrade-v0.2.2.md exists', existsSync(upgradeDoc))
if (existsSync(upgradeDoc)) {
  const txt = readFileSync(upgradeDoc, 'utf8')
  check('upgrade doc mentions reply_secret', /reply_secret/.test(txt))
  check('upgrade doc mentions amend_nonce', /amend_nonce/.test(txt))
  check('upgrade doc mentions HERMES_LINK_TRUST_LEGACY', /HERMES_LINK_TRUST_LEGACY/.test(txt))
}
const gatewayDemo = join(root, 'scripts', 'hermes-gateway-demo.py')
check('scripts/hermes-gateway-demo.py exists', existsSync(gatewayDemo))
if (existsSync(gatewayDemo)) {
  const py = readFileSync(gatewayDemo, 'utf8')
  check('gateway demo imports inbox/dsh paths', /Hermes Home/i.test(py))
  check('gateway demo writes secret-suffixed reply', /reply_secret|secret/.test(py))
  check('gateway demo writes nonce-suffixed amend', /amend_nonce|<nonce>/.test(py))
}

// 8. Syntax check on all .mjs
const mjsFiles = [
  'index.mjs',
  'import/request-dump-to-events.mjs',
  'import/import-hermes-session.mjs',
  'services/hermes-session-watcher.mjs',
  'services/persona-loader.mjs',
  'services/consult-hermes.mjs',
  'services/hermes-inbox.mjs',
  'services/outbox.mjs',
  'services/redact.mjs',
  'services/session-mirror.mjs',
  'services/continuations.mjs',
  'services/amend-watcher.mjs',
  'services/audit.mjs',
  'services/hermes-project-memory.mjs',
  'http/dispatch.mjs',
  'tools/list-hermes-sessions.mjs',
  'tools/session-mirror-control.mjs',
  'tools/import-hermes-session.mjs',
  'tools/load-hermes-persona.mjs',
  'tools/consult-hermes.mjs',
  'tools/mirror-session-to-hermes.mjs',
  'tools/load-hermes-project-memory.mjs',
]
for (const f of mjsFiles) {
  const p = join(pkg, f)
  try {
    // Primary pass: no stdio capture (works in sandboxed shells); the exit
    // code is the source of truth. On failure, retry with capture to surface
    // the actual syntax error text where pipes are allowed.
    const r = spawnSync(process.execPath, ['--check', p], { stdio: 'ignore' })
    if (r.status === 0) {
      check('syntax OK: ' + f, true)
      continue
    }
    const r2 = spawnSync(process.execPath, ['--check', p], { stdio: 'pipe' })
    const detail = (r2.stderr ? r2.stderr.toString() : '').split('\n').slice(0, 4).join(' | ') || 'syntax error'
    check('syntax OK: ' + f, false, detail)
  } catch (e) {
    check('syntax OK: ' + f, false, String(e && e.message || e).slice(0, 200))
  }
}

// 9. install/uninstall scripts exist
const installScript = join(root, 'scripts', 'install-dsh-hermes-link.ps1')
const uninstallScript = join(root, 'scripts', 'uninstall-dsh-hermes-link.ps1')
check('install-dsh-hermes-link.ps1 exists', existsSync(installScript))
check('uninstall-dsh-hermes-link.ps1 exists', existsSync(uninstallScript))

// 9b. v0.2.3 hardening test script exists
check('scripts/test-v0.2.3-hardening.mjs exists',
  existsSync(join(root, 'scripts', 'test-v0.2.3-hardening.mjs')))
const personaSrc = readFileSync(join(pkg, 'services', 'persona-loader.mjs'), 'utf8')
check('persona-loader no longer reads MEMORY.md (K.1)',
  !/if \(want\.memory\)/.test(personaSrc))
const redactSrc = readFileSync(join(pkg, 'services', 'redact.mjs'), 'utf8')
check('shared redact service covers cookie / set-cookie / session_id (K.5)',
  /cookie|session_id|set[_-]?cookie/i.test(redactSrc))
const mirrorSrc = readFileSync(join(pkg, 'tools', 'mirror-session-to-hermes.mjs'), 'utf8')
check('mirror-session tool re-exports shared redactEvent',
  /export \{ redactEvent \}/.test(mirrorSrc))
const sessionMirrorSrc = readFileSync(join(pkg, 'services', 'session-mirror.mjs'), 'utf8')
check('session-mirror service always redacts via redactEvent',
  /redactEvent/.test(sessionMirrorSrc))
const dispatchSrc = readFileSync(join(pkg, 'http', 'dispatch.mjs'), 'utf8')
check('dispatch exposes /mcp/collab/session-stream',
  /\/mcp\/collab\/session-stream/.test(dispatchSrc))
const importerSrc = readFileSync(join(pkg, 'import', 'import-hermes-session.mjs'), 'utf8')
check('import-hermes-session cwd safety check present (K.2)',
  /isSafeCwd/.test(importerSrc))
const outboxSrc = readFileSync(join(pkg, 'services', 'outbox.mjs'), 'utf8')
check('outbox appendSessionEvent bounds filename length (K.3)',
  /safeId\.length > 200/.test(outboxSrc))

// ----------------------------------------------------------------------------
// Output
// ----------------------------------------------------------------------------

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
const ICON = (ok) => ok ? '\u2713' : '\u2717'
for (const c of checks) {
  console.log(`  ${ICON(c.ok)} ${pad(c.label, 60)} ${c.detail || ''}`)
}
console.log('')
console.log(`Total: ${checks.length}  Passed: ${checks.length - failed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
