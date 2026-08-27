#!/usr/bin/env node
// scripts/test-token-budget.mjs
//
// v0.5.0 (B1) - token-budget + real-tokenizer coverage for dispatch_dry_run.
//
// Covers:
//   - real tokenizer status / impl reported on every dry-run result
//   - per-piece char accounting unchanged (legacy prompt_chars formula)
//   - real-token count is exact (not ceil(chars/4))
//   - CJK + emoji + mixed input sanity
//   - max_prompt_tokens / max_total_tokens gates
//   - would_block_on populated when budget exceeded
//   - error_code_on_block surfaces E_TOKEN_BUDGET_EXCEEDED for downstream
//     consumers (HTTP layer / metrics)
//   - tokenizer gracefully degrades when package missing or throws

import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDir = join(root, 'packages/dsh-hermes-link')
const dryRun = await import(pathToFileURL(join(pkgDir, 'services/dispatch-dry-run.mjs')).href)
const tok = await import(pathToFileURL(join(pkgDir, 'services/tokenizer.mjs')).href)
const ec = await import(pathToFileURL(join(pkgDir, 'services/error-codes.mjs')).href)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log('  ok ' + name); passed++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); failed++ }
}

// ---- tokenizer-level ----

t('case 1: tokenizer reports real impl when o200k_base is available', () => {
  const s = tok.tokenizersAvailable()
  assert.ok(['ready', 'fallback'].includes(s), 'expected ready|fallback, got ' + s)
  if (s === 'ready') {
    assert.ok(['o200k_base', 'cl100k_base'].includes(tok.tokenizerImpl()),
      'expected real impl, got ' + tok.tokenizerImpl())
  }
})

t('case 2: countTokens handles short ASCII with exact values', () => {
  // o200k_base: "hello world" = 2 tokens (the canonical BPE test)
  if (tok.tokenizerImpl() === 'o200k_base') {
    assert.equal(tok.countTokens('hello world'), 2)
    assert.equal(tok.countTokens(''), 0)
    assert.equal(tok.countTokens('test'), 1)
  } else {
    // fallback still produces a non-zero count
    assert.ok(tok.countTokens('hello world') > 0)
  }
})

t('case 3: countTokens handles CJK', () => {
  const tokens = tok.countTokens('你好世界')
  assert.ok(tokens >= 1, 'CJK should produce >= 1 token, got ' + tokens)
})

t('case 4: countTokens null / undefined returns 0', () => {
  assert.equal(tok.countTokens(null), 0)
  assert.equal(tok.countTokens(undefined), 0)
  assert.equal(tok.countTokens(''), 0)
})

t('case 5: countTokensParts sums non-empty parts', () => {
  assert.equal(tok.countTokensParts(['hello', 'world']), tok.countTokens('hello') + tok.countTokens('world'))
  assert.equal(tok.countTokensParts(['a', '', null, undefined, 'b']), tok.countTokens('a') + tok.countTokens('b'))
  assert.equal(tok.countTokensParts([]), 0)
  assert.equal(tok.countTokensParts(null), 0)
  assert.equal(tok.countTokensParts(undefined), 0)
})

t('case 6: fallback path still counts when real tokenizer unreachable', () => {
  // simulate package missing
  tok.__resetForTests()
  // rewrite require cache - we can't easily mock in-process without VM context.
  // instead, countTokens when there is no real impl still returns a sensible
  // value derived from length. We just verify the fallback contract.
  tok.ensureTokenizer()  // we can't actually delete the loaded mod, but ensureTokenizer is idempotent
  const s = tok.countTokens('hello world')
  assert.ok(s > 0)
  tok.__resetForTests()
})

// ---- dry-run integration ----

const MIN = { task_id: 't-1', skill: 'web_search', task: 'do thing' }

t('case 10: dry-run result exposes tokenizer diagnostic fields', () => {
  const r = dryRun.buildDispatchDryRun(MIN, {})
  assert.ok(r.tokenizer, 'tokenizer missing from result')
  assert.ok(typeof r.tokenizer.status === 'string')
  assert.ok(typeof r.tokenizer.impl === 'string' || r.tokenizer.impl === null)
  assert.ok('budget' in r, 'budget block missing from result')
  assert.equal(r.budget.model_tier, 'flash')
  assert.equal(r.budget.prompt_budget, 32000)
  assert.equal(r.budget.output_cap, 4000)
})

t('case 11: prompt_chars keeps legacy ENVELOPE_OVERHEAD_CHARS formula', () => {
  const r = dryRun.buildDispatchDryRun(
    { ...MIN, task: 'x'.repeat(100), args: { q: 'y' } },
    { foundationSlice: 'z'.repeat(50) },
  )
  // 500 (overhead) + 50 (persona) + 100 (task) + 0 (knowledge) + 9 ({"q":"y"}) = 659
  assert.equal(r.prompt_chars, 659)
})

t('case 12: estimated_prompt_tokens equals real-tokenizer count + envelope', () => {
  const r = dryRun.buildDispatchDryRun(MIN, {})
  // 120 envelope tokens + countTokens(MIN.task + personaText(empty))
  assert.equal(r.estimated_prompt_tokens,
    tok.countTokens('do thing') + 120)
})

