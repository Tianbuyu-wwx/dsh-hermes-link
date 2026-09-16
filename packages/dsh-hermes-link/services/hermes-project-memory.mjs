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
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_BYTES = 4096

export function normalizeCwd(p) {
  if (!p || typeof p !== 'string') return ''
  // v0.6.0 (B): fold path separators as well as case + trailing separators.
  // The mirror policy compares a DSH header.cwd against Hermes state.db rows and
  // the two sides legitimately carry mixed separators (the pre-v0.6.0 import
  // path produced values like "C:\\Users\\x\\.dsh/hermes-workspace").
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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

// -----------------------------------------------------------------------------
// v0.6.0 (B) - cwd-scoped mirror policy support (HERMES_LINK_MIRROR_POLICY)
// -----------------------------------------------------------------------------

/**
 * Walk up from p looking for a git worktree root (.git file or directory).
 * Filesystem-only (no subprocess, no shelling out to git), bounded to 16 levels.
 * @param {string} p
 * @returns {string|null}
 */
function gitWorktreeRoot(p) {
  try {
    let dir = p
    for (let i = 0; i < 16; i++) {
      if (!dir) break
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dirname(dir)
      if (!parent || parent === dir) break
      dir = parent
    }
  } catch (_e) { /* best-effort */ }
  return null
}

/**
 * Does dshCwd provably belong to a project Hermes actually has a session for?
 *
 * Reuses normalizeCwd() + the same equality rule as buildProjectMemorySlice()
 * above, and adds the two extra axes the mirror policy is allowed to use:
 *   - Hermes sessions.git_repo_root (the column exists in the real state.db;
 *     older/minimal fixtures may not have it, so it is probed via
 *     PRAGMA table_info before it is read);
 *   - the DSH cwd's own git worktree root, so a DSH session started in a
 *     subdirectory of the project still counts as the same project.
 *
 * Never throws: any sqlite / fs problem means 'no match' (fail closed), because
 * a false positive would mirror an unrelated project into Hermes.
 *
 * @param {string} hermesHome
 * @param {string} dshCwd
 * @returns {{matched: boolean, via: string|null, matched_session_id: string|null, matched_count: number}}
 */
export function matchHermesProject(hermesHome, dshCwd) {
  const none = { matched: false, via: null, matched_session_id: null, matched_count: 0 }
  if (!hermesHome || !dshCwd) return none
  const want = normalizeCwd(dshCwd)
  if (!want) return none
  const stateDb = join(hermesHome, 'state.db')
  if (!existsSync(stateDb)) return none

  let rows = []
  try {
    const db = new DatabaseSync(stateDb, { readOnly: true })
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name))
      const hasGitRoot = cols.has('git_repo_root')
      rows = db.prepare(hasGitRoot
        ? 'SELECT id, cwd, git_repo_root FROM sessions'
        : 'SELECT id, cwd FROM sessions').all()
    } finally {
      db.close()
    }
  } catch (_e) {
    return none
  }

  const wantRoot = gitWorktreeRoot(dshCwd)
  const wantRootNorm = wantRoot ? normalizeCwd(wantRoot) : ''
  for (const r of rows) {
    const cwd = normalizeCwd(r.cwd)
    const gitRoot = normalizeCwd(r.git_repo_root)
    let via = null
    if (cwd && cwd === want) via = 'cwd'
    else if (gitRoot && gitRoot === want) via = 'git_repo_root'
    else if (wantRootNorm && cwd && cwd === wantRootNorm) via = 'git_worktree_root'
    else if (wantRootNorm && gitRoot && gitRoot === wantRootNorm) via = 'git_worktree_root'
    if (!via) continue
    return { matched: true, via, matched_session_id: r.id == null ? null : String(r.id), matched_count: 1 }
  }
  return none
}
