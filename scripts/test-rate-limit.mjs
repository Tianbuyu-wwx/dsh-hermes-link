#!/usr/bin/env node
// scripts/test-rate-limit.mjs
//
// v0.6.0 (D1) - rate-limit + daily-token budget coverage.

import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDir = join(root, 'packages/dsh-hermes-link')

const rlMod = await import(pathToFileURL(join(pkgDir, 'services/rate-limit.mjs')).href)
const ecMod = await import(pathToFileURL(join(pkgDir, 'services/error-codes.mjs')).href)

const { RateLimiter, tokenKey, buildRateLimiterFromEnv, rateLimitDefaults } = rlMod
const { mcpError, ErrorCodes } = ecMod

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log('  ok ' + name); passed++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); failed++ }
}

t('tokenKey hashes the same input to the same value', () => {
  const k1 = tokenKey('Bearer-xyz')
  const k2 = tokenKey('Bearer-xyz')
  assert.equal(k1, k2)
  assert.match(k1, /^[0-9a-f]{16}$/)
})

t('tokenKey returns empty for falsy inputs', () => {
  assert.equal(tokenKey(''), '')
  assert.equal(tokenKey(null), '')
  assert.equal(tokenKey(undefined), '')
  assert.equal(tokenKey(123), '')
})

t('tokenKey distinguishes different inputs', () => {
  const k1 = tokenKey('a')
  const k2 = tokenKey('b')
  assert.notEqual(k1, k2)
})

t('RateLimiter allows under the per-minute cap', () => {
  const r = new RateLimiter({ rpm: 5, dailyTokens: 0 })
  for (let i = 0; i < 5; i++) {
    assert.equal(r.check({ key: 'k1', endpoint: 'dispatch_task' }).allowed, true, 'iter ' + i)
  }
})

t('RateLimiter rejects request #N+1 with retryAfterMs', () => {
  let now = 1_700_000_000_000
  const r = new RateLimiter({ rpm: 3, dailyTokens: 0, now: () => now })
  for (let i = 0; i < 3; i++) {
    assert.equal(r.check({ key: 'k1', tokenCount: 0 }).allowed, true, 'first-3 iter ' + i)
  }
  const d = r.check({ key: 'k1', tokenCount: 0 })
  assert.equal(d.allowed, false)
  assert.equal(d.scope, 'minute')
  assert.ok(d.retryAfterMs >= 59_500 && d.retryAfterMs <= 60_500,
    'retryAfterMs in [59500,60500], got ' + d.retryAfterMs)
  assert.equal(d.current, 3)
  assert.equal(d.limit, 3)
})

t('RateLimiter buckets are independent across keys', () => {
  const r = new RateLimiter({ rpm: 2, dailyTokens: 0 })
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, false)
  assert.equal(r.check({ key: 'k2' }).allowed, true)
  assert.equal(r.check({ key: 'k2' }).allowed, true)
  assert.equal(r.check({ key: 'k2' }).allowed, false)
})

t('RateLimiter prunes the sliding window on stale entries', () => {
  let now = 1_700_000_000_000
  const r = new RateLimiter({ rpm: 2, dailyTokens: 0, now: () => now })
  // 2 quick calls accepted, 3rd rejected (no time travel)
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, false)
  // advance past window: bucket pruned, fresh slate
  now += 61_000
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, true)
  assert.equal(r.check({ key: 'k1' }).allowed, false)
})

t('RateLimiter per-endpoint multipliers: dry_run gets 5x', () => {
  let now = 1_700_000_000_000
  const r = new RateLimiter({
    rpm: 1, dailyTokens: 0,
    now: () => now,
    endpoints: { dispatch_dry_run: 5, dispatch_task: 1 },
  })
  for (let i = 0; i < 5; i++) {
    const d = r.check({ key: 'k1', endpoint: 'dispatch_dry_run' })
    assert.equal(d.allowed, true, 'iter ' + i)
    now += 10
  }
  assert.equal(r.check({ key: 'k1', endpoint: 'dispatch_dry_run' }).allowed, false)
})

t('RateLimiter per-endpoint multipliers: tight cap < base', () => {
  const r = new RateLimiter({ rpm: 5, dailyTokens: 0, endpoints: { import_hermes_session: 0.5 } })
  assert.equal(r.check({ key: 'k1', endpoint: 'import_hermes_session' }).allowed, true)
  assert.equal(r.check({ key: 'k1', endpoint: 'import_hermes_session' }).allowed, true)
  assert.equal(r.check({ key: 'k1', endpoint: 'import_hermes_session' }).allowed, false)
})

