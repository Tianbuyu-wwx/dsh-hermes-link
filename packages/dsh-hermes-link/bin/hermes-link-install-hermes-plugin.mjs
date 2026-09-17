#!/usr/bin/env node
// bin/hermes-link-install-hermes-plugin.mjs
//
// Installs the Hermes-side bridge (hermes-plugin/dsh-link) into a Hermes
// installation: it writes the outbox/hermes notifications DSH has been reading
// since v0.6.0 AND answers the consult tickets DSH has been writing since v0.2.0.
//
// The plugin is copied to <Hermes Home>/plugins/dsh-link/ -- the documented
// out-of-tree plugin location ($HERMES_HOME/plugins/, later-wins discovery).
// Hermes loads plugins at start-up, so it must be restarted afterwards.
//
// v0.6.10: the copy itself moved to services/hermes-plugin-install.mjs so the
// setup wizard shares it; this stays the low-level, scriptable entry point.
//
// USAGE
//   npx hermes-link-install-hermes-plugin             # install
//   npx hermes-link-install-hermes-plugin --dry-run   # show what would happen
//   npx hermes-link-install-hermes-plugin --hermes-home <dir>
//
// EXIT: 0 installed (or already current), 2 = bad usage / Hermes home not found.

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const { detectHermesHome, installHermesPlugin, inspectInstalledPlugin } =
  await import(pathToFileURL(join(pkgRoot, 'services', 'hermes-plugin-install.mjs')).href)

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const argOf = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : d }

const home = argOf('--hermes-home', detectHermesHome())
const dryRun = has('--dry-run')

if (!existsSync(home)) {
  console.error('no Hermes home at ' + home + ' (pass --hermes-home <dir> or set HERMES_HOME)')
  process.exit(2)
}

let plan
try {
  plan = installHermesPlugin({ hermesHome: home, pkgRoot, dryRun })
} catch (e) {
  console.error(e && e.message || String(e))
  process.exit(2)
}

console.log('hermes home : ' + home)
console.log('plugin dest : ' + plan.dest)
console.log('files       : ' + plan.files.join(', '))
if (dryRun) {
  console.log('')
  console.log('DRY RUN - nothing written. Re-run without --dry-run to install.')
  process.exit(0)
}

if (plan.missing.length > 0) {
  console.error('copy reported success but these files are missing: ' + plan.missing.join(', '))
  process.exit(1)
}

const state = inspectInstalledPlugin({ hermesHome: home, pkgRoot })
console.log('')
console.log('installed ' + plan.copied.length + ' file(s), plugin version ' + (state.version || 'unknown') + '.')
console.log('NEXT: restart Hermes (plugins are discovered at start-up), then verify with')
console.log('  curl http://127.0.0.1:3080/mcp/collab/hermes-outbox/status   # DSH side counters')
console.log('  dir "%LOCALAPPDATA%\\hermes\\outbox\\hermes"                  # produced notifications')
console.log('  npx hermes-link-status                                        # one-glance health')
