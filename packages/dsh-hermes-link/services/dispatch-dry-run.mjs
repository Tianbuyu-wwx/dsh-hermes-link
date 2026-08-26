// services/dispatch-dry-run.mjs
//
// v0.3.3 (F5) - Hermes-side pre-flight cost estimator for dispatch_task.
//
// Hermes can call this BEFORE dispatch_task to decide whether the
// proposed sub-agent fits in the available context window, whether the
// skill name is known to the DSH tool catalog, and to surface warnings
// (long task, unusual model_tier, etc.) without burning an LLM turn.
//
// The estimator is intentionally heuristic (chars / 4 ~= tokens for
// English/CJK mix). Real token counts depend on the tokenizer; if
// you need exact counts, use a real tokenizer via ctx.tokenMeter after
// a real dispatch.

const APPROX_CHARS_PER_TOKEN = 4   // heuristic; varies by model + language
const ENVELOPE_OVERHEAD_CHARS = 500 // prompt envelope wrapping (system + closing tags)

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
  }

  // Basic shape check (task_id / skill / task required)
  function fail(hint) {
    return { ...result, ok: false, error_code: 'E_INVALID_SPEC', hint }
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

  // Per-field accounting
  result.persona_chars = deps.foundationSlice ? deps.foundationSlice.length : 0
  result.task_chars = args.task.length
  if (Array.isArray(args.knowledge_subset)) {
    for (const k of args.knowledge_subset) {
      result.knowledge_chars += (k && typeof k.excerpt === 'string') ? k.excerpt.length : 0
    }
  }
  result.args_chars = args.args ? JSON.stringify(args.args).length : 0
  result.prompt_chars = ENVELOPE_OVERHEAD_CHARS + result.persona_chars + result.task_chars + result.knowledge_chars + result.args_chars

  // Heuristic token estimate
  result.estimated_prompt_tokens = Math.ceil(result.prompt_chars / APPROX_CHARS_PER_TOKEN)

  // Output tokens (default cap)
  result.estimated_max_output_tokens = Number.isInteger(args.max_tokens)
    ? args.max_tokens
    : 4000
  result.estimated_total_tokens = result.estimated_prompt_tokens + result.estimated_max_output_tokens

  // model_tier (recorded + warning if unknown)
  result.model_tier = args.model_tier || 'flash'
  if (args.model_tier && !['flash', 'pro', 'vision'].includes(args.model_tier)) {
    result.warnings.push('unknown_model_tier: ' + args.model_tier + ' (expected one of flash/pro/vision)')
  }

  // Skill availability check via ctx.tools.view (best-effort)
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

  // Task length warnings
  if (args.task.length > 8000) {
    result.warnings.push('task_at_or_above_maxLength: ' + args.task.length + ' chars (dispatch_task validates 8000 cap)')
  } else if (args.task.length > 4000) {
    result.warnings.push('task_long: ' + args.task.length + ' chars (consider trimming)')
  }

  // Persona size warning
  if (result.persona_chars > 4000) {
    result.warnings.push('persona_truncated: ' + result.persona_chars + ' chars (4KB cap in dispatch_task)')
  }

  // Token budget warnings (rough thresholds)
  if (result.estimated_prompt_tokens > 16000) {
    result.warnings.push('prompt_very_large: ' + result.estimated_prompt_tokens + ' tokens (likely truncation)')
  } else if (result.estimated_prompt_tokens > 8000) {
    result.warnings.push('prompt_large: ' + result.estimated_prompt_tokens + ' tokens')
  }

  // Output cap
  if (Number.isInteger(args.max_tokens)) {
    if (args.max_tokens < 256) {
      result.warnings.push('max_tokens_below_minimum: ' + args.max_tokens + ' (dispatch_task enforces min 256)')
    } else if (args.max_tokens > 32000) {
      result.warnings.push('max_tokens_above_maximum: ' + args.max_tokens + ' (dispatch_task enforces max 32000)')
    }
  }

  // mode + provider presence (informational, not blocking)
  if (args.mode && !['one-shot', 'continuable'].includes(args.mode)) {
    result.warnings.push('unknown_mode: ' + args.mode + ' (expected one-shot or continuable)')
  }
  if (args.provider && !['fork', 'spawn'].includes(args.provider)) {
    result.warnings.push('unknown_provider: ' + args.provider + ' (expected fork or spawn)')
  }

  return result
}
