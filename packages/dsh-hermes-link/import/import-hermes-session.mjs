// import-hermes-session.mjs
//
// V2 core service: take a Hermes session_id, find the latest request_dump for
// it, convert it to DSH SessionEvent[], and seed a fresh DSH session in the
// store via ctx.sessions.create(id, { seed, meta }).
//
// Metadata comes from Hermes' state.db `sessions` table (authoritative):
//   - title  : friendly session title (e.g. "修改默认hermes CLI")
//   - cwd    : the working directory the Hermes session ran in (null = unknown)
//   - model  : the model the session used
// A caller-supplied `workspace` overrides cwd ("还可以用用户选的工作目录").
// Sessions whose cwd is null/unknown fall back to the Hermes workspace dir.
//
// Auto-sync: `sync()` imports every session that is not yet a DSH session,
// honoring per-session cwd + title + optional workspace override. Called at
// plugin startup and on every watcher 'change'.

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The converter is imported DYNAMICALLY with a cache-busting query so edits to
// request-dump-to-events.mjs take effect on the next import without restarting
// the DSH process (Node's ESM loader treats a different query string as a
// distinct module). This is the "路径 A" hot-reload seam.
const CONVERTER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'request-dump-to-events.mjs'),
).href

/**
 * Factory for the service.
 * @param {object} deps
 * @param {object} deps.ctx                Cordis ctx (ctx.sessions,
 *                                         ctx.workspaceRegistry, ctx.sessionTitle)
 * @param {string} deps.hermesHome         Hermes data home (LOCALAPPDATA/hermes)
 * @param {string} [deps.workspaceDir]     Fallback dir for sessions with no cwd.
 *                                         Default: DSH_HOME/hermes-workspace
 */
