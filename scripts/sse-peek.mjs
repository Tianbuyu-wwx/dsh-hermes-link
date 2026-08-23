// sse-peek.mjs — minimal SSE consumer for diagnosis
import { request } from 'node:http'

const url = process.argv[2] || 'http://127.0.0.1:3080/mcp/dispatch/stream?child_id=2068cafd-3e30-4a4f-ad4d-152fc35d41b9'
const deadlineMs = parseInt(process.argv[3] || '5000', 10)

const parsed = new URL(url)
const req = request({
  hostname: parsed.hostname,
  port: parsed.port,
  path: parsed.pathname + parsed.search,
  method: 'GET',
  headers: { Accept: 'text/event-stream' },
})
req.on('response', (res) => {
  console.log('STATUS:', res.statusCode)
  console.log('HEADERS:', JSON.stringify(res.headers, null, 2))
  let buffer = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 2)
      console.log('--- EVENT ---')
      console.log(block)
    }
  })
  res.on('end', () => console.log('--- END ---'))
  res.on('error', (e) => console.error('res error:', e))
})
req.on('error', (e) => console.error('req error:', e))
req.end()

setTimeout(() => { console.log('--- TIMEOUT ' + deadlineMs + 'ms ---'); req.destroy(); process.exit(0) }, deadlineMs)
