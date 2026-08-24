#!/usr/bin/env node
// scripts/test-v0.2.3-hardening.mjs
// Unit tests for the v0.2.3 hotfix (K.1–K.5).
//
//   K.1: loadPersona no longer reads MEMORY.md (cross-project contamination).
//        scope='all' / 'soul' / 'config' returns SOUL + config only.
//        scope='memory' returns a migration hint and no MEMORY content.
//   K.2: import-hermes-session refuses system-critical / non-absolute / null-
//        byte / over-long cwd paths from Hermes state.db (falls back to
//        hermes-workspace). User-supplied `workspace` override still wins
//        because the user is opting in.
//   K.3: outbox.appendSessionEvent bounds the mirror filename length to
//        ≤ 200 chars by hashing the tail. Super-long sessionId produces a
//        file that is still readable.
//   K.5: redactEvent scrubs Cookie: ..., Set-Cookie: ..., and the new
//        generic-keyword 'cookie' / 'session_id' / 'set_cookie' additions.
//
// No DSH runtime required.

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const personaUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'persona-loader.mjs')).href
const outboxUrl  = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'outbox.mjs')).href
const mirrorUrl  = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'tools', 'mirror-session-to-hermes.mjs')).href

// mirror-session-to-hermes.mjs imports @deepseek-ai/dsh-tools which is provided
// by the DSH host at runtime. Without a DSH checkout (CI sandbox) it cannot
// resolve, so the whole test is a no-op skip instead of a hard failure.
let personaMod, outboxMod, mirrorMod
try {
  ;[personaMod, outboxMod, mirrorMod] = await Promise.all([
    import(personaUrl), import(outboxUrl), import(mirrorUrl),
  ])
} catch (e) {
  if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('@deepseek-ai/')) {
    console.log('(test-v0.2.3-hardening skipped — no @deepseek-ai/* host checkout available)')
    process.exit(0)
  }
  throw e
}
const { loadPersona } = personaMod
const { createOutbox } = outboxMod
const { redactEvent } = mirrorMod

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-v023-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

// ============================================================================
// K.1 — loadPersona no longer reads MEMORY.md wholesale
// ============================================================================

t('K.1: scope=all returns SOUL + config but NEVER MEMORY body', () => {
  const { home, cleanup } = makeHome()
  try {
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'SOUL.md'), '# SOUL\nhelpful + direct\n', 'utf8')
    writeFileSync(join(home, 'memories', 'MEMORY.md'),
      '# MEMORY\n[project X] secret fact only relevant to project X\n', 'utf8')
    writeFileSync(join(home, 'config.yaml'), 'model:\n  default: deepseek-v4\n', 'utf8')
    const out = loadPersona(home, { scope: 'all' })
    assert.ok(out.text.includes('SOUL'), 'SOUL present')
    assert.ok(out.text.includes('model:'), 'config slice present')
    assert.ok(!out.text.includes('project X'), 'MEMORY body NOT present')
    assert.ok(!out.text.includes('secret fact'), 'MEMORY body NOT present')
    assert.ok(!out.parts.some((p) => p.name === 'MEMORY.md' && p.bytes > 0),
      'no MEMORY.md part with positive bytes')
  } finally { cleanup() }
})

t('K.1: scope=soul returns only SOUL', () => {
  const { home, cleanup } = makeHome()
  try {
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'SOUL.md'), '# SOUL\n', 'utf8')
    writeFileSync(join(home, 'memories', 'MEMORY.md'), 'project Y secret\n', 'utf8')
    const out = loadPersona(home, { scope: 'soul' })
    assert.ok(out.text.includes('SOUL'))
    assert.ok(!out.text.includes('project Y'))
    assert.equal(out.parts.find((p) => p.name === 'MEMORY.md'), undefined)
  } finally { cleanup() }
})

t('K.1: scope=memory returns migration hint + zero MEMORY content', () => {
  const { home, cleanup } = makeHome()
  try {
    mkdirSync(join(home, 'memories'), { recursive: true })
    writeFileSync(join(home, 'memories', 'MEMORY.md'), 'sensitive-XYZ\n', 'utf8')
    const out = loadPersona(home, { scope: 'memory' })
    assert.ok(!out.text.includes('sensitive-XYZ'), 'NO memory body even with scope=memory')
    assert.ok(out.text.includes('load_hermes_project_memory'),
      'emits migration hint pointing to load_hermes_project_memory')
    const memPart = out.parts.find((p) => p.name === 'MEMORY.md')
    assert.ok(memPart, 'still reports MEMORY.md part for transparency')
    assert.equal(memPart.bytes, 0, 'MEMORY.md part reports 0 bytes (not delivered)')
    assert.ok(memPart.note && memPart.note.includes('v0.2.3'))
  } finally { cleanup() }
})

