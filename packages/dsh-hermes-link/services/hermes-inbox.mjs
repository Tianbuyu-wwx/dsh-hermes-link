// services/hermes-inbox.mjs
//
// Shared conversation record between Hermes and DSH, migrated from the
// retired hermes-foundation plugin (v0.6/v0.7 behavior) into hermes-link.
//
// Conventions (unchanged from hermes-foundation, so Hermes-side scripts keep
// working):
//   - Hermes writes ~/.dsh/hermes-inbox/session.jsonl (JSONL, one turn per
//     line: { ts, source, user?, assistant?, content? }) and a latest.md
//     mirror at the end of each turn (scripts/hermes-push.mjs is the helper).
//   - DSH reads the shared record via:
//       1. `hermes_inbox` tool        — on-demand read (visible in chat UI)
//       2. `hermes_inbox_append` tool — DSH appends a turn back to Hermes
//       3. agent/session-start hook   — v0.7: injects the most recent
//          MAX_INJECT_TURNS Hermes turns into the MAIN dsh session log so the
//          user sees Hermes's conversation at the top of the chat and can
//          continue development from there. Sub-agents (depth>0) are NOT
//          injected; a compaction marker prevents re-injection.
//
// Hermes-side self-check: GET /mcp/hermes-inbox/health (read-only) still
// exists for scripts/hermes-push.mjs --status.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_INBOX_CHARS   = 8192   // cap for rendered inbox block
const MAX_INJECT_TURNS  = 20     // cap on Hermes turns injected into a dsh session log
const HERMES_SESSION_TAIL_BYTES = 32 * 1024

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function inboxDir() {
  return join(dshHome(), 'hermes-inbox')
}

export function inboxSessionPath() {
  return join(inboxDir(), 'session.jsonl')
}

export function inboxLatestPath() {
  return join(inboxDir(), 'latest.md')
}

function readText(p) {
  if (!p) return ''
  try {
    if (!existsSync(p)) return ''
    return readFileSync(p, 'utf8')
  } catch { return '' }
}

/**
 * Read all turns from session.jsonl (JSONL). Malformed lines are skipped.
 * @returns {Array<{ts:string, source?:string, user?:string, assistant?:string, content?:string}>|null}
 */
export function readHermesSessionTurns() {
  const path = inboxSessionPath()
  if (!existsSync(path)) return null
  const raw = readText(path)
  if (!raw) return null
  const lines = raw.split('\n').filter(Boolean)
  const turns = []
  for (const line of lines) {
    try { turns.push(JSON.parse(line)) } catch (e) { /* skip malformed */ }
  }
  return turns.length > 0 ? turns : null
}

/**
 * Render the full Hermes session log into a markdown block. Reads only the
 * tail (last 32KB) so huge logs don't OOM; head truncation is marked.
 */
export function loadHermesSession() {
  const path = inboxSessionPath()
  if (!existsSync(path)) return null
  let raw = readText(path)
  if (!raw) return null
  let headTruncated = false
  if (raw.length > HERMES_SESSION_TAIL_BYTES) {
    const idx = raw.length - HERMES_SESSION_TAIL_BYTES
    const nl = raw.indexOf('\n', idx)
    raw = nl > 0 ? raw.slice(nl + 1) : raw.slice(idx)
    headTruncated = true
  }
  if (raw.length > MAX_INBOX_CHARS) {
    raw = raw.slice(0, MAX_INBOX_CHARS) +
      '\n<!-- hermes-session: truncated at ' + MAX_INBOX_CHARS + ' chars from tail -->'
  }
  const lines = raw.trim().split('\n').filter(Boolean)
  const turns = []
  for (const line of lines) {
    try { turns.push(JSON.parse(line)) } catch (e) { /* skip malformed */ }
  }
  if (turns.length === 0) return null
  const blocks = []
  if (headTruncated) blocks.push('<!-- hermes-session: head truncated; showing most recent turns -->')
  turns.forEach((t, i) => {
    const ts = t.ts || '(ts unknown)'
    blocks.push('### Turn ' + (i + 1) + ' — ' + ts)
    if (t.source === 'full' && typeof t.content === 'string') {
      blocks.push(t.content)
    } else {
      if (t.user)      blocks.push('USER: ' + t.user)
      if (t.assistant) blocks.push('---')
      if (t.assistant) blocks.push('HERMES: ' + t.assistant)
    }
    blocks.push('')
  })
  return blocks.join('\n')
}

