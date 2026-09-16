// services/rate-limit.mjs
//
// v0.6.0 (D1) - per-token rate-limit + daily token budget for the
// Hermes <-> DSH bridge. Complements v0.5.0 (per-call token-budget) by
// defending the public surface against frequency-based abuse.
//
// Two axes:
//   - minute scope:  sliding-window N requests / 60 s per token
//                    (defaults to 60 rpm; configurable via env)
//   - day scope:    daily token consumption per token, summed across
//                    all dispatch_task calls, computed via the v0.5.0
//                    tokenizer (real o200k_base / cl100k_base).
//                    (defaults to 2 000 000 tokens / UTC day; env)
//
// Storage: in-memory only. Suitable for single-process DSH. Multi-process
// deployments would need shared state (Redis, etc.) - documented as a known
// limitation in the v0.6.0 release notes.

// The HTTP layer maps rejections to mcpError(id, 'E_RATE_LIMITED', ...)
// carrying the LimitDecision fields on data so callers can read retry
// timing without parsing free-form strings.
// Open-mode caveat: when HERMES_LINK_TOKEN is unset the bridge accepts any
// caller without authentication and rate-limit is effectively bypassed. The
// right fix is per-IP throttling; we punt that to v0.7.0 and keep D1 scoped
// to authenticated callers.

import { createHash } from 'node:crypto'

/**
 * @typedef {{
 *   allowed: boolean,
 *   scope?: 'minute'|'day',
 *   retryAfterMs?: number,
 *   current?: number,
 *   limit?: number,
 *   endpoint?: string
 * }} LimitDecision
 */

export class RateLimiter {
  constructor({
    rpm = 60,
    dailyTokens = 2_000_000,
    now = () => Date.now(),
    endpoints = {},
  } = {}) {
    this.rpm = rpm                  // 0 disables
    this.dailyTokens = dailyTokens  // 0 disables
    this.now = now
    this.endpoints = endpoints      // { methodName: multiplier } (dry_run gets +5x)
    this.minuteWindow = new Map()   // key -> sorted [epochMs, ...]
    this.dayBuckets = new Map()     // key -> { date, tokensUsed }
    this.lastPrune = this.now()
    this.pruneEvery = 60_000
  }

  /**
   * Atomically check + record a request. For dispatch_task callers,
   * pass `tokenCount` (real o200k_base / cl100k_base count of the prompt)
   * so daily-budget tracking matches what the model actually charges.
   *
   * @param {object} args
   * @param {string} [args.key]    Bearer-token hash. Omit / falsy to bypass.
   * @param {string} [args.endpoint] JSON-RPC method name (drives per-method multipliers).
   * @param {number} [args.tokenCount] tokens to charge against the daily bucket.
   * @returns {LimitDecision}
   */
  check({ key, endpoint = '*', tokenCount = 0 } = {}) {
    if (!key) return { allowed: true, endpoint }
    if (this.rpm <= 0 && this.dailyTokens <= 0) return { allowed: true, endpoint }

    const now = this.now()
    if (now - this.lastPrune > this.pruneEvery) this._prune()
    this.lastPrune = now

    const effectiveRpm = Math.max(1, Math.floor(this.rpm * (this.endpoints[endpoint] || 1)))

    // minute window check (request count)
    if (this.rpm > 0) {
      const windowStart = now - 60_000
      const ts = this.minuteWindow.get(key) || []
      const fresh = ts.filter(t => t > windowStart)
      if (fresh.length >= effectiveRpm) {
        const retryAfterMs = (fresh[0] + 60_000) - now
        return {
          allowed: false, scope: 'minute', endpoint, key,
          retryAfterMs: Math.max(0, retryAfterMs),
          current: fresh.length,
          limit: effectiveRpm,
        }
      }
      fresh.push(now)
      this.minuteWindow.set(key, fresh)
    }

    // daily budget check (token count)
    if (this.dailyTokens > 0 && tokenCount > 0) {
      const date = _todayKey(now)
      let bucket = this.dayBuckets.get(key)
      if (!bucket || bucket.date !== date) {
        bucket = { date, tokens: 0 }
        this.dayBuckets.set(key, bucket)
      }
      if (bucket.tokens + tokenCount > this.dailyTokens) {
        const retryAfterMs = _msUntilUtcMidnight(now)
        return {
          allowed: false, scope: 'day', endpoint, key,
          retryAfterMs,
          current: bucket.tokens,
          limit: this.dailyTokens,
        }
      }
      bucket.tokens += tokenCount
    }

    return { allowed: true, endpoint }
  }