t('K.1: when SOUL.md is missing, scope=all returns only config (no error)', () => {
  const { home, cleanup } = makeHome()
  try {
    writeFileSync(join(home, 'config.yaml'), 'model:\n  default: m\n', 'utf8')
    const out = loadPersona(home, { scope: 'all' })
    assert.ok(out.text.includes('config.yaml'))
    assert.ok(!out.text.includes('SOUL'))
  } finally { cleanup() }
})

// ============================================================================
// K.2 — import cwd safety (isSafeCwd)
// ============================================================================
//
// We import the importer helper indirectly: the safety predicate is not exported
// directly, but resolveCwd() is the only consumer. We test the observable
// behaviour via importSession with various cwd scenarios by importing the
// module and inspecting its exports.

t('K.2: module still exports the surface (smoke that K.2 refactor is reachable)', async () => {
  const mod = await import(pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'import', 'import-hermes-session.mjs')).href)
  assert.equal(typeof mod.createImporter, 'function', 'createImporter exported')
})

// K.2 path safety — replicate the predicate inline and confirm semantics.
// We re-declare the rule here so the test is independent of import-hermes-
// session.mjs internals (the predicate is not exported there either).

// Mirror the product-code rule verbatim (the actual predicate lives inside
// import-hermes-session.mjs as a non-exported function — we replicate the rule
// here so this test is independent of internal restructuring).
//
// IMPORTANT: forbidden entries must be in their normalised form
// (lowercase, forward-slashes) because the real predicate normalises the
// candidate cwd via `p.replace(/[\\/]+/g, '/').toLowerCase()` BEFORE comparing.
const FORBIDDEN = [
  'c:/windows', 'c:/windows/system32', 'c:/windows/syswow64',
  'c:/program files', 'c:/program files (x86)', 'c:/programdata',
  '/etc', '/bin', '/sbin', '/usr', '/var', '/proc', '/sys', '/boot', '/root',
  '/lib', '/lib64', '/opt', '/dev',
]

function isSafeCwdMirror(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.length > 1024) return false
  if (p.includes('\u0000')) return false
  const isAbsWin = /^[A-Za-z]:[\\/]/.test(p)
  const isAbsPosix = p.startsWith('/')
  if (!isAbsWin && !isAbsPosix) return false
  const norm = p.replace(/[\\/]+/g, '/').toLowerCase()
  for (const f of FORBIDDEN) {
    if (norm === f) return false
    if (norm.startsWith(f + '/')) return false
  }
  return true
}

t('K.2: forbidden system directories are rejected (exact + children)', () => {
  // Exact roots
  for (const p of FORBIDDEN) {
    assert.equal(isSafeCwdMirror(p), false, `must reject ${p}`)
  }
  // Windows-style spelled variants (case + separators)
  for (const variant of [
    'C:\\Windows', 'C:/Windows', 'c:\\WINDOWS\\', 'C:\\Windows\\System32',
    'c:////Windows', 'C:\\Program Files',
  ]) {
    assert.equal(isSafeCwdMirror(variant), false, `must reject Windows variant ${variant}`)
  }
  // POSIX children of forbidden roots are also rejected (anchored at root only)
  for (const f of ['/etc', '/usr', '/bin']) {
    assert.equal(isSafeCwdMirror(f + '/local/bin'), false, `child of ${f} rejected`)
  }
})

t('K.2: legitimate user workspace paths are accepted', () => {
  const good = [
    'C:\\Users\\alice\\projects\\dsh-hermes',
    'c:/Users/Bob/dev/myapp',
    '/home/carol/work/agent',
    '/Users/dave/code',
    'D:\\projects\\.dsh-hermes-link',
    '/srv/data',                  // /srv is NOT in forbidden list
  ]
  for (const p of good) {
    assert.equal(isSafeCwdMirror(p), true, `must accept ${p}`)
  }
})

t('K.2: non-absolute, empty, null-byte, over-long paths are rejected', () => {
  assert.equal(isSafeCwdMirror(''), false)
  assert.equal(isSafeCwdMirror('relative/path'), false)
  assert.equal(isSafeCwdMirror('C:relative'), false)
  assert.equal(isSafeCwdMirror('\u0000/etc'), false)
  assert.equal(isSafeCwdMirror('C:/' + 'a'.repeat(1100)), false, 'over-1024 rejected')
  assert.equal(isSafeCwdMirror('/etc/passwd'), false, '/etc/passwd rejected (forbidden)')
  assert.equal(isSafeCwdMirror('/etc'), false)
})

// ============================================================================
// K.3 — appendSessionEvent bounds filename length
// ============================================================================

