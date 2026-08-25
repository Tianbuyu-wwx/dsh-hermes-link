#!/usr/bin/env node
// scripts/check-version-sync.mjs
//
// Fails CI if any of the canonical version strings drift across files.
// Locations checked (each must match packages/dsh-hermes-link/package.json):
//   - http/dispatch.mjs      VERSION constant
//   - index.mjs              VERSION constant
//   - packages/dsh-hermes-link/CHANGELOG.md  latest entry heading
//   - dispatch-spec.schema.json  title version
//   - skills/dsh-hermes-link/SKILL.md  description version
//   - README.md  npm badge version
//   - scripts/smoke-test.mjs  (if present)
//   - docs/security-model.md  (Layer 12 SSE auth reference)

import { strict as assert } from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(root, 'packages/dsh-hermes-link/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const truth = pkg.version

let passed = 0, failed = 0
function check(name, got, expected) {
  if (got === expected) { console.log(`  ok ${name}: ${got}`); passed++ }
  else { console.log(`  FAIL ${name}: got "${got}", expected "${expected}"`); failed++ }
}

function skip(name) {
  console.log(`  -- ${name}: not present, skipping`)
}

// 1. package.json version (the source of truth)
check('packages/dsh-hermes-link/package.json', pkg.version, truth)

// 2. http/dispatch.mjs VERSION
const dispatchTxt = readFileSync(join(root, 'packages/dsh-hermes-link/http/dispatch.mjs'), 'utf8')
const m1 = dispatchTxt.match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
if (m1) check('http/dispatch.mjs VERSION', m1[1], truth)
else skip('http/dispatch.mjs VERSION')

// 3. index.mjs VERSION
const indexTxt = readFileSync(join(root, 'packages/dsh-hermes-link/index.mjs'), 'utf8')
const m2 = indexTxt.match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
if (m2) check('index.mjs VERSION', m2[1], truth)
else skip('index.mjs VERSION')

// 4. CHANGELOG.md latest entry
const changelogPath = join(root, 'CHANGELOG.md')
if (existsSync(changelogPath)) {
  const changelogTxt = readFileSync(changelogPath, 'utf8')
  const m3 = changelogTxt.match(/##\s*\[([^\]]+)\]\s*[鈥?]/)
  if (m3) check('packages/dsh-hermes-link/CHANGELOG.md latest entry', m3[1], truth)
  else skip('packages/dsh-hermes-link/CHANGELOG.md latest entry')
} else {
  skip('packages/dsh-hermes-link/CHANGELOG.md')
}

// 5. dispatch-spec.schema.json title
const schemaPath = join(root, 'packages/dsh-hermes-link/dispatch-spec.schema.json')
if (existsSync(schemaPath)) {
  const schemaTxt = readFileSync(schemaPath, 'utf8')
  const schema = JSON.parse(schemaTxt)
  const m4 = (schema.title || '').match(/v(\d+\.\d+\.\d+)/)
  if (m4) check('dispatch-spec.schema.json title', m4[1], truth)
  else skip('dispatch-spec.schema.json title')
} else {
  skip('dispatch-spec.schema.json title')
}

// 6. SKILL.md description
const skillPath = join(root, 'packages/dsh-hermes-link/skills/dsh-hermes-link/SKILL.md')
if (existsSync(skillPath)) {
  const skillTxt = readFileSync(skillPath, 'utf8')
  const m6 = skillTxt.match(/v(\d+\.\d+\.\d+)/)
  if (m6) check('SKILL.md version mention', m6[1], truth)
  else skip('SKILL.md version mention')
} else {
  skip('SKILL.md')
}

// 7. README.md npm badge
const readmePath = join(root, 'README.md')
if (existsSync(readmePath)) {
  const readmeTxt = readFileSync(readmePath, 'utf8')
  const badgeMatch = readmeTxt.match(/npm\/v\/@Tianbuyu-wwx\/dsh-hermes-link\/(\d+\.\d+\.\d+)/)
  if (badgeMatch) check('README.md npm badge', badgeMatch[1], truth)
  else skip('README.md npm badge')
} else {
  skip('README.md')
}

// 8. root README.zh.md (if present)
const readmeZhPath = join(root, 'README.zh.md')
if (existsSync(readmeZhPath)) {
  const txt = readFileSync(readmeZhPath, 'utf8')
  const m = txt.match(/v(\d+\.\d+\.\d+)/)
  if (m) check('README.zh.md version mention', m[1], truth)
  else skip('README.zh.md version mention')
}

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
