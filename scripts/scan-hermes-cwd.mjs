// scripts/scan-hermes-cwd.mjs
// Scan all Hermes request_dumps, infer each session's likely working directory
// from absolute paths found in tool inputs. Prints a report.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'C:/Users/Tianbuyu/AppData/Local/hermes/sessions'

const files = readdirSync(dir).filter((f) => f.startsWith('request_dump_') && f.endsWith('.json'))
const sessions = new Map()

function addPath(sid, p, n = 1) {
  let s = sessions.get(sid)
  if (!s) { s = { files: 0, paths: new Map() }; sessions.set(sid, s) }
  s.paths.set(p, (s.paths.get(p) || 0) + n)
}

for (const f of files) {
  let dump
  try { dump = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
  const sid = dump && dump.session_id
  if (!sid) continue
  const s = sessions.get(sid) || (sessions.set(sid, { files: 0, paths: new Map() }), sessions.get(sid))
  s.files++
  const msgs = (dump.request && dump.request.body && dump.request.body.messages) || []
  const text = JSON.stringify(msgs)
  // match windows absolute paths (drive letter) and attempt to collapse to dirs
  const re = /([A-Za-z]:[\\/][^"'\\s)]{2,200})/g
  let m
  while ((m = re.exec(text)) !== null) {
    let p = m[1]
    // strip file tail heuristically: if appears to be a file (has extension with < 10 chars), take dirname
    const ext = p.match(/\.[a-zA-Z0-9]{1,8}$/)
    const looksLikeFile = ext && !p.endsWith('/') && !p.endsWith('\\')
    if (looksLikeFile) {
      p = p.slice(0, p.lastIndexOf(/[\\/]/.exec(p) ? p.match(/[\\/][^\\/]*$/)[0] : '')) || p
    }
    // normalize backslash, trim trailing
    p = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (p.length >= 3) addPath(sid, p)
  }
}

for (const [sid, s] of [...sessions.entries()]) {
  const top = [...s.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  console.log(`${sid}  files=${s.files} => ${top.map(([p, c]) => `${p} x${c}`).join(' | ') || '(no paths)'}`)
}