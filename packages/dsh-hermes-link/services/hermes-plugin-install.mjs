// services/hermes-plugin-install.mjs
//
// v0.6.10 - the copy step shared by `hermes-link-install-hermes-plugin` and the new
// `hermes-link-setup` wizard. Extracted so the wizard cannot drift from the installer
// (one copy path, one set of guards) and so the guards can be tested without spawning
// a process.
//
// Two Windows traps are encoded here:
//   * `cpSync` needs the destination entry to exist and fails with a confusing ESRCH
//     when it does not -> `copyFileSync` per file;
//   * a copy that quietly does nothing (AV, locked file) must not be reported as
//     success -> every file is verified to exist afterwards.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Same precedence the plugin, the DSH side and both CLIs use. */
export function detectHermesHome(env = process.env, platform = process.platform) {
  if (env.HERMES_HOME) return env.HERMES_HOME
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hermes')
}

/** The packaged plugin lives next to this service file: <pkg>/hermes-plugin/dsh-link. */
export function pluginSourceDir(pkgRoot) {
  return join(pkgRoot, 'hermes-plugin', 'dsh-link')
}

/** Version declared by a plugin.yaml (the only field the wizard needs). */
export function readPluginVersion(dir) {
  try {
    const text = readFileSync(join(dir, 'plugin.yaml'), 'utf8')
    const m = /^version:\s*(.+)$/m.exec(text)
    return m ? m[1].trim() : null
  } catch { return null }
}

/**
 * What is on disk right now, without touching anything.
 * @returns {{dest:string, installed:boolean, version:string|null, missing:string[]}}
 */
export function inspectInstalledPlugin({ hermesHome, pkgRoot }) {
  const dest = join(hermesHome, 'plugins', 'dsh-link')
  const required = ['plugin.yaml', '__init__.py']
  const installed = required.every((f) => existsSync(join(dest, f)))
  return { dest, installed, version: installed ? readPluginVersion(dest) : null, missing: required.filter((f) => !existsSync(join(dest, f))) }
}

/**
 * Copy the packaged plugin into <Hermes Home>/plugins/dsh-link/.
 * @returns {{dest:string, files:string[], copied:string[], missing:string[], dryRun:boolean}}
 */
export function installHermesPlugin({ hermesHome, pkgRoot, dryRun = false }) {
  const src = pluginSourceDir(pkgRoot)
  if (!existsSync(src)) throw new Error('the packaged plugin is missing: ' + src)
  const files = readdirSync(src).filter((f) => statSync(join(src, f)).isFile())
  const dest = join(hermesHome, 'plugins', 'dsh-link')
  if (dryRun) return { dest, files, copied: [], missing: [], dryRun: true }
  mkdirSync(dest, { recursive: true })
  const copied = []
  for (const f of files) {
    copyFileSync(join(src, f), join(dest, f))
    copied.push(f)
  }
  const missing = files.filter((f) => !existsSync(join(dest, f)))
  return { dest, files, copied, missing, dryRun: false }
}