/**
 * Load the shared record: session.jsonl (preferred), else legacy latest.md.
 */
export function loadHermesInbox() {
  const session = loadHermesSession()
  if (session) return session
  const latest = inboxLatestPath()
  if (!existsSync(latest)) return null
  let s = readText(latest)
  if (!s) return null
  if (s.length > MAX_INBOX_CHARS) {
    s = s.slice(0, MAX_INBOX_CHARS) +
      '\n<!-- hermes-inbox: truncated at ' + MAX_INBOX_CHARS + ' chars; tail dropped -->'
  }
  return s
}

export function sessionHasHermesMarker(session) {
  if (!session || !Array.isArray(session.events)) return false
  for (const e of session.events) {
    // Accept both eras of the marker reason ('hermes-foundation:' pre-migration,
    // 'hermes-link:' current) so already-injected sessions are never re-injected.
    if (e && e.type === 'compaction/start' && e.data && typeof e.data.reason === 'string'
      && e.data.reason.endsWith('hermes-inbox-injection-marker')) {
      return true
    }
  }
  return false
}

/**
 * v0.7 injection: append the most recent Hermes turns to a MAIN dsh session's
 * event log (depth 0 only; sub-agents never see Hermes history). Marker-guarded
 * against re-injection. Never throws.
 * @param {object} ctx    Cordis ctx (ctx.sessions, ctx.agents)
 * @param {object} agent  the live Agent whose session just started
 * @returns {number} turns injected (0 when skipped)
 */
