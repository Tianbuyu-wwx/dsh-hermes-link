#!/usr/bin/env node
// scripts/check-docs-fresh.mjs
//
// Fails CI if README / SKILL.md tool tables don't reflect actual tools/ directory.
// Each check uses the actual on-disk source of truth.

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const toolsDir = join(root, 'packages/dsh-hermes-link/tools')
const skillPath = join(root, 'packages/dsh-hermes-link/skills/dsh-hermes-link/SKILL.md')
const readmePath = join(root, 'README.md')

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { console.log(`  ok ${name}`); passed++ }
  else { console.log(`  FAIL ${name}: ${detail}`); failed++ }
}

// Enumerate actual tools by parsing `name: '<tool-name>'` from each file
const actualToolNames = new Set()
for (const f of readdirSync(toolsDir)) {
  if (!f.endsWith('.mjs')) continue
  const txt = readFileSync(join(toolsDir, f), 'utf8')
  const m = txt.match(/name:\s*['"`]([a-z_]+)['"`]/)
  if (m) actualToolNames.add(m[1])
}
console.log(`Discovered ${actualToolNames.size} tool names in tools/: ${[...actualToolNames].sort().join(', ')}`)

// Each actual tool must be mentioned in SKILL.md
if (existsSync(skillPath)) {
  const skillTxt = readFileSync(skillPath, 'utf8')
  for (const tool of actualToolNames) {
    check(`SKILL.md mentions tool "${tool}"`, skillTxt.includes(tool),
      `not found in skills/dsh-hermes-link/SKILL.md`)
  }
  // SKILL.md tool table row count should at least cover all tools
  const skillToolRows = (skillTxt.match(/^\|\s*`[a-z_]+`\s*\|/gm) || []).length
  check('SKILL.md tool table has >= actual count',
    skillToolRows >= actualToolNames.size,
    `SKILL.md has ${skillToolRows} table rows; tools/ has ${actualToolNames.size}`)
}

// Each actual tool must be mentioned in README
if (existsSync(readmePath)) {
  const readmeTxt = readFileSync(readmePath, 'utf8')
  for (const tool of actualToolNames) {
    check(`README.md mentions tool "${tool}"`, readmeTxt.includes('`' + tool + '`'),
      `not found in README.md tool table`)
  }
}

// CHANGELOG.md latest entry has required sections (if it has any entry at all)
const changelogPath = join(root, 'CHANGELOG.md')
if (existsSync(changelogPath)) {
  const txt = readFileSync(changelogPath, 'utf8')
  // take everything up to the first '---' separator
  // Latest entry: everything from the last '## [' heading onward
  const sections = txt.match(/## \[\d+\.\d+\.\d+\][^\n]*\n[\s\S]*?(?=\n## \[|$)/g) || []
  // First match is the most recent (Keep a Changelog convention: newest at top)
  const latestEntry = sections[0] || txt
  // v0.3.0+ entries may or may not have a Changed section; only check that
  // there's at least one section heading to signal structure
  const hasAnySection = /###\s+(Added|Changed|Fixed|Security|Deprecated|Removed)/.test(latestEntry)
  check('CHANGELOG.md latest entry has at least one ### section', hasAnySection,
    'no ### Added/Changed/Fixed/Security section heading')
}

// No leftover old plugin id "hermes-link" in user-facing docs (only as "dsh-hermes-link" is OK;
// legacy id should always appear with the dsh- prefix or with a migration note)
if (existsSync(skillPath)) {
  const txt = readFileSync(skillPath, 'utf8')
  // OK patterns: dsh-hermes-link; ok mention of bare "hermes-link" only if next to a migration note
  const bareHermesLink = /(?:^|[^a-z-])hermes-link(?![-a-z])/g
  const matches = [...txt.matchAll(bareHermesLink)]
  const bad = matches.filter((m) => !/hermes-link[^a-z-]*鈫抾v0\.2\.5/.test(m[0]))
  check('SKILL.md no bare "hermes-link" without rename hint', bad.length === 0,
    `found ${bad.length} bare references (no migration note)`)
}

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
