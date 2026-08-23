// scripts/hermes-push.mjs — Hermes-side write to dsh's hermes-inbox files.
//
// v0.5: writes both files in `~/.dsh/hermes-inbox/`:
//   - latest.md       — last turn (overwrites; for quick access)
//   - session.jsonl   — full conversation history (appends; DSH loads on
//                       session-start, caps at HERMES_SESSION_CAP bytes from
//                       the tail so older turns get dropped when huge)
//
// Usage:
//   node scripts/hermes-push.mjs --user "the user said X" --assistant "hermes replied Y"
//   node scripts/hermes-push.mjs --full "verbatim turn text"
//   node scripts/hermes-push.mjs --file path/to/turn.md
//   node scripts/hermes-push.mjs --status          (read-only)
//   node scripts/hermes-push.mjs --reset-session   (clear session.jsonl)

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const INBOX_DIR = join(DSH_HOME, 'hermes-inbox')
const LATEST_PATH = join(INBOX_DIR, 'latest.md')
const SESSION_PATH = join(INBOX_DIR, 'session.jsonl')

const args = parseArgs(process.argv.slice(2))

if (args.status) {
  try {
    const r = await fetch('http://127.0.0.1:3080/mcp/hermes-inbox/health')
    console.log(await r.text())
  } catch (e) {
    console.log('dsh not reachable: ' + (e && e.message))
  }
  process.exit(0)
}

if (args['reset-session']) {
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(SESSION_PATH, '', 'utf8')
  console.log(JSON.stringify({ ok: true, action: 'reset', path: SESSION_PATH }, null, 2))
  process.exit(0)
}

let body = { user: args.user, assistant: args.assistant, full: args.full }
if (args.file) {
  body.full = readFileSync(args.file, 'utf8')
}

if (!body.full && !body.user && !body.assistant) {
  console.error('USAGE:')
  console.error('  node scripts/hermes-push.mjs --user "USER said X" --assistant "HERMES replied Y"')
  console.error('  node scripts/hermes-push.mjs --full "verbatim turn"')
  console.error('  node scripts/hermes-push.mjs --file path/to/turn.md')
  console.error('  node scripts/hermes-push.mjs --status')
  console.error('  node scripts/hermes-push.mjs --reset-session')
  process.exit(1)
}

const ts = new Date().toISOString()
let turn
if (typeof body.full === 'string' && body.full.length > 0) {
  turn = { ts, source: 'full', content: body.full }
} else {
  turn = { ts, source: 'structured', user: body.user || null, assistant: body.assistant || null }
}

mkdirSync(INBOX_DIR, { recursive: true })

// 1) Overwrite latest.md with the latest turn only (markdown body).
let latestContent
if (turn.source === 'full') {
  latestContent = turn.content
} else {
  const lines = []
  if (turn.user)      lines.push('USER: ' + turn.user)
  if (turn.assistant) lines.push('---')
  if (turn.assistant) lines.push('HERMES: ' + turn.assistant)
  latestContent = lines.join('\n')
}
writeFileSync(LATEST_PATH, latestContent, 'utf8')

// 2) Append turn to session.jsonl (full conversation history).
appendFileSync(SESSION_PATH, JSON.stringify(turn) + '\n', 'utf8')

// 3) Snapshot per-turn (debugging).
const tsFile = ts.replace(/[:.]/g, '-')
writeFileSync(join(INBOX_DIR, 'turn-' + tsFile + '.md'), latestContent, 'utf8')

console.log(JSON.stringify({
  ok: true,
  ts,
  size: latestContent.length,
  latest_path: LATEST_PATH,
  session_path: SESSION_PATH,
}, null, 2))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--user' && argv[i + 1])      { out.user = argv[++i]; continue }
    if (a === '--assistant' && argv[i + 1]) { out.assistant = argv[++i]; continue }
    if (a === '--full' && argv[i + 1])      { out.full = argv[++i]; continue }
    if (a === '--file' && argv[i + 1])      { out.file = argv[++i]; continue }
    if (a === '--status')                   { out.status = true; continue }
    if (a === '--reset-session')             { out['reset-session'] = true; continue }
  }
  return out
}