  /** Read-only accessors for metrics + tests. */
  dailyTokensUsed(key = null) {
    if (key) {
      const b = this.dayBuckets.get(key)
      return b ? b.tokens : 0
    }
    let total = 0
    for (const b of this.dayBuckets.values()) total += b.tokens
    return total
  }

  minuteTokensUsed(key = null) {
    if (key) {
      const ts = this.minuteWindow.get(key)
      if (!ts) return 0
      const now = this.now()
      return ts.filter(t => t > now - 60_000).length
    }
    let total = 0
    const now = this.now()
    for (const ts of this.minuteWindow.values()) total += ts.filter(t => t > now - 60_000).length
    return total
  }

  /** Drop keys whose window expired. Called automatically; public for tests. */
  _prune() {
    const now = this.now()
    const windowStart = now - 60_000
    for (const [k, ts] of this.minuteWindow) {
      const fresh = ts.filter(t => t > windowStart)
      if (fresh.length === 0) this.minuteWindow.delete(k)
      else if (fresh.length !== ts.length) this.minuteWindow.set(k, fresh)
    }
    const today = _todayKey(now)
    for (const [k, b] of this.dayBuckets) if (b.date !== today) this.dayBuckets.delete(k)
  }

  /** For tests. */
  reset() {
    this.minuteWindow.clear()
    this.dayBuckets.clear()
    this.lastPrune = this.now()
  }

  /** Diagnostic snapshot - NOT for telemetry labels (may leak key info). */
  stats() {
    return {
      rpm: this.rpm,
      dailyTokens: this.dailyTokens,
      keysTracked: this.minuteWindow.size + this.dayBuckets.size,
      minuteRequests: this.minuteTokensUsed(),
      dailyRequestsTokens: this.dailyTokensUsed(),
    }
  }
}

/**
 * Stable, non-reversible short hash for a Bearer token. Used as the
 * rate-limit bucket key so log lines / metrics never carry the raw
 * credential. Truncated to 16 hex chars (64 bits) - sufficient for
 * in-memory dedup, far below a credential equivalent.
 *
 * @param {string} raw  raw bearer token (any non-empty string).
 * @returns {string} 16-char lowercase hex key.
 */
export function tokenKey(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** UTC YYYY-MM-DD for a given epoch ms. */
function _todayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10)
}

/** Ms until the next UTC midnight, from the given now. */
function _msUntilUtcMidnight(nowMs) {
  const d = new Date(nowMs)
  const tomorrow = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(0, tomorrow - nowMs)
}

// ---------------------------------------------------------------------------
// Singleton configuration (env-driven) + apply()-time wiring
// ---------------------------------------------------------------------------

const DEFAULTS = {
  rpm: 60,
  dailyTokens: 2_000_000,
  endpoints: {
    // dry_run is cheap (no spawn); allow 5x the base rate.
    dispatch_dry_run: 5,
    // Session CRUD is conservative; tighten up-front against import spam.
    import_hermes_session: 0.5,
    consult_hermes: 1,
    dispatch_task: 1,
    dispatch_followup: 1,
    dispatch_interrupt: 1,
  },
}

let _instance = null
let _instanceOpts = null

/**
 * Build a fresh instance from env + overrides. Used by index.mjs apply().
 * If env HERMES_LINK_RATE_LIMIT_RPM=0 or HERMES_LINK_RATE_LIMIT_DAILY_TOKENS=0
 * the corresponding axis is disabled (key==0 means "off").
 *
 * @param {object} [overrides]
 * @returns {RateLimiter}
 */
export function buildRateLimiterFromEnv(overrides = {}) {
  const envRpm = parseInt(process.env.HERMES_LINK_RATE_LIMIT_RPM || '', 10)
  const envDay = parseInt(process.env.HERMES_LINK_RATE_LIMIT_DAILY_TOKENS || '', 10)
  const opts = {
    rpm: Number.isFinite(envRpm) ? envRpm : DEFAULTS.rpm,
    dailyTokens: Number.isFinite(envDay) ? envDay : DEFAULTS.dailyTokens,
    endpoints: { ...DEFAULTS.endpoints, ...(overrides.endpoints || {}) },
  }
  if (overrides.rpm != null) opts.rpm = overrides.rpm
  if (overrides.dailyTokens != null) opts.dailyTokens = overrides.dailyTokens
  _instance = new RateLimiter(opts)
  _instanceOpts = opts
  return _instance
}

export function getRateLimiter() { return _instance }
export function setRateLimiterForTests(r) { _instance = r }
export function rateLimitDefaults() { return { ...DEFAULTS, endpoints: { ...DEFAULTS.endpoints } } }