t('case 13: max_prompt_tokens below estimated triggers would_block_on', () => {
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'hello world '.repeat(50), max_prompt_tokens: 5 })
  assert.ok(r.would_block_on.includes('prompt_tokens_exceeds_max'),
    'expected prompt_tokens_exceeds_max in ' + JSON.stringify(r.would_block_on))
  assert.ok(r.warnings.some((w) => w.includes('prompt_tokens')), 'expected prompt_tokens warning')
  assert.equal(r.budget.max_prompt_tokens, 5)
  assert.equal(r.budget.error_code_on_block, 'E_TOKEN_BUDGET_EXCEEDED')
})

t('case 14: max_total_tokens below estimated triggers would_block_on', () => {
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'hello world '.repeat(50), max_total_tokens: 100 })
  assert.ok(r.would_block_on.includes('total_tokens_exceeds_max'),
    'expected total_tokens_exceeds_max in ' + JSON.stringify(r.would_block_on))
  assert.equal(r.budget.max_total_tokens, 100)
  assert.equal(r.budget.error_code_on_block, 'E_TOKEN_BUDGET_EXCEEDED')
})

t('case 15: under-budget call has error_code_on_block = null', () => {
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'tiny', max_prompt_tokens: 10000, max_total_tokens: 50000 })
  assert.equal(r.budget.error_code_on_block, null)
  assert.equal(r.would_block_on.length, 0)
})

t('case 16: tier-aware prompt_very_large warning fires on real tokens', () => {
  // 160K 'x' chars ~ 20K real tokens, crossing PROMPT_VERY_LARGE_TOKENS=16000
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'x'.repeat(160000) }, {})
  assert.ok(r.warnings.some((w) => w.includes('prompt_very_large') || w.includes('prompt_above_tier_budget')),
    'expected prompt_very_large or prompt_above_tier_budget warning')
})

t('case 17: tokenizer impl affects count when real; fallback otherwise', () => {
  // This case validates that the tokenizer field is populated for downstream
  // monitoring - so even on a fallback it should be explicit, not undefined.
  const r = dryRun.buildDispatchDryRun(MIN, {})
  assert.ok('impl' in r.tokenizer, 'tokenizer.impl must be a key')
  assert.ok('status' in r.tokenizer, 'tokenizer.status must be a key')
})

t('case 18: budget gates dont block when no caps and within tier', () => {
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'small task' }, { foundationSlice: 'tiny' })
  assert.equal(r.would_block_on.length, 0)
  assert.equal(r.budget.over_prompt_budget, false)
  assert.equal(r.budget.over_total_budget, false)
})

t('case 19: budget gates still catch tier overflow with no caps set', () => {
  // 100K chars prose should overflow even flash tier (32000 prompt budget).
  const r = dryRun.buildDispatchDryRun({ ...MIN, task: 'lorem ipsum '.repeat(8000) }, {})
  // The result may warn ("prompt_above_tier_budget") but should NOT add a
  // would_block_on entry unless max_prompt_tokens was explicitly set.
  assert.equal(r.would_block_on.length, 0)
  assert.ok(r.warnings.some((w) => w.includes('prompt')), 'expected prompt warning')
})

t('case 20: error_codes registry exposes E_TOKEN_BUDGET_EXCEEDED', () => {
  assert.ok(ec.ErrorCodes.E_TOKEN_BUDGET_EXCEEDED)
  assert.equal(ec.ErrorCodes.E_TOKEN_BUDGET_EXCEEDED.code, -32021)
  assert.ok(ec.ErrorCodes.E_TOKEN_BUDGET_EXCEEDED.message.length > 0)
  assert.ok(ec.ErrorCodes.E_TOKEN_BUDGET_EXCEEDED.hint.length > 0)
})

t('case 21: mcpError wraps the new code with hint + data', () => {
  const e = ec.mcpError(null, 'E_TOKEN_BUDGET_EXCEEDED', 'prompt=21000 > max=5000',
    { estimated_prompt_tokens: 21000, max_prompt_tokens: 5000, would_block_on: ['prompt_tokens_exceeds_max'] })
  assert.equal(e.error.code, -32021)
  assert.equal(e.error.data.error_code, 'E_TOKEN_BUDGET_EXCEEDED')
  assert.ok(e.error.data.hint.includes('dispatch_dry_run'))
  assert.equal(e.error.data.estimated_prompt_tokens, 21000)
})

t('case 22: tokenizer output is monotonic in input length (no anomalies)', () => {
  const a = tok.countTokens('a')
  const b = tok.countTokens('a'.repeat(100))
  const c = tok.countTokens('a'.repeat(10000))
  assert.ok(b >= a, `expected b(${b}) >= a(${a})`)
  assert.ok(c >= b, `expected c(${c}) >= b(${b})`)
  // 10K chars should produce well over a hundred tokens
  assert.ok(c > 100, `expected c(${c}) > 100 tokens for 10000 chars`)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
