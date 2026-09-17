// services/setup.mjs
//
// v0.6.10 - the planning half of `npx dsh-hermes-link-setup`.
//
// WHY: installing the bridge took six steps spread across the README (copy the Hermes
// plugin, enable it there, restart Hermes, restart DSH, verify, troubleshoot), and every
// one of them is a place a new user gets stuck -- the audit that started this project
// exists because two of those steps were silently skipped. The wizard answers "what is
// left to do, and can you do it for me?" in one screen.
//
// Pure planning on purpose: the bin does the IO, the tests exercise the decision table
// (missing plugin -> install, installed but not enabled -> enable, DSH running an older
// copy -> restart).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The `plugins.enabled` list out of a Hermes config.yaml, read without a YAML dep. */
export function enabledPluginsFromConfig(text) {
  const lines = String(text || "").split(/\r?\n/)
  const out = []
  let inPlugins = false
  let inEnabled = false
  for (const line of lines) {
    if (/^plugins:\s*$/.test(line)) { inPlugins = true; continue }
    if (inPlugins && /^[A-Za-z]/.test(line)) break
    if (!inPlugins) continue
    if (/^\s{1,4}enabled:\s*$/.test(line)) { inEnabled = true; continue }
    if (!inEnabled) continue
    const m = /^\s*-\s*(\S+)\s*$/.exec(line)
    if (m) { out.push(m[1]); continue }
    if (/^\s*\S/.test(line)) inEnabled = false
  }
  return out
}

/** Read what Hermes thinks about the bridge plugin. Never throws. */
export function readHermesPluginConfig({ hermesHome }) {
  const configPath = join(hermesHome, 'config.yaml')
  try {
    const text = readFileSync(configPath, 'utf8')
    const enabled = enabledPluginsFromConfig(text)
    return { configPath, exists: true, enabled: enabled.includes('dsh-link'), enabledPlugins: enabled }
  } catch {
    return { configPath, exists: false, enabled: false, enabledPlugins: [] }
  }
}

/**
 * The decision table. Inputs are already-read facts; output is a list of steps.
 * status: ok = nothing to do, action = the wizard can do it, manual = a human must,
 * fail = the wizard cannot proceed.
 */
export function planSetup({ hermesHome, hermesHomeExists = true, plugin, config, hermesCli = null, dshHealth = null, packageVersion = null } = {}) {
  const steps = []
  const actions = []
  const manual = []

  steps.push(hermesHomeExists
    ? { id: 'hermes_home', status: 'ok', title: 'Hermes home', detail: hermesHome }
    : { id: 'hermes_home', status: 'fail', title: 'Hermes home', detail: 'not found: ' + hermesHome, hint: 'pass --hermes-home <dir> or set HERMES_HOME' })

  const installed = !!(plugin && plugin.installed)
  if (!installed) {
    steps.push({ id: 'plugin_files', status: 'action', title: 'Hermes bridge plugin', detail: 'not installed at ' + ((plugin && plugin.dest) || '?') })
    actions.push('install')
  } else {
    steps.push({ id: 'plugin_files', status: 'ok', title: 'Hermes bridge plugin', detail: 'installed at ' + plugin.dest + ' (plugin ' + (plugin.version || 'unknown') + ')' })
  }

  if (config && config.enabled) {
    steps.push({ id: 'plugin_enabled', status: 'ok', title: 'Enabled in Hermes', detail: 'plugins.enabled lists dsh-link' })
  } else {
    const cmd = hermesCli
      ? hermesCli.cmd + " " + [...hermesCli.args, "plugins", "enable", "dsh-link", "--no-allow-tool-override"].join(" ")
      : "hermes plugins enable dsh-link --no-allow-tool-override"
    steps.push({ id: 'plugin_enabled', status: hermesCli ? 'action' : 'manual', title: 'Enabled in Hermes', detail: config && config.exists ? 'plugins.enabled does not list dsh-link' : 'no config.yaml yet', command: cmd })
    if (hermesCli) actions.push("enable"); else manual.push(cmd)
  }

  if (dshHealth && dshHealth.ok) {
    const running = dshHealth.version || 'unknown'
    const behind = !!(packageVersion && running !== packageVersion)
    steps.push(behind
      ? { id: 'dsh_plugin', status: 'manual', title: 'DSH plugin', detail: 'running ' + running + ', package is ' + packageVersion, hint: 'restart DSH to load ' + packageVersion }
      : { id: 'dsh_plugin', status: 'ok', title: 'DSH plugin', detail: 'running ' + running })
    if (behind) manual.push('restart DSH (running ' + running + ', package ' + packageVersion + ')')
  } else if (dshHealth) {
    steps.push({ id: 'dsh_plugin', status: 'ok', title: 'DSH plugin', detail: 'not probed (' + (dshHealth.error || 'no url') + ')' })
  }

  const needsHermesRestart = actions.includes('install') || actions.includes('enable')
  if (needsHermesRestart) {
    steps.push({ id: 'hermes_restart', status: 'manual', title: 'Restart Hermes', detail: 'plugins are discovered at start-up', hint: 'start a new Hermes session or restart it' })
    manual.push('restart Hermes (or start a new session) so it loads the bridge')
  }

  return { hermesHome, steps, actions, manual, ok: !steps.some((s) => s.status === "fail") && actions.length === 0 && manual.length === 0 }
}

/** One-screen rendering, shared by the CLI and the tests. */
export function renderSetup(plan, { dryRun = false } = {}) {
  const lines = []
  lines.push('dsh-hermes-link setup' + (dryRun ? ' (dry run)' : ''))
  lines.push('  hermes home: ' + plan.hermesHome)
  for (const s of plan.steps) {
    const tag = s.status === 'ok' ? 'ok  ' : s.status === 'action' ? 'TODO' : s.status === 'manual' ? 'YOU ' : 'FAIL'
    lines.push('  [' + tag + '] ' + s.title.padEnd(22) + ' ' + s.detail)
    if (s.command) lines.push('         ' + s.command)
    if (s.hint) lines.push('         -> ' + s.hint)
  }
  if (plan.manual.length) {
    lines.push('')
    lines.push('  left for you:')
    for (const m of plan.manual) lines.push('    - ' + m)
  }
  if (plan.ok) { lines.push(''); lines.push('  nothing to do - the bridge is installed, enabled and current.') }
  return lines.join("\n")
}