export function createImporter({ ctx, hermesHome, workspaceDir }) {
  const sessionsDir = join(hermesHome, 'sessions')
  const hermesWorkspaceDir = workspaceDir ||
    (process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')) + '/hermes-workspace'

  // Ensure the fallback Hermes workspace dir exists (must be a real directory
  // for workspaceRegistry.create + session cwd validation).
  try { mkdirSync(hermesWorkspaceDir, { recursive: true }) } catch {}

  // Hot-reload seam.
  async function loadConverter() {
    return import(CONVERTER_URL + `?v=${Date.now()}`)
  }

  // Lazily read Hermes state.db sessions metadata, cached per call.
  let metaCache = null
  async function loadStateDbMeta() {
    if (metaCache) return metaCache
    metaCache = new Map()
    const dbPath = join(hermesHome, 'state.db')
    if (!existsSync(dbPath)) return metaCache
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare(
        `SELECT id, cwd, model, title, git_repo_root, git_branch FROM sessions`,
      ).all()
      for (const r of rows) {
        metaCache.set(String(r.id), {
          cwd: r.cwd || null,
          model: r.model || null,
          title: r.title || null,
          gitRepoRoot: r.git_repo_root || null,
          gitBranch: r.git_branch || null,
        })
      }
      db.close()
    } catch (e) {
      console.warn('[dsh-hermes-link] state.db read failed:', e && e.message || e)
    }
    return metaCache
  }

  /**
   * List Hermes sessions (latest dump per session_id), newest first, enriched
   * with state.db metadata.
   * @returns {Promise<Array<object>>}
   */
  async function list({ limit = 200 } = {}) {
    const { walkRequestDumps, groupBySession } = await loadConverter()
    if (!existsSync(sessionsDir)) return []
    const meta = await loadStateDbMeta()
    const files = [...walkRequestDumps(sessionsDir)]
    const grouped = groupBySession(files).slice(0, limit)
    return grouped.map((g) => {
      const m = meta.get(g.session_id) || {}
      return {
        session_id: g.session_id,
        mtime: g.mtime,
        dump_path: g.latestPath,
        size_bytes: safeSize(g.latestPath),
        first_user_snippet: extractFirstUserSnippet(g.dump),
        message_count: countMessages(g.dump),
        title: m.title || null,
        cwd: m.cwd || null,
        model: m.model || null,
        git_repo_root: m.gitRepoRoot || null,
        git_branch: m.gitBranch || null,
      }
    })
  }

  /**
   * Look up one Hermes session by id; same shape as list() entries.
   */
  async function findOne(hermesSessionId) {
    const { walkRequestDumps, groupBySession } = await loadConverter()
    if (!existsSync(sessionsDir)) return null
    const meta = await loadStateDbMeta()
    const grouped = groupBySession([...walkRequestDumps(sessionsDir)])
    const g = grouped.find((x) => x.session_id === hermesSessionId)
    if (!g) return null
    const m = meta.get(hermesSessionId) || {}
    return {
      session_id: g.session_id,
      mtime: g.mtime,
      dump_path: g.latestPath,
      size_bytes: safeSize(g.latestPath),
      first_user_snippet: extractFirstUserSnippet(g.dump),
      message_count: countMessages(g.dump),
      title: m.title || null,
      cwd: m.cwd || null,
      model: m.model || null,
      git_repo_root: m.gitRepoRoot || null,
      git_branch: m.gitBranch || null,
    }
  }

  /**
   * Pick the effective cwd for one session:
   *   caller workspace override  >  state.db cwd (if it exists on disk AND passes safety)  >  fallback.
   *
   * v0.2.3 (K.2): state.db cwd is now safety-checked. Hermes state.db is treated as
   * untrusted input — a buggy or compromised Hermes writer could stuff a path like
   * `C:\Windows\System32` into cwd, and DSH would then create a session header
   * pointing at a system directory. Subsequent sub-agent dispatch would treat
   * relative paths as anchored there. The safety check refuses clearly dangerous
   * paths (system dirs, null bytes, non-absolute, too long) and falls back to the
   * hermes-workspace fallback. The user can still pass an explicit workspace via
   * `importSession({ workspace })` without restriction — they are opting in.
   */
  function isSafeCwd(p) {
    if (typeof p !== 'string' || p.length === 0) return false
    if (p.length > 1024) return false // unreasonable path length, refuse
    if (p.includes('\u0000')) return false // null byte injection
    // Must be absolute. Detect both Windows (C:\ or C:/) and POSIX (/) roots.
    const isAbsWin = /^[A-Za-z]:[\\/]/.test(p)
    const isAbsPosix = p.startsWith('/')
    if (!isAbsWin && !isAbsPosix) return false
    const norm = p.replace(/[\\/]+/g, '/').toLowerCase()
    // System-critical directories we never want to anchor a session to.
    const forbidden = [
      // Windows
      'c:/windows', 'c:/windows/system32', 'c:/windows/syswow64',
      'c:/program files', 'c:/program files (x86)',
      'c:/programdata',
      // POSIX
      '/etc', '/bin', '/sbin', '/usr', '/var', '/proc', '/sys', '/boot', '/root',
      '/lib', '/lib64', '/opt', '/dev',
    ]
    for (const f of forbidden) {
      // exact root, or root + path-separator (so /usr/local is fine but /usr is not)
      if (norm === f) return false
      if (norm.startsWith(f + '/')) return false
    }
    return true
  }

  function resolveCwd(info, requestedWorkspace) {
    if (requestedWorkspace && typeof requestedWorkspace === 'string' && requestedWorkspace.trim()) {
      return requestedWorkspace.trim()
    }
    if (info && info.cwd && isSafeCwd(info.cwd) && existsSync(info.cwd) && statSync(info.cwd).isDirectory()) {
      return info.cwd
    }
    return hermesWorkspaceDir
  }

  /**
   * Import one Hermes session into the DSH store as a live session with full
   * historical context. Idempotent on session_id (same sid → same DSH id).
   *
   * @param {string} hermesSessionId
   * @param {object} [opts]
   * @param {string} [opts.workspace]   Absolute dir override for this session's cwd.
   * @returns {Promise<object>}
   */
  async function importSession(hermesSessionId, opts = {}) {
    if (!ctx.sessionPersistence) {
      throw new Error('dsh-hermes-link: ctx.sessionPersistence not available; is dsh-session-persistence mounted?')
    }

    const info = await findOne(hermesSessionId)
    if (!info) {
      return { status: 'not_found', hermesSessionId }
    }
    const dump = readJsonFile(info.dump_path)
    if (!dump) {
      return { status: 'read_error', hermesSessionId, dump_path: info.dump_path }
    }

    const dshSessionId = `hermes-${hermesSessionId}`
    const finalCwd = resolveCwd(info, opts.workspace)

    // Already persisted on disk → nothing to do (resume will find it). We still
    // ensure the workspace exists + session attached (idempotent), because the
    // workspace registry only bootstraps at startup and persisted-only imports
    // that arrived later would otherwise be invisible to the sidebar.
    try {
      await ctx.sessionPersistence.inspect(dshSessionId)
      const attachErr = await attachToWorkspace(ctx, finalCwd, dshSessionId)
      return {
        status: 'already_imported',
        hermesSessionId,
        sessionId: dshSessionId,
        eventCount: null,
        firstUserSnippet: info.first_user_snippet,
        title: info.title || null,
        cwd: finalCwd,
        model: info.model || null,
        note: 'already persisted',
        attach: attachErr ? ('failed: ' + attachErr) : 'ok',
      }
    } catch (e) {
      const msg = String(e && e.message || e)
      const notFound = msg.includes('not found') || msg.includes('no stored session')
      if (!notFound) {
        // Log exists on disk but cannot be read/validated. Two causes:
        //   1. genuinely corrupt file (report read error, keep the artifact);
        //   2. imported by an older dsh-hermes-link whose event stream was rejected
        //      by the current DSH session validator (e.g. turn/end with turn 0).
        // For case 2 the artifact is unrecoverable as-is: the validator will
        // reject it on every resume, so the session can never be continued.
        // Remove the stored artifact and rebuild it from the request dump — the
        // converter rewrite for this import produces a validator-accepted
        // stream, so the user gets a resume-able session instead of a dead one.
        if (msg.includes('failed validation') || msg.includes('malformed')) {
          try {
            const artifacts = await ctx.sessionPersistence.listArtifacts()
            const bad = artifacts.find((a) => a.header && a.header.id === dshSessionId)
            if (bad && bad.path) {
              await rm(bad.path, { force: true })
              console.log('[dsh-hermes-link] removed invalid persisted session ' + dshSessionId + ' (' + bad.path + '); rebuilding from dump')
            }
          } catch (rmErr) {
            return {
              status: 'already_imported',
              hermesSessionId,
              sessionId: dshSessionId,
              eventCount: null,
              firstUserSnippet: info.first_user_snippet,
              title: info.title || null,
              cwd: finalCwd,
              model: info.model || null,
              note: 'persisted but inspect failed: ' + msg.slice(0, 200) + '; artifact removal also failed: ' + String(rmErr && rmErr.message || rmErr).slice(0, 200),
              attach: 'failed',
            }
          }
          // artifact removed → fall through to rebuild below
        } else {
          // genuine corruption, unknown signature → report, keep artifact
          const attachErr = await attachToWorkspace(ctx, finalCwd, dshSessionId)
          return {
            status: 'already_imported',
            hermesSessionId,
            sessionId: dshSessionId,
            eventCount: null,
            firstUserSnippet: info.first_user_snippet,
            title: info.title || null,
            cwd: finalCwd,
            model: info.model || null,
            note: 'persisted but inspect failed: ' + msg.slice(0, 200),
            attach: attachErr ? ('failed: ' + attachErr) : 'ok',
          }
        }
      }
      // truly absent (or removed above) → fall through to create
    }
    // Also guard against a live session holding the id (shouldn't happen after
    // the persistent-only rewrite, but a stale live copy would collide).
    if (ctx.sessions && ctx.sessions.get(dshSessionId)) {
      return {
        status: 'live_collision',
        hermesSessionId,
        sessionId: dshSessionId,
        note: 'a live DSH session holds this id; restart DSH to drop stale live sessions before re-importing',
      }
    }

    const { requestDumpToEvents } = await loadConverter()
    const { events } = requestDumpToEvents(dump)

    // Title: state.db title, else first-user snippet + date.
    const title = info.title || makeTitle(info.first_user_snippet, info.session_id)

    // Append a pinned session/title event (log-backed title). Its seq is the
    // next index after the seed events, so the log stays contiguous.
    const titleSeq = events.length
    const titleTime = (events[events.length - 1] && events[events.length - 1].time) || Date.now()
    const titleEvent = {
      type: 'session/title',
      seq: titleSeq,
      time: titleTime,
      // `session/title` is a plugin extension type (dsh-session-title), not in
      // the core KNOWN_SESSION_EVENT_TYPES set. `ignorable` tells persistence/
      // inspection this record is informational and safe to skip, so cold
      // reads accept it even when title plugins are not mounted.
      ignorable: true,
      data: {
        title,
        messageSeqs: [],
        source: { kind: 'user' }, // pinned: automatic generation never overrides
      },
    }
    const allEvents = [...events, titleEvent]

    let created
    try {
      // jsonl backend header validation (isHeaderLine) requires:
      //   type: "session", version, id, createdAt (safe int),
      //   delegationDepth (safe int ≥ 0); cwd optional; agentPreset ours.
      const header = {
        type: 'session',
        version: 0,
        id: dshSessionId,
        createdAt: (events[0] && events[0].time) || Date.now(),
        delegationDepth: 0,
        ...(finalCwd ? { cwd: finalCwd } : {}),
        agentPreset: 'hermes-imported',
      }
      await ctx.sessionPersistence.create(header)
      await ctx.sessionPersistence.append(dshSessionId, allEvents)
      created = { id: dshSessionId, events: allEvents }
    } catch (e) {
      return {
        status: 'create_failed',
        hermesSessionId,
        error: String(e && e.message || e),
        eventCount: allEvents.length,
      }
    }

    // Ensure the workspace exists + session attached (sidebar grouping).
    const attachErr = await attachToWorkspace(ctx, finalCwd, dshSessionId)

    return {
      status: 'created',
      hermesSessionId,
      sessionId: created.id,
      eventCount: allEvents.length,
      firstUserSnippet: info.first_user_snippet,
      cwd: finalCwd,
      title,
      model: info.model || null,
      persisted_only: true,
      note: 'persisted to disk; open from the sidebar to resume',
      attach: attachErr ? ('failed: ' + attachErr) : 'ok',
    }
  }

  /**
   * Import ALL Hermes sessions (idempotent per session).
   * @param {object} [opts]
   * @param {string[]} [opts.only]      optional explicit session_id allowlist
   * @param {string}   [opts.workspace] global cwd override
   * @returns {Promise<{ imported, skipped, failed, results }>}
   */
  async function importAll({ only, workspace } = {}) {
    const { walkRequestDumps, groupBySession } = await loadConverter()
    if (!existsSync(sessionsDir)) {
      return { imported: 0, skipped: 0, failed: 0, results: [] }
    }
    const grouped = groupBySession([...walkRequestDumps(sessionsDir)])
    const results = []
    let imported = 0, skipped = 0, failed = 0
    const allow = only && only.length > 0 ? new Set(only) : null
    for (const g of grouped) {
      if (allow && !allow.has(g.session_id)) continue
      const r = await importSession(g.session_id, { workspace })
      results.push(r)
      if (r.status === 'created') imported++
      else if (r.status === 'already_imported') skipped++
      else failed++
    }
    return { imported, skipped, failed, results }
  }

  /**
   * Sync entry point for startup + watcher: import every Hermes session that
   * is not already a DSH session. Never throws.
   */
  async function sync() {
    const r = await importAll()
    if (r.failed > 0) {
      for (const res of r.results) {
        if (res.status !== 'created' && res.status !== 'already_imported') {
          console.error('[dsh-hermes-link] sync failed for', res.hermesSessionId,
            '->', res.status, res.error || '', res.note || '')
        }
      }
    }
    return r
  }

  /**
   * Rename every live Hermes-imported session to a readable title
   * (state.db title preferred; else first user snippet). Idempotent.
   */
  async function renameAll() {
    const results = []
    let renamed = 0, failed = 0
    const meta = await loadStateDbMeta()
    const live = ctx.sessions ? ctx.sessions.list() : []
    for (const s of live) {
      const id = String(s.id)
      if (!id.startsWith('hermes-')) continue
      const sid = id.replace(/^hermes-/, '')
      const m = meta.get(sid) || {}
      const snippet = firstUserSnippetOf(s)
      const title = m.title || makeTitle(snippet, sid)
      const err = await renameSession(ctx, s, title)
      if (err) {
        failed++
        results.push({ sessionId: id, status: 'failed', error: err })
      } else {
        renamed++
        results.push({ sessionId: id, status: 'renamed', title })
      }
    }
    return { renamed, failed, results }
  }

  return { list, findOne, importSession, importAll, sync, renameAll, sessionsDir, hermesWorkspaceDir }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Create (or reuse) the workspace for `cwd` and attach one session to it.
 * Membership requires session header cwd === workspace path. Never throws —
 * returns an error string when it cannot attach.
 */
async function attachToWorkspace(ctx, cwd, sessionId) {
  try {
    const reg = ctx && ctx.workspaceRegistry
    if (!reg) return 'workspaceRegistry unavailable'
    if (!cwd || !existsSync(cwd)) return 'cwd missing: ' + (cwd || '(none)')
    const title = basenameOf(cwd)
    const ws = await reg.create(cwd, title)
    await ws.attachSession(sessionId)
    return null
  } catch (e) {
    return String(e && e.message || e)
  }
}

/** Best-effort session title rename. Never throws — returns error string. */
async function renameSession(ctx, session, title) {
  try {
    const svc = ctx && ctx.sessionTitle
    if (!svc) return 'sessionTitle unavailable'
    if (!session) return 'session not live'
    if (!title) return 'no title text'
    svc.rename(session, title)
    return null
  } catch (e) {
    return String(e && e.message || e)
  }
}

/** Make a pinned session title from a snippet + short date from sid. */
function makeTitle(snippet, hermesSessionId) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(hermesSessionId || '')
  const date = m ? `${m[2]}-${m[3]}` : ''
  const clean = (snippet || '').replace(/\s+/g, ' ').trim()
  const body = clean.slice(0, 36)
  const t = body + (date ? ` (${date})` : '')
  return t.slice(0, 60)
}

/** First user text snippet from a live DSH session (for renameAll on old imports). */
function firstUserSnippetOf(session) {
  try {
    for (const e of session.events || []) {
      if (e && e.type === 'user/message' && e.data && e.data.content) {
        const blocks = Array.isArray(e.data.content) ? e.data.content : []
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const t = b.text.replace(/\s+/g, ' ').trim()
            if (t) return t
          }
        }
      }
    }
  } catch {}
  return ''
}

function extractFirstUserSnippet(dump) {
  try {
    const msgs = dump && dump.request && dump.request.body && dump.request.body.messages
    if (!Array.isArray(msgs)) return ''
    for (const m of msgs) {
      if (m && m.role === 'user') {
        if (typeof m.content === 'string') return m.content.slice(0, 160)
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b && b.type === 'text' && typeof b.text === 'string') {
              return b.text.slice(0, 160)
            }
          }
        }
      }
    }
  } catch {}
  return ''
}

function countMessages(dump) {
  const msgs = dump && dump.request && dump.request.body && dump.request.body.messages
  return Array.isArray(msgs) ? msgs.length : 0
}

function safeSize(p) {
  try { return statSync(p).size } catch { return 0 }
}

function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function basenameOf(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}