export function injectHermesTurns(ctx, agent) {
  if (!agent || !agent.session || !agent.session.header) return 0
  const header = agent.session.header
  if (header.delegationDepth !== 0) return 0
  // Imported Hermes sessions already carry their own history — injecting the
  // shared-record turns on top of them would duplicate conversation.
  if (header.agentPreset === 'hermes-imported') return 0
  if (!ctx || !ctx.sessions) return 0
  const session = ctx.sessions.get(agent.id)
  if (!session) return 0
  const hermesTurns = readHermesSessionTurns()
  if (!hermesTurns || hermesTurns.length === 0) return 0
  if (sessionHasHermesMarker(session)) return 0
  const tail = hermesTurns.slice(-MAX_INJECT_TURNS)
  let injectedSteps = 0 // per-injection step counter for the synthetic assistant messages
  for (const turn of tail) {
    if (turn.user) {
      session.append('user/message', {
        id: 'hermes-injected-' + turn.ts + '-u',
        role: 'user',
        content: [{ type: 'text', text: '[from Hermes conversation] ' + turn.user }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    }
    if (turn.assistant) {
      // assistant/message data MUST be the nested envelope { turn, step, message }
      // where message = { id, role:'assistant', content, source } and source.kind
      // is 'model' with provider+model (dsh-session assertMessageEventShape).
      // A flat { id, role, content, source:{kind:'assistant'} } fails load-time
      // validation ("lacks an identified message") and bricks resume/history.
      session.append('assistant/message', {
        turn: 0,
        step: injectedSteps++,
        message: {
          id: 'hermes-injected-' + turn.ts + '-a',
          role: 'assistant',
          content: [{ type: 'text', text: '[Hermes] ' + turn.assistant }],
          source: { kind: 'model', provider: 'hermes-link', model: 'history-sync' },
        },
      }, { surfaceOp: 'append' })
    }
  }
  session.append('compaction/start', {
    reason: 'hermes-link: hermes-inbox-injection-marker',
    ts: new Date().toISOString(),
    turns_injected: tail.length,
  })
  return tail.length
}

/**
 * Register the two shared-record tools (hermes_inbox / hermes_inbox_append)
 * on ctx. Exact same names/contract as hermes-foundation so the chat UI and
 * scripts keep working.
 * @param {object} ctx  Cordis ctx
 */
export function registerInboxTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'hermes_inbox',
    description: 'Read Hermes\'s recent conversation history from ~/.dsh/hermes-inbox/session.jsonl. Returns the full conversation log (turns: ts, user, assistant, optional full content). Use this when the user opens DSH and asks to see what Hermes has been doing.',
    parameters: {
      tail: { type: 'integer', description: 'Number of recent turns to return (default: all).' },
      format: { type: 'string', enum: ['jsonl', 'markdown'], default: 'markdown', description: 'Output format.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          total_turns: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          turns: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          content: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value && value.content ? value.content : JSON.stringify(value, null, 2) }]
      },
    },
    execute: (args) => {
      const path = inboxSessionPath()
      if (!existsSync(path)) {
        return { path, total_turns: 0, returned: 0, turns: [], content: '(hermes-inbox session.jsonl not present; Hermes has not pushed any turns yet)' }
      }
      const raw = readText(path)
      const lines = raw.split('\n').filter(Boolean)
      const turns = []
      for (const line of lines) {
        try { turns.push(JSON.parse(line)) } catch (e) { /* skip malformed */ }
      }
      const tail = args.tail && args.tail > 0 ? Math.min(args.tail, turns.length) : turns.length
      const selected = turns.slice(turns.length - tail)
      let content
      if (args.format === 'jsonl') {
        content = selected.map((t) => JSON.stringify(t)).join('\n')
      } else {
        const blocks = []
        selected.forEach((t, i) => {
          const idx = turns.length - selected.length + i + 1
          blocks.push('### Turn ' + idx + ' — ' + (t.ts || '(ts unknown)'))
          if (t.source === 'full' && typeof t.content === 'string') {
            blocks.push(t.content)
          } else {
            if (t.user)      blocks.push('USER: ' + t.user)
            if (t.assistant) blocks.push('---')
            if (t.assistant) blocks.push('HERMES: ' + t.assistant)
          }
          blocks.push('')
        })
        content = blocks.join('\n')
      }
      return { path, total_turns: turns.length, returned: selected.length, turns: selected, content }
    },
  }))
  console.log('[hermes-link v0.2] tool registered: hermes_inbox')

  ctx.tools.register(defineTool({
    name: 'hermes_inbox_append',
    description: 'Append a new turn to the shared Hermes/DSH conversation record at ~/.dsh/hermes-inbox/session.jsonl. The user can ask DSH to "tell Hermes ..." or "note to Hermes ..." and the resulting message becomes part of Hermes\'s chat history. Hermes sees the appended turn on its next session-start.',
    parameters: {
      user: { type: 'string', description: 'User-role message to append (mutually exclusive with full).' },
      assistant: { type: 'string', description: 'Hermes-role message to append (optional; omit if user-only).' },
      full: { type: 'string', description: 'Full verbatim text block to append (e.g., a third-party note).' },
      source: { type: 'string', default: 'dsh', description: 'Provenance tag (default: "dsh"; arbitrary short string).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          ts: { type: 'string', required: true },
          total_turns: { type: 'integer', required: true },
          size: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute: (args) => {
      const path = inboxSessionPath()
      const dir = inboxDir()
      mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString()
      let turn
      if (typeof args.full === 'string' && args.full.length > 0) {
        turn = { ts, source: args.source || 'dsh', content: args.full }
      } else if (typeof args.user === 'string' || typeof args.assistant === 'string') {
        turn = { ts, source: args.source || 'dsh', user: args.user || null, assistant: args.assistant || null }
      } else {
        return { ok: false, path, ts: '', total_turns: 0, size: 0 }
      }
      const line = JSON.stringify(turn) + '\n'
      appendFileSync(path, line, 'utf8')
      // Also overwrite latest.md with the latest turn for fast back-compat reads.
      let latestContent
      if (turn.source === 'dsh' && turn.content) {
        latestContent = '<!-- appended by DSH -->\n' + turn.content
      } else if (turn.user || turn.assistant) {
        const lines = []
        if (turn.user)      lines.push('USER: ' + turn.user)
        if (turn.assistant) lines.push('---')
        if (turn.assistant) lines.push('HERMES: ' + turn.assistant)
        latestContent = lines.join('\n')
      } else {
        latestContent = '(empty)'
      }
      writeFileSync(inboxLatestPath(), latestContent, 'utf8')
      const raw = readText(path)
      const total = raw.split('\n').filter(Boolean).length
      return { ok: true, path, ts, total_turns: total, size: Buffer.byteLength(line, 'utf8') }
    },
  }))
  console.log('[hermes-link v0.2] tool registered: hermes_inbox_append')

  // -------------------------------------------------------------------------
  // hermes_clear_injected — audit-only tool for sessions that were
  // contaminated by the v0.7 / v0.2.0 automatic-injection path.
  //
  // v0.2.1 disables automatic injection (see index.mjs agent/session-start
  // hook), so going forward no new session will be polluted. Sessions that
  // were ALREADY polluted in their durable event log cannot be cleaned up
  // here — Session.events is append-only / deep-frozen in DSH. This tool
  // reports exactly how much contamination a session carries and points the
  // user at the only real fix (start a new session). It does not modify
  // state.
  //
  // exec: ToolRunContext — exec.agent is the live Agent that called the tool;
  // agent.session is the canonical durable session.
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'hermes_clear_injected',
    description: 'Audit-only: report any Hermes turns that were automatically injected into the current main session by hermes-foundation v0.7 or hermes-link v0.2.0. Returns counts and an honest pointer to "start a new session" — DSH Session.events are append-only / deep-frozen and cannot be retroactively edited, so the only way to drop injected events is a fresh session. This tool does NOT modify any state; automatic injection is already disabled as of hermes-link v0.2.1.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          session_id: { type: 'string' },
          agent_preset: { type: 'string' },
          delegation_depth: { type: 'integer' },
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              user_injected: { type: 'integer', required: true },
              assistant_injected: { type: 'integer', required: true },
              marker_found: { type: 'boolean', required: true },
            },
          },
          total_injected_events: { type: 'integer', required: true },
          note: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute(_args, exec) {
      const agent = exec && exec.agent
      if (!agent || !agent.session) {
        return {
          ok: false,
          session_id: null,
          agent_preset: null,
          delegation_depth: null,
          counts: { user_injected: 0, assistant_injected: 0, marker_found: false },
          total_injected_events: 0,
          note: 'no live agent/session available',
          suggestion: 'this tool only inspects the current main session; open a DSH session and try again',
        }
      }
      const events = agent.session.events
      const header = agent.session.header || {}
      let userInjected = 0
      let asstInjected = 0
      let markerFound = false
      for (const e of events) {
        if (!e) continue
        if (e.type === 'user/message'
          && e.data && typeof e.data.id === 'string'
          && e.data.id.startsWith('hermes-injected-')) {
          userInjected++
        } else if (e.type === 'assistant/message'
          && e.data && e.data.message && typeof e.data.message.id === 'string'
          && e.data.message.id.startsWith('hermes-injected-')) {
          asstInjected++
        } else if (e.type === 'compaction/start'
          && e.data && typeof e.data.reason === 'string'
          && e.data.reason.endsWith('hermes-inbox-injection-marker')) {
          markerFound = true
        }
      }
      const total = userInjected + asstInjected + (markerFound ? 1 : 0)
      return {
        ok: true,
        session_id: agent.session.id,
        agent_preset: header.agentPreset || null,
        delegation_depth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : null,
        counts: { user_injected: userInjected, assistant_injected: asstInjected, marker_found: markerFound },
        total_injected_events: total,
        note: 'DSH Session.events are append-only / deep-frozen; these events cannot be removed retroactively. Going forward, hermes-link v0.2.1+ no longer auto-injects on session-start, so a fresh session will not carry this contamination.',
        suggestion: 'open a New session in the DSH GUI; it will start without any injected Hermes turns.',
      }
    },
  }))
  console.log('[hermes-link v0.2.1] tool registered: hermes_clear_injected')
}

/** Health payload for GET /mcp/hermes-inbox/health (kept for hermes-push.mjs --status). */
export function inboxHealthPayload() {
  const latest = inboxLatestPath()
  let lastSize = 0
  let lastTs = null
  try {
    if (existsSync(latest)) {
      const st = statSync(latest)
      lastSize = st.size
      lastTs = st.mtime.toISOString()
    }
  } catch {}
  return {
    ok: true,
    version: '0.2.0',
    mode: 'file-based (hermes-link)',
    latest_path: latest,
    last_size: lastSize,
    last_ts: lastTs,
    inbox_dir: inboxDir(),
    session_log: inboxSessionPath(),
  }
}