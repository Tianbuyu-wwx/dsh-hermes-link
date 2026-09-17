#!/usr/bin/env node
// bin/hermes-link-install-hermes-plugin.mjs
//
// Installs the Hermes-side producer (hermes-plugin/dsh-outbox) into a Hermes
// installation, so Hermes actually writes the notifications that DSH's
// outbox/hermes consumer has been reading since v0.6.0.
//
// The plugin is copied to <Hermes Home>/plugins/dsh-outbox/ — the documented
// out-of-tree plugin location ($HERMES_HOME/plugins/, later-wins discovery).
// Hermes loads plugins at start-up, so it must be restarted afterwards.
//
// USAGE
//   npx hermes-link-install-hermes-plugin             # install
//   npx hermes-link-install-hermes-plugin --dry-run   # show what would happen
//   npx hermes-link-install-hermes-plugin --hermes-home <dir>
//
// EXIT: 0 installed (or already current), 2 = bad usage / Hermes home not found.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const argOf = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : d }

/** Same precedence the plugin and the DSH side use. */
function detectHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hermes')
}

const home = argOf('--hermes-home', detectHermesHome())
const dryRun = has('--dry-run')
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(pkgRoot, 'hermes-plugin', 'dsh-outbox')
const dest = join(home, 'plugins', 'dsh-outbox')

if (!existsSync(src)) {
  console.error('the packaged plugin is missing: ' + src)
  process.exit(2)
}
if (!existsSync(home)) {
  console.error('no Hermes home at ' + home + ' (pass --hermes-home <dir> or set HERMES_HOME)')
  process.exit(2)
}

const files = readdirSync(src).filter((f) => statSync(join(src, f)).isFile())
console.log('hermes home : ' + home)
console.log('plugin src  : ' + src)
console.log('plugin dest : ' + dest)
console.log('files       : ' + files.join(', '))
if (dryRun) {
  console.log('')
  console.log('DRY RUN - nothing written. Re-run without --dry-run to install.')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
// copyFileSync, not cpSync: cpSync's override path needs the destination entry to
// already exist on Windows and fails with a confusing ESRCH when it does not.
for (const f of files) copyFileSync(join(src, f), join(dest, f))
const missing = files.filter((f) => !existsSync(join(dest, f)))
if (missing.length > 0) {
  console.error('copy reported success but these files are missing: ' + missing.join(', '))
  process.exit(1)
}
console.log('')
console.log('installed ' + files.length + ' file(s).')
console.log('NEXT: restart Hermes (plugins are discovered at start-up), then verify with')
console.log('  curl http://127.0.0.1:3080/mcp/collab/hermes-outbox/status   # DSH side counters')
console.log('  dir "%LOCALAPPDATA%\\hermes\\outbox\\hermes"                  # produced notifications')
