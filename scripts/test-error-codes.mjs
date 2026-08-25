#!/usr/bin/env node
// scripts/test-error-codes.mjs
// Unit tests for services/error-codes.mjs (E9) + verifies that the
// dispatch*.mjs callers migrated away from numeric codes.

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ecPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/services/error-codes.mjs')).href
const { mcpError, mcpResult, ErrorCodes } = await import(ecPath)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++ }
}

// --- mcpResult ---
t('case 1: mcpResult builds valid envelope', () => {
  const r = mcpResult(42, { ok: true })
  assert.equal(r.jsonrpc, '2.0')
  assert.equal(r.id, 42)
  assert.deepEqual(r.result, { ok: true })
})

// --- mcpError with extra + data ---
t('case 2: mcpError includes error_code and hint in data', () => {
  const e = mcpError(null, 'E_DUPLICATE_TASK_ID', 't-001')
  assert.equal(e.error.code, -32004)
  assert.ok(e.error.message.includes('duplicate task_id'))
  assert.ok(e.error.message.includes('t-001'))
  assert.equal(e.error.data.error_code, 'E_DUPLICATE_TASK_ID')
  assert.ok(e.error.data.hint.includes('child_id'))
})

t('case 3: mcpError without extra keeps message short', () => {
  const e = mcpError(null, 'E_AUTH_REQUIRED')
  assert.equal(e.error.message, ErrorCodes.E_AUTH_REQUIRED.message)
})

t('case 4: mcpError merges extra data without losing hint', () => {
  const e = mcpError(null, 'E_DISPATCH_FAILED', 'deadline exceeded', { task_id: 't-001', elapsed_ms: 60001 })
  assert.equal(e.error.data.task_id, 't-001')
  assert.equal(e.error.data.elapsed_ms, 60001)
  assert.equal(e.error.data.error_code, 'E_DISPATCH_FAILED')
  assert.ok(e.error.data.hint)
})

// --- error code number invariants ---
t('case 5: unknown code name throws (typo guard)', () => {
  assert.throws(() => mcpError(null, 'E_TYPOED'), /unknown error code/)
})

t('case 6: E_INVALID_SPEC / E_PARSE_ERROR / E_INTERNAL keep their codes', () => {
  assert.equal(ErrorCodes.E_INVALID_SPEC.code, -32602)
  assert.equal(ErrorCodes.E_PARSE_ERROR.code, -32700)
  assert.equal(ErrorCodes.E_INTERNAL.code, -32603)
})

t('case 7: E_UNKNOWN_METHOD and E_UNKNOWN_TOOL share -32601', () => {
  assert.equal(ErrorCodes.E_UNKNOWN_METHOD.code, -32601)
  assert.equal(ErrorCodes.E_UNKNOWN_TOOL.code, -32601)
})

// --- registry completeness ---
t('case 8: every ErrorCodes entry has all required fields', () => {
  for (const [name, def] of Object.entries(ErrorCodes)) {
    assert.ok(typeof def.code === 'number', name + '.code is not number')
    assert.ok(typeof def.message === 'string' && def.message.length > 0, name + '.message missing')
    assert.ok(typeof def.hint === 'string' && def.hint.length > 0, name + '.hint missing')
  }
})

// --- migration check: no http/*.mjs file uses literal numeric mcpError codes ---
t('case 9: no literal numeric mcpError codes remain in http/', () => {
  const httpDir = join(root, 'packages/dsh-hermes-link/http')
  const numericPattern = /mcpError\([^)]*-32\d{3}/
  for (const f of readdirSync(httpDir)) {
    if (!f.endsWith('.mjs')) continue
    const txt = readFileSync(join(httpDir, f), 'utf8')
    const matches = txt.match(/mcpError\([^)]*-\d{5}/g) || []
    if (matches.length) {
      throw new Error(f + ' has literal numeric mcpError codes: ' + matches.slice(0, 3).join('; '))
    }
  }
})

t('case 10: error data field is null-safe when extra data is undefined', () => {
  const e = mcpError(7, 'E_NO_LIVE_AGENT')
  assert.equal(e.error.code, -32005)
  assert.equal(e.id, 7)
  assert.ok(e.error.data)
  assert.equal(e.error.data.error_code, 'E_NO_LIVE_AGENT')
})

// --- coverage: every link-specific code is reachable from at least one call site ---
t('case 11: every ErrorCodes entry is referenced from packages/dsh-hermes-link/**', () => {
  const scanDir = (dir, out) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) scanDir(full, out)
      else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
        // skip the registry itself (defines the codes; not a caller)
        if (full.includes('error-codes.mjs')) continue
        out.push(readFileSync(full, 'utf8'))
      }
    }
  }
  const texts = []
  scanDir(join(root, 'packages/dsh-hermes-link'), texts)
  const allText = texts.join('\n')
  const unreachable = []
  for (const name of Object.keys(ErrorCodes)) {
    const re = new RegExp("'\\s*" + name + "\\s*'", 'g')
    if (!re.test(allText)) unreachable.push(name)
  }
  if (unreachable.length) {
    throw new Error('unreachable error codes: ' + unreachable.join(', '))
  }
})

t('case 12: _util.mjs re-exports mcpError / mcpResult from error-codes', async () => {
  const utilPath = pathToFileURL(join(root, 'packages/dsh-hermes-link/http/_util.mjs')).href
  const util = await import(utilPath)
  // Same function reference (not just same behavior)
  assert.equal(util.mcpError, mcpError)
  assert.equal(util.mcpResult, mcpResult)
  assert.equal(util.ErrorCodes, ErrorCodes)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
