#!/usr/bin/env node
// scripts/test-foundation-policy.mjs
// Unit tests for the v0.2.2 foundation slice policy:
//   - SOUL.md is included
//   - MEMORY.md is NOT included (regardless of cwd / hermes state.db)
//   - when SOUL.md is missing, foundation is empty

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const indexUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'index.mjs')).href

// index.mjs imports @deepseek-ai/* packages provided by the DSH host at
// runtime. Without a DSH checkout (CI sandbox) those cannot resolve, so the
// whole test is a no-op skip instead of a hard failure.
let mod
try {
  mod = await import(indexUrl)
} catch (e) {
  if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('@deepseek-ai/')) {
    console.log('(test-foundation-policy skipped — no @deepseek-ai/* host checkout available)')
    process.exit(0)
  }
  throw e
}
const { buildFoundationSlice } = mod

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-found-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

t('case 1: SOUL only — MEMORY.md presence does NOT leak into foundation', () => {
  const { home, cleanup } = makeHome()
  try {
    writeFileSync(join(home, 'SOUL.md'), '# SOUL\nhelpful + direct\n', 'utf8')
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'memories', 'MEMORY.md'), '# MEMORY\n[project A] all of project A notes here\n', 'utf8')
    const slice = buildFoundationSlice(home)
    assert.ok(slice.includes('SOUL'), 'SOUL content present')
    assert.ok(slice.includes('helpful + direct'), 'SOUL body present')
    assert.ok(!slice.includes('MEMORY'), 'MEMORY header NOT in foundation')
    assert.ok(!slice.includes('project A'), 'MEMORY body NOT in foundation')
  } finally { cleanup() }
})

t('case 2: missing SOUL → empty foundation (no fallback to MEMORY)', () => {
  const { home, cleanup } = makeHome()
  try {
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'memories', 'MEMORY.md'), '# MEMORY\n', 'utf8')
    const slice = buildFoundationSlice(home)
    assert.equal(slice, '', 'foundation is empty when SOUL.md is absent')
  } finally { cleanup() }
})

t('case 3: only SOUL present → foundation is exactly the SOUL block', () => {
  const { home, cleanup } = makeHome()
  try {
    const soul = '# SOUL\nthis is the only thing\n'
    writeFileSync(join(home, 'SOUL.md'), soul, 'utf8')
    const slice = buildFoundationSlice(home)
    assert.ok(slice.startsWith('<!-- Hermes SOUL.md'))
    assert.ok(slice.includes(soul.trim()))
    assert.ok(!slice.includes('MEMORY'))
  } finally { cleanup() }
})

t('case 4: SOUL truncated at MAX_FOUNDATION_SLICE_CHARS (4096) when huge', () => {
  const { home, cleanup } = makeHome()
  try {
    const big = 'x'.repeat(8192)
    writeFileSync(join(home, 'SOUL.md'), big, 'utf8')
    const slice = buildFoundationSlice(home)
    assert.ok(slice.length <= 4096 + 200, 'truncated near cap (allow marker)')
    assert.ok(slice.includes('truncated'), 'truncation marker present')
  } finally { cleanup() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)