// http/_util.mjs
//
// v0.3.0 - shared HTTP utilities extracted during the dispatch.mjs refactor
// (E1). mcpError / mcpResult now live in services/error-codes.mjs (E9) - this
// file re-exports them so existing callers (`import { mcpError } from './_util.mjs'`)
// keep working unchanged. The thin shim also keeps clampInt / truncate /
// readAllStream / sendJson / send which are HTTP-only plumbing.

// mcpError + mcpResult are now sourced from the centralized error-codes
// registry; re-export so older `import { mcpError } from './_util.mjs'` paths
// continue to resolve.
export { mcpError, mcpResult, ErrorCodes } from '../services/error-codes.mjs'

function clampInt(v, min, max, dflt) {
  if (v == null) return dflt
  const n = parseInt(v, 10)
  if (!Number.isInteger(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

function truncate(s, max) {
  if (s == null) return ''
  return s.length > max ? s.slice(0, max) + '\n...(' + (s.length - max) + ' chars truncated)' : s
}

function readAllStream(stream) {
  return new Promise((resolve, reject) => {
    if (stream == null) return resolve('')
    if (typeof stream === 'string') return resolve(stream)
    if (typeof stream.on !== 'function') return resolve('')
    // v0.2.3: accumulate raw Buffers and decode once - per-chunk c.toString()
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

export { clampInt, truncate, readAllStream, sendJson, send }
