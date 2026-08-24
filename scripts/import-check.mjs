#!/usr/bin/env node
// scripts/import-check.mjs
// Full module-load check for every dsh-hermes-link source file (imports resolve,
// top-level code runs). Requires the repo-local node_modules/@deepseek-ai
// junction (points at the DSH harness checkout) for dsh package imports.
// No DSH runtime required — only module loading, no ctx wiring.

const root = new URL('..', import.meta.url).pathname.replace(/\\/g, '/')
const url = (p) => new URL('../' + p, import.meta.url).href

// The dsh-hermes-link plugin imports @deepseek-ai/* packages that are provided
// by the DSH host at runtime. In a CI sandbox without a DSH checkout those
// imports cannot resolve, so the whole import-check is a no-op skip.
let hasDshHost = true
try {
  await import(url('packages/dsh-hermes-link/index.mjs'))
} catch (e) {
  if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('@deepseek-ai/')) {
    hasDshHost = false
  } else {
    console.log(`  ✗ index.mjs failed to load for a NON-host reason: ${e.message}`)
    process.exit(1)
  }
}
if (!hasDshHost) {
  console.log('(import-check skipped — no @deepseek-ai/* host checkout available)')
  process.exit(0)
}

const modules = [
  'packages/dsh-hermes-link/index.mjs',
  'packages/dsh-hermes-link/import/request-dump-to-events.mjs',
  'packages/dsh-hermes-link/import/import-hermes-session.mjs',
  'packages/dsh-hermes-link/services/hermes-session-watcher.mjs',
  'packages/dsh-hermes-link/services/persona-loader.mjs',
  'packages/dsh-hermes-link/services/consult-hermes.mjs',
  'packages/dsh-hermes-link/services/hermes-inbox.mjs',
  'packages/dsh-hermes-link/services/outbox.mjs',
  'packages/dsh-hermes-link/services/continuations.mjs',
  'packages/dsh-hermes-link/services/amend-watcher.mjs',
  'packages/dsh-hermes-link/services/audit.mjs',
  'packages/dsh-hermes-link/services/hermes-project-memory.mjs',
  'packages/dsh-hermes-link/http/dispatch.mjs',
  'packages/dsh-hermes-link/tools/list-hermes-sessions.mjs',
  'packages/dsh-hermes-link/tools/import-hermes-session.mjs',
  'packages/dsh-hermes-link/tools/load-hermes-persona.mjs',
  'packages/dsh-hermes-link/tools/consult-hermes.mjs',
  'packages/dsh-hermes-link/tools/mirror-session-to-hermes.mjs',
  'packages/dsh-hermes-link/tools/load-hermes-project-memory.mjs',
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