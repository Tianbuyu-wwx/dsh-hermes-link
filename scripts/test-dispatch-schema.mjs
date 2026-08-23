#!/usr/bin/env node
// scripts/test-dispatch-schema.mjs
// Unit tests for http/dispatch.mjs validateSpec + clampInt + formatPersona.
// No DSH runtime required (dispatch.mjs only imports the JSON schema).

import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dispatchPath = join(root, 'packages', 'dsh-hermes-link', 'http', 'dispatch.mjs')
const { validateSpec, clampInt, formatPersona } = await import(pathToFileURL(dispatchPath).href)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

const MINIMAL = { task_id: 't-001', skill: 'read', task: 'do the thing' }
const FULL = {
  task_id: 't-002',
  skill: 'web_search',
  task: 'find top 5 react state libs',
  args: { query: 'react' },
  knowledge_subset: [{ source: 'kb.md', scope: '#top5', excerpt: '…', why: 'focus' }],
  model_tier: 'pro',
  max_tokens: 8000,
  deadline_ms: 120000,
  mode: 'one-shot',
}

t('case 1: minimal valid spec passes', () => {
  assert.equal(validateSpec(MINIMAL), null)
})

t('case 2: full valid spec passes (incl. continueable mode)', () => {
  assert.equal(validateSpec({ ...FULL, mode: 'continuable', provider: 'fork', shared_history_n: 3 }), null)
})

t('case 3: missing required field fails', () => {
  const err = validateSpec({ task_id: 't', skill: 'read' })
  assert.ok(err && err.includes('missing required field: task'))
})

t('case 4: unknown top-level field fails (additionalProperties=false)', () => {
  const err = validateSpec({ ...MINIMAL, rogue: 1 })
  assert.ok(err && err.includes('unknown field'))
})

t('case 5: task over maxLength fails', () => {
  const err = validateSpec({ ...MINIMAL, task: 'x'.repeat(8001) })
  assert.ok(err && err.includes('longer than maxLength'))
})

t('case 6: invalid model_tier enum fails', () => {
  const err = validateSpec({ ...MINIMAL, model_tier: 'sonnet' })
  assert.ok(err && err.includes('model_tier'))
})

t('case 7: non-integer max_tokens fails', () => {
  const err = validateSpec({ ...MINIMAL, max_tokens: 4000.5 })
  assert.ok(err && err.includes('must be integer'))
})

t('case 8: max_tokens below minimum fails', () => {
  const err = validateSpec({ ...MINIMAL, max_tokens: 100 })
  assert.ok(err && err.includes('too small'))
})

t('case 9: knowledge_subset over maxItems fails', () => {
  const items = Array.from({ length: 17 }, (_, i) => ({ source: 's' + i }))
  const err = validateSpec({ ...MINIMAL, knowledge_subset: items })
  assert.ok(err && err.includes('more than 16'))
})

t('case 10: knowledge_subset entry with unknown field fails', () => {
  const err = validateSpec({ ...MINIMAL, knowledge_subset: [{ source: 'a', nope: 1 }] })
  assert.ok(err && err.includes('unknown field'))
})

t('case 11: non-object spec fails', () => {
  assert.ok(validateSpec('nope') && validateSpec(null) && validateSpec([1]))
})

t('case 12: clampInt behaviors', () => {
  assert.equal(clampInt(undefined, 1, 10, 5), 5)
  assert.equal(clampInt('7', 1, 10, 5), 7)
  assert.equal(clampInt(99, 1, 10, 5), 10)
  assert.equal(clampInt('abc', 1, 10, 5), 5)
})

t('case 13: formatPersona includes mode / provider / task envelope', () => {
  const p = formatPersona({ ...MINIMAL, model_tier: 'flash', args: { a: 1 } }, 'FOUNDATION', { mode: 'one-shot', provider: 'spawn' })
  assert.ok(p.includes('--- task envelope'))
  assert.ok(p.includes('mode: one-shot'))
  assert.ok(p.includes('provider: spawn'))
  assert.ok(p.includes('FOUNDATION'))
  assert.ok(p.includes('Do NOT call tools beyond the one allowed tool'))
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)