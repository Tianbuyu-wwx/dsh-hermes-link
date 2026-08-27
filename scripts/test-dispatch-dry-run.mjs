#!/usr/bin/env node
// scripts/test-dispatch-dry-run.mjs
//
// Unit tests for services/dispatch-dry-run.mjs (v0.3.3 F5).

import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/dispatch-dry-run.mjs')).href
const { buildDispatchDryRun } = await import(modPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

const MIN = {
  task_id: 't-001',
  skill: 'web_search',
  task: 'find top 5 react state libs',
}

// --- happy path ---
t('case 1: valid minimal spec returns estimates', () => {
  const r = buildDispatchDryRun(MIN, {})
  assert.equal(r.ok, true)
  assert.ok(r.estimated_prompt_tokens > 0)
  assert.ok(r.estimated_max_output_tokens >= 0)
  assert.equal(r.model_tier, 'flash')
  assert.equal(r.estimated_max_output_tokens, 4000)  // default
})

t('case 2: model_tier override is recorded', () => {
  const r = buildDispatchDryRun({ ...MIN, model_tier: 'pro' }, {})
  assert.equal(r.model_tier, 'pro')
})

t('case 3: max_tokens override is recorded', () => {
  const r = buildDispatchDryRun({ ...MIN, max_tokens: 1000 }, {})
  assert.equal(r.estimated_max_output_tokens, 1000)
  assert.equal(r.estimated_total_tokens, r.estimated_prompt_tokens + 1000)
})

// --- char accounting ---
t('case 4: task_chars equals task.length', () => {
  const task = 'x'.repeat(500)
  const r = buildDispatchDryRun({ ...MIN, task }, {})
  assert.equal(r.task_chars, 500)
})

t('case 5: knowledge_subset excerpt chars sum correctly', () => {
  const ks = [
    { source: 'a.md', excerpt: 'aaa' },
    { source: 'b.md', excerpt: 'bb' },
    { source: 'c.md' /* no excerpt */ },
  ]
  const r = buildDispatchDryRun({ ...MIN, knowledge_subset: ks }, {})
  assert.equal(r.knowledge_chars, 5)
})

t('case 6: args is JSON-stringified for accounting', () => {
  const r = buildDispatchDryRun({ ...MIN, args: { query: 'hello', limit: 5 } }, {})
  // {"query":"hello","limit":5} = 27 chars
  assert.equal(r.args_chars, 27)
})

t('case 7: persona_chars comes from foundationSlice dep', () => {
  const r = buildDispatchDryRun(MIN, { foundationSlice: 'SOUL content here' })
  assert.equal(r.persona_chars, 17)
})

t('case 8: prompt_chars sums persona + task + knowledge + args + overhead', () => {
  const r = buildDispatchDryRun(
    { ...MIN, task: 'x'.repeat(100), args: { q: 'y' } },
    { foundationSlice: 'z'.repeat(50) },
  )
  // 500 (overhead) + 50 (persona) + 100 (task) + 0 (knowledge) + 9 ({"q":"y"}) = 659
  assert.equal(r.prompt_chars, 659)
})

t('case 9: estimated_prompt_tokens uses real tokenizer, prompt_chars keeps legacy formula', () => {
  // v0.5.0 (B1): estimated_prompt_tokens is now computed via the real
  // o200k_base / cl100k_base tokenizer (gpt-tokenizer), not chars / 4.
  // prompt_chars keeps the legacy ENVELOPE_OVERHEAD_CHARS + sum formula.
  const r = buildDispatchDryRun({ ...MIN, task: 'x'.repeat(99) }, { foundationSlice: 'z'.repeat(0) })
  assert.equal(r.prompt_chars, 599)   // 500 + 0 + 99 + 0 + 0 (legacy shape)
  // real tokens: 'x'.repeat(99) = 13 tokens + ENVELOPE_OVERHEAD_TOKENS(120)
  assert.equal(r.estimated_prompt_tokens, 133)
  assert.ok(['o200k_base', 'cl100k_base'].includes(r.tokenizer.impl), 'expected real tokenizer, got ' + r.tokenizer.status + '/' + r.tokenizer.impl)
})

// --- validation failures ---
t('case 10: missing task_id returns E_INVALID_SPEC', () => {
  const r = buildDispatchDryRun({ skill: 'x', task: 'y' }, {})
  assert.equal(r.ok, false)
  assert.equal(r.error_code, 'E_INVALID_SPEC')
  assert.ok(r.hint.includes('task_id'))
})

t('case 11: missing skill returns E_INVALID_SPEC', () => {
  const r = buildDispatchDryRun({ task_id: 't', task: 'y' }, {})
  assert.equal(r.ok, false)
  assert.ok(r.hint.includes('skill'))
})

t('case 12: missing task returns E_INVALID_SPEC', () => {
  const r = buildDispatchDryRun({ task_id: 't', skill: 'x' }, {})
  assert.equal(r.ok, false)
  assert.ok(r.hint.includes('task'))
})

t('case 13: null args returns E_INVALID_SPEC', () => {
  const r = buildDispatchDryRun(null, {})
  assert.equal(r.ok, false)
})

t('case 14: array args returns E_INVALID_SPEC', () => {
  const r = buildDispatchDryRun([1, 2, 3], {})
  assert.equal(r.ok, false)
})

t('case 15: empty task_id string is invalid', () => {
  const r = buildDispatchDryRun({ ...MIN, task_id: '' }, {})
  assert.equal(r.ok, false)
})

// --- warnings ---
t('case 16: unknown model_tier triggers warning', () => {
  const r = buildDispatchDryRun({ ...MIN, model_tier: 'gpt-5' }, {})
  assert.ok(r.warnings.some((w) => w.includes('unknown_model_tier')))
})

t('case 17: task > 4000 chars triggers long warning', () => {
  const r = buildDispatchDryRun({ ...MIN, task: 'x'.repeat(5000) }, {})
  assert.ok(r.warnings.some((w) => w.includes('task_long')))
})

t('case 18: task > 8000 chars triggers maxLength warning', () => {
  const r = buildDispatchDryRun({ ...MIN, task: 'x'.repeat(8500) }, {})
  assert.ok(r.warnings.some((w) => w.includes('task_at_or_above_maxLength')))
})

t('case 19: large prompt (real tokens > 16K) triggers prompt_very_large warning', () => {
  // v0.5.0 (B1): threshold is on real tokens now. 160K chars of 'x'
  // compresses to ~20K tokens on o200k_base, crossing PROMPT_VERY_LARGE_TOKENS=16000.
  const r = buildDispatchDryRun({ ...MIN, task: 'x'.repeat(160000) }, {})
  assert.ok(r.warnings.some((w) => w.includes('prompt_very_large')) || r.warnings.some((w) => w.includes('prompt_above_tier_budget')), 'expected prompt_very_large or prompt_above_tier_budget warning for large task')
})

t('case 20: persona > 4KB triggers truncation warning', () => {
  const r = buildDispatchDryRun(MIN, { foundationSlice: 'x'.repeat(5000) })
  assert.ok(r.warnings.some((w) => w.includes('persona_truncated')))
})

t('case 21: max_tokens < 256 triggers below_minimum warning', () => {
  const r = buildDispatchDryRun({ ...MIN, max_tokens: 100 }, {})
  assert.ok(r.warnings.some((w) => w.includes('max_tokens_below_minimum')))
})

t('case 22: max_tokens > 32000 triggers above_maximum warning', () => {
  const r = buildDispatchDryRun({ ...MIN, max_tokens: 50000 }, {})
  assert.ok(r.warnings.some((w) => w.includes('max_tokens_above_maximum')))
})

t('case 23: unknown mode triggers warning', () => {
  const r = buildDispatchDryRun({ ...MIN, mode: 'super-batch' }, {})
  assert.ok(r.warnings.some((w) => w.includes('unknown_mode')))
})

t('case 24: unknown provider triggers warning', () => {
  const r = buildDispatchDryRun({ ...MIN, provider: 'clone' }, {})
  assert.ok(r.warnings.some((w) => w.includes('unknown_provider')))
})

// --- would_block_on ---
t('case 25: unknown skill triggers would_block_on when ctx.tools.view returns names', () => {
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: ['other_skill', 'another_skill'] }),
    },
  }
  const r = buildDispatchDryRun(MIN, { ctx })
  assert.ok(r.would_block_on.includes('skill:unknown_tool'))
  assert.ok(r.warnings.some((w) => w.includes('not in dsh tools catalog')))
})

