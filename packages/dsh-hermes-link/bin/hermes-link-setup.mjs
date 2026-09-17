#!/usr/bin/env node
// bin/hermes-link-setup.mjs
//
// v0.6.10 - one command from "I installed the npm package" to "both sides are
// talking". It checks the Hermes home, installs/updates the Hermes-side bridge
// plugin, enables it in Hermes (via the Hermes CLI when one is reachable, otherwise
// it prints the exact command), probes the running DSH plugin, and ends with the
// short list of things only a human can do (the restarts).
//
// USAGE
//   npx dsh-hermes-link-setup [--dry-run] [--hermes-home <dir>] [--url <dsh url>] [--json]
//
// EXIT: 0 everything is in place (restarts aside), 1 something still needs a human,
//       2 bad usage / Hermes home not found.

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const { detectHermesHome, installHermesPlugin, inspectInstalledPlugin } = await import(pathToFileURL(join(pkgRoot, 'services', 'hermes-plugin-install.mjs')).href)
const { planSetup, readHermesPluginConfig, renderSetup } = await import(pathToFileURL(join(pkgRoot, 'services', 'setup.mjs')).href)

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const argOf = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : d }

const hermesHome = argOf('--hermes-home', detectHermesHome())
const dshUrl = String(argOf('--url', process.env.HERMES_LINK_URL || 'http://127.0.0.1:3080')).replace(/\/+$/, '')
const dryRun = has('--dry-run')
const json = has('--json')

let packageVersion = null
try { packageVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version } catch { packageVersion = null }

/** A Hermes CLI we can actually run: the console script first, then the module. */
function findHermesCli() {
  const candidates = [
    { cmd: 'hermes', args: [], cwd: hermesHome },
    { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'hermes_cli.main'], cwd: join(hermesHome, 'hermes-agent') },
    { cmd: 'python', args: ['-m', 'hermes_cli.main'], cwd: join(hermesHome, 'hermes-agent') },
  ]
  for (const c of candidates) {
    if (c.args.length && !existsSync(c.cwd)) continue
    try {
      const r = spawnSync(c.cmd, [...c.args, 'plugins', 'list'], { cwd: c.cwd, encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' })
      if (r && r.status === 0) return c
    } catch { /* try the next candidate */ }
  }
  return null
}

async function probeDsh() {
  try {
    const res = await fetch(dshUrl + '/mcp/collab/health')
    if (!res.ok) return { ok: false, error: "HTTP " + res.status }
    const body = await res.json()
    return { ok: true, version: body.version || null }
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
}

function gather() {
  const plugin = inspectInstalledPlugin({ hermesHome, pkgRoot })
  const config = readHermesPluginConfig({ hermesHome })
  return { plugin, config }
}

if (!existsSync(hermesHome)) {
  console.error('no Hermes home at ' + hermesHome + ' (pass --hermes-home <dir> or set HERMES_HOME)')
  process.exit(2)
}

let gathered = gather()
const hermesCli = findHermesCli()
const dshHealth = await probeDsh()
let plan = planSetup({ hermesHome, hermesHomeExists: true, plugin: gathered.plugin, config: gathered.config, hermesCli, dshHealth, packageVersion })

if (!json) console.log(renderSetup(plan, { dryRun }))

if (!dryRun && plan.actions.length > 0) {
  if (!json) console.log('')
  if (plan.actions.includes("install")) {
    if (!json) console.log('  -> installing the Hermes bridge plugin ...')
    const r = installHermesPlugin({ hermesHome, pkgRoot })
    if (r.missing.length) { console.error("  !! copy reported success but these files are missing: " + r.missing.join(", ")); process.exit(1) }
    if (!json) console.log('     copied ' + r.copied.length + ' file(s) to ' + r.dest)
  }
  if (plan.actions.includes("enable") && hermesCli) {
    if (!json) console.log('  -> enabling it in Hermes ...')
    const r = spawnSync(hermesCli.cmd, [...hermesCli.args, 'plugins', 'enable', 'dsh-link', '--no-allow-tool-override'], { cwd: hermesCli.cwd, encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32' })
    const out = ((r && r.stdout) || "") + ((r && r.stderr) || "")
    if (!json) console.log("     " + out.trim().split("\n")[0])
    if (!r || r.status !== 0) console.error('  !! enable failed; run it yourself: ' + hermesCli.cmd + ' ' + [...hermesCli.args, 'plugins', 'enable', 'dsh-link', '--no-allow-tool-override'].join(' '))
  }
  gathered = gather()
  plan = planSetup({ hermesHome, hermesHomeExists: true, plugin: gathered.plugin, config: gathered.config, hermesCli, dshHealth, packageVersion })
  if (!json) { console.log(''); console.log(renderSetup(plan)) }
}

if (json) {
  console.log(JSON.stringify({ hermesHome, dshUrl, packageVersion, hermesCli: hermesCli ? hermesCli.cmd + " " + hermesCli.args.join(" ") : null, dshHealth, ...plan }, null, 2))
}
process.exit(plan.ok ? 0 : 1)
