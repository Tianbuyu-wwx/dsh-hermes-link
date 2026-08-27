// services/dispatch-dry-run.mjs
//
// v0.3.3 (F5) Hermes-side pre-flight cost estimator for dispatch_task.
// v0.5.0 (B1) real tokenizer (gpt-tokenizer o200k_base / cl100k_base) with
//                 chars/4 fallback, plus token-budget gates.
//
// Hermes can call this BEFORE dispatch_task to decide whether the
// proposed sub-agent fits in the available context window, whether the
// skill name is known to the DSH tool catalog, and to surface warnings
// (long task, unusual model_tier, exceeded budget) without burning an
// LLM turn.

import { countTokens, countTokensParts, tokenizersAvailable, tokenizerImpl } from './tokenizer.mjs'

const ENVELOPE_OVERHEAD_CHARS = 500  // legacy metric; kept so v0.3.3 callers comparing prompt_chars still see the same number
const ENVELOPE_OVERHEAD_TOKENS = 120  // real-token envelope overhead (system block + closing tags)
// v0.5.0 (B1): real o200k_base tokenizer ~ 8 chars / token for repeated
// ASCII, but ~ 2 chars/token for CJK. Use real token counts (not chars / 4)
// for the warn-block thresholds so they don't false-trigger on CJK content
// or under-trigger on prose-heavy prompts.
const PROMPT_LARGE_TOKENS = 8000
const PROMPT_VERY_LARGE_TOKENS = 16000

export const MODEL_CONTEXT_BUDGETS = Object.freeze({
  // Each tier's effective usable token window for prompt + max_output.
  // 2026-era frontier defaults; tune per deployment if you swap models.
  flash:  { prompt: 32000, output: 4000  },
  pro:    { prompt: 96000, output: 8000  },
  vision: { prompt: 64000, output: 4000  },
})

export const DEFAULT_MAX_OUTPUT_TOKENS = 4000
export const MIN_MAX_OUTPUT_TOKENS = 256
export const MAX_MAX_OUTPUT_TOKENS = 32000

/**
 * @param {object} args   dispatch spec (same shape as dispatch_task)
 * @param {object} deps
 * @param {string} [deps.foundationSlice]  pre-computed SOUL.md contents
 * @param {object} [deps.ctx]              cordis ctx (for tools.view() lookup)
 * @returns {{
 *   ok: boolean,
 *   error_code?: string,
 *   hint?: string,
 *   estimated_prompt_tokens: number,
 *   estimated_max_output_tokens: number,
 *   estimated_total_tokens: number,
 *   prompt_chars: number,
 *   persona_chars: number,
 *   task_chars: number,
 *   knowledge_chars: number,
 *   args_chars: number,
 *   model_tier: string,
 *   would_block_on: string[],
 *   warnings: string[],
 *   tokenizer: { impl: string|null, status: string },
 *   budget: { model_tier: string, prompt_budget: number, output_cap: number,
 *             max_prompt_tokens?: number, max_total_tokens?: number,
 *             over_prompt_budget: boolean, over_total_budget: boolean },
 * }}
 */
