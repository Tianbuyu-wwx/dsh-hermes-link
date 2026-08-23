#!/usr/bin/env node
// scripts/import-check.mjs
// Full module-load check for every hermes-link source file (imports resolve,
// top-level code runs). Requires the repo-local node_modules/@deepseek-ai
// junction (points at the DSH harness checkout) for dsh package imports.
// No DSH runtime required — only module loading, no ctx wiring.

const root = new URL('..', import.meta.url).pathname.replace(/\\/g, '/')
const url = (p) => new URL('../' + p, import.meta.url).href

const modules = [
  'packages/hermes-link/index.mjs',
  'packages/hermes-link/import/request-dump-to-events.mjs',
  'packages/hermes-link/import/import-hermes-session.mjs',
  'packages/hermes-link/services/hermes-session-watcher.mjs',
  'packages/hermes-link/services/persona-loader.mjs',
  'packages/hermes-link/services/consult-hermes.mjs',
  'packages/hermes-link/services/hermes-inbox.mjs',
  'packages/hermes-link/services/outbox.mjs',
  'packages/hermes-link/services/continuations.mjs',
  'packages/hermes-link/services/amend-watcher.mjs',
  'packages/hermes-link/services/audit.mjs',
  'packages/hermes-link/services/hermes-project-memory.mjs',
  'packages/hermes-link/http/dispatch.mjs',
  'packages/hermes-link/tools/list-hermes-sessions.mjs',
  'packages/hermes-link/tools/import-hermes-session.mjs',
  'packages/hermes-link/tools/load-hermes-persona.mjs',
  'packages/hermes-link/tools/consult-hermes.mjs',
  'packages/hermes-link/tools/mirror-session-to-hermes.mjs',
  'packages/hermes-link/tools/load-hermes-project-memory.mjs',
]

let failed = 0
for (const m of modules) {
  try {
    const mod = await import(url(m))
    const exportNames = Object.keys(mod).slice(0, 6).join(',')
    console.log(`  \u2713 ${m}  -> [${exportNames}${Object.keys(mod).length > 6 ? ',…' : ''}]`)
  } catch (e) {
    console.log(`  \u2717 ${m}: ${e.message}`)
    failed++
  }
}
console.log('')
console.log(`Total: ${modules.length}  Passed: ${modules.length - failed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)