t('RateLimiter daily-token budget accumulates and rejects overage', () => {
  let now = 1_700_000_000_000
  const r = new RateLimiter({ rpm: 0, dailyTokens: 1000, now: () => now })
  assert.equal(r.check({ key: 'k1', tokenCount: 400 }).allowed, true)
  assert.equal(r.check({ key: 'k1', tokenCount: 400 }).allowed, true)
  const d = r.check({ key: 'k1', tokenCount: 400 })
  assert.equal(d.allowed, false)
  assert.equal(d.scope, 'day')
  assert.equal(d.current, 800)
  assert.equal(d.limit, 1000)
})

t('RateLimiter daily-token budget resets across UTC day', () => {
  let now = 1_700_000_000_000
  const r = new RateLimiter({ rpm: 0, dailyTokens: 1000, now: () => now })
  assert.equal(r.check({ key: 'k1', tokenCount: 999 }).allowed, true)
  now += 24 * 60 * 60 * 1000
  assert.equal(r.check({ key: 'k1', tokenCount: 999 }).allowed, true)
})

t('RateLimiter daily Tokens charge only when tokenCount > 0', () => {
  const r = new RateLimiter({ rpm: 0, dailyTokens: 100 })
  for (let i = 0; i < 200; i++) r.check({ key: 'k1', tokenCount: 0 })
  assert.equal(r.dailyTokensUsed('k1'), 0)
  assert.equal(r.check({ key: 'k1', tokenCount: 100 }).allowed, true)
  assert.equal(r.check({ key: 'k1', tokenCount: 1 }).allowed, false)
})

t('RateLimiter allows everything when both axes are 0', () => {
  const r = new RateLimiter({ rpm: 0, dailyTokens: 0 })
  for (let i = 0; i < 100; i++) {
    assert.equal(r.check({ key: 'k1', tokenCount: 1e9 }).allowed, true)
  }
})

t('RateLimiter allows empty key (anonymous)', () => {
  const r = new RateLimiter({ rpm: 1, dailyTokens: 1 })
  for (let i = 0; i < 50; i++) assert.equal(r.check({ tokenCount: 1 }).allowed, true)
})

t('E_RATE_LIMITED is exposed in ErrorCodes with -32022', () => {
  assert.ok(ErrorCodes.E_RATE_LIMITED)
  assert.equal(ErrorCodes.E_RATE_LIMITED.code, -32022)
  assert.ok(ErrorCodes.E_RATE_LIMITED.message.length > 0)
  assert.ok(ErrorCodes.E_RATE_LIMITED.hint.includes('retry_after_ms') || ErrorCodes.E_RATE_LIMITED.hint.includes('back off'))
})

t('mcpError wraps E_RATE_LIMITED with all data fields', () => {
  const e = mcpError(null, 'E_RATE_LIMITED', 'minute bucket exhausted',
    { scope: 'minute', endpoint: 'dispatch_task', current: 60, limit: 60, retry_after_ms: 1234 })
  assert.equal(e.error.code, -32022)
  assert.equal(e.error.data.error_code, 'E_RATE_LIMITED')
  assert.equal(e.error.data.scope, 'minute')
  assert.equal(e.error.data.endpoint, 'dispatch_task')
  assert.equal(e.error.data.retry_after_ms, 1234)
})

t('buildRateLimiterFromEnv respects HERMES_LINK_RATE_LIMIT_RPM env', () => {
  const prev = process.env.HERMES_LINK_RATE_LIMIT_RPM
  try {
    process.env.HERMES_LINK_RATE_LIMIT_RPM = '7'
    const rl = buildRateLimiterFromEnv()
    assert.equal(rl.rpm, 7)
  } finally {
    if (prev === undefined) delete process.env.HERMES_LINK_RATE_LIMIT_RPM
    else process.env.HERMES_LINK_RATE_LIMIT_RPM = prev
  }
})

t('rateLimitDefaults sane', () => {
  const d = rateLimitDefaults()
  assert.ok(d.rpm > 0)
  assert.ok(d.dailyTokens > 0)
  assert.ok(d.endpoints.dispatch_dry_run >= 1)
  assert.equal(d.endpoints.dispatch_task, 1)
})

t('http/jsonrpc-handlers parses cleanly with new import', async () => {
  const m = await import(pathToFileURL(join(pkgDir, 'http/jsonrpc-handlers.mjs')).href)
  assert.equal(typeof m.handleRpc, 'function')
})

console.log('')
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
