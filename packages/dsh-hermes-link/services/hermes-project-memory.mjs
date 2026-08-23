// services/hermes-project-memory.mjs
//
// v0.2.2 — cwd-scoped Hermes memory slice.
//
// The foundation slice in index.mjs (buildFoundationSlice) now contains ONLY
// SOUL.md (≤4KB) — MEMORY.md is no longer broadcast to every dispatched sub-
// agent, because MEMORY.md typically aggregates notes across many projects and
// would routinely contaminate an unrelated sub-agent (the same class of bug as
// the v0.7 → v0.2.0 main-session injection that v0.2.1 disabled).
//
// This service is the opt-in replacement: it reads Hermes `state.db` and only
// returns memory lines from MEMORY.md whose surrounding context matches the
// dispatch's current working directory. The mapping heuristic is:
//   1. Hermes state.db `sessions.cwd` must equal (case-insensitive, trailing-
//      slash-normalized) the dispatch's dshCwd.
//   2. With at least one match, scan MEMORY.md and include lines that mention
//      either the cwd's basename or the full cwd path.
//   3. Cap the output at MAX_BYTES.
//
// If no match exists, returns '' (the caller is responsible for not injecting
// anything into the persona envelope).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_BYTES = 4096

function normalizeCwd(p) {
  if (!p || typeof p !== 'string') return ''
  let s = p.replace(/[\\/]+$/, '').toLowerCase()
  return s
}

function basenameOf(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * @param {string} hermesHome
 * @param {string} dshCwd
 * @returns {Promise<string>} empty if no match; else markdown block.
 */
export async function buildProjectMemorySlice(hermesHome, dshCwd) {
  if (!hermesHome || !dshCwd) return ''
  const dshCwdNorm = normalizeCwd(dshCwd)
  if (!dshCwdNorm) return ''

  const stateDb = join(hermesHome, 'state.db')
  if (!existsSync(stateDb)) return ''

  let matchedCount = 0
  try {
    const db = new DatabaseSync(stateDb, { readOnly: true })
    const rows = db.prepare('SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL').all()
    db.close()
    for (const r of rows) {
      if (normalizeCwd(r.cwd) === dshCwdNorm) matchedCount++
    }
  } catch (e) {
    return ''
  }

  if (matchedCount === 0) return ''

  const memPath = join(hermesHome, 'memories', 'MEMORY.md')
  if (!existsSync(memPath)) return ''

  let raw = ''
  try { raw = readFileSync(memPath, 'utf8') } catch { return '' }
  if (!raw) return ''

  const base = basenameOf(dshCwd)
  const lines = raw.split('\n')
  const hit = []
  let inHit = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // A line "counts" if it mentions the cwd's basename OR the full cwd.
    const lower = l.toLowerCase()
    const matches = lower.includes(base.toLowerCase()) || lower.includes(dshCwdNorm)
    if (matches) {
      // Extend backward to the preceding blank line (header) for context.
      let start = i
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim() === '') { start = j + 1; break }
        if (j === 0) start = 0
      }
      // Extend forward through any continuation (lines without another blank gap).
      let end = i
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') break
        end = k
      }
      // Collect the contiguous block.
      for (let m = start; m <= end; m++) {
        if (!hit.includes(m)) hit.push(m)
      }
      i = end
      inHit = false
    }
  }

  if (hit.length === 0) return ''
  const collected = hit.map((idx) => lines[idx]).join('\n')
  let out = `<!-- Hermes project-memory (cwd=${dshCwd}; matched ${matchedCount} state.db session(s)) -->\n` + collected
  if (out.length > MAX_BYTES) {
    out = out.slice(0, MAX_BYTES) + `\n<!-- dsh-hermes-link: truncated at ${MAX_BYTES} bytes; full MEMORY.md at ${memPath} -->`
  }
  return out
}