// http/dispatch.mjs
//
// v0.3.0 - SLIM entry point after E1 refactor. Wires:
//   - auth (Bearer) 闂?gate everything except /health when HERMES_LINK_TOKEN is set
//   - health endpoint
//   - REST routes (/sessions /import /import-all /rename-all /persona /consult /memory-suggest)
//   - JSON-RPC dispatcher (delegates to jsonrpc-handlers.mjs)
//   - re-exports of the public API for backward compatibility (tests, external)
//
// The heavy lifting lives in:
//   - jsonrpc-handlers.mjs   闂?JSON-RPC 2.0 dispatch (initialize, tools/list, tools/call)
//   - dispatch-task.mjs      闂?dispatch_task + validateSpec + formatPersona + helpers
//   - dispatch-control.mjs   闂?dispatch_followup / interrupt / list / get
//   - _util.mjs              闂?mcpError / mcpResult / clampInt / readAllStream / send*

import { appendAudit, readAuditLines } from '../services/audit.mjs'


import { mcpError, mcpResult, clampInt, readAllStream, sendJson, send } from './_util.mjs'
import { handleRpc } from './jsonrpc-handlers.mjs'
import {
  handleDispatchTask,
  dispatcherCount,
  validateSpec,
  formatPersona,
  extractOutputText,
  measureRealTokens,
  extractRecentParentTurns,
  renderTurnsForContext,
  pickParentAgent,
} from './dispatch-task.mjs'

export const VERSION = '0.5.0'
const BEARER_TOKEN = process.env.HERMES_LINK_TOKEN || ''

// Re-exports for backward compat (tests / external consumers).
export {
  handleDispatchTask,
  dispatcherCount,
  validateSpec,
  formatPersona,
  extractOutputText,
  measureRealTokens,
  extractRecentParentTurns,
  renderTurnsForContext,
  pickParentAgent,
  clampInt,
}
export { mcpError, mcpResult, readAllStream, sendJson, send } from './_util.mjs'

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

function authFail(res) {
  return sendJson(res, 401, mcpError(null, 'E_AUTH_REQUIRED', 'unauthorized: missing or invalid Authorization: Bearer <token>'))
}

function checkAuth(req, res) {
  if (!BEARER_TOKEN) return null
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
  // v0.3.0 F1 - SSE sseBroker is created in index.mjs and passed via deps
  // (so amend-watcher.mjs can share the same singleton via globalThis).
  const sseBroker = deps.sseBroker
  const { hermesHome, importer, personaLoader, consultClient, foundationSlice, sessionMirror } = deps

  // 1. JSON-RPC envelope (POST /mcp/collab) 闂?delegates to jsonrpc-handlers.mjs.
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
        if (!raw) return sendJson(res, 400, mcpError(null, 'E_INVALID_REQUEST', 'missing body'))
        try { body = JSON.parse(raw) }
        catch (e) { return sendJson(res, 400, mcpError(null, 'E_PARSE_ERROR', 'parse error: ' + e.message)) }
      } else if (method === 'GET') {
        body = { jsonrpc: '2.0', id: 0, method: 'ping' }
      } else {
        return sendJson(res, 405, mcpError(null, 'E_INVALID_REQUEST', 'method not allowed: ' + method))
      }
      try {
        const out = await handleRpc(ctx, body, {
          ...deps,
          dispatcherCount,
        })
        if (out === null) return send(res, 204, '')
        return sendJson(res, 200, out)
      } catch (e) {
        return sendJson(res, 500, mcpError(body && body.id, 'E_INTERNAL', 'internal: ' + (e && e.message || e)))
      }
    },
  })

  // 2. Health endpoint 闂?never auth-gated.
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/health',
    handler: async (_req, res) => sendJson(res, 200, {
      ok: true,
      version: VERSION,
      hermes_home: hermesHome,
      importer_ready: !!importer,
      persona_ready: !!personaLoader,
      consult_ready: !!consultClient,
      continuable_registry: deps.continuations ? 'on' : 'off',
      auth: BEARER_TOKEN ? 'bearer-required' : 'open',
      foundation_slice_chars: foundationSlice ? foundationSlice.length : 0,
      active_dispatchers: dispatcherCount(),
      sse_broker: sseBroker ? sseBroker.stats() : null,
    }),
  })

  // 2b-prime. v0.3.2 F6 - Prometheus metrics endpoint (text exposition format v0.0.4)
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/metrics',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
      const m = deps.metrics
      if (!m) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('# metrics registry not initialized\n')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(m.serialize())
    },
  })

    // 2b. SSE stream (v0.3.0 F1) - real-time event feed for a continuable task.
  //     Bearer-auth same as other routes; ?task_id= required, ?since_seq replay,
  //     ?timeout_ms optional auto-close.
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/stream',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!sseBroker) return sendJson(res, 503, mcpError(null, 'E_INTERNAL', 'sse broker not initialized'))
      const url = new URL(req.url || '/', 'http://localhost')
      const taskId = url.searchParams.get('task_id')
      if (!taskId) return sendJson(res, 400, mcpError(null, 'E_INVALID_SPEC', 'missing task_id'))
      const rawSince  = url.searchParams.get('since_seq')
      const sinceSeq  = rawSince === null ? -1 : clampInt(rawSince, 0, 1e9, 0)
      const timeoutMs = clampInt(url.searchParams.get('timeout_ms'), 0, 600000, 0)
      // subscribe() writes headers + handles the response. It returns null if
      // task is not found (already wrote not_found event + closed).
      const sub = sseBroker.subscribe(taskId, res, { sinceSeq, timeoutMs })
      if (sub === null) return
      return undefined
    },
  })
// 2b2. v0.4.0 - SSE stream for a DSH session mirror.
  //     Hermes (or any client) can subscribe to real-time DSH session events
  //     that are being mirrored to Hermes Home/inbox/dsh/session-mirror/.
  //     Bearer-auth same as other routes; ?session_id= required, ?since_seq
  //     replay, ?timeout_ms optional auto-close.
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/session-stream',
    handler: async (req, res) => {
      const denied = checkAuth(req, res)
      if (denied) return denied
      if (!sseBroker) return sendJson(res, 503, mcpError(null, 'E_INTERNAL', 'sse broker not initialized'))
      const url = new URL(req.url || '/', 'http://localhost')
      const sessionId = url.searchParams.get('session_id')
      if (!sessionId) return sendJson(res, 400, mcpError(null, 'E_INVALID_SPEC', 'missing session_id'))
      const safeId = sessionMirror && sessionMirror.status ? sessionMirror.status(sessionId).safe_session_id : sessionId
      const channel = `session:${safeId}`
      if (!sseBroker.isAttached(channel)) {
        sseBroker.attachTask(channel, { kind: 'session-mirror', session_id: sessionId, attached_at: Date.now() })
      }
      const rawSince  = url.searchParams.get('since_seq')
      const sinceSeq  = rawSince === null ? -1 : clampInt(rawSince, 0, 1e9, 0)
      const timeoutMs = clampInt(url.searchParams.get('timeout_ms'), 0, 600000, 0)
      const sub = sseBroker.subscribe(channel, res, { sinceSeq, timeoutMs })
      if (sub === null) return
      return undefined
    },
  })

  // 2c. dispatch_subscribe JSON-RPC helper - returns the SSE URL for clients
  //     that prefer JSON-RPC discovery over a raw GET.
  //     (The real stream lives at /mcp/collab/stream - this just describes it.)

  // 3. /mcp/collab/sessions 闂?list Hermes archives
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/sessions',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
      if (!importer) return sendJson(res, 503, { error: 'importer not available' })
      const url = new URL(req.url || '/', 'http://localhost')
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200)
      const list = await importer.list({ limit })
      return sendJson(res, 200, {
        count: list.length,
        sessions: list.map((s) => ({
          ...s,
          // v0.4.0: if this Hermes session was imported as a DSH session
          // (`hermes-<id>`), its mirrored-back state is shown here.
          mirror_status: sessionMirror ? sessionMirror.status('hermes-' + s.session_id) : null,
        })),
      })
    },
  })
// 3b. v0.4.0 - session-mirror status (one by ?session_id=, or all enabled)
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/session-mirror/status',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
      if (!sessionMirror) return sendJson(res, 503, { error: 'session mirror service not available' })
      const url = new URL(req.url || '/', 'http://localhost')
      const sessionId = url.searchParams.get('session_id')
      if (sessionId) return sendJson(res, 200, sessionMirror.status(sessionId))
      const sessions = sessionMirror.listStatus()
      return sendJson(res, 200, { count: sessions.length, sessions })
    },
  })

  // 4. /mcp/collab/import 闂?import one Hermes session as a live DSH session
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/import',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
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
      if (deps.metrics) deps.metrics.inc('hermes_link_import_total', { status: result.status })
      appendAudit({ kind: 'import', hermesSessionId, status: result.status, ts: Date.now() })
      return sendJson(res, status, result)
    },
  })

  // 5. /mcp/collab/import-all
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/import-all',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
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

  // 6. /mcp/collab/rename-all
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/rename-all',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
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

  // 7. /mcp/collab/persona
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/persona',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
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

  // 8. /mcp/collab/consult
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/consult',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
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
      if (deps.metrics) deps.metrics.inc('hermes_link_consult_total', { status: result.status })
      appendAudit({ kind: 'consult', status: result.status, ticket: result.ticket || null, elapsed_ms: Date.now() - startedAt, ts: Date.now() })
      if (deps.outbox && result.status === 'replied') {
        deps.outbox.appendUsage({ kind: 'consult', status: 'replied', ticket: result.ticket, elapsed_ms: Date.now() - startedAt })
      }
      return sendJson(res, status, result)
    },
  })

  // 9. /mcp/collab/memory-suggest
  webServer.register({
    kind: 'exact',
    path: '/mcp/collab/memory-suggest',
    handler: async (req, res) => {
      const denied = checkAuth(req, res); if (denied) return denied
      if (!deps.outbox) return sendJson(res, 503, { error: 'outbox not available' })
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
      const result = deps.outbox.writeMemorySuggestion({
        text,
        tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        context: body.context || undefined,
      })
      appendAudit({ kind: 'memory-suggest', ok: result.ok, ts: Date.now() })
      return sendJson(res, result.ok ? 200 : 500, result)
    },
  })

  console.log('[dsh-hermes-link v' + VERSION + '] routes registered: /mcp/collab (+followup/interrupt/list/get/probe)  /mcp/collab/health  /mcp/collab/sessions  /mcp/collab/session-stream  /mcp/collab/session-mirror/status  /mcp/collab/import  /mcp/collab/import-all  /mcp/collab/persona  /mcp/collab/consult  /mcp/collab/memory-suggest')
}

