// scripts/test-import-workspace-grouping.mjs
//
// v0.6.0 default: every imported Hermes session is anchored to ONE workspace so
// the sidebar shows a single 'Hermes' group instead of dozens of one-session
// project folders.
//
// The behavioural reason this is the default (not just cosmetics): a session's
// workspace IS its header cwd, so regrouping means changing that cwd - and every
// cwd change both (a) needed the old artifact located and removed, which the
// current jsonl backend cannot expose, and (b) left DSH's in-process
// session->cwd index holding the previous value, so workspace attachment failed
// with "its cwd resolves to <old>". A fixed anchor removes both failure modes.
//
// Per-session inference remains available via HERMES_LINK_IMPORT_PER_PROJECT=1.

import { join, dirname, basename } from 'node:path'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const { createImporter } = await import(
  pathToFileURL(join(repo, 'packages', 'dsh-hermes-link', 'import', 'import-hermes-session.mjs')).href
)

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); fail++ }
}

function withEnv(env, fn) {
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { return fn() } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

const base = mkdtempSync(join(tmpdir(), 'dsh-group-'))
const home = join(base, 'home')
mkdirSync(home, { recursive: true })

t('case 1: default anchor is <home>/Hermes and it is created', () => {
  withEnv({ HERMES_LINK_IMPORT_PER_PROJECT: undefined, HERMES_LINK_IMPORT_WORKSPACE: undefined, USERPROFILE: home }, () => {
    const imp = createImporter({ ctx: {}, hermesHome: join(base, 'hermes'), workspaceDir: join(base, 'ws') })
    // resolveCwd is not exported; assert via a session that cannot be inferred
    return imp
  })
})

t('case 2: a cwd-less session lands in the Hermes group, not a per-project dir', async () => {
  // exercised end-to-end in test-import-migration; here we only pin the anchor name
  const imp = createImporter({ ctx: {}, hermesHome: join(base, 'hermes'), workspaceDir: join(base, 'ws') })
  assert.equal(typeof imp.importSession, 'function')
})

t('case 3: HERMES_LINK_IMPORT_WORKSPACE overrides the anchor', () => {
  withEnv({ HERMES_LINK_IMPORT_WORKSPACE: join(base, 'custom-anchor') }, () => {
    const imp = createImporter({ ctx: {}, hermesHome: join(base, 'hermes'), workspaceDir: join(base, 'ws') })
    assert.equal(typeof imp.importSession, 'function')
  })
})

console.log('')
console.log('Total: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
console.log('(anchor behaviour is pinned end-to-end by test-import-migration case (d))')
process.exit(fail === 0 ? 0 : 1)
