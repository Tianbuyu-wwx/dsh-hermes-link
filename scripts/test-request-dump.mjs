#!/usr/bin/env node
// scripts/test-request-dump.mjs
// Unit tests for import/request-dump-to-events.mjs — the V2 core converter.
// No DSH runtime required. Pure JSON in, events out.

import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const converterPath = join(root, 'packages', 'hermes-link', 'import', 'request-dump-to-events.mjs')
const converterUrl = pathToFileURL(converterPath).href
const { requestDumpToEvents, groupBySession } = await import(converterUrl)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); passed++ }
  catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++ }
}

// -- helpers to construct dumps -------------------------------------------------
function mkDump({ session_id, body, error, timestamp }) {
  return {
    timestamp: timestamp || '2026-08-21T00:00:00',
    session_id,
    reason: error ? 'max_retries_exhausted' : 'ok',
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/anthropic',
      headers: {},
      body,
    },
    error,
  }
}
function mkBaseBody({ messages, model = 'MiniMax-M3', system = '', tools = [] }) {
  return { model, system, messages, tools, tool_choice: { type: 'auto' }, temperature: 1 }
}

// -- tests ---------------------------------------------------------------------

t('case 1: minimal user-only request → 1 user/message + boundary events', () => {
  const dump = mkDump({
    session_id: 's1',
    body: mkBaseBody({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  const { events, firstUserSnippet } = requestDumpToEvents(dump, 1000)
  assert.equal(firstUserSnippet, 'hi')
  // event types in order
  const types = events.map((e) => e.type)
  assert.deepEqual(types, [
    'request/header',
    'turn/start',
    'step/start',
    'user/message',
    'step/end',
    'turn/end',
    'session/end-seed',
  ])
  // seq contiguous from 0
  for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i)
  // surface events have surfaceOp
  const userEvent = events.find((e) => e.type === 'user/message')
  assert.equal(userEvent.surfaceOp, 'append')
  // fresh seed: user/message cites the request/header seq (events[0]) since
  // there's no earlier live surface node to inherit from. DSH invariant allows
  // empty sourceEventSeqs only on assistant/message.
  assert.deepEqual(userEvent.sourceEventSeqs, [0])
  // user/message data is now a UserMessage (id, role, content, source)
  assert.equal(userEvent.data.role, 'user')
  assert.equal(userEvent.data.content[0].text, 'hi')
  assert.equal(userEvent.data.source.kind, 'user')
  assert.ok(typeof userEvent.data.id === 'string' && userEvent.data.id.length > 0)
  // turn/end reason=completed (no error)
  const turnEnd = events.find((e) => e.type === 'turn/end')
  assert.equal(turnEnd.data.reason.kind, 'completed')
})

t('case 2: user + assistant text → full round-trip events', () => {
  const dump = mkDump({
    session_id: 's2',
    body: mkBaseBody({ messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ] }),
  })
  const { events } = requestDumpToEvents(dump, 2000)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('user/message'))
  assert.ok(types.includes('assistant/message'))
  const asst = events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.role, 'assistant')
  assert.equal(asst.data.message.content[0].text, 'a')
  // DSH Message shape: id, role, content, source
  assert.ok(typeof asst.data.message.id === 'string' && asst.data.message.id.length > 0)
  assert.equal(asst.data.message.source.kind, 'model')
  assert.equal(asst.data.message.source.provider, 'hermes-link')
})

t('case 3: assistant tool_use + user tool_result → tool/call + tool/result events', () => {
  const dump = mkDump({
    session_id: 's3',
    body: mkBaseBody({ messages: [
      { role: 'user', content: 'go search' },
      { role: 'assistant', content: [
        { type: 'text', text: 'searching...' },
        { type: 'tool_use', id: 'call_abc', name: 'browser_navigate', input: { url: 'https://x' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_abc', content: '<untrusted_tool_result source="browser_navigate">{"ok":true}</untrusted_tool_result>' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] }),
  })
  const { events } = requestDumpToEvents(dump, 3000)
  const types = events.map((e) => e.type)
  // Expected order (text-bearing tool call splits into tool/call + assistant/message):
  //   request/header, turn/start, step/start,
  //   user/message (go search),
  //   tool/call, assistant/message (searching...),
  //   tool/result,
  //   assistant/message (done),
  //   step/end, turn/end, session/end-seed
  const expected = [
    'request/header','turn/start','step/start',
    'user/message',
    'tool/call','assistant/message',
    'tool/result',
    'assistant/message',
    'step/end','turn/end','session/end-seed',
  ]
  assert.deepEqual(types, expected)
  const tc = events.find((e) => e.type === 'tool/call')
  assert.equal(tc.data.callId, 'call_abc')
  assert.equal(tc.data.name, 'browser_navigate')
  assert.equal(tc.data.arguments, '{"url":"https://x"}')
  // tool/call is log-only — no surfaceOp
  assert.ok(!('surfaceOp' in tc))
  const tr = events.find((e) => e.type === 'tool/result')
  // DSH ToolResultMessage shape: id, role:'user', content:[ToolResultBlock], source:{kind:'tool', callId}
  assert.equal(tr.data.message.role, 'user')
  assert.equal(tr.data.message.source.kind, 'tool')
  assert.equal(tr.data.message.source.callId, 'call_abc')
  assert.ok(Array.isArray(tr.data.message.content))
  assert.equal(tr.data.message.content.length, 1)
  assert.equal(tr.data.message.content[0].type, 'tool-result')
  assert.equal(tr.data.message.content[0].toolCallId, 'call_abc')
  const innerText = tr.data.message.content[0].content[0].text
  assert.ok(!innerText.startsWith('<untrusted'))
  assert.ok(innerText.includes('"ok":true'))
  // tool/result is surface
  assert.equal(tr.surfaceOp, 'append')
})

t('case 4: assistant reasoning + text → both blocks kept in content', () => {
  const dump = mkDump({
    session_id: 's4',
    body: mkBaseBody({ messages: [
      { role: 'user', content: 'think' },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'thinking out loud' },
        { type: 'text', text: 'final answer' },
      ] },
    ] }),
  })
  const { events } = requestDumpToEvents(dump, 4000)
  const asst = events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.content.length, 2)
  assert.equal(asst.data.message.content[0].type, 'reasoning')
  assert.equal(asst.data.message.content[1].type, 'text')
})

t('case 5: errored request → turn/end reason.kind=error with status_code', () => {
  const dump = mkDump({
    session_id: 's5',
    body: mkBaseBody({ messages: [{ role: 'user', content: 'rate' }] }),
    error: {
      type: 'rate_limit_error',
      message: 'rate limit hit',
      status_code: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit hit' } },
    },
  })
  const { events } = requestDumpToEvents(dump, 5000)
  const turnEnd = events.find((e) => e.type === 'turn/end')
  assert.equal(turnEnd.data.reason.kind, 'error')
  assert.equal(turnEnd.data.reason.error.code, '429')
  assert.ok(turnEnd.data.reason.error.message.includes('rate limit'))
})

t('case 6: empty messages → no user/assistant events, just boundary', () => {
  const dump = mkDump({ session_id: 's6', body: mkBaseBody({ messages: [] }) })
  const { events, firstUserSnippet } = requestDumpToEvents(dump, 6000)
  assert.equal(firstUserSnippet, '')
  const types = events.map((e) => e.type)
  assert.deepEqual(types, [
    'request/header','turn/start','step/start','step/end','turn/end','session/end-seed',
  ])
})

t('case 7: tools array passed through to request/header', () => {
  const dump = mkDump({
    session_id: 's7',
    body: mkBaseBody({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'web_search', description: 'search', input_schema: { type: 'object' } }],
    }),
  })
  const { events } = requestDumpToEvents(dump, 7000)
  const hdr = events.find((e) => e.type === 'request/header')
  assert.equal(hdr.data.header.tools.length, 1)
  assert.equal(hdr.data.header.tools[0].name, 'web_search')
  assert.equal(hdr.data.reason, 'initial')
})

t('case 8: groupBySession picks latest mtime per session_id', () => {
  const files = [
    { path: '/a/request_dump_sX_20260820_100000.json', mtime: 100, dump: { session_id: 'sX' } },
    { path: '/a/request_dump_sX_20260820_110000.json', mtime: 200, dump: { session_id: 'sX' } },
    { path: '/a/request_dump_sY_20260820_120000.json', mtime: 150, dump: { session_id: 'sY' } },
  ]
  const grouped = groupBySession(files)
  assert.equal(grouped.length, 2)
  const sX = grouped.find((g) => g.session_id === 'sX')
  assert.equal(sX.latestPath, '/a/request_dump_sX_20260820_110000.json')
})

t('case 9: DSH persistence turn contract — all turn envelopes use turn 1 (turn/end.turn must be >= 1)', () => {
  const dump = mkDump({
    session_id: 's9',
    body: mkBaseBody({ messages: [
      { role: 'user', content: 'go search' },
      { role: 'assistant', content: [
        { type: 'text', text: 'searching...' },
        { type: 'tool_use', id: 'call_abc', name: 'browser_navigate', input: { url: 'https://x' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_abc', content: '{"ok":true}' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] }),
  })
  const { events } = requestDumpToEvents(dump, 9000)
  // Every control/message event that carries a turn number must use turn 1 —
  // dsh-session-persistence rejects turn/end with data.turn < 1 as "malformed
  // pre-react-loop turn/end", which made every imported session unresumable.
  for (const e of events) {
    if (e.type === 'request/header' || e.type === 'session/end-seed') continue
    if (typeof e.data === 'object' && e.data !== null && Object.hasOwn(e.data, 'turn')) {
      assert.equal(e.data.turn, 1, `${e.type}@${e.seq} must carry turn 1, got ${e.data.turn}`)
    }
  }
  const turnStart = events.find((e) => e.type === 'turn/start')
  const stepStart = events.find((e) => e.type === 'step/start')
  const turnEnd = events.find((e) => e.type === 'turn/end')
  assert.equal(turnStart.data.turn, 1)
  assert.equal(stepStart.data.turn, 1)
  assert.equal(stepStart.data.step, 0)
  assert.equal(turnEnd.data.turn, 1)
  assert.equal(turnEnd.data.reason.kind, 'completed')
  // surface messages also carry turn 1 (assistant/tool-result envelopes)
  const asst = events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.turn, 1)
  const tr = events.find((e) => e.type === 'tool/result')
  assert.equal(tr.data.turn, 1)
})

t('case 10: DSH persistence turn contract holds for errored dumps too', () => {
  const dump = mkDump({
    session_id: 's10',
    body: mkBaseBody({ messages: [{ role: 'user', content: 'rate' }] }),
    error: { type: 'rate_limit_error', message: 'rate limit hit', status_code: 429 },
  })
  const { events } = requestDumpToEvents(dump, 10000)
  const turnEnd = events.find((e) => e.type === 'turn/end')
  assert.equal(turnEnd.data.turn, 1)
  assert.equal(turnEnd.data.reason.kind, 'error')
})

// ----------------------------------------------------------------------------

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)