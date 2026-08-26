#!/usr/bin/env node
// scripts/test-session-mirror.mjs
// Unit tests for v0.4.0 opt-in automatic DSH session mirroring:
//   - default is OFF
//   - enable writes future events to the mirror JSONL with redaction
//   - disable stops future writes
//   - enable(backfill) mirrors existing events
//   - enabled state persists across service instances
//   - optional SSE broker receives session/event notifications

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outboxUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'outbox.mjs')).href
const mirrorUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'services', 'session-mirror.mjs')).href
const { createOutbox } = await import(outboxUrl)
const { createSessionMirror } = await import(mirrorUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

function makeDirs() {
  const hermesHome = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-mirror-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-hermes-link-mirror-state-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  return {
    hermesHome,
    dshHome,
    cleanup() {
      if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old
      try { rmSync(hermesHome, { recursive: true, force: true }) } catch {}
      try { rmSync(dshHome, { recursive: true, force: true }) } catch {}
    },
  }
}

const secretEvent = () => ({
  type: 'user/message',
  seq: 7,
  data: { content: [{ type: 'text', text: 'key sk-proj-abcdef0123456789abcdef0123456789ABCDEF' }] },
})

const cleanEvent = () => ({ type: 'assistant/message', seq: 8, data: { content: [{ type: 'text', text: 'hello' }] } })

t('default OFF: handleEvent writes nothing before enable', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    assert.equal(sm.isEnabled('sess-1'), false)
    const status = sm.status('sess-1')
    assert.equal(status.enabled, false)
    assert.equal(status.default_off, true)
    sm.handleEvent('sess-1', secretEvent())
    ob.flushNow()
    const mirror = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror', 'sess-1.jsonl')
    assert.equal(existsSync(mirror), false, 'no mirror file before opt-in')
  } finally { env.cleanup() }
})

t('enable + handleEvent writes redacted JSONL to Hermes mirror', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    sm.enable('sess-1')
    assert.equal(sm.isEnabled('sess-1'), true)
    sm.handleEvent('sess-1', secretEvent())
    ob.flushNow()
    const mirror = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror', 'sess-1.jsonl')
    assert.ok(existsSync(mirror), 'mirror file created')
    const lines = readFileSync(mirror, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.equal(line.event.type, 'user/message')
    assert.ok(!line.event.data.content[0].text.includes('sk-proj-'), 'secret redacted')
    assert.ok(line.event.data.content[0].text.includes('[REDACTED]'))
    const status = sm.status('sess-1')
    assert.equal(status.event_count, 1)
    assert.equal(status.enabled, true)
  } finally { env.cleanup() }
})

t('disable stops future mirror writes', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    sm.enable('sess-1')
    sm.disable('sess-1')
    assert.equal(sm.isEnabled('sess-1'), false)
    sm.handleEvent('sess-1', cleanEvent())
    ob.flushNow()
    const mirror = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror', 'sess-1.jsonl')
    assert.equal(existsSync(mirror), false, 'disable before any event leaves no file')
  } finally { env.cleanup() }
})

t('enable(backfill=true) writes existing events immediately', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    const events = [secretEvent(), cleanEvent()]
    sm.enable('sess-2', { events })
    ob.flushNow()
    const mirror = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror', 'sess-2.jsonl')
    const lines = readFileSync(mirror, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(!lines[0].includes('sk-proj-'), 'backfilled secrets redacted')
    assert.equal(sm.status('sess-2').event_count, 2)
  } finally { env.cleanup() }
})

t('enabled state persists across service instances', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm1 = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    sm1.enable('persist-sess')
    const sm2 = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob })
    assert.equal(sm2.isEnabled('persist-sess'), true)
    assert.ok(sm2.status('persist-sess').enabled_at, 'enabled_at persisted')
  } finally { env.cleanup() }
})

t('SSE broker receives session/event publication when mirror is enabled', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const published = []
    const broker = {
      attachTask(channel, meta) { attached.push({ channel, meta }) },
      publish(channel, event) { published.push({ channel, event }) },
    }
    const attached = []
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob, sseBroker: broker })
    sm.enable('sess-3')
    sm.handleEvent('sess-3', cleanEvent())
    assert.equal(published.length, 1)
    assert.equal(published[0].channel, 'session:sess-3')
    assert.equal(published[0].event.kind, 'session/event')
    assert.equal(published[0].event.data.session_id, 'sess-3')
    assert.equal(published[0].event.data.event_type, 'assistant/message')
    ob.flushNow()
  } finally { env.cleanup() }
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)