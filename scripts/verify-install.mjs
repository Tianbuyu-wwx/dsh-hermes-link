#!/usr/bin/env node
// scripts/verify-install.mjs
// Post-install structural verification. Checks DSH profile + Hermes config.
// Idempotent — run anytime to confirm the install is intact.

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshProfile = process.env.DSH_PROFILE ||
  join(homedir(), '.dsh', 'profiles', 'web')

const hermesHome = process.env.HERMES_HOME ||
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')

const checks = []
let failed = 0
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
  if (!ok) failed++
}

// 1. DSH profile exists
check('DSH profile exists', existsSync(dshProfile), dshProfile)

// 2. hermes-link installed as junction / link
const dst = join(dshProfile, 'node_modules', 'hermes-link')
const dstExists = existsSync(dst)
check('hermes-link installed in node_modules', dstExists, dst)
if (dstExists) {
  const st = statSync(dst)
  check('hermes-link is a directory', st.isDirectory())
  check('hermes-link/index.mjs readable', existsSync(join(dst, 'index.mjs')))
  check('hermes-link/cordis.patch.yml readable', existsSync(join(dst, 'cordis.patch.yml')))
  check('hermes-link/package.json readable', existsSync(join(dst, 'package.json')))
}

// 3. Old hermes-* packages should be removed
const old = ['hermes-foundation','hermes-oneshot-arbitrate','hermes-dispatch-bridge','hermes-dsh-collab']
for (const pkg of old) {
  const p = join(dshProfile, 'node_modules', pkg)
  check('removed: ' + pkg, !existsSync(p))
}

// 5. package.json: dependencies + bundles
const pkgJsonPath = join(dshProfile, 'package.json')
if (existsSync(pkgJsonPath)) {
  let pkgJson
  try { pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) } catch (e) {
    check('package.json parses', false, e.message)
  }
  if (pkgJson) {
    const deps = pkgJson.dependencies || {}
    check('package.json has hermes-link dependency',
      Object.keys(deps).includes('hermes-link'),
      deps['hermes-link'] || '')
    for (const pkg of old) {
      check('package.json removed ' + pkg + ' dependency',
        !Object.keys(deps).includes(pkg))
    }
    const bundles = (pkgJson.dsh && pkgJson.dsh.profile && pkgJson.dsh.profile.bundles) || []
    check('package.json bundles has hermes-link', bundles.includes('hermes-link'))
    for (const pkg of old) {
      check('package.json bundles removed ' + pkg, !bundles.includes(pkg))
    }
  }
} else {
  check('package.json exists', false, pkgJsonPath)
}

// 6. cordis.patch.yml
const cordisPatch = join(dshProfile, 'cordis.patch.yml')
if (existsSync(cordisPatch)) {
  const cp = readFileSync(cordisPatch, 'utf8')
  // hermes-link row, enabled (multiline; RegExp ctor for flags)
  check('cordis.patch.yml has hermes-link enabled',
    new RegExp('^- id: hermes-link\\b.*?disabled:\\s*false', 'ms').test(cp))
  // old rows still listed (disabled, idempotent)
  for (const pkg of old) {
    check('cordis.patch.yml still references ' + pkg + ' (disabled)',
      new RegExp('- id: ' + pkg + '\\b').test(cp))
  }
} else {
  check('cordis.patch.yml exists', false, cordisPatch)
}

// 7. Hermes config.yaml
const hermesConfig = join(hermesHome, 'config.yaml')
if (existsSync(hermesConfig)) {
  const hc = readFileSync(hermesConfig, 'utf8')
  check('Hermes config.yaml points to /mcp/collab',
    hc.includes('http://127.0.0.1:3080/mcp/collab'))
  check('Hermes config.yaml no longer references /mcp/dispatch',
    !hc.includes('http://127.0.0.1:3080/mcp/dispatch'))
} else {
  check('Hermes config.yaml exists (warning, optional)', false,
    hermesConfig + ' — Hermes may not be installed; skip this check')
}

// 8. Hermes Home/sessions exists
const sessionsDir = join(hermesHome, 'sessions')
check('Hermes sessions dir exists', existsSync(sessionsDir), sessionsDir)

// 9. hermes-imported agent preset exists (required for resume)
const presetDir = join(homedir(), '.dsh', '.agent-presets', 'hermes-imported')
check('hermes-imported agent preset exists',
  existsSync(join(presetDir, 'agent.cordis.yml')),
  presetDir)

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
const ICON = (ok) => ok ? '\u2713' : '\u2717'
for (const c of checks) {
  const detail = c.detail ? c.detail.replace(hermesHome, '<HERMES_HOME>').replace(dshProfile, '<DSH_PROFILE>') : ''
  console.log(`  ${ICON(c.ok)} ${pad(c.label, 60)} ${detail}`)
}
console.log('')
console.log(`Total: ${checks.length}  Passed: ${checks.length - failed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)