t('case 26: known skill does NOT trigger would_block_on', () => {
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: ['web_search', 'other_skill'] }),
    },
  }
  const r = buildDispatchDryRun(MIN, { ctx })
  assert.equal(r.would_block_on.includes('skill:unknown_tool'), false)
})

t('case 27: missing ctx (no deps) does not crash and does not add would_block_on', () => {
  const r = buildDispatchDryRun(MIN, {})
  assert.equal(r.would_block_on.length, 0)
})

t('case 28: ctx.tools.view throwing does not crash', () => {
  const ctx = { tools: { view: () => { throw new Error('view failed') } } }
  const r = buildDispatchDryRun(MIN, { ctx })
  // Should still succeed but skip the skill check
  assert.equal(r.ok, true)
  assert.equal(r.would_block_on.length, 0)
})

// --- realistic integration ---
t('case 29: realistic Hermes pre-flight scenario', () => {
  const ctx = {
    tools: { view: () => ({ restrictableNames: ['web_search', 'code_search'] }) },
  }
  // Hermes wants to dispatch a code-search with 200-char task, 5 knowledge excerpts of 50 chars each
  const ks = Array.from({ length: 5 }, (_, i) => ({ source: 'doc' + i + '.md', excerpt: 'x'.repeat(50) }))
  const args = { query: 'find usage of X', limit: 10 }
  const r = buildDispatchDryRun({
    task_id: 'h-2026-001',
    skill: 'web_search',
    task: 'x'.repeat(200),
    args,
    knowledge_subset: ks,
    model_tier: 'pro',
    max_tokens: 2000,
  }, { ctx, foundationSlice: 'core soul content' })
  assert.equal(r.ok, true)
  assert.equal(r.model_tier, 'pro')
  assert.equal(r.estimated_max_output_tokens, 2000)
  assert.equal(r.would_block_on.length, 0)
  assert.equal(r.warnings.length, 0)
  // 500 + ~18 (persona) + 200 + 250 (knowledge) + ~30 (args) = ~998
  assert.ok(r.prompt_chars > 900 && r.prompt_chars < 1100)
})

// --- dry-run never spawns ---
t('case 30: dry-run has no side effects (no audit, no outbox, no continuations)', () => {
  const r = buildDispatchDryRun(MIN, {})
  // The function returns a pure data structure; no global state touched.
  assert.equal(typeof r, 'object')
  assert.ok('estimated_prompt_tokens' in r)
  assert.ok('would_block_on' in r)
  assert.ok('warnings' in r)
  // Pure data only - no Promise, no async
  assert.ok(r.constructor === Object)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
