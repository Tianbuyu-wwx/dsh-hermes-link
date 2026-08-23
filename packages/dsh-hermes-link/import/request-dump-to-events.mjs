// request-dump-to-events.mjs
//
// Hermes session archive → DSH SessionEvent[] converter.
//
// Hermes `sessions/request_dump_<sid>_<ts>.json` is an Anthropic-API-format
// request capture. One file per request attempt; a single Hermes session often
// has several dumps (e.g. retry on 429). We collapse a session's dumps into
// one canonical message stream, dedupe by message identity, and emit a valid
// DSH event log.
//
// DSH event envelope (per lib/types/types.d.ts):
//   { type, seq, time, data,
//     surfaceOp?: 'append' | { op:'replace', start, end },  // surface events only
//     sourceEventSeqs?: number[],                            // surface events only
//     ignorable?: true }                                     // optional
//
// Per-event data shape:
//   user/message       data = UserMessage                     (id, role:'user', content, source)
//   assistant/message  data = { turn, step, message: AssistantMessage, usage?, interrupted? }
//   tool/call          data = { turn, step, callId, name, arguments }
//   tool/result        data = { turn, step, message: ToolResultMessage, error?, meta? }
//   turn/start         data = { turn }
//   step/start         data = { turn, step }
//   step/end           data = { turn, step }
//   turn/end           data = { turn, reason: TurnEndReason }
//   request/header     data = { header: EpochHeader, reason: RequestHeaderReason }
//   session/end-seed   data = {}                              (signals seed boundary)
//
// DSH Message (dsh-llm message.d.ts):
//   Message { id: MessageId, role, content: ContentBlock[], source: MessageSource }
//   UserMessage       extends Message { role: 'user',  source: { kind: 'user' } }
//   AssistantMessage  extends Message { role: 'assistant', source: { kind: 'model', provider, model, replayState? } }
//   ToolResultMessage extends Message { role: 'user', content: [ToolResultBlock], source: { kind: 'tool', callId } }
//
// We use the dsh-llm factories (createUserMessage / createAssistantMessage / createToolResultMessage)
// which stamp a fresh MessageId and deep-freeze the message — both required for Session.append.

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Inline DSH message factories. We don't import from @deepseek-ai/dsh-llm because
// the dsh-hermes-link package has no node_modules of its own and the host's copy
// isn't reachable from this workspace. The factories mirror the runtime behavior
// of dsh-llm's createUserMessage / createAssistantMessage / createToolResultMessage
// (MessageId brand is runtime-identity, deep-freeze is recursive Object.freeze).
//
// DSH Session.append validates the message SHAPE, not the factory reference;
// a frozen { id, role, content, source } object is sufficient.

// -----------------------------------------------------------------------------
// Inline DSH Message factories (mirror @deepseek-ai/dsh-llm behavior)
// -----------------------------------------------------------------------------

const MessageId = (x) => x   // brand is compile-time; runtime identity
const CallId    = (x) => x

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const k of Object.getOwnPropertyNames(obj)) {
    const v = obj[k]
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v)
  }
  return obj
}

function createMessage(input) {
  return deepFreeze({ ...input, id: MessageId(randomUUID()) })
}

function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' })
}

function createAssistantMessage(input) {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: { kind: 'model', ...input.source },
  })
}