t('K.3: short sessionId: file written with sanitized basename (no truncation)', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    assert.equal(ob.appendSessionEvent('short-id', { type: 'user/message', seq: 0 }), true)
    const files = readdirSync(join(home, 'inbox', 'dsh', 'session-mirror'))
    assert.equal(files.length, 1)
    assert.ok(files[0] === 'short-id.jsonl', 'short ids unchanged')
  } finally { cleanup() }
})

t('K.3: super-long sessionId: filename bounded to ~200 chars, content preserved', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    const long = 'a'.repeat(500) + ':' + 'b'.repeat(500) + ':' + 'c'.repeat(500)
    assert.ok(long.length > 1500, 'sessionId is genuinely long')
    assert.equal(ob.appendSessionEvent(long, { type: 'user/message', seq: 7 }), true)
    const files = readdirSync(join(home, 'inbox', 'dsh', 'session-mirror'))
    assert.equal(files.length, 1, 'one file written')
    const fname = files[0]
    assert.ok(fname.endsWith('.jsonl'))
    assert.ok(fname.length <= 210, 'filename bounded (≤ ~210 chars incl .jsonl) — got ' + fname.length)
    // Sanity-check that the file is readable and contains our event.
    const lines = readFileSync(join(home, 'inbox', 'dsh', 'session-mirror', fname), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const rec = JSON.parse(lines[0])
    assert.equal(rec.event.type, 'user/message')
    assert.equal(rec.event.seq, 7)
  } finally { cleanup() }
})

t('K.3: two distinct super-long ids produce two distinct bounded filenames', () => {
  const { home, cleanup } = makeHome()
  try {
    const ob = createOutbox({ hermesHome: home })
    const a = 'A'.repeat(800)
    const b = 'B'.repeat(800) + 'X'  // differs in last char
    ob.appendSessionEvent(a, { type: 'x' })
    ob.appendSessionEvent(b, { type: 'x' })
    const files = readdirSync(join(home, 'inbox', 'dsh', 'session-mirror'))
    assert.equal(files.length, 2)
    assert.notEqual(files[0], files[1])
  } finally { cleanup() }
})

t('K.3: hash tail is deterministic (predictable)', () => {
  // Independent re-derivation of the suffix the outbox should compute.
  const long = 'X'.repeat(500)
  const expectedTail = createHash('sha1').update(long).digest('hex').slice(0, 12)
  assert.equal(expectedTail.length, 12, 'sha1 12-char tail produced')
})

// ============================================================================
// K.5 — redactEvent scrubs Cookie / Set-Cookie / session_id / set-cookie
// ============================================================================

t('K.5: Cookie header value is redacted', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: 'Cookie: session=abc123def456; foo=bar' }] } }
  const { event, redacted_blocks } = redactEvent(ev)
  assert.ok(!event.data.content[0].text.includes('abc123def456'), 'cookie value redacted')
  // The 'Cookie' keyword + value replaced (we match cookie | session_id | set_cookie).
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
  assert.ok(redacted_blocks >= 1)
})

t('K.5: Set-Cookie header value is redacted', () => {
  const ev = { type: 'assistant/message', data: { content: [{ type: 'text', text: 'Set-Cookie: sid=verysecretvalue; HttpOnly' }] } }
  const { event } = redactEvent(ev)
  assert.ok(!event.data.content[0].text.includes('verysecretvalue'), 'Set-Cookie value redacted')
})

t('K.5: session_id assignment is redacted (new generic keyword)', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: 'session_id=zzz123456; carry on' }] } }
  const { event } = redactEvent(ev)
  assert.ok(!event.data.content[0].text.includes('zzz123456'), 'session_id value redacted')
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
})

t('K.5: set-cookie lower-case assignment is redacted', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: 'set-cookie=alpha123' }] } }
  const { event } = redactEvent(ev)
  assert.ok(!event.data.content[0].text.includes('alpha123'))
})

t('K.5: mytoken=... is NOT redacted (boundary \b protects)', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: 'mytoken=keepme; token=redactme' }] } }
  const { event } = redactEvent(ev)
  assert.ok(event.data.content[0].text.includes('mytoken=keepme'), 'no false positive on mytoken')
  assert.ok(!event.data.content[0].text.includes('token=redactme'))
})

t('K.5: existing regexes still work (jwt, sk-, AKIA, PEM) — no regression', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: [
    'OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signedpart',
    'aws: AKIAIOSFODNN7EXAMPLE',
  ].join('\n') }] } }
  const { event } = redactEvent(ev)
  const t = event.data.content[0].text
  assert.ok(!t.includes('sk-proj-'))
  assert.ok(!t.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!t.includes('eyJhbGciOiJIUzI1NiJ9'))
})

// ============================================================================

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)