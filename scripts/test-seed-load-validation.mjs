// scripts/test-seed-load-validation.mjs
//
// v0.6.0 (D1) regression gate - converter output must satisfy DSH's SEED/LOAD
// validator, not merely the append-time format codec.
//
// Why this test exists: the two validators are DIFFERENT and the append path is
// the weaker one. A converter defect that omitted the required 'stream' field on
// assistant/message was accepted by the v3 codec (append() succeeded, the
// artifact was written) but rejected when the session was later READ:
//   "stored session \"hermes-...\" is corrupt: seed assistant/message at index 8
//    has invalid settlement fields"
// i.e. every synced conversation imported cleanly and then failed to open.
// Only the real loader catches that, so this test drives the real loader:
//   - validateStoredEvents  (persistence contract)
//   - Session.create(id, seed, header, 0)   (dsh-session seed validation)
//
// Coverage: synthetic dumps always (CI-safe), plus real Hermes request dumps
// when a Hermes home is present (same skip-if-absent convention as
// scripts/import-check.mjs).

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const convUrl = pathToFileURL(join(repo, 'packages', 'dsh-hermes-link', 'import', 'request-dump-to-events.mjs')).href
const { requestDumpToEvents } = await import(convUrl)

const HERMES_HOME = process.env.HERMES_HOME || join(process.env.LOCALAPPDATA || '', 'hermes')

// Locate the installed DSH packages (same discovery the repo's other tests use).
function findDshRoot() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    join(repo, 'node_modules', '@deepseek-ai'),
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai'),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(join(c, 'dsh-session-persistence'))) return c
  return null
}

let pass = 0, fail = 0, skipped = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); fail++ }
}

const dshRoot = findDshRoot()
if (!dshRoot) {
  console.log('  -- DSH checkout not found; seed-load cases SKIPPED (set DSH_CHECKOUT to enable)')
  skipped++
  console.log('\nTotal: 0  Passed: 0  Failed: 0  Skipped: 1')
  process.exit(0)
}

const sp = await import(pathToFileURL(join(dshRoot, 'dsh-session-persistence', 'lib/index.js')).href)
const dshSession = await import(pathToFileURL(join(dshRoot, 'dsh-session', 'lib/index.js')).href)
const VERSION = dshSession.SESSION_FORMAT_VERSION

function validate(events, id) {
  const header = {
    type: 'session', version: VERSION, id,
    createdAt: 1700000000000, delegationDepth: 0, isSeeded: false,
    agentPreset: 'hermes-imported',
  }
  const meta = sp.materializeCreateHeader(header)
  sp.validateStoredEvents(meta, events)
  dshSession.Session.create(id, events, meta, 0)
}

function dump(messages, extra = {}) {
  return { session_id: 'synthetic', request: { body: { model: 'test-model', messages, ...extra } } }
}

const cases = [
  ['plain user + assistant text', dump([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ])],
  ['assistant with tool_use (tool/call + assistant/message + tool/result)', dump([
    { role: 'user', content: 'do a thing' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'some_tool', input: { a: 1 } }] },
    { role: 'tool', tool_call_id: 't1', content: 'tool output' },
    { role: 'assistant', content: 'done' },
  ])],
  ['assistant with empty content (placeholder turn)', dump([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: '' },
  ])],
  ['content block arrays', dump([
    { role: 'user', content: [{ type: 'text', text: 'blocky' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  ])],
  ['no tools, no system, with error', { session_id: 'synthetic', error: { type: 'x' }, request: { body: { model: 'm', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }] } } }],
]

for (const [label, d] of cases) {
  t('synthetic: ' + label, () => {
    const out = requestDumpToEvents(d, 1700000000000)
    const events = out && out.events ? out.events : out
    if (!Array.isArray(events) || events.length === 0) throw new Error('converter produced no events')
    validate(events, 'synthetic-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40))
  })
}

// Every assistant/message must carry the settlement fields the loader requires.
t('every assistant/message carries turn + step + stream[]', () => {
  const out = requestDumpToEvents(cases[0][1], 1700000000000)
  const events = out.events ? out.events : out
  const am = events.filter((e) => e.type === 'assistant/message')
  if (am.length === 0) throw new Error('expected at least one assistant/message')
  for (const e of am) {
    if (!Number.isSafeInteger(e.data.turn)) throw new Error('turn not a safe integer')
    if (!Number.isSafeInteger(e.data.step)) throw new Error('step not a safe integer')
    if (!Array.isArray(e.data.stream)) throw new Error('stream must be an array (loader requires Array.isArray)')
  }
})

t('assistant/message never carries sourceEventSeqs (v3 codec rule)', () => {
  const out = requestDumpToEvents(cases[1][1], 1700000000000)
  const events = out.events ? out.events : out
  for (const e of events.filter((x) => x.type === 'assistant/message')) {
    if (Object.hasOwn(e, 'sourceEventSeqs')) throw new Error('assistant/message must not carry sourceEventSeqs')
  }
})

// Real dumps when a Hermes home is available (bounded, deterministic sampling).
const sessionsDir = join(HERMES_HOME, 'sessions')
if (existsSync(sessionsDir)) {
  const files = readdirSync(sessionsDir).filter((f) => f.startsWith('request_dump_') && f.endsWith('.json')).sort()
  const sample = files.slice(-6)
  for (const f of sample) {
    t('real dump: ' + f.slice(0, 60), () => {
      const d = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
      const out = requestDumpToEvents(d, 1700000000000)
      const events = out.events ? out.events : out
      if (!Array.isArray(events) || events.length === 0) return   // dump with no messages
      validate(events, 'real-' + f.replace(/[^a-z0-9]+/gi, '-').slice(0, 48))
    })
  }
} else {
  console.log('  -- no Hermes home at ' + sessionsDir + '; real-dump cases skipped')
  skipped++
}

console.log('')
console.log('Total: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail + (skipped ? '  Skipped: ' + skipped : ''))
process.exit(fail === 0 ? 0 : 1)
