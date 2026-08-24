// http/dispatch.mjs
//
// All HTTP routes for dsh-hermes-link (v0.2). Single file: one webServer.register
// call (one route block) instead of five. Routing is method+path dispatch.
//
//   POST /mcp/collab                 JSON-RPC 2.0 envelope
//                                    Methods: initialize, ping, tools/list,
//                                             tools/call dispatch_task,
//                                             tools/call dispatch_followup,
//                                             tools/call dispatch_interrupt,
//                                             tools/call dispatch_list,
//                                             tools/call dispatch_get,
//                                             tools/call get_dispatch
//   GET  /mcp/collab/health          Plain JSON liveness (never auth-gated)
//   GET  /mcp/collab/sessions        V1 list Hermes session archives (query: ?limit=N)
//   POST /mcp/collab/import          V2 import one Hermes session as a live DSH session
//   POST /mcp/collab/import-all      V2 import all (optional allowlist)
//   POST /mcp/collab/rename-all      V2 retitle live hermes-* sessions
//   GET  /mcp/collab/persona         V3 load Hermes persona/memory/config slices
//   POST /mcp/collab/consult         D2 ask Hermes a question (file-based, sync reply)
//   POST /mcp/collab/memory-suggest  D7 write a memory suggestion for Hermes
//
// v0.2 additions over v0.1:
//   • dispatch_task mode=continuable → durable child via ctx.subagents.startContinuable,
//     driven by dispatch_followup / dispatch_interrupt / dispatch_list / dispatch_get.
//   • One-shot dispatch reports real tokens via ctx.tokenMeter.measure.
//   • Audit log (D4) + usage records (D6) appended for every dispatch/consult.
//   • Bearer auth: when env HERMES_LINK_TOKEN is set, every /mcp/collab* route
//     (except /health) requires `Authorization: Bearer <token>`.
//   • Per-request consult timeout_ms is honored (bugfix).

import schema from '../dispatch-spec.schema.json' with { type: 'json' }
import { appendAudit, readAuditLines } from '../services/audit.mjs'
import { waitForNextReply } from '../services/continuations.mjs'
import { buildProjectMemorySlice } from '../services/hermes-project-memory.mjs'

const VERSION = '0.2.5'
const DEFAULT_MAX_TOKENS  = 4000
const DEFAULT_DEADLINE_MS = 60000
const PROVIDER_NAME       = 'spawn'
const DEFAULT_LLM_PROVIDER = 'deepseek-official'
const MODEL_BY_TIER = {
  flash:  'deepseek-v4-flash',
  pro:    'deepseek-v4-pro',
  vision: 'deepseek-v4-flash',
}
const BEARER_TOKEN = process.env.HERMES_LINK_TOKEN || ''

// -----------------------------------------------------------------------------
// Auth (P2-12): gate everything except /health when a token is configured.
// -----------------------------------------------------------------------------

function authFail(res) {
  return sendJson(res, 401, mcpError(null, -32001, 'unauthorized: missing or invalid Authorization: Bearer <token>'))
}

function checkAuth(req, res) {
  if (!BEARER_TOKEN) return null // no token configured → open
  const headers = (req && req.headers) || {}
  const h = headers.authorization || headers.Authorization || ''
  if (h === 'Bearer ' + BEARER_TOKEN) return null
  return authFail(res)
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export function register(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    console.error('[dsh-hermes-link] webServer unavailable; HTTP routes NOT registered')
    return
  }
  const {
    hermesHome, importer, personaLoader, consultClient, foundationSlice,
    continuations, outbox,
  } = deps

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      const method = (req && (req.method || req.Method)) || 'GET'
      let body = null
      if (method === 'POST') {
        const raw = await readAllStream(req)
        if (!raw) return sendJson(res, 400, mcpError(null, -32600, 'missing body'))
        try { body = JSON.parse(raw) }
        catch (e) { return sendJson(res, 400, mcpError(null, -32700, 'parse error: ' + e.message)) }
      } else if (method === 'GET') {
        body = { jsonrpc: '2.0', id: 0, method: 'ping' }
      } else {
        return sendJson(res, 405, mcpError(null, -32600, 'method not allowed: ' + method))
      }
      try {
        const out = await handleRpc(ctx, body, {
          hermesHome, importer, personaLoader, consultClient, foundationSlice,
          continuations, outbox,
        })
        if (out === null) return send(res, 204, '')
        return sendJson(res, 200, out)
      } catch (e) {
        return sendJson(res, 500, mcpError(body && body.id, -32603, 'internal: ' + (e && e.message || e)))
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/health',
    handler: async (_req, res) => sendJson(res, 200, {
      ok: true,
      version: VERSION,
      hermes_home: hermesHome,
      importer_ready: !!importer,
      persona_ready: !!personaLoader,
      consult_ready:  !!consultClient,
      continuable_registry: continuations ? 'on' : 'off',
      auth: BEARER_TOKEN ? 'bearer-required' : 'open',
      foundation_slice_chars: foundationSlice ? foundationSlice.length : 0,
      active_dispatchers: dispatcherCount(),
    }),
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/sessions',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!importer) return sendJson(res, 503, { error: 'importer not available' })
      const url = new URL(req.url || '/', 'http://localhost')
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200)
      const list = await importer.list({ limit })
      return sendJson(res, 200, { count: list.length, sessions: list })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/import',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!importer) return sendJson(res, 503, { error: 'importer not available' })
      const method = (req.method || req.Method || 'GET')
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const raw = await readAllStream(req)
      let body
      try { body = JSON.parse(raw || '{}') }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
      const hermesSessionId = body && body.hermesSessionId
      if (!hermesSessionId || typeof hermesSessionId !== 'string') {
        return sendJson(res, 400, { error: 'missing hermesSessionId' })
      }
      const workspace = (body && typeof body.workspace === 'string' && body.workspace.trim())
        ? body.workspace.trim() : undefined
      const result = await importer.importSession(hermesSessionId, { workspace })
      const status = result.status === 'created' || result.status === 'already_imported' ? 200
                   : result.status === 'not_found' ? 404
                   : 500
      appendAudit({ kind: 'import', hermesSessionId, status: result.status, ts: Date.now() })
      return sendJson(res, status, result)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/import-all',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!importer) return sendJson(res, 503, { error: 'importer not available' })
      const method = (req.method || req.Method || 'GET')
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const raw = await readAllStream(req)
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
      const only = Array.isArray(body.only) ? body.only.filter((x) => typeof x === 'string') : undefined
      const workspace = (body && typeof body.workspace === 'string' && body.workspace.trim())
        ? body.workspace.trim() : undefined
      const result = await importer.importAll({ only, workspace })
      appendAudit({ kind: 'import-all', imported: result.imported, skipped: result.skipped, failed: result.failed, ts: Date.now() })
      return sendJson(res, 200, result)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/rename-all',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!importer) return sendJson(res, 503, { error: 'importer not available' })
      const method = (req.method || req.Method || 'GET')
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      if (typeof importer.renameAll !== 'function') {
        return sendJson(res, 500, { error: 'renameAll not available (old importer loaded)' })
      }
      const result = await importer.renameAll()
      return sendJson(res, 200, result)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/persona',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!personaLoader) return sendJson(res, 503, { error: 'persona loader not available' })
      const url = new URL(req.url || '/', 'http://localhost')
      const scope = ['all','soul','memory','config'].includes(url.searchParams.get('scope'))
        ? url.searchParams.get('scope') : 'all'
      const out = personaLoader.loadPersona(hermesHome, { scope })
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-dsh-hermes-link-scope': scope,
        'x-dsh-hermes-link-parts': JSON.stringify(out.parts),
      })
      res.end(out.text)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/consult',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!consultClient) return sendJson(res, 503, { error: 'consult client not available' })
      const method = (req.method || req.Method || 'GET')
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const raw = await readAllStream(req)
      let body
      try { body = JSON.parse(raw || '{}') }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
      const prompt = body && body.prompt
      if (!prompt || typeof prompt !== 'string') {
        return sendJson(res, 400, { error: 'missing prompt' })
      }
      const ctxObj = body.context || {}
      const timeoutMs = clampInt(body.timeout_ms, 1000, 120000, 30000)
      const startedAt = Date.now()
      const result = await consultClient.consult(prompt, ctxObj, timeoutMs)
      const status = result.status === 'replied' ? 200
                   : result.status === 'pending' ? 202
                   : 500
      appendAudit({ kind: 'consult', status: result.status, ticket: result.ticket || null, elapsed_ms: Date.now() - startedAt, ts: Date.now() })
      if (outbox && result.status === 'replied') {
        outbox.appendUsage({ kind: 'consult', status: 'replied', ticket: result.ticket, elapsed_ms: Date.now() - startedAt })
      }
      return sendJson(res, status, result)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/memory-suggest',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!outbox) return sendJson(res, 503, { error: 'outbox not available' })
      const method = (req.method || req.Method || 'GET')
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const raw = await readAllStream(req)
      let body
      try { body = JSON.parse(raw || '{}') }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
      const text = body && body.text
      if (!text || typeof text !== 'string') {
        return sendJson(res, 400, { error: 'missing text' })
      }
      const result = outbox.writeMemorySuggestion({
        text,
        tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        context: body.context || undefined,
      })
      appendAudit({ kind: 'memory-suggest', ok: result.ok, ts: Date.now() })
      return sendJson(res, result.ok ? 200 : 500, result)
    },
  })

  console.log('[dsh-hermes-link v0.2] routes registered: /mcp/collab (+' +
    'followup/interrupt/list/get/get_dispatch)  /mcp/collab/health  /mcp/collab/sessions  ' +
    '/mcp/collab/import  /mcp/collab/import-all  /mcp/collab/persona  /mcp/collab/consult  /mcp/collab/memory-suggest')
}

// -----------------------------------------------------------------------------
// JSON-RPC dispatch handler
// -----------------------------------------------------------------------------

const dispatchers = new Map()

function dispatcherCount() { return dispatchers.size }

async function handleRpc(ctx, body, deps) {
  const id     = body && body.id
  const method = body && body.method
  const params = body && body.params

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-hermes-link', version: VERSION },
    })
  }
  if (method === 'ping') {
    return mcpResult(id, {
      ok: true,
      version: VERSION,
      hermes_home: deps.hermesHome,
      importer_ready: !!deps.importer,
      persona_ready: !!deps.personaLoader,
      consult_ready: !!deps.consultClient,
      continuable_registry: deps.continuations ? 'on' : 'off',
      active_dispatchers: dispatchers.size,
    })
  }
  if (method === 'notifications/initialized') {
    return null
  }
  if (method === 'tools/list') {
    return mcpResult(id, {
      tools: [
        {
          name: 'dispatch_task',
          description: 'Hermes-side entry: spawn a focused sub-agent. mode=one-shot returns the final result; mode=continuable returns child_id for ongoing followup.',
          inputSchema: {
            type: 'object',
            required: schema.required,
            additionalProperties: schema.additionalProperties,
            properties: schema.properties,
          },
        },
        {
          name: 'dispatch_followup',
          description: 'Send more content to a continuable child and await its next reply. Returns the reply text + token usage.',
          inputSchema: {
            type: 'object',
            required: ['child_id', 'content'],
            additionalProperties: false,
            properties: {
              child_id: { type: 'string', minLength: 1, maxLength: 128 },
              content: { type: 'array', minItems: 1, items: { type: 'object' } },
              deadline_ms: { type: 'integer', minimum: 1000, maximum: 600000, default: 60000 },
            },
          },
        },
        {
          name: 'dispatch_interrupt',
          description: 'Interrupt a continuable child. Idempotent. No-op if child already ended.',
          inputSchema: {
            type: 'object',
            required: ['child_id'],
            additionalProperties: false,
            properties: {
              child_id: { type: 'string', minLength: 1, maxLength: 128 },
              reason: { type: 'string', maxLength: 256 },
            },
          },
        },
        {
          name: 'dispatch_list',
          description: 'List known continuable children (SQLite-backed) with live-status augmentation.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          },
        },
        {
          name: 'dispatch_get',
          description: 'Read the live session event log for a child agent (in-process only).',
          inputSchema: {
            type: 'object',
            required: ['child_id'],
            additionalProperties: false,
            properties: {
              child_id: { type: 'string', minLength: 1, maxLength: 128 },
              since: { type: 'integer', minimum: 0, default: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 },
            },
          },
        },
        {
          name: 'dispatch_probe',
          description: 'Zero-cost tool-name probe: validates a skill/tool name against the live dsh global tool catalog without spawning an agent. Returns the full known-tools list on miss.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { skill: { type: 'string', minLength: 1, maxLength: 128, description: 'tool name to validate' } },
          },
        },
        {
          name: 'get_dispatch',
          description: 'Read the dsh-hermes-link audit log (last N entries, default 20).',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', default: 20, minimum: 1, maximum: 500 } },
          },
        },
      ],
    })
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'dispatch_task') {
      const out = await handleDispatchTask(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_probe') {
      // v0.2.3: zero-cost tool-catalog probe. Reads tools.view().restrictableNames
      // (read-only, no restriction layer is applied) so an orchestrator can
      // validate a skill/tool name before burning an LLM turn on dispatch_task.
      const probeName = args && typeof args.skill === 'string' && args.skill ? args.skill : ''
      if (!probeName) return mcpError(id, -32602, 'invalid spec: missing required field: skill')
      let names = null
      try {
        let view = null
        try { view = ctx.tools.view() } catch {}
        if ((!view || !view.restrictableNames) && ctx.tools.view) {
          try { view = ctx.tools.view({}) } catch {}
        }
        if (view && view.restrictableNames) names = [...view.restrictableNames].sort()
      } catch {}
      if (!names) {
        return mcpError(id, -32603, 'tool catalog unavailable: tools.view().restrictableNames not readable in this dsh build')
      }
      if (names.includes(probeName)) {
        return mcpResult(id, { content: [{ type: 'text', text: 'ok: tool "' + probeName + '" is known (' + names.length + ' global tools)' }] })
      }
      return mcpError(id, -32011,
        'unknown tool "' + probeName + '"; known global tools (' + names.length + '): ' + names.join(', '))
    }
    if (name === 'dispatch_followup') {
      const out = await handleDispatchFollowup(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_interrupt') {
      const out = await handleDispatchInterrupt(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_list') {
      const out = await handleDispatchList(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'dispatch_get') {
      const out = await handleDispatchGet(ctx, args, deps)
      if (out._error) return out._error
      return mcpResult(id, out)
    }
    if (name === 'get_dispatch') {
      const limit = Number(args.limit) || 20
      const lines = readAuditLines(limit)
      return mcpResult(id, { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }] })
    }
    return mcpError(id, -32601, 'unknown tool: ' + name)
  }
  return mcpError(id, -32601, 'unknown method: ' + method)
}

// -----------------------------------------------------------------------------
// dispatch_task
// -----------------------------------------------------------------------------

async function handleDispatchTask(ctx, args, deps) {
  const { consultClient, foundationSlice, continuations, outbox } = deps
  const err = validateSpec(args)
  if (err) return { _error: mcpError(null, -32602, 'invalid spec: ' + err) }

  const parent = pickParentAgent(ctx)
  if (!parent) {
    return { _error: mcpError(null, -32005, 'no live agent available; dsh session must be running to dispatch a task') }
  }

  const taskId = args.task_id
  if (dispatchers.has(taskId)) {
    return { _error: mcpError(null, -32004, 'duplicate task_id; already running: ' + taskId) }
  }
  dispatchers.set(taskId, { startedAt: Date.now(), status: 'running' })

  const model = MODEL_BY_TIER[args.model_tier || 'flash'] || MODEL_BY_TIER.flash
  const mode = args.mode === 'continuable' ? 'continuable' : 'one-shot'
  const provider = (args.provider === 'fork' || args.provider === 'spawn')
    ? args.provider
    : (mode === 'continuable' ? 'fork' : 'spawn')
  const sharedHistoryN = Number.isInteger(args.shared_history_n) ? args.shared_history_n : 0
  // v0.2.2 — cwd-scoped MEMORY.md is opt-in per dispatch. Defaults to off so
  // unrelated projects never receive another project's notes.
  const includeProjectMemory = args.include_project_memory === true
  const dshCwd = parent && parent.session && parent.session.header && parent.session.header.cwd
  let projectMemorySlice = ''
  if (includeProjectMemory && dshCwd && deps.hermesHome) {
    try { projectMemorySlice = await buildProjectMemorySlice(deps.hermesHome, dshCwd) || '' }
    catch (e) { projectMemorySlice = '' }
  }
  const persona = formatPersona(args, foundationSlice || '', {
    mode, provider, sharedHistoryN, parent, ctx,
    projectMemorySlice,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('deadline_ms exceeded')),
    args.deadline_ms || DEFAULT_DEADLINE_MS)
  const startedAt = Date.now()

  appendAudit({
    ts: new Date(startedAt).toISOString(),
    status: 'queued',
    task_id: taskId,
    skill: args.skill,
    model_tier: args.model_tier || 'flash',
    model,
    mode,
    provider,
    parent_agent_id: parent.id,
    deadline_ms: args.deadline_ms || DEFAULT_DEADLINE_MS,
  })

  // ----- continuable path -----
  if (mode === 'continuable') {
    try {
      const spawnResult = await ctx.subagents.startContinuable({
        provider,
        label: 'dsh-hermes-link:' + taskId,
        signal: controller.signal,
        request: {
          label: 'dsh-hermes-link:' + taskId,
          prompt: [{ type: 'text', text: args.task }],
          parent,
          signal: controller.signal,
          toolFilter: { allow: [args.skill] },
          persona,
          agentOptions: {
            provider: DEFAULT_LLM_PROVIDER,
            model,
            maxTokens: args.max_tokens || DEFAULT_MAX_TOKENS,
          },
          maxDepth: 1,
        },
      })
      const childId = String(spawnResult.childId)
      const workspace = (parent.session && parent.session.header && parent.session.header.cwd) || ''
      let amendNonce = ''
      if (continuations) {
        const entry = {
          child_id: childId,
          task_id: taskId,
          parent_agent_id: parent.id,
          workspace,
          model,
          model_tier: args.model_tier || 'flash',
          skill: args.skill,
          created_at: startedAt,
          last_seen: startedAt,
          status: 'started',
          stop_reason: null,
          mode,
          initialSpec: args,
        }
        continuations.register(entry)
        const reg = continuations.get(childId)
        amendNonce = (reg && reg.amendNonce) || ''
      }
      clearTimeout(timer)
      appendAudit({
        ts: new Date().toISOString(),
        status: 'continuable_started',
        task_id: taskId,
        child_id: childId,
        parent_agent_id: parent.id,
        model,
        skill: args.skill,
      })
      const amendFileName = amendNonce
        ? 'Use filename pattern: <ts>-' + taskId + '-' + amendNonce + '.json when writing the amend file (v0.2.2+ nonce-authenticated protocol).'
        : '(warning: amend nonce unavailable; amend files will be rejected until the child is re-registered)'
      return {
        content: [{
          type: 'text',
          text: [
            '[dsh-hermes-link v' + VERSION + '] continuable child_id=' + childId,
            'task_id=' + taskId + '  skill=' + args.skill + '  model=' + model,
            'parent_agent_id=' + parent.id,
            'message_id=' + String(spawnResult.messageId),
            '',
            'To continue: dispatch_followup { child_id: "' + childId + '", content: [...] }',
            'To abort: dispatch_interrupt { child_id: "' + childId + '" }',
            amendFileName,
          ].join('\n'),
        }],
        metadata: {
          v0_2_status: 'continuable_started',
          task_id: taskId,
          child_id: childId,
          message_id: String(spawnResult.messageId),
          parent_agent_id: parent.id,
          mode,
          amend_nonce: amendNonce,
          amend_filename_pattern: amendNonce ? ('<ts>-' + taskId + '-' + amendNonce + '.json') : null,
        },
      }
    } catch (e) {
      clearTimeout(timer)
      dispatchers.set(taskId, { startedAt, finishedAt: Date.now(), status: 'error' })
      setTimeout(() => dispatchers.delete(taskId), 60_000)
      appendAudit({
        ts: new Date().toISOString(),
        status: 'error',
        stage: 'continuable_spawn',
        task_id: taskId,
        error: String(e && e.message || e),
      })
      return { _error: mcpError(null, -32010, 'continuable spawn failed: ' + (e && e.message || e)) }
    }
  }

  // ----- one-shot path -----
  let runResult, error, run
  try {
    run = await ctx.subagents.start(PROVIDER_NAME, {
      label: 'dsh-hermes-link:' + taskId,
      prompt: [{ type: 'text', text: args.task }],
      parent,
      signal: controller.signal,
      toolFilter: { allow: [args.skill] },
      persona,
      agentOptions: { provider: DEFAULT_LLM_PROVIDER, model, maxTokens: args.max_tokens || DEFAULT_MAX_TOKENS },
      maxDepth: 1,
    })
    runResult = await run.result
  } catch (e) {
    error = e
  }
  clearTimeout(timer)
  const finishedAt = Date.now()

  let realTokens = null
  if (run) {
    if (!error) realTokens = measureRealTokens(ctx, run.localAgent)
    try { await run.dispose() } catch {}
  }

  dispatchers.set(taskId, { startedAt, finishedAt, status: error ? 'error' : 'completed' })
  setTimeout(() => dispatchers.delete(taskId), 60_000)  // GC after 60s

  const outputText = error ? '' : extractOutputText(runResult && runResult.output)
  const stopReason = error ? 'error' : ((runResult && runResult.stopReason) || 'completed')
  appendAudit({
    ts: new Date(finishedAt).toISOString(),
    status: error ? 'error' : stopReason,
    task_id: taskId,
    skill: args.skill,
    model,
    mode: 'one-shot',
    elapsed_ms: finishedAt - startedAt,
    parent_agent_id: parent.id,
    subagent_session_id: run ? run.id : null,
    output_chars: outputText.length,
    real_tokens: realTokens,
  })

  // Push result to Hermes via file-based channel (D1) + usage record (D6).
  let d1Status = 'skipped'
  if (consultClient) {
    try {
      consultClient.writeResult({
        task_id: taskId,
        status: error ? 'error' : 'ok',
        output: outputText,
        tokens_used: realTokens ? realTokens.total_tokens : null,
        error: error ? String(error && error.message || error) : undefined,
        elapsed_ms: finishedAt - startedAt,
      })
      d1Status = 'written'
    } catch (e) {
      d1Status = 'failed: ' + (e && e.message || e)
    }
  }
  if (outbox) {
    outbox.appendUsage({
      kind: 'dispatch',
      mode: 'one-shot',
      task_id: taskId,
      status: error ? 'error' : 'ok',
      stop_reason: stopReason,
      elapsed_ms: finishedAt - startedAt,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      model,
      skill: args.skill,
    })
  }

  if (error) {
    return { _error: mcpError(null, -32011, 'dispatch failed: ' + (error && error.message || error),
      { task_id: taskId, elapsed_ms: finishedAt - startedAt, d1: d1Status }) }
  }
  return {
    content: [{
      type: 'text',
      text: [
        '[dsh-hermes-link v' + VERSION + '] task_id=' + taskId,
        'skill=' + args.skill + '  model=' + model + '  mode=one-shot',
        'elapsed_ms=' + (finishedAt - startedAt) + '  stop_reason=' + stopReason,
        realTokens ? 'real_tokens: total=' + realTokens.total_tokens + ' surface=' + realTokens.surface_tokens : 'real_tokens: (unavailable)',
        'd1_status=' + d1Status,
        '',
        '--- output ---',
        outputText || '(empty)',
      ].join('\n'),
    }],
    metadata: {
      task_id: taskId,
      status: stopReason,
      elapsed_ms: finishedAt - startedAt,
      d1: d1Status,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      real_tokens: realTokens,
    },
  }
}

// -----------------------------------------------------------------------------
// dispatch_followup / dispatch_interrupt / dispatch_list / dispatch_get
// -----------------------------------------------------------------------------

async function handleDispatchFollowup(ctx, args, deps) {
  const { continuations, outbox } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, -32602, 'invalid spec: child_id required') }
  const entry = continuations ? continuations.get(childId) : null
  if (!entry) return { _error: mcpError(null, -32012, 'unknown child_id; not in registry') }
  if (!Array.isArray(args.content) || args.content.length === 0) {
    return { _error: mcpError(null, -32602, 'invalid spec: content (ContentBlock[]) required') }
  }
  const liveParent = ctx.agents.get(entry.parent_agent_id) || pickParentAgent(ctx)
  if (!liveParent) return { _error: mcpError(null, -32005, 'no live parent agent available for followup') }

  const deadlineMs = Number.isInteger(args.deadline_ms) ? args.deadline_ms : 60000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('deadline_ms exceeded')), deadlineMs)
  const startedAt = Date.now()

  let messageId
  try {
    messageId = await ctx.subagents.followup(liveParent, childId, args.content, {
      signal: controller.signal,
      source: { kind: 'user' },
    })
  } catch (e) {
    clearTimeout(timer)
    return { _error: mcpError(null, -32010, 'followup submit failed: ' + (e && e.message || e)) }
  }

  const reloadedAgent = ctx.agents.get(childId)
  const beforeSeq = reloadedAgent ? reloadedAgent.session.seq : 0

  let reply
  try {
    reply = await waitForNextReply(ctx, childId, beforeSeq, controller.signal)
  } catch (e) {
    clearTimeout(timer)
    if (continuations) continuations.update(childId, { status: 'timeout', stop_reason: 'followup_deadline' })
    return { _error: mcpError(null, -32011, 'followup wait failed: ' + (e && e.message || e), { message_id: String(messageId) }) }
  }

  clearTimeout(timer)
  const finishedAt = Date.now()
  const finalAgent = ctx.agents.get(childId) || reloadedAgent
  const outputText = extractOutputText(reply.assistant_content)
  const realTokens = measureRealTokens(ctx, finalAgent)
  if (continuations) continuations.update(childId, { status: 'idle', stop_reason: 'awaiting_next' })

  appendAudit({
    ts: new Date(finishedAt).toISOString(),
    status: 'followup_completed',
    child_id: childId,
    task_id: entry.task_id,
    parent_agent_id: entry.parent_agent_id,
    message_id: String(messageId),
    elapsed_ms: finishedAt - startedAt,
    output_chars: outputText.length,
    real_tokens: realTokens,
  })
  if (outbox) {
    outbox.appendUsage({
      kind: 'dispatch',
      mode: 'continuable',
      task_id: entry.task_id,
      child_id: childId,
      status: 'ok',
      elapsed_ms: finishedAt - startedAt,
      tokens_used: realTokens ? realTokens.total_tokens : null,
      model: entry.model,
      skill: entry.skill,
    })
  }

  return {
    content: [{
      type: 'text',
      text: [
        '[dsh-hermes-link v' + VERSION + '] followup child_id=' + childId,
        'message_id=' + String(messageId),
        'elapsed_ms=' + (finishedAt - startedAt),
        realTokens ? 'real_tokens: total=' + realTokens.total_tokens : 'real_tokens: (unavailable)',
        '',
        '--- output ---',
        outputText || '(empty)',
      ].join('\n'),
    }],
    metadata: {
      v0_2_status: 'followup_completed',
      child_id: childId,
      task_id: entry.task_id,
      message_id: String(messageId),
      elapsed_ms: finishedAt - startedAt,
      real_tokens: realTokens,
    },
  }
}

async function handleDispatchInterrupt(ctx, args, deps) {
  const { continuations } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, -32602, 'invalid spec: child_id required') }
  const entry = continuations ? continuations.get(childId) : null
  if (!entry) return { _error: mcpError(null, -32012, 'unknown child_id') }
  const agent = ctx.agents.get(childId)
  if (!agent) {
    if (continuations) continuations.update(childId, { status: 'orphan', stop_reason: 'interrupted_not_live' })
    return { content: [{ type: 'text', text: 'child_id=' + childId + ' was not live; marked orphan' }] }
  }
  const parent = ctx.agents.get(entry.parent_agent_id) || pickParentAgent(ctx)
  try {
    ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
  } catch (e) {
    return { _error: mcpError(null, -32010, 'interrupt failed: ' + (e && e.message || e)) }
  }
  if (continuations) continuations.update(childId, { status: 'interrupted', stop_reason: 'interrupt_requested' })
  appendAudit({
    ts: new Date().toISOString(),
    status: 'interrupted',
    child_id: childId,
    task_id: entry.task_id,
    reason: args.reason || '(no reason)',
  })
  return {
    content: [{ type: 'text', text: 'interrupted child_id=' + childId + (args.reason ? ' reason=' + args.reason : '') }],
    metadata: { v0_2_status: 'interrupted', child_id: childId },
  }
}

async function handleDispatchList(ctx, args, deps) {
  const { continuations } = deps
  if (!continuations) return { _error: mcpError(null, -32012, 'continuation registry not available') }
  const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 200) : 50
  const rows = continuations.list({ limit })
  const enriched = rows.map((r) => ({
    ...r,
    is_live: ctx.agents.get(r.child_id) ? true : false,
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: enriched.length, children: enriched }, null, 2) }],
    metadata: { v0_2_status: 'list_ok', count: enriched.length },
  }
}

async function handleDispatchGet(ctx, args, deps) {
  const { continuations } = deps
  const childId = args.child_id
  if (!childId) return { _error: mcpError(null, -32602, 'invalid spec: child_id required' ) }
  const entry = continuations ? continuations.get(childId) : null
  const agent = ctx.agents.get(childId)
  if (!agent) {
    return { _error: mcpError(null, -32012, 'child agent not live in current dsh session; dispatch_list shows persisted metadata') }
  }
  const events = agent.session.events
  const since = Number.isInteger(args.since) ? Math.max(0, args.since) : 0
  const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 1000) : events.length
  const tail = events.slice(since, since + limit)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        child_id: childId,
        task_id: entry ? entry.task_id : null,
        parent_agent_id: entry ? entry.parent_agent_id : null,
        session_id: agent.session.id,
        total_events: events.length,
        returned: tail.length,
        events: tail,
      }, null, 2),
    }],
    metadata: { v0_2_status: 'get_ok', child_id: childId, total_events: events.length, returned: tail.length },
  }
}

// -----------------------------------------------------------------------------
// Validation + persona formatting + token measurement (shared helpers)
// -----------------------------------------------------------------------------

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be a JSON object'
  for (const k of schema.required) {
    if (spec[k] === undefined || spec[k] === null) return 'missing required field: ' + k
  }
  for (const [k, def] of Object.entries(schema.properties)) {
    const v = spec[k]
    if (v === undefined) continue
    if (def.type === 'string') {
      if (typeof v !== 'string') return k + ' must be string'
      if (def.minLength != null && v.length < def.minLength) return k + ' shorter than minLength=' + def.minLength
      if (def.maxLength != null && v.length > def.maxLength) return k + ' longer than maxLength=' + def.maxLength
      if (def.enum && !def.enum.includes(v)) return k + ' must be one of ' + def.enum.join(',')
    } else if (def.type === 'integer') {
      if (!Number.isInteger(v)) return k + ' must be integer'
      if (def.minimum != null && v < def.minimum) return k + ' too small'
      if (def.maximum != null && v > def.maximum) return k + ' too large'
    } else if (def.type === 'array') {
      if (!Array.isArray(v)) return k + ' must be array'
      if (def.maxItems != null && v.length > def.maxItems) return k + ' has more than ' + def.maxItems + ' items'
      // Shallow item validation for closed item schemas (additionalProperties=false).
      const items = def.items
      if (items && typeof items === 'object') {
        const allowed = items.additionalProperties === false ? new Set(Object.keys(items.properties || {})) : null
        for (const item of v) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return k + ' items must be objects'
          }
          if (allowed) {
            for (const ik of Object.keys(item)) {
              if (!allowed.has(ik)) return k + ' item has unknown field: ' + ik
            }
          }
        }
      }
    } else if (def.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return k + ' must be object'
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const k of Object.keys(spec)) {
      if (!allowed.has(k)) return 'unknown field at top level: ' + k
    }
  }
  return null
}

export function formatPersona(args, foundationSlice, opts = {}) {
  const knowledgeLines = []
  for (const k of (args.knowledge_subset || [])) {
    knowledgeLines.push('  - source: ' + k.source)
    if (k.scope)   knowledgeLines.push('    scope: ' + k.scope)
    if (k.excerpt) knowledgeLines.push('    excerpt: ' + k.excerpt)
    if (k.why)     knowledgeLines.push('    why: ' + k.why)
  }
  const mode = opts.mode || 'one-shot'
  const provider = opts.provider || 'spawn'
  const sharedHistoryN = opts.sharedHistoryN || 0
  const projectMemorySlice = opts.projectMemorySlice || ''
  const parent = opts.parent
  const ctx = opts.ctx
  let sharedHistoryBlock = ''
  if (sharedHistoryN > 0 && parent && ctx) {
    const turns = extractRecentParentTurns(parent, sharedHistoryN)
    const rendered = renderTurnsForContext(turns)
    if (rendered) sharedHistoryBlock = rendered
  }
  return [
    'You are a Hermes-dispatched sub-agent. The orchestrator (Hermes) sent you to do ONE focused task.',
    'Stay narrow; do not delegate; do not invent state outside the task.',
    '',
    '--- hermes-foundation (auto-injected, SOUL only since v0.2.2) ---',
    foundationSlice || '(empty)',
    '--- end hermes-foundation ---',
    projectMemorySlice ? '' : '',
    projectMemorySlice ? '--- hermes project-memory (cwd-scoped, opt-in per dispatch_task) ---' : '',
    projectMemorySlice ? projectMemorySlice : '',
    projectMemorySlice ? '--- end hermes project-memory ---' : '',
    '',
    '--- task envelope (from Hermes) ---',
    'task_id: ' + args.task_id,
    'skill: ' + args.skill,
    'task: ' + args.task,
    'args: ' + JSON.stringify(args.args || {}),
    'model_tier: ' + (args.model_tier || 'flash'),
    'mode: ' + mode,
    'provider: ' + provider,
    sharedHistoryN > 0 ? 'shared_history_n: ' + sharedHistoryN : '',
    'knowledge_subset:',
    knowledgeLines.length ? knowledgeLines.join('\n') : '  (none)',
    '--- end task envelope ---',
    sharedHistoryBlock ? '--- parent shared history (last ' + sharedHistoryN + ' turns) ---' : '',
    sharedHistoryBlock ? sharedHistoryBlock : '',
    sharedHistoryBlock ? '--- end parent shared history ---' : '',
    '',
    'Output: complete the task using the single tool attached to your context (' + args.skill + ').',
    'Return a concise, structured summary; Hermes will relay it to the user.',
    'Do NOT call tools beyond the one allowed tool. Do NOT spawn further sub-agents.',
    '',
    '--- encoding rules (v0.2.3) ---',
    '- The task text is UTF-8. If any CJK text looks garbled (mojibake like \u00ef\u00bf\u00bd or \u00b1\u00c4\u00d0\u00d0), do NOT guess-reconstruct it: quote the raw text verbatim in your output and state that it arrived corrupted.',
    '- Copy any user-provided sentinel strings, IDs, and quoted content into tool arguments VERBATIM — never paraphrase, translate, or "fix" them.',
  ].join('\n')
}

export function extractRecentParentTurns(parent, n) {
  if (!n || n <= 0) return []
  if (!parent || !parent.session || !Array.isArray(parent.session.events)) return []
  const events = parent.session.events
  const turns = []
  let lastTurnEnd = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.type === 'turn/end') {
      if (lastTurnEnd !== null) {
        const slice = events.slice(i + 1, lastTurnEnd + 1)
        if (slice.length > 0) turns.unshift(slice)
      }
      lastTurnEnd = i
      if (turns.length >= n) break
    }
  }
  if (turns.length < n && lastTurnEnd !== null) {
    const slice = events.slice(0, lastTurnEnd + 1)
    if (slice.length > 0) turns.unshift(slice)
  }
  return turns
}

export function renderTurnsForContext(turns) {
  const lines = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    lines.push('--- parent turn ' + (i + 1) + ' ---')
    for (const e of turn) {
      if (!e) continue
      if (e.type === 'user/message' && e.data && e.data.message && Array.isArray(e.data.message.content)) {
        const text = e.data.message.content
          .map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
          .filter(Boolean).join(' ')
        if (text) lines.push('USER: ' + truncate(text, 2000))
      } else if (e.type === 'assistant/message' && e.data && e.data.message && Array.isArray(e.data.message.content)) {
        const text = e.data.message.content
          .map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
          .filter(Boolean).join(' ')
        if (text) lines.push('ASSISTANT: ' + truncate(text, 2000))
      } else if (e.type === 'tool-result' && e.data && e.data.isError) {
        lines.push('TOOL_ERROR: ' + truncate(JSON.stringify(e.data.content), 300))
      }
    }
  }
  return lines.join('\n')
}

export function measureRealTokens(ctx, agent) {
  try {
    if (agent && ctx.tokenMeter) {
      const m = ctx.tokenMeter.measure(agent.session)
      return {
        total_tokens: m.totalTokens,
        surface_tokens: m.surfaceTokens,
        projected_tokens: m.projectedTokens,
        pressure_tokens: m.pressureTokens,
        baseline: m.baseline,
      }
    }
  } catch (e) {
    return { error: 'measure failed: ' + (e && e.message || e) }
  }
  return null
}

export function extractOutputText(content) {
  const parts = []
  for (const block of content || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block && block.type === 'reasoning' && typeof block.text === 'string') parts.push('> ' + block.text)
  }
  return parts.join('\n').trim()
}

export function pickParentAgent(ctx) {
  const roots = ctx.agents && ctx.agents.roots && ctx.agents.roots()
  if (roots && roots.length > 0) return roots[0]
  const all = ctx.agents && ctx.agents.list && ctx.agents.list()
  if (all && all.length > 0) return all[0]
  return null
}

function truncate(s, max) {
  if (s == null) return ''
  return s.length > max ? s.slice(0, max) + '\n…(' + (s.length - max) + ' chars truncated)' : s
}

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result } }
function mcpError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: Object.assign({ code, message }, data !== undefined ? { data } : {}) }
}

export function clampInt(v, min, max, dflt) {
  if (v == null) return dflt
  const n = parseInt(v, 10)
  if (!Number.isInteger(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

function readAllStream(stream) {
  return new Promise((resolve, reject) => {
    if (stream == null) return resolve('')
    if (typeof stream === 'string') return resolve(stream)
    if (typeof stream.on !== 'function') return resolve('')
    // v0.2.3: accumulate raw Buffers and decode once — per-chunk
    // c.toString() corrupts multi-byte UTF-8 characters that straddle a
    // chunk boundary (observed as mojibake in CJK task payloads).
    const chunks = []
    stream.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c))
    stream.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  // v0.3 charset pin: some clients infer windows-1252 without an explicit
  // charset, garbling CJK responses.
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
}

function send(res, status, body) {
  res.writeHead(status, {})
  res.end(body)
}