export function buildDispatchDryRun(args, deps) {
  deps = deps || {}
  const result = {
    ok: true,
    estimated_prompt_tokens: 0,
    estimated_max_output_tokens: 0,
    estimated_total_tokens: 0,
    prompt_chars: 0,
    persona_chars: 0,
    task_chars: 0,
    knowledge_chars: 0,
    args_chars: 0,
    model_tier: 'flash',
    would_block_on: [],
    warnings: [],
    tokenizer: { impl: tokenizerImpl(), status: tokenizersAvailable() },
    budget: {
      model_tier: 'flash',
      prompt_budget: MODEL_CONTEXT_BUDGETS.flash.prompt,
      output_cap: DEFAULT_MAX_OUTPUT_TOKENS,
      over_prompt_budget: false,
      over_total_budget: false,
    },
  }

  function fail(hint) {
    return Object.assign({}, result, { ok: false, error_code: 'E_INVALID_SPEC', hint })
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return fail('args must be an object')
  }
  if (!args.task_id || typeof args.task_id !== 'string') {
    return fail('task_id required (string)')
  }
  if (!args.skill || typeof args.skill !== 'string') {
    return fail('skill required (string)')
  }
  if (!args.task || typeof args.task !== 'string') {
    return fail('task required (string)')
  }

  // ---- per-field char accounting (prompt_chars keeps the legacy formula:
  //      ENVELOPE_OVERHEAD_CHARS + per-piece sums. The metric is still useful
  //      as a budget hint in the Hermes-side caller even when the underlying
  //      token count is computed via the real tokenizer.) ----
  const personaText = deps.foundationSlice || ''
  result.persona_chars = personaText.length
  result.task_chars = args.task.length
  if (Array.isArray(args.knowledge_subset)) {
    for (const k of args.knowledge_subset) {
      result.knowledge_chars += (k && typeof k.excerpt === 'string') ? k.excerpt.length : 0
    }
  }
  const argsJson = args.args ? JSON.stringify(args.args) : ''
  result.args_chars = argsJson.length
  // legacy: prompt_chars includes the envelope overhead so callers comparing
  // against v0.3.3 metrics still see the same number.
  result.prompt_chars = ENVELOPE_OVERHEAD_CHARS + result.persona_chars + result.task_chars + result.knowledge_chars + result.args_chars

  // ---- real token estimation per piece (v0.5.0 B1) ----
  const personaTokens = countTokens(personaText)
  const taskTokens = countTokens(args.task)
  let knowledgeTokens = 0
  if (Array.isArray(args.knowledge_subset)) {
    for (const k of args.knowledge_subset) {
      knowledgeTokens += countTokens(k && typeof k.excerpt === 'string' ? k.excerpt : '')
    }
  }
  const argsTokens = countTokens(argsJson)
  // envelope overhead is only added as a flat constant once per dispatch.
  const promptTokens = personaTokens + taskTokens + knowledgeTokens + argsTokens + ENVELOPE_OVERHEAD_TOKENS

  result.estimated_prompt_tokens = promptTokens

  // ---- output tokens ----
  const maxTokensArg = Number.isInteger(args.max_tokens) ? args.max_tokens : DEFAULT_MAX_OUTPUT_TOKENS
  result.estimated_max_output_tokens = Math.min(MAX_MAX_OUTPUT_TOKENS, maxTokensArg)
  result.estimated_total_tokens = result.estimated_prompt_tokens + result.estimated_max_output_tokens

  // ---- model_tier + budget ----
  const tier = ['flash', 'pro', 'vision'].includes(args.model_tier) ? args.model_tier : 'flash'
  result.model_tier = tier
  const tierBudget = MODEL_CONTEXT_BUDGETS[tier]
  result.budget.model_tier = tier
  result.budget.prompt_budget = tierBudget.prompt
  result.budget.output_cap = Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, maxTokensArg))

  // optional caller-supplied caps override the tier defaults
  const maxPrompt = Number.isInteger(args.max_prompt_tokens) ? args.max_prompt_tokens : null
  const maxTotal = Number.isInteger(args.max_total_tokens) ? args.max_total_tokens : null
  if (maxPrompt != null) result.budget.max_prompt_tokens = maxPrompt
  if (maxTotal != null) result.budget.max_total_tokens = maxTotal

  // ---- skill availability (best-effort) ----
  const ctx = deps.ctx
  if (ctx && ctx.tools && typeof ctx.tools.view === 'function') {
    let view = null
    try { view = ctx.tools.view() } catch (_e) {}
    if (view && Array.isArray(view.restrictableNames)) {
      if (!view.restrictableNames.includes(args.skill)) {
        result.would_block_on.push('skill:unknown_tool')
        result.warnings.push('skill "' + args.skill + '" not in dsh tools catalog (dispatch_task would fail)')
      }
    }
  }

  // ---- warnings ----
  if (args.task.length > 8000) {
    result.warnings.push('task_at_or_above_maxLength: ' + args.task.length + ' chars (dispatch_task validates 8000 cap)')
  } else if (args.task.length > 4000) {
    result.warnings.push('task_long: ' + args.task.length + ' chars (consider trimming)')
  }
  if (result.persona_chars > 4000) {
    result.warnings.push('persona_truncated: ' + result.persona_chars + ' chars (4KB cap in dispatch_task)')
  }

  // Token budget gates (v0.5.0)
  if (result.estimated_prompt_tokens > PROMPT_VERY_LARGE_TOKENS) {
    result.warnings.push('prompt_very_large: ' + result.estimated_prompt_tokens + ' tokens (likely truncation; threshold=' + PROMPT_VERY_LARGE_TOKENS + ')')
  } else if (result.estimated_prompt_tokens > PROMPT_LARGE_TOKENS) {
    result.warnings.push('prompt_large: ' + result.estimated_prompt_tokens + ' tokens (threshold=' + PROMPT_LARGE_TOKENS + ')')
  }
  if (maxPrompt != null && result.estimated_prompt_tokens > maxPrompt) {
    result.would_block_on.push('prompt_tokens_exceeds_max')
    result.warnings.push('prompt_tokens ' + result.estimated_prompt_tokens + ' > max_prompt_tokens ' + maxPrompt)
  } else if (maxPrompt == null && result.estimated_prompt_tokens > tierBudget.prompt) {
    result.warnings.push('prompt_above_tier_budget: ' + result.estimated_prompt_tokens + ' > ' + tierBudget.prompt + ' tokens (tier=' + tier + ')')
  }
  if (maxTotal != null && result.estimated_total_tokens > maxTotal) {
    result.would_block_on.push('total_tokens_exceeds_max')
    result.warnings.push('total_tokens ' + result.estimated_total_tokens + ' > max_total_tokens ' + maxTotal)
  }
  if (Number.isInteger(args.max_tokens)) {
    if (args.max_tokens < MIN_MAX_OUTPUT_TOKENS) {
      result.warnings.push('max_tokens_below_minimum: ' + args.max_tokens + ' (dispatch_task enforces min ' + MIN_MAX_OUTPUT_TOKENS + ')')
    } else if (args.max_tokens > MAX_MAX_OUTPUT_TOKENS) {
      result.warnings.push('max_tokens_above_maximum: ' + args.max_tokens + ' (dispatch_task enforces max ' + MAX_MAX_OUTPUT_TOKENS + ')')
    }
  }

  // mark the budget gate flags for downstream consumers
  result.budget.over_prompt_budget = result.estimated_prompt_tokens > tierBudget.prompt
  result.budget.over_total_budget = result.estimated_total_tokens > (tierBudget.prompt + tierBudget.output)
  // pre-flight mapping: when would_block_on has budget items, the dispatcher
  // (or the JSON-RPC handler) should surface this as E_TOKEN_BUDGET_EXCEEDED.
  // The string is included here so callers / tests can grep without
  // pulling in the error-codes registry.
  result.budget.error_code_on_block = result.would_block_on.length ? 'E_TOKEN_BUDGET_EXCEEDED' : null

  if (args.model_tier && !['flash', 'pro', 'vision'].includes(args.model_tier)) {
    result.warnings.push('unknown_model_tier: ' + args.model_tier + ' (expected one of flash/pro/vision)')
  }
  if (args.mode && !['one-shot', 'continuable'].includes(args.mode)) {
    result.warnings.push('unknown_mode: ' + args.mode + ' (expected one-shot or continuable)')
  }
  if (args.provider && !['fork', 'spawn'].includes(args.provider)) {
    result.warnings.push('unknown_provider: ' + args.provider + ' (expected fork or spawn)')
  }

  return result
}