function createToolResultMessage(input) {
  return createUserMessage({
    source: { kind: 'tool', callId: CallId(input.callId) },
    content: [{ type: 'tool-result', toolCallId: CallId(input.callId), content: input.content, isError: input.isError }],
  })
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Convert a single request_dump JSON object into DSH seed events + meta header.
 * Returns `{ events, meta, firstUserSnippet }`.
 *
 * Caller is responsible for:
 *   1. Grouping multiple dumps for the same session_id
 *   2. Calling this on each dump in chronological order
 *   3. Merging the per-dump event lists
 *
 * @param {object} dump   parsed request_dump JSON
 * @param {number} baseTime  base unix-ms; per-event time = baseTime + seq*1000
 */
export function requestDumpToEvents(dump, baseTime = Date.now()) {
  const body     = dump && dump.request && dump.request.body
  const model    = (body && body.model) || 'unknown'
  // provider is always 'dsh-hermes-link' for imported history (the originating model is
  // captured in `model`; provider just names who produced the events in DSH terms).
  const provider = 'dsh-hermes-link'
  const sys      = (body && body.system)
  const tools    = (body && body.tools) || []
  const messages = Array.isArray(body && body.messages) ? body.messages : []
  const error    = dump && dump.error

  const events = []
  let seq = 0
  const t0 = baseTime
  const mkTime = () => t0 + seq * 1000

  // -- request/header (capture model + system + tools so deriveMessages works) --
  const headerData = {
    header: {
      config: { provider, model },
      system: typeof sys === 'string'
        ? sys
        : (Array.isArray(sys) ? sys.map((b) => (b && b.text) || '').join('\n') : ''),
      tools: tools.map((t) => toCleanJson({
        name: t && t.name,
        description: t && t.description,
        input_schema: t && t.input_schema,
      })),
    },
    reason: 'initial',
  }
  events.push(makeEvent('request/header', headerData, seq++, mkTime()))

  // -- turn 1, step 0 begin --
  // DSH persistence validates turn/end.turn >= 1 (a turn:0 envelope is
  // rejected as "malformed pre-react-loop turn/end"), so imported history is
  // folded into turn 1, not 0 — same shape as a real first turn.
  events.push(makeEvent('turn/start',  { turn: 1 },            seq++, mkTime()))
  events.push(makeEvent('step/start',  { turn: 1, step: 0 },   seq++, mkTime()))

  // Walk messages; assistant with tool_use becomes 1 tool/call event per use + 1 assistant/message.
  // user with tool_result blocks becomes 1 tool/result event per block.
  // user with text becomes 1 user/message event.
  let firstUserSnippet = ''
  let stepAssistantCount = 0
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]
    if (!msg || !msg.role) continue
    if (msg.role === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        if (!firstUserSnippet) firstUserSnippet = content.slice(0, 160)
        const message = createUserMessage({
          content: [{ type: 'text', text: content }],
          source: { kind: 'user' },
        })
        events.push(makeSurfaceEvent('user/message', message, seq++, mkTime(), [0]))
      } else if (Array.isArray(content)) {
        const textParts = []
        const toolResults = []
        for (const block of content) {
          if (!block) continue
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text)
          } else if (block.type === 'tool_result') {
            toolResults.push(block)
          }
        }
        if (textParts.length > 0) {
          const combined = textParts.join('\n')
          if (!firstUserSnippet) firstUserSnippet = combined.slice(0, 160)
          const message = createUserMessage({
            content: [{ type: 'text', text: combined }],
            source: { kind: 'user' },
          })
          events.push(makeSurfaceEvent('user/message', message, seq++, mkTime(), [0]))
        }
        for (const tr of toolResults) {
          // strip Hermes' untrusted wrapper so the model sees just the payload.
          const stripped = stripUntrustedWrapper(tr.content)
          const message = createToolResultMessage({
            callId: tr.tool_use_id || '',
            content: [{ type: 'text', text: typeof stripped === 'string' ? stripped : safeStringify(stripped) }],
            isError: false,
          })
          events.push(makeSurfaceEvent('tool/result', {
            turn: 1,
            step: stepAssistantCount,
            message,
          }, seq++, mkTime(), [0]))
        }
      }
    } else if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : []
      const textBlocks = []
      const toolUses = []
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          textBlocks.push(block)
        } else if (block.type === 'tool_use') {
          toolUses.push(block)
        } else if (block.type === 'reasoning' && typeof block.text === 'string') {
          textBlocks.push(block)
        }
      }
      // emit tool/call first (log-only), then assistant/message (surface)
      for (const tu of toolUses) {
        events.push(makeEvent('tool/call', {
          turn: 1,
          step: stepAssistantCount,
          callId: tu.id || `call_${seq}`,
          name: tu.name || '',
          arguments: typeof tu.input === 'string' ? tu.input : safeStringify(tu.input || {}),
        }, seq++, mkTime()))
      }
      // even if there were only tool_uses (no text), still emit assistant/message
      // with an empty text block so the surface has a placeholder turn.
      if (textBlocks.length === 0) {
        textBlocks.push({ type: 'text', text: '' })
      }
      const message = createAssistantMessage({
        content: textBlocks,
        source: { provider, model },
      })
      events.push(makeSurfaceEvent('assistant/message', {
        turn: 1,
        step: stepAssistantCount,
        message,
      }, seq++, mkTime()))
      stepAssistantCount++
    }
  }

  // -- step 0 end + turn 1 end (best-effort: the dump is a failed/aborted request) --
  events.push(makeEvent('step/end',  { turn: 1, step: 0 },  seq++, mkTime()))
  if (error) {
    events.push(makeEvent('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          message: (error.message || error.type || 'unknown').slice(0, 1024),
          code: String(error.status_code || error.type || 'UNKNOWN'),
        },
      },
    }, seq++, mkTime()))
  } else {
    events.push(makeEvent('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }, seq++, mkTime()))
  }

  // -- session/end-seed marks the seed boundary; the framework treats everything
  //    before it as inherited history and does NOT publish session/event for them.
  events.push(makeEvent('session/end-seed', {}, seq++, mkTime()))

  const meta = {
    cwd: process.cwd(),
    agentPreset: 'hermes-imported',
  }

  return { events, meta, firstUserSnippet }
}

/**
 * Group request_dump files by Hermes session_id, sort each group by mtime asc,
 * and yield a list of canonical message streams (deduped). For v0.1 we simply
 * pick the latest dump per session_id — the latest dump carries the full
 * messages[] (it's a snapshot of the conversation at request time).
 */
export function groupBySession(files) {
  const byId = new Map()
  for (const f of files) {
    const sid = (f.dump && f.dump.session_id) || extractSessionIdFromPath(f.path)
    if (!sid) continue
    const cur = byId.get(sid)
    if (!cur || f.mtime > cur.mtime) {
      byId.set(sid, { session_id: sid, latestPath: f.path, dump: f.dump, mtime: f.mtime })
    }
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime)
}

/**
 * Walk Hermes Home/sessions/ and yield one entry per request_dump file.
 * Reads file mtime + parses JSON lazily; caller decides what to keep.
 */
export function* walkRequestDumps(sessionsDir) {
  let entries
  try { entries = readdirSync(sessionsDir) } catch { return }
  for (const name of entries) {
    if (!name.startsWith('request_dump_') || !name.endsWith('.json')) continue
    const path = join(sessionsDir, name)
    let st
    try { st = statSync(path) } catch { continue }
    if (!st.isFile()) continue
    let dump
    try { dump = JSON.parse(readFileSync(path, 'utf8')) }
    catch { continue }
    yield { path, mtime: st.mtimeMs, dump }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeEvent(type, data, seq, time) {
  return { type, seq, time, data }
}

function makeSurfaceEvent(type, data, seq, time, provenanceSeqs) {
  // surface events require surfaceOp + sourceEventSeqs.
  // - assistant/message: empty sourceEventSeqs is allowed (DSH invariant).
  // - user/message + tool/result: must reference at least one earlier event.
  // For a fresh seed we cite the request/header event (events[0]) since the entire
  // history flows from that single header snapshot; turns of "earlier assistant
  // messages" are reconstructed by the framework from the seed surface ordering.
  return {
    type, seq, time, data,
    surfaceOp: 'append',
    sourceEventSeqs: Array.isArray(provenanceSeqs) ? provenanceSeqs : [],
  }
}

function inferProviderFromModel(model) {
  // unused after v0.1 simplification; kept as a hint for future v0.2 provenance
  // capture (the real upstream adapter provider should win when known).
  if (!model) return 'unknown'
  if (model.includes('deepseek')) return 'deepseek-official'
  if (model.includes('claude')) return 'anthropic'
  if (model.includes('gpt')) return 'openai'
  if (model.includes('gemini')) return 'google'
  return 'unknown'
}

function extractSessionIdFromPath(path) {
  // request_dump_<sid>_<ts>.json  → sid is the segment between the first and second _
  const m = /request_dump_([^_]+(?:_[^_]+)*?)_\d{8}_\d{6}/.exec(path)
  return m ? m[1] : null
}

function stripUntrustedWrapper(content) {
  // Hermes sometimes wraps tool results with an <untrusted_tool_result source="...">
  // preamble. The actual payload is either the substring inside those tags or the
  // .content key on an object.
  if (typeof content === 'string') {
    const m = /<untrusted_tool_result\b[^>]*>([\s\S]*?)<\/untrusted_tool_result>/.exec(content)
    if (m) return m[1]
    return content
  }
  if (content && typeof content === 'object') {
    if (typeof content.content === 'string') return content.content
    if (Array.isArray(content.content)) return content.content
  }
  return safeStringify(content || '')
}

function safeStringify(o) {
  try { return JSON.stringify(o) } catch { return String(o) }
}

/**
 * Recursively strip anything that is not losslessly JSON-serializable:
 *   - drops object keys whose value is undefined
 *   - converts NaN / Infinity to null
 *   - converts functions / symbols / classes to their String form
 * This keeps every emitted event within DSH's isJsonValue contract.
 */
function toCleanJson(value) {
  if (value === undefined) return undefined        // caller must drop the key
  if (value === null) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const x = toCleanJson(item)
      if (x !== undefined) out.push(x)
    }
    return out
  }
  if (typeof value === 'object') {
    // Date / Map / Set / class instances are not lossless JSON
    if (value instanceof Date) return value.toISOString()
    if (typeof value.toJSON === 'function' && !Array.isArray(value)) {
      try {
        const direct = JSON.parse(JSON.stringify(value))
        if (direct !== undefined) return direct
      } catch {}
    }
    const out = {}
    for (const k of Object.getOwnPropertyNames(value)) {
      const x = toCleanJson(value[k])
      if (x !== undefined) out[k] = x
    }
    return out
  }
  // functions / symbols / bigint
  return String(value)
}