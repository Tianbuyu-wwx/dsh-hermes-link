#!/usr/bin/env node
// scripts/test-mirror-opt-in.mjs
// Unit tests for the v0.2.2 opt-in V4 mirror:
//   - redactEvent scrubs common secret patterns (API keys, AWS, PEM, JWT, generic
//     key=value) from text-bearing fields
//   - redactEvent does NOT touch identity fields (id, role, source.kind, etc.)
//   - redactEvent does NOT recurse into events that have no data field
//   - secret patterns with prefix capture preserve the prefix

import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mirrorUrl = pathToFileURL(join(root, 'packages', 'dsh-hermes-link', 'tools', 'mirror-session-to-hermes.mjs')).href
const { redactEvent } = await import(mirrorUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

t('case 1: OpenAI/Anthropic API keys redacted from user message text', () => {
  const ev = { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'Here is my key sk-proj-abcdef0123456789abcdef0123456789ABCDEF and sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx' }] } }
  const { event, redacted_blocks } = redactEvent(ev)
  assert.ok(!event.data.content[0].text.includes('sk-proj-'))
  assert.ok(!event.data.content[0].text.includes('sk-ant-'))
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
  assert.ok(redacted_blocks >= 1)
})

t('case 2: AWS access key + JWT + generic key=value all redacted', () => {
  const text = 'creds: AKIAIOSFODNN7EXAMPLE jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnopqrstuvwxyz0123456789 and api_key="ghp_abcdefghijklmnopqrstuvwxyz0123456789"'
  const { event } = redactEvent({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
  assert.ok(!event.data.content[0].text.includes('AKIA'))
  assert.ok(!event.data.content[0].text.includes('eyJ'))
  assert.ok(!event.data.content[0].text.includes('ghp_'))
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
})

t('case 3: PEM private key block is fully redacted', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...\n-----END RSA PRIVATE KEY-----'
  const { event } = redactEvent({ type: 'tool/result', data: { content: [{ type: 'text', text: 'before ' + pem + ' after' }] } })
  assert.ok(!event.data.content[0].text.includes('BEGIN RSA PRIVATE KEY'))
  assert.ok(!event.data.content[0].text.includes('MIIEowIBAAK'))
  assert.ok(event.data.content[0].text.includes('before') && event.data.content[0].text.includes('after'))
})

t('case 4: identity fields are NOT redacted', () => {
  const ev = {
    type: 'user/message',
    seq: 1,
    time: 100,
    data: {
      id: 'msg-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'safe content with AKIAIOSFODNN7EXAMPLE' }],
    },
  }
  const { event } = redactEvent(ev)
  assert.equal(event.data.id, 'msg-1', 'data.id untouched')
  assert.equal(event.data.role, 'user', 'data.role untouched')
  assert.deepEqual(event.data.source, { kind: 'user' }, 'data.source untouched')
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
})

t('case 5: event without data field is left intact', () => {
  const ev = { type: 'turn/start', seq: 0, time: 0 }
  const { event, redacted_blocks } = redactEvent(ev)
  assert.deepEqual(event, ev)
  assert.equal(redacted_blocks, 0)
})

t('case 6: non-text fields are NOT scrubbed even if they contain secrets', () => {
  const ev = { type: 'compaction/start', data: { reason: 'maintenance', tag: 'AKIA-LEAK' } }
  const { event } = redactEvent(ev)
  // "tag" is not in TEXT_FIELDS → not redacted.
  assert.equal(event.data.tag, 'AKIA-LEAK')
})

t('case 7: deeply nested text inside content[] is recursed', () => {
  const ev = {
    type: 'assistant/message',
    data: {
      content: [
        { type: 'text', text: 'top sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { type: 'tool_use', input: { password: 'pw: hunter2' } }, // not in TEXT_FIELDS at this key
        { type: 'tool_use', input: { description: 'desc sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb' } }, // description IS in TEXT_FIELDS
      ],
    },
  }
  const { event } = redactEvent(ev)
  assert.ok(event.data.content[0].text.includes('[REDACTED]'))
  // nested 'password' key not in TEXT_FIELDS → kept
  assert.equal(event.data.content[1].input.password, 'pw: hunter2')
  // nested 'description' IS in TEXT_FIELDS → redacted
  assert.ok(!event.data.content[2].input.description.includes('sk-ant-'))
})

t('case 8: redactEvent returns the original event unchanged (no leak) when no secrets', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: 'clean content' }] } }
  const { event, redacted_blocks } = redactEvent(ev)
  assert.deepEqual(event, ev)
  assert.equal(redacted_blocks, 0)
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)