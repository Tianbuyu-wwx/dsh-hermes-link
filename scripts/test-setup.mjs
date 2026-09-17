#!/usr/bin/env node
// scripts/test-setup.mjs
//
// v0.6.10 - the setup wizard's decision table and its Hermes-config reader. Pure
// functions only: the bin does the IO, so this suite can pin every branch without
// touching a real Hermes installation.

import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const setupPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/setup.mjs')).href
const { enabledPluginsFromConfig, planSetup, renderSetup } = await import(setupPath)
const installPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/hermes-plugin-install.mjs')).href
const { detectHermesHome } = await import(installPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log('  ok ' + name); passed++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); failed++ }
}

t('home detection follows HERMES_HOME, then the platform default', () => {
  assert.equal(detectHermesHome({ HERMES_HOME: 'D:/h' }, 'win32'), 'D:/h')
  assert.match(detectHermesHome({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'win32'), /hermes$/)
  assert.match(detectHermesHome({ HOME: '/home/x' }, 'linux'), /hermes$/)
})

t('config reader finds plugins.enabled without a YAML dependency', () => {
  const text = [
    'agent-default-model:',
    '  provider: x',
    'plugins:',
    '  enabled:',
    '    - dsh-link',
    '    - other',
    '  entries:',
    '    dsh-link:',
    '      llm: {}',
  ].join('\n')
  assert.deepEqual(enabledPluginsFromConfig(text), ['dsh-link', 'other'], 'entries must not leak into the list')
  assert.deepEqual(enabledPluginsFromConfig('plugins:\n  enabled: []\n'), [])
  assert.deepEqual(enabledPluginsFromConfig(''), [])
  assert.deepEqual(enabledPluginsFromConfig('other:\n  enabled:\n    - nope\n'), [], 'a different section is not the plugins section')
})

t('missing plugin -> the wizard installs it and asks for a Hermes restart', () => {
  const plan = planSetup({
    hermesHome: 'H',
    plugin: { installed: false, dest: 'H/plugins/dsh-link' },
    config: { exists: false, enabled: false },
    hermesCli: null,
    dshHealth: { ok: true, version: '0.6.10' },
    packageVersion: '0.6.10',
  })
  assert.deepEqual(plan.actions, ['install'], 'the wizard can copy the files')
  assert.equal(plan.ok, false)
  assert.ok(plan.manual.some((m) => m.includes('enable dsh-link')), 'no CLI -> the exact command is printed')
  assert.ok(plan.manual.some((m) => m.includes('restart Hermes')))
  assert.equal(plan.steps.find((s) => s.id === 'plugin_files').status, 'action')
  assert.match(renderSetup(plan), /\[TODO\] Hermes bridge plugin/)
})

t('installed but not enabled -> enable through the Hermes CLI when one exists', () => {
  const plan = planSetup({
    hermesHome: 'H',
    plugin: { installed: true, dest: 'H/plugins/dsh-link', version: '0.3.0' },
    config: { exists: true, enabled: false },
    hermesCli: { cmd: 'python', args: ['-m', 'hermes_cli.main'], cwd: 'H/hermes-agent' },
    dshHealth: { ok: true, version: '0.6.10' },
    packageVersion: '0.6.10',
  })
  assert.deepEqual(plan.actions, ['enable'])
  const step = plan.steps.find((s) => s.id === 'plugin_enabled')
  assert.equal(step.status, 'action')
  assert.match(step.command, /hermes_cli\.main plugins enable dsh-link --no-allow-tool-override/)
  assert.ok(plan.manual.some((m) => m.includes('restart Hermes')))
})

t('everything in place -> ok, nothing for the human', () => {
  const plan = planSetup({
    hermesHome: 'H',
    plugin: { installed: true, dest: 'H/plugins/dsh-link', version: '0.3.0' },
    config: { exists: true, enabled: true },
    hermesCli: null,
    dshHealth: { ok: true, version: '0.6.10' },
    packageVersion: '0.6.10',
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.manual, [])
  assert.match(renderSetup(plan), /nothing to do/)
})

t('a DSH running an older package is reported, not silently accepted', () => {
  const plan = planSetup({
    hermesHome: 'H',
    plugin: { installed: true, dest: 'H/plugins/dsh-link', version: '0.3.0' },
    config: { exists: true, enabled: true },
    hermesCli: null,
    dshHealth: { ok: true, version: '0.6.6' },
    packageVersion: '0.6.10',
  })
  assert.equal(plan.ok, false)
  assert.ok(plan.manual.some((m) => m.includes('restart DSH')))
  assert.equal(plan.steps.find((s) => s.id === 'dsh_plugin').status, 'manual')
})

t('an unreachable DSH is not an error, and a missing Hermes home is fatal', () => {
  const noDsh = planSetup({
    hermesHome: 'H',
    plugin: { installed: true, dest: 'H/p' },
    config: { exists: true, enabled: true },
    hermesCli: null,
    dshHealth: { ok: false, error: 'fetch failed' },
    packageVersion: '0.6.10',
  })
  assert.equal(noDsh.ok, true, "DSH not running yet is normal during setup")
  const noHome = planSetup({ hermesHome: "H", hermesHomeExists: false })
  assert.equal(noHome.ok, false)
  assert.equal(noHome.steps[0].status, 'fail')
})

console.log('')
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
