// services/tokenizer.mjs
//
// v0.5.0 (B1) - real tokenizer integration with graceful fallback.
//
// countTokens(string) returns the token count using the o200k_base encoder
// (GPT-4o / Claude-family 2024+ era frontier models) by default. We
// optionally load cl100k_base as a fallback for back-compat with
// pre-v0.5.0 estimates that referenced the older family.
//
// Behaviour:
//   - 'ready'    : real cl100k_base or o200k_base loaded; counts are exact
//   - 'fallback' : real package absent / broken; uses chars / 4 (same as
//                  v0.3.3 dry-run behaviour)
//   - 'unloaded' : lazy - first call will resolve to one of the above
//
// Callers MUST use countTokens() instead of re-implementing the fallback.
// tokenizersAvailable() exposes which implementation is in use so
// metrics / logs can carry the info.

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)

let _status = 'unloaded'
let _impl = null
let _countTokensFn = null
let _loadError = null

/**
 * One-shot sync load. Triggered automatically by countTokens(); exposed so
 * apply() can warm it during plugin init and avoid the first-call cost on
 * the dispatch hot path.
 *
 * @returns {'ready'|'fallback'}
 */
export function ensureTokenizer () {
  if (_status !== 'unloaded') return _status
  // Attempt 1: o200k_base via named export from the package root (v4 layout).
  try {
    const mod = _require('gpt-tokenizer')
    if (mod && typeof mod.countTokens === 'function') {
      _countTokensFn = mod.countTokens
      _impl = 'o200k_base'
      _status = 'ready'
      return _status
    }
    _loadError = 'gpt-tokenizer present but no countTokens() export'
  } catch (e) {
    _loadError = (e && (e.code || e.message)) || String(e)
  }
  // Attempt 2: cl100k_base via subpath (v2.x layout).
  try {
    const mod2 = _require('gpt-tokenizer/encoding/cl100k_base')
    if (mod2 && typeof mod2.countTokens === 'function') {
      _countTokensFn = mod2.countTokens
      _impl = 'cl100k_base'
      _status = 'ready'
      _loadError = null
      return _status
    }
  } catch (_e2) { /* keep the first error if both fail */ }
  _status = 'fallback'
  return _status
}

/**
 * Count tokens for a UTF-8 string. Synchronous, falls back to chars / 4 if
 * the real tokenizer is unavailable.
 *
 * @param {string|null|undefined} s
 * @returns {number}
 */
export function countTokens (s) {
  if (s == null) return 0
  if (typeof s !== 'string') s = String(s)
  if (_status === 'unloaded') ensureTokenizer()
  if (_countTokensFn) {
    try {
      const n = _countTokensFn(s)
      return Array.isArray(n) ? n.length : (n >>> 0)
    } catch (_e) {
      _countTokensFn = null
      _status = 'fallback'
    }
  }
  return Math.ceil(s.length / 4)
}

/**
 * Sum token counts over an array of strings. Empty cells are skipped.
 * @param {Array<string|null|undefined>} parts
 * @returns {number}
 */
export function countTokensParts (parts) {
  if (!Array.isArray(parts)) return 0
  let total = 0
  for (const p of parts) total += countTokens(p)
  return total
}

/** @returns {'ready'|'fallback'|'unloaded'} */
export function tokenizersAvailable () {
  if (_status === 'unloaded') ensureTokenizer()
  return _status
}

/** @returns {string|null} 'o200k_base' | 'cl100k_base' | null */
export function tokenizerImpl () {
  if (_status === 'unloaded') ensureTokenizer()
  return _impl
}

/**
 * Test-only: reset the cached state so a test can simulate
 * "package missing" or "package present". Not for production.
 */
export function __resetForTests () {
  _status = 'unloaded'
  _impl = null
  _countTokensFn = null
  _loadError = null
}

/** Last load error message (or null). Useful for `--diagnose` flags. */
export function tokenizerLoadError () { return _loadError }