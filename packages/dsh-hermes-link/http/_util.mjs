// http/_util.mjs
//
// v0.3.0 — shared HTTP utilities extracted during the dispatch.mjs refactor
// (E1). Centralizes the small functions that every split route file needs:
//
//   - mcpError / mcpResult   — JSON-RPC 2.0 envelope builders
//   - clampInt               — query-string int coercion with bounds
//   - truncate               — long-text elision (used in renderTurnsForContext)
//   - readAllStream          — UTF-8-safe request body reader (no chunk-boundary mojibake)
//   - sendJson               — write JSON response with explicit utf-8 charset
//   - send                   — write raw response
//
// In commit 2 (E9 — error codes) mcpError moves to services/error-codes.mjs
// to add the centralized ErrorCodes registry + error_code/hint in data.
// This file will then re-export from there to keep all callers unchanged.

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result } }

function mcpError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: Object.assign({ code, message }, data !== undefined ? { data } : {}) }
}

function clampInt(v, min, max, dflt) {
  if (v == null) return dflt
  const n = parseInt(v, 10)
  if (!Number.isInteger(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

function truncate(s, max) {
  if (s == null) return ''
  return s.length > max ? s.slice(0, max) + '\n…(' + (s.length - max) + ' chars truncated)' : s
}

function readAllStream(stream) {
  return new Promise((resolve, reject) => {
    if (stream == null) return resolve('')
    if (typeof stream === 'string') return resolve(stream)
    if (typeof stream.on !== 'function') return resolve('')
    // v0.2.3: accumulate raw Buffers and decode once — per-chunk c.toString()
    // corrupts multi-byte UTF-8 characters that straddle a chunk boundary
    // (observed as mojibake in CJK task payloads).
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

export { mcpError, mcpResult, clampInt, truncate, readAllStream, sendJson, send }
