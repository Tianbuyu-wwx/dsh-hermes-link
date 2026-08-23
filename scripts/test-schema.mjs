// scripts/test-schema.mjs — exercises the lightweight JSON-Schema validator
// embedded in hermes-dispatch-bridge/index.mjs (extracted here so we can
// import & unit-test without booting the dsh runtime).
//
// Run:  node scripts/test-schema.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const schemaPath = join(repo, 'packages/hermes-dispatch-bridge/dispatch-spec.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

// -- extracted validator (must stay in sync with index.mjs) ----------------
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return 'spec must be a JSON object'
  }
  for (const k of schema.required) {
    if (spec[k] === undefined || spec[k] === null) {
      return 'missing required field: ' + k
    }
  }
  for (const [k, def] of Object.entries(schema.properties)) {
    const v = spec[k]
    if (v === undefined) continue
    if (def.type === 'string') {
      if (typeof v !== 'string') return k + ' must be string'
      if (def.minLength != null && v.length < def.minLength) return k + ' shorter than minLength=' + def.minLength
      if (def.maxLength != null && v.length > def.maxLength) return k + ' longer than maxLength=' + def.maxLength
      if (def.enum && !def.enum.includes(v)) return k + ' must be one of ' + def.enum.join(',')
    } else if (def.type === 'integer') {
      if (!Number.isInteger(v)) return k + ' must be integer'
      if (def.minimum != null && v < def.minimum) return k + ' too small'
      if (def.maximum != null && v > def.maximum) return k + ' too large'
    } else if (def.type === 'array') {
      if (!Array.isArray(v)) return k + ' must be array'
      if (def.maxItems != null && v.length > def.maxItems) return k + ' has more than ' + def.maxItems + ' items'
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const k of Object.keys(spec)) {
      if (!allowed.has(k)) return 'unknown field at top level: ' + k
    }
  }
  // Hard cap on knowledge_subset bytes.
  if (Array.isArray(spec.knowledge_subset)) {
    const MAX_KNOWLEDGE_BYTES = 2048
    const bytes = JSON.stringify(spec.knowledge_subset).length
    if (bytes > MAX_KNOWLEDGE_BYTES) return 'knowledge_subset is ' + bytes + ' bytes (> max ' + MAX_KNOWLEDGE_BYTES + ')'
  }
  return null
}

// -- test cases -------------------------------------------------------------

const valid = {
  version: '0.3',
  task_id: 'demo-1',
  skill:   'obsidian_search',
  task:    'find the venv migration note',
  knowledge_subset: [
    { source: '~/notes/py-venv.md', why: 'mid migration' },
  ],
  args: { query: 'tag:py-venv', max_results: 5 },
  model_tier: 'flash',
  max_tokens: 4000,
  deadline_ms: 60000,
}

const cases = [
  { name: 'all-required, no optional', spec: { version: '0.3', task_id: 't', skill: 'read', task: 'x' }, expectOk: true },
  { name: 'valid full payload',        spec: valid, expectOk: true },
  { name: 'missing required task_id',  spec: (() => { const s = { ...valid }; delete s.task_id; return s })(), expectOk: false },
  { name: 'wrong version',             spec: { ...valid, version: '0.99' }, expectOk: false },
  { name: 'task too long',             spec: { ...valid, task: 'x'.repeat(8001) }, expectOk: false },
  { name: 'model_tier invalid',        spec: { ...valid, model_tier: 'opus' }, expectOk: false },
  { name: 'max_tokens too low',        spec: { ...valid, max_tokens: 100 }, expectOk: false },
  { name: 'deadline_ms too high',      spec: { ...valid, deadline_ms: 999_999 }, expectOk: false },
  { name: 'knowledge_subset over 2KB',
    spec: { ...valid, knowledge_subset: Array.from({ length: 4 }, (_, i) => ({ source: 's' + i + '/' + 'x'.repeat(900) })) }, expectOk: false },
  { name: 'knowledge_subset 7 entries (boundary ok)',
    spec: { ...valid, knowledge_subset: Array.from({ length: 7 }, (_, i) => ({ source: 's' + i })) }, expectOk: true },
  { name: 'knowledge_subset 9 entries (over maxItems)',
    spec: { ...valid, knowledge_subset: Array.from({ length: 9 }, (_, i) => ({ source: 's' + i })) }, expectOk: false },
  { name: 'additional property rejected',
    spec: { ...valid, surprise: true }, expectOk: false },  // schema says additionalProperties:false
]

let fails = 0
for (const c of cases) {
  const r = validateSpec(c.spec)
  const isOk = r === null
  // 'additional property rejected' IS now enforced after the validator fix.
  const expect = c.expectOk
  const pass = isOk === expect
  console.log(`  ${pass ? '✓' : '✗'} ${c.name.padEnd(50)} ok=${isOk} want=${expect} err=${r || '-'}`)
  if (!pass) fails++
}
console.log(`\n[test-schema] ${fails === 0 ? 'OK' : `${fails} fail(s)`}`)
process.exit(fails === 0 ? 0 : 1)
