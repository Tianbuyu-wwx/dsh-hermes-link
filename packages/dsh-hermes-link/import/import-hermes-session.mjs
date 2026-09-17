// import-hermes-session.mjs
//
// V2 core service: take a Hermes session_id, find the latest request_dump for
// it, convert it to DSH SessionEvent[], and persist it as a fresh DSH session
// through ctx.sessionPersistence (create(header) -> write handle ->
// append(events) -> flush() -> close()).
//
// Metadata comes from Hermes' state.db `sessions` table (authoritative):
//   - title  : friendly session title (e.g. "修改默认hermes CLI")
//   - cwd    : the working directory the Hermes session ran in (null = unknown)
//              (when it cannot be determined the header omits cwd entirely --
//              see resolveCwd; there is no hermes-workspace fallback any more)
//   - model  : the model the session used
// A caller-supplied `workspace` overrides cwd ("还可以用用户选的工作目录").
// When nothing can be determined -- no state.db cwd, no git repo root, no
// @folder:/cd evidence in the dump -- the header simply omits cwd and DSH files
// the session under its own _no-cwd project. It is NEVER silently parked in the
// empty Hermes workspace dir (that is what mis-filed 46 sessions before D3).
//
// Auto-sync: `sync()` imports every session that is not yet a DSH session,
// honoring per-session cwd + title + optional workspace override. Called at
// plugin startup and on every watcher 'change'.

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, dirname, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The converter is imported DYNAMICALLY with a cache-busting query so edits to
// request-dump-to-events.mjs take effect on the next import without restarting
// the DSH process (Node's ESM loader treats a different query string as a
// distinct module). This is the "路径 A" hot-reload seam.
const CONVERTER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'request-dump-to-events.mjs'),
).href

// -----------------------------------------------------------------------------
// DSH sessionPersistence contract (verified against
// @deepseek-ai/dsh-session-persistence@0.1.5-rc.2 + dsh-session-persistence-jsonl)
// -----------------------------------------------------------------------------
//
// 0.1.5 API: create / open / stat / list on the service, plus a per-session
// handle returned by create()/open() whose append / flush / close own the
// actual writes. The APIs this file used to call -- inspect(), listArtifacts()
// and the service-level append(id, events) -- no longer exist.
const REQUIRED_PERSISTENCE_METHODS = ['create', 'open', 'stat', 'list']
const REQUIRED_HANDLE_METHODS = ['append', 'flush', 'close']

/** SessionHeader.version; verified = 3 (SESSION_FORMAT_VERSION in @deepseek-ai/dsh-session). */
const SESSION_FORMAT_VERSION_FALLBACK = 3

/**
 * Explicit workspace markers written into a prompt, e.g. the DSH file-reference
 * form "@folder:" followed by a path in backticks. A user naming the directory
 * outranks any `cd` we might scrape out of tool calls.
 */
const FOLDER_MARKER_PATTERNS = [
  /@folder:\s*`([^`\r\n]+)`/g,
  /@folder:\s*"([^"\r\n]+)"/g,
  /@folder:\s*'([^'\r\n]+)'/g,
  /@folder:\s*([A-Za-z]:[\\/][^\s`"'\r\n]+)/g,
  /@folder:\s*(\/[^\s`"'\r\n]+)/g,
]
/** Weight of one explicit @folder: marker relative to one incidental `cd`. */
const FOLDER_MARKER_WEIGHT = 3

let formatVersionPromise = null
/**
 * Resolve the harness's current session format version lazily and defensively.
 * A static `import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'` is
 * not possible: that package is host-provided and is NOT resolvable from this
 * repo (the repo's own tests import this module stand-alone, and
 * packages/dsh-hermes-link/node_modules only carries dsh-skill-filesystem /
 * dsh-tools), so this module must stay host-independent. The verified literal is
 * the fallback; if a future harness bumps the version, create() refuses the
 * stale header and D2 reports that refusal loudly instead of swallowing it.
 * @returns {Promise<number>}
 */
function resolveSessionFormatVersion() {
  formatVersionPromise ||= (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-session')
      if (mod && typeof mod.SESSION_FORMAT_VERSION === 'number') return mod.SESSION_FORMAT_VERSION
    } catch {}
    return SESSION_FORMAT_VERSION_FALLBACK
  })()
  return formatVersionPromise
}

/**
 * Live model route to pin on an imported session, as ONE trailing
 * `model/selection` event.
 *
 * Why this exists (v0.6.0): DSH reads a Session's "current model" from its LAST
 * `request/header` (dsh-api-session-controller -> selectionFor()), and the
 * converter records the originating Hermes model under a synthetic provider
 * (`dsh-hermes-link`, see request-dump-to-events.mjs). No LLM adapter serves
 * that provider, so the client resolves the Session's selection as unroutable
 * (dsh-client-ui-model-selection: routable=false) and BLOCKS the whole
 * composer: the model and the agent preset/mode both become unchangeable, and a
 * prompt is refused with `session/model-unavailable`.
 *
 * The cure is not to rewrite history -- the historic request/header keeps its
 * honest provenance -- but to append the very intent DSH appends when a user
 * picks a model for a Session: one `model/selection` event
 * (`agent.session.append('model/selection', selection)`,
 * dsh-api-session-controller). The projection then yields
 * `next = pending ?? lastUsed` = a served route, which is what clears the block.
 *
 * Resolution order: explicit caller value -> HERMES_LINK_IMPORT_MODEL
 * (`provider/model` or `provider/model#effort`; the FIRST slash splits, so a
 * provider-owned id such as `commandcode/deepseek/deepseek-v4.1-flash` works)
 * -> the deployment default (ctx.agentDefaultModel.currentSelection()). When
 * nothing resolves, the event is OMITTED rather than invented: fabricating a
 * provider is exactly what produced the unroutable sessions.
 *
 * @param {object} [deps]
 * @param {object} [deps.ctx]        Cordis ctx (ctx.agentDefaultModel).
 * @param {object} [deps.selection]  Explicit {provider, model, reasoningEffort?}.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
export function resolveImportModelSelection(deps = {}) {
  const candidates = [
    deps.selection,
    parseImportModelSpec(process.env.HERMES_LINK_IMPORT_MODEL),
    readDefaultSelection(deps.ctx),
  ]
  for (const candidate of candidates) {
    const selection = normalizeModelSelection(candidate)
    if (selection) return selection
  }
  return null
}

/**
 * Parse `provider/model[#effort]`. Only the FIRST slash splits, because a
 * provider-owned model id may itself contain slashes.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
function parseImportModelSpec(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hash = trimmed.indexOf('#')
  const route = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const effort = hash === -1 ? '' : trimmed.slice(hash + 1).trim()
  const slash = route.indexOf('/')
  if (slash <= 0 || slash >= route.length - 1) return null
  return {
    provider: route.slice(0, slash).trim(),
    model: route.slice(slash + 1).trim(),
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

/**
 * Read the deployment's default route. Never throws: a missing service is normal.
 *
 * v0.6.6 - the service is looked up THREE ways, because the single direct read
 * silently returned null in production while every test (which injects the service
 * by hand) stayed green: 33 sessions imported after the pin shipped had no
 * `model/selection` at all. Order: the injected service, the registry lookup
 * (`ctx.get`, which also sees services published outside this plugin's scope),
 * then the deployment's own settings file.
 */
function readDefaultSelection(ctx) {
  try {
    const direct = ctx && ctx.agentDefaultModel
    if (direct && typeof direct.currentSelection === 'function') return direct.currentSelection()
  } catch { /* fall through */ }
  try {
    const viaRegistry = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    if (viaRegistry && typeof viaRegistry.currentSelection === 'function') return viaRegistry.currentSelection()
  } catch { /* fall through */ }
  return readSettingsDefaultRoute()
}

/**
 * Last-resort route source: the deployment's own `agent-default-model` block in
 * `$DSH_HOME/settings.yaml` (the same file the repair tool reads). Deliberately a
 * tiny targeted reader -- no YAML dependency, no cordis service, so it cannot be
 * unavailable at import time.
 */
function readSettingsDefaultRoute() {
  try {
    const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    const text = readFileSync(join(dshHome, 'settings.yaml'), 'utf8')
    const lines = String(text).split(/\r?\n/)
    const start = lines.findIndex((l) => /^agent-default-model:\s*$/.test(l))
    if (start === -1) return null
    const block = {}
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^\S/.test(line)) break
      const m = /^\s+([A-Za-z][\w-]*):\s*(.+?)\s*$/.exec(line)
      if (m) block[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    if (!block.provider || !block.model) return null
    return { provider: block.provider, model: block.model, ...(block.reasoningEffort ? { reasoningEffort: block.reasoningEffort } : {}) }
  } catch {
    return null
  }
}

/** Keep only a usable route; anything else means "no selection" (never a guess). */
function normalizeModelSelection(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) return null
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
}

/**
 * Factory for the service.
 * @param {object} deps
 * @param {object} deps.ctx                Cordis ctx (ctx.sessions,
 *                                         ctx.workspaceRegistry, ctx.sessionTitle)
 * @param {string} deps.hermesHome         Hermes data home (LOCALAPPDATA/hermes)
 * @param {string} [deps.workspaceDir]     Fallback dir for sessions with no cwd.
 *                                         Default: DSH_HOME/hermes-workspace
 * @param {object} [deps.defaultModel]     Explicit live model route to pin on a
 *                                         newly imported session (tests, or a
 *                                         caller carrying its own route). Falls
 *                                         back to HERMES_LINK_IMPORT_MODEL and
 *                                         then ctx.agentDefaultModel.
 */
export function createImporter({ ctx, hermesHome, workspaceDir, defaultModel }) {
  const sessionsDir = join(hermesHome, 'sessions')
  // D3 (separator bug): the old string concat produced
  // `C:\Users\<user>\.dsh/hermes-workspace` -- a mixed-separator path that
  // workspaceRegistry cannot match against a session header cwd. Build it with
  // join() and normalise whatever the caller passed in (index.mjs still passes
  // its own concatenated string).
  const hermesWorkspaceDir = normalize(
    workspaceDir ||
    join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'hermes-workspace'),
  )

  // Ensure the dir exists (must be a real directory for workspaceRegistry.create
  // + session cwd validation) when a caller explicitly uses it as a fallback.
  // D3: it is NO LONGER the silent default for sessions with an unknown cwd --
  // see resolveCwd().
  try { mkdirSync(hermesWorkspaceDir, { recursive: true }) } catch {}

  // v0.6.0: the holding workspace for sessions whose ORIGINAL working directory
  // genuinely cannot be determined (no state.db cwd, no git repo root, no
  // '@folder:' hint in the dump). 88 of 145 imported sessions land here.
  //
  // Why a holding workspace at all: DSH can only show a session in the sidebar
  // through a workspace, and workspaceRegistry validates header cwd === the
  // workspace path. Returning undefined (the D3 behaviour) therefore produced
  // sessions that were complete, loadable and yet permanently INVISIBLE.
  //
  // Why this differs from the old hermes-workspace fallback that caused the
  // v0.2.1-class incident: that one pretended an unknown directory WAS the
  // project, silently, for every session. This one is a single, explicitly
  // named holding area ("hermes-imported-unknown-cwd") that a user reads as
  // exactly what it is -- not a project. It is used only after every real
  // signal has failed, never as a first choice.
  //
  // It deliberately does NOT live inside DSH_HOME. dsh-workspace's
  // attachSession() reads the session header through its own host
  // (host.readSessionHeader) and for a session whose cwd resolves inside the
  // DSH state directory that read yields NO cwd, so every attach failed with
  //   "its stored header carries no cwd to validate against"
  // even though the artifact demonstrably stores it (verified by reading the
  // header back through the real jsonl backend). Observed in one run: sessions
  // with cwd elsewhere attached fine; sessions pointed at
  // ~/.dsh/hermes-imported-unknown-cwd all failed. A user-visible directory in
  // the home folder is also a more honest place for it.
  const unknownCwdDir = normalize(
    join(process.env.USERPROFILE || process.env.HOME || '.', 'hermes-imported-unknown-cwd'),
  )
  try { mkdirSync(unknownCwdDir, { recursive: true }) } catch {}

  // ---------------------------------------------------------------------------
  // D2: explicit sessionPersistence API capability self-check.
  //
  // The plugin used to call inspect() / listArtifacts() / a service-level
  // append(id, events), none of which exist in dsh-session-persistence
  // 0.1.5-rc.2. Every import threw a TypeError, the throw was downgraded to
  // status "already_imported", and Hermes -> DSH session sync silently did
  // nothing for 9 days. Detect the incompatibility up front and say so out loud
  // instead of failing one session at a time in silence.
  // ---------------------------------------------------------------------------
  let incompatibilityWarned = false
  function missingPersistenceMethods(sp) {
    return REQUIRED_PERSISTENCE_METHODS.filter((name) => typeof (sp && sp[name]) !== 'function')
  }
  function warnIncompatible(missing) {
    if (incompatibilityWarned) return
    incompatibilityWarned = true
    console.error(
      '[dsh-hermes-link] INCOMPATIBLE DSH sessionPersistence API: ctx.sessionPersistence is missing ' +
      missing.join(', ') +
      '. Hermes -> DSH session import CANNOT work; every session will be reported as import_failed ' +
      '(never as already_imported). Expected the 0.1.5 contract: create/open/stat/list plus a write ' +
      'handle with append/flush/close. Upgrade dsh-hermes-link or the DSH harness.',
    )
  }
  if (ctx && ctx.sessionPersistence) {
    const missingAtStartup = missingPersistenceMethods(ctx.sessionPersistence)
    if (missingAtStartup.length > 0) warnIncompatible(missingAtStartup)
  }

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
   *   caller workspace override  >  state.db cwd (if it exists on disk AND passes
   *   safety)  >  git repo root  >  dump inference (@folder:/cd)  >  undefined.
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
    // macOS temp dirs live under /var/folders (often a symlink to
    // /private/var/folders). These are user-scoped temp dirs, not
    // system-critical /var paths, so they are safe to anchor a session to.
    if (norm === '/var/folders' || norm.startsWith('/var/folders/')) return true
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
/** Normalize a filesystem path for comparison (case + trailing separators). */
  function normalizePath(p) {
    return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function samePath(a, b) {
    return !!a && !!b && normalizePath(a) === normalizePath(b)
  }

  /**
   * Infer the original working directory from a Hermes request dump when
   * state.db has no usable cwd/git_repo_root. Hermes often records `cd
   * "E:/项目/xxx"` in terminal tool calls; the most frequent existing safe
   * directory is treated as the session's original workspace.
   *
   * D3: prompt text is scanned too, so an explicit `@folder:`E:\项目\x`` marker
   * is recognised. Real failing case 20260913_074803_3b7bee has NO tool calls at
   * all -- only a first user message starting with
   * `@folder:`E:\项目\太湖水质预测\地基实现_太湖水质预测`` -- and the old matcher
   * dropped it into the empty hermes-workspace dir.
   */
  function inferWorkspaceFromDump(dump) {
    const counts = new Map()
    const consider = (p, weight = 1) => {
      if (!p || typeof p !== 'string') return
      p = p.trim().replace(/[\\/]+$/, '')
      if (!p || !isSafeCwd(p)) return
      if (!existsSync(p) || !statSync(p).isDirectory()) return
      counts.set(p, (counts.get(p) || 0) + weight)
    }
    // D3: prompts may name the working directory explicitly
    // (`@folder:`E:\项目\x``). Weighted above scraped `cd` hits so a user's
    // explicit statement wins over incidental shell commands in the same dump.
    const considerText = (text) => {
      if (typeof text !== 'string' || !text.includes('@folder:')) return
      for (const re of FOLDER_MARKER_PATTERNS) {
        for (const m of text.matchAll(re)) consider(m[1], FOLDER_MARKER_WEIGHT)
      }
    }
    const considerCommand = (cmd) => {
      if (typeof cmd !== 'string') return
      const patterns = [
        /cd\s+["']([^"']+)["']/g,
        /cd\s+([A-Za-z]:[\\/][^\s"']+)/g,
        /cd\s+(\/[^\s"']+)/g,
      ]
      for (const re of patterns) {
        for (const m of cmd.matchAll(re)) consider(m[1])
      }
    }
    const considerArgs = (args) => {
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { return }
      }
      if (!args || typeof args !== 'object') return
      if (typeof args.command === 'string') considerCommand(args.command)
      for (const key of ['path', 'cwd', 'workspace', 'directory']) {
        if (typeof args[key] === 'string') consider(args[key])
      }
    }
    const messages = dump && dump.request && dump.request.body && Array.isArray(dump.request.body.messages)
      ? dump.request.body.messages
      : []
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc && (tc.function || tc)
          if (fn && fn.arguments) considerArgs(fn.arguments)
          else if (fn && fn.input) considerArgs(fn.input)
        }
      }
      // D3: prompt text (plain string content, or text blocks) may carry @folder:.
      if (typeof m.content === 'string') considerText(m.content)
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text' && typeof block.text === 'string') considerText(block.text)
          else if (block.type === 'tool_use' && block.input) considerArgs(block.input)
        }
      }
    }
    let best = null
    let bestCount = 0
    for (const [p, c] of counts) {
      if (c > bestCount || (c === bestCount && (!best || p.length > best.length))) {
        best = p
        bestCount = c
      }
    }
    return best
  }

  /** True when the persisted log has real DSH-side activity after the seed. */
  function hasPostImportActivity(inspection) {
    const events = (inspection && inspection.events) || []
    let seedIdx = -1
    for (let i = 0; i < events.length; i++) {
      if (events[i] && events[i].type === 'session/end-seed') seedIdx = i
    }
    if (seedIdx < 0) return true // unexpected shape; don't auto-delete
    for (let i = seedIdx + 1; i < events.length; i++) {
      const ev = events[i]
      if (ev && ev.type !== 'session/title') return true
    }
    return false
  }

  // v0.6.0 (D1) fix #7: MSYS / Git-Bash / Cygwin paths are NOT Windows paths.
  //
  // Hermes runs shell commands through Git Bash, so a dump's `cd` / @folder hint
  // can carry a POSIX-style absolute path such as '/c/Users/me/Downloads'.
  // isSafeCwd() deliberately accepts POSIX-absolute paths (correct on macOS and
  // Linux), so on Windows that value used to flow straight into SessionHeader.cwd
  // and then into workspaceRegistry.create(), which refuses it:
  //   "Workspace path is not fully qualified: '/c/Users/me/Downloads'"
  // The session was written and stayed invisible in the sidebar. 90 of 145
  // imported sessions were stranded this way. Translate the drive form, and on
  // Windows refuse anything that still is not fully qualified rather than hand
  // DSH a path it will reject.
  function toPlatformPath(p) {
    if (typeof p !== 'string') return ''
    if (process.platform !== 'win32') return p
    let m = /^\/cygdrive\/([A-Za-z])(\/.*)?$/.exec(p)
    if (!m) m = /^\/([A-Za-z])(\/.*)?$/.exec(p)
    if (m) return m[1].toUpperCase() + ':' + (m[2] || '/').replace(/\//g, '\\')
    return p
  }

  /** Usable cwd: platform-addressable, safe, and a real directory. */
  function isUsableCwd(p) {
    if (typeof p !== 'string' || p.length === 0) return false
    const t = toPlatformPath(p)
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(t)) return false
    if (!isSafeCwd(t)) return false
    try { return existsSync(t) && statSync(t).isDirectory() } catch (_e) { return false }
  }

  // v0.6.0 - single-workspace grouping (the default).
  //
  // Every imported session is anchored to ONE directory, so the sidebar shows a
  // single 'Hermes' workspace instead of dozens of one-session project folders.
  //
  // This also removes a whole class of failure we kept hitting. A session's
  // workspace IS its header cwd, so the only way to regroup a session is to
  // change that cwd - and every cwd change (a) required locating and removing
  // the old artifact, which the current jsonl backend cannot expose, and
  // (b) left DSH's in-process session->cwd index holding the PREVIOUS value,
  // which made workspace attachment fail with "its cwd resolves to <old>".
  // With a fixed anchor the cwd never changes after creation, so neither
  // problem can recur.
  //
  // Set HERMES_LINK_IMPORT_PER_PROJECT=1 to restore per-session cwd inference
  // (original project directory from state.db / git root / '@folder:' hint).
  // Set HERMES_LINK_IMPORT_WORKSPACE=<absolute path> to choose the anchor.
  // Set HERMES_LINK_IMPORT_MODEL=provider/model[#effort] to pin a specific live
  // route on every import (v0.6.0 model pin below; default = the deployment's
  // agent-default-model, i.e. ctx.agentDefaultModel.currentSelection()).
  const groupDirRaw = process.env.HERMES_LINK_IMPORT_WORKSPACE || 'Hermes'
  const groupDir = normalize(
    /^[A-Za-z]:[\\/]|^\//.test(groupDirRaw)
      ? groupDirRaw
      : join(process.env.USERPROFILE || process.env.HOME || '.', groupDirRaw),
  )
  try { mkdirSync(groupDir, { recursive: true }) } catch {}

  function resolveCwd(info, requestedWorkspace, dump) {
    if (requestedWorkspace && typeof requestedWorkspace === 'string' && requestedWorkspace.trim()) {
      return toPlatformPath(requestedWorkspace.trim())
    }
    if (process.env.HERMES_LINK_IMPORT_PER_PROJECT !== '1') return groupDir
    const homeDir = process.env.USERPROFILE || ''
    const stateCwd = isUsableCwd(info && info.cwd) ? toPlatformPath(info.cwd) : null
    const repoRoot = isUsableCwd(info && info.gitRepoRoot) ? toPlatformPath(info.gitRepoRoot) : null
    const inferred = (() => {
      const v = dump ? inferWorkspaceFromDump(dump) : null
      return isUsableCwd(v) ? toPlatformPath(v) : null
    })()
    // Prefer the state.db cwd (authoritative) unless it is just the user's
    // home directory and the dump points at a more specific project.
    if (stateCwd && !(homeDir && samePath(stateCwd, homeDir) && inferred)) {
      return stateCwd
    }
    if (repoRoot) return repoRoot
    if (inferred) return inferred
    // D3 removed the hermes-workspace fallback because it silently parked 46
    // sessions in a directory they never ran in. But returning undefined left
    // the session unattachable (no workspace -> invisible in the sidebar), so
    // "honest" traded one failure for another. The resolution is an explicitly
    // named holding workspace: still never a real project, but attachable.
    return unknownCwdDir
  }

  /**
   * Import one Hermes session into the DSH store as a persisted DSH session
   * with full historical context. Idempotent on session_id (same sid → same
   * DSH id).
   *
   * Persistence contract used here (dsh-session-persistence 0.1.5-rc.2):
   *   stat(id) -> Snapshot | undefined           (replaces inspect())
   *   list()   -> Snapshot[]                     (replaces listArtifacts())
   *   create(header) -> write handle             (the handle owns the writes)
   *   handle.append(events) -> handle.flush() -> handle.close()
   *   (the service-level append(id, events) no longer exists)
   * Every failure is reported as import_failed / create_failed -- never
   * downgraded to already_imported (D2).
   *
   * @param {string} hermesSessionId
   * @param {object} [opts]
   * @param {string} [opts.workspace]   Absolute dir override for this session's cwd.
   * @returns {Promise<object>}
   */
  async function importSession(hermesSessionId, opts = {}) {
    const sp = ctx.sessionPersistence
    if (!sp) {
      throw new Error('dsh-hermes-link: ctx.sessionPersistence not available; is dsh-session-persistence mounted?')
    }
    const dshSessionId = `hermes-${hermesSessionId}`
    // D2: capability self-check. An incompatible API must fail loudly and
    // specifically for every session -- never look like "already imported".
    const missing = missingPersistenceMethods(sp)
    if (missing.length > 0) {
      warnIncompatible(missing)
      return {
        status: 'import_failed',
        hermesSessionId,
        sessionId: dshSessionId,
        eventCount: null,
        error: 'sessionPersistence API incompatible: ctx.sessionPersistence is missing ' + missing.join(', '),
        note: 'needs the 0.1.5 contract: create/open/stat/list + handle append/flush/close',
      }
    }

    const info = await findOne(hermesSessionId)
    if (!info) {
      return { status: 'not_found', hermesSessionId }
    }
    const dump = readJsonFile(info.dump_path)
    if (!dump) {
      return { status: 'read_error', hermesSessionId, dump_path: info.dump_path }
    }

    const finalCwd = resolveCwd(info, opts.workspace, dump)

    // ---- Is this session already persisted? (was inspect(); D1 -> stat) ------
    // We still ensure the workspace exists + session attached (idempotent),
    // because the workspace registry only bootstraps at startup and
    // persisted-only imports that arrived later would otherwise be invisible to
    // the sidebar.
    let existing
    try {
      existing = await sp.stat(dshSessionId)
    } catch (e) {
      if (!isNotFoundError(e)) {
        // D2: ANY non-"not found" failure is a REAL failure and must never be
        // downgraded. The old code funnelled `TypeError: ...inspect is not a
        // function` into its "corrupt artifact" branch and answered
        // already_imported, which is why sync() skipped every session silently
        // for 9 days.
        return {
          status: 'import_failed',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: null,
          cwd: finalCwd,
          error: 'sessionPersistence.stat failed: ' + describeError(e),
          note: (e && e.location && e.location.path)
            ? 'raw log: ' + e.location.path
            : 'the stored session was not modified',
        }
      }
      existing = undefined
    }

    if (existing) {
      const existingCwd = (existing.header && existing.header.cwd) || null
      // D3: only a BETTER cwd may trigger a rebuild. An unresolved cwd must
      // never churn an existing session into the backend's _no-cwd project.
      const cwdChanged = typeof finalCwd === 'string' && finalCwd.length > 0 && !samePath(existingCwd, finalCwd)
      if (!cwdChanged) {
        const attachErr = await attachToWorkspace(ctx, finalCwd || existingCwd, dshSessionId)
        return {
          status: 'already_imported',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: typeof existing.eventCount === 'number' ? existing.eventCount : null,
          firstUserSnippet: info.first_user_snippet,
          title: info.title || null,
          cwd: finalCwd || existingCwd,
          model: info.model || null,
          note: 'already persisted',
          attach: attachErr ? ('failed: ' + attachErr) : 'ok',
        }
      }
      // Workspace changed (e.g. old hermes-workspace fallback -> now inferred or
      // state.db cwd). Auto-rebuild only when no DSH-side activity exists after
      // the seed; otherwise we would delete real work done in the imported session.
      let storedEvents = null
      let readErr = null
      try {
        storedEvents = await readStoredEvents(sp, dshSessionId)
      } catch (e) {
        readErr = e
      }
      if (readErr && !isUnreadableStoredLog(readErr)) {
        // A read failure we must not paper over (permissions, IO, a removed
        // API, ...). Report it; never answer already_imported.
        return {
          status: 'import_failed',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: null,
          cwd: existingCwd || finalCwd,
          error: 'the stored session could not be read: ' + describeError(readErr),
          note: isNotFoundError(readErr)
            ? 'the session disappeared between stat() and open() (concurrent delete); the next sync recreates it'
            : 'cwd changed to ' + finalCwd + ' but the stored log is unreadable',
        }
      }
      // A stored log the current validator refuses can never be resumed as-is,
      // so it is rebuildable; a readable log with post-seed activity is NOT (it
      // holds real DSH-side work).
      const rebuildable = !!readErr || !hasPostImportActivity({ events: storedEvents })
      if (!rebuildable) {
        const attachErr = await attachToWorkspace(ctx, existingCwd || finalCwd, dshSessionId)
        return {
          status: 'already_imported',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: null,
          firstUserSnippet: info.first_user_snippet,
          title: info.title || null,
          cwd: existingCwd || finalCwd,
          model: info.model || null,
          note: 'cwd changed to ' + finalCwd + ' but session has post-import activity; automatic rebuild skipped',
          attach: attachErr ? ('failed: ' + attachErr) : 'ok',
        }
      }
      // Rebuild: the physical artifact must go first, because create() refuses
      // an id the backend still holds. Snapshots from stat()/list() carry no
      // path (D1), so the path has to come from a format refusal's documented
      // location or the backend's listArtifacts() hook; when neither yields one
      // this FAILS loudly instead of answering already_imported.
      const removal = await removeStoredArtifact(sp, dshSessionId, readErr)
      if (!removal.ok) {
        return {
          status: 'import_failed',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: null,
          cwd: existingCwd || finalCwd,
          error: 'cwd changed to ' + finalCwd + ' but the persisted session could not be located/removed: ' + (removal.error || 'no artifact path available'),
          note: readErr ? 'stored log unreadable: ' + describeError(readErr) : 'persisted session left untouched',
        }
      }
      console.log('[dsh-hermes-link] removed persisted session ' + dshSessionId + ' (' + removal.path +
        ') -> rebuilding in workspace ' + finalCwd + (readErr ? ' [reason: ' + describeError(readErr) + ']' : ''))
      // artifact removed → fall through to create with the new workspace
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

    // v0.6.0: pin the session's live model route (resolveImportModelSelection
    // carries the full rationale). APPENDED, never substituted into history --
    // the historic request/header keeps the Hermes model as provenance.
    const modelSelection = resolveImportModelSelection({ ctx, selection: defaultModel })
    if (modelSelection) {
      allEvents.push({
        type: 'model/selection',
        seq: allEvents.length,
        time: titleTime,
        data: { ...modelSelection },
      })
    }

    // Header contract (DSH 0.1.5-rc.2):
    //   - create() takes a *logical* SessionHeader and the backend's codec
    //     asserts its exact key set (assertReleasedV2Keys): version, id,
    //     createdAt, isSeeded, delegationDepth, cwd, parentSession, origin,
    //     agentPreset -- and NOTHING else. The on-disk "type": "session" tag is
    //     added by the codec itself (releasedV2 encodeHeader), so passing it
    //     here throws "unexpected field type".
    //   - version must equal SESSION_FORMAT_VERSION (= 3); the old literal 0 and
    //     the missing isSeeded were refused outright.
    //   - cwd is optional but must be absolute; delegationDepth a safe int >= 0.
    const version = await resolveSessionFormatVersion()
    const header = {
      version,
      id: dshSessionId,
      createdAt: (events[0] && events[0].time) || Date.now(),
      isSeeded: false,
      delegationDepth: 0,
      ...(finalCwd ? { cwd: finalCwd } : {}),
      agentPreset: 'hermes-imported',
    }

    let handle
    try {
      handle = await sp.create(header)
    } catch (e) {
      if (isAlreadyExistsError(e)) {
        // stat() said "absent" but the backend holds the id -- e.g. a stored
        // header stat() cannot read. Do not claim success; explain instead.
        const listed = await findSnapshotInList(sp, dshSessionId)
        return {
          status: 'import_failed',
          hermesSessionId,
          sessionId: dshSessionId,
          eventCount: allEvents.length,
          cwd: finalCwd,
          error: 'sessionPersistence.create reported an existing session that stat() did not see: ' + describeError(e),
          note: listed && listed.header
            ? 'list() reports it with cwd ' + (listed.header.cwd || '(none)') + '; the stored artifact was left untouched'
            : 'the stored artifact was left untouched' + (listed && listed.listError ? ' (list() also failed: ' + listed.listError + ')' : ''),
        }
      }
      return {
        status: 'create_failed',
        hermesSessionId,
        sessionId: dshSessionId,
        cwd: finalCwd,
        error: 'sessionPersistence.create failed: ' + describeError(e),
        eventCount: allEvents.length,
      }
    }

    // The handle returned by create() owns the writes now (D1): the service has
    // no append(id, events) any more.
    const handleMissing = REQUIRED_HANDLE_METHODS.filter((m) => typeof handle[m] !== 'function')
    if (handleMissing.length > 0) {
      try { await handle.close() } catch {}
      console.error('[dsh-hermes-link] INCOMPATIBLE session handle from create(): missing ' +
        handleMissing.join(', ') + ' (expected SessionHandle.append/flush/close)')
      return {
        status: 'import_failed',
        hermesSessionId,
        sessionId: dshSessionId,
        eventCount: allEvents.length,
        cwd: finalCwd,
        error: 'the session handle returned by create() is missing ' + handleMissing.join(', '),
        note: 'expected SessionHandle.append/flush/close (0.1.5 contract)',
      }
    }

    try {
      await handle.append(allEvents)
      await handle.flush() // durability barrier: only a resolved flush promises storage
    } catch (e) {
      let closeErr = null
      try { await handle.close() } catch (ce) { closeErr = ce }
      // Closing an unmaterialized write handle discards the created session
      // (the jsonl backend releases it without a filesystem footprint), so
      // check what actually survived instead of guessing.
      let leftover = null
      try {
        leftover = await sp.stat(dshSessionId)
      } catch (statErr) {
        leftover = { statError: describeError(statErr) }
      }
      const cleanup = leftover ? await removeStoredArtifact(sp, dshSessionId, e) : { ok: false }
      const leftoverNote = !leftover
        ? 'nothing was left on disk; the next sync can retry'
        : cleanup.ok
          ? 'partial artifact removed; the next sync can retry'
          : 'a partial artifact REMAINS: ' + (cleanup.error || 'no artifact path available') +
            (leftover.statError ? ' (stat() also failed: ' + leftover.statError + ')' : '')
      return {
        status: 'create_failed',
        hermesSessionId,
        sessionId: dshSessionId,
        cwd: finalCwd,
        error: 'created the session but failed to write its events: ' + describeError(e),
        eventCount: allEvents.length,
        note: leftoverNote + (closeErr ? '; handle close also failed: ' + describeError(closeErr) : ''),
      }
    }
    let closeFailure = null
    try { await handle.close() } catch (e) { closeFailure = e }

    // Ensure the workspace exists + session attached (sidebar grouping).
    const attachErr = await attachToWorkspace(ctx, finalCwd, dshSessionId)

    return {
      status: 'created',
      hermesSessionId,
      sessionId: dshSessionId,
      eventCount: allEvents.length,
      firstUserSnippet: info.first_user_snippet,
      cwd: finalCwd,
      title,
      model: info.model || null,
      modelSelection,
      persisted_only: true,
      note: 'persisted to disk; open from the sidebar to resume' +
        (closeFailure ? ' (handle close failed: ' + describeError(closeFailure) + ')' : ''),
      attach: attachErr ? ('failed: ' + attachErr) : 'ok',
    }
  }

  /**
   * Read the complete stored event log through a READ handle. Reading never
   * takes write ownership; the handle is always closed.
   * @returns {Promise<readonly object[]>}
   */
  async function readStoredEvents(sp, id) {
    const handle = await sp.open(id, 'read')
    try {
      const slice = await handle.read(0)
      return (slice && Array.isArray(slice.events)) ? slice.events : []
    } finally {
      try { await handle.close() } catch {}
    }
  }

  /**
   * D1: `listArtifacts()` -> `list()`. Snapshots carry the header + revision
   * (and sometimes eventCount/sizeBytes) but deliberately NO artifact path.
   * Used as a second opinion / diagnostic, never as the primary existence check
   * (stat() is exact and cheaper). Never throws: a list() failure is reported
   * in `listError` so the caller can put it in a result instead of hiding it.
   * @returns {Promise<object|null>}
   */
  async function findSnapshotInList(sp, id) {
    try {
      const snapshots = await sp.list()
      return (snapshots || []).find((s) => s && s.header && s.header.id === id) || null
    } catch (e) {
      return { listError: describeError(e) }
    }
  }

  /**
   * Locate and remove the physical artifact of a stored DSH session.
   *
   * listArtifacts() left the published SessionPersistence contract in
   * 0.1.5-rc.2 (D1) and stat()/list() snapshots carry no path, so a removal can
   * only be driven by:
   *   1. `SessionFormatUnsupportedError.location.path` -- the documented raw-log
   *      location attached to a format refusal, or
   *   2. the shipped jsonl backend's still-present listArtifacts() hook,
   *      feature-detected and used ONLY to find a path -- never to decide
   *      whether a session exists.
   * When neither yields a path the removal FAILS and the caller reports
   * import_failed; it never falls back to already_imported.
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  async function removeStoredArtifact(sp, id, cause) {
    let path = (cause && cause.location && typeof cause.location.path === 'string') ? cause.location.path : null
    if (!path && typeof sp.listArtifacts === 'function') {
      try {
        const artifacts = await sp.listArtifacts()
        const hit = (artifacts || []).find((a) => a &&
          ((a.header && a.header.id === id) || (a.meta && a.meta.id === id)))
        if (hit && typeof hit.path === 'string' && hit.path) path = hit.path
      } catch (e) {
        return { ok: false, error: 'listArtifacts() failed: ' + describeError(e) }
      }
    }
    if (!path) {
      return { ok: false, error: 'the backend exposes no artifact path for this session (stat/list snapshots carry none)' }
    }
    try {
      await rm(path, { force: true })
      return { ok: true, path }
    } catch (e) {
      return { ok: false, path, error: 'rm(' + path + ') failed: ' + describeError(e) }
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
    // v0.6.0 (D5) fix #6: the import pass can leave a stale account behind when a
    // session's cwd is corrected (old record keeps the id -> next boot dies in
    // validateStoredState). Collapse duplicates before returning.
    await pruneDuplicateMemberships(ctx)
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
      // D2: one loud summary on top of the per-session lines, so a silently
      // broken import path cannot pass for a healthy one.
      console.error('[dsh-hermes-link] sync: ' + r.imported + ' imported, ' + r.skipped +
        ' already imported, ' + r.failed + ' FAILED -- Hermes -> DSH session import is not fully working')
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

  // toPlatformPath / isUsableCwd are exposed for tests only (they are pure).
  // modelRoute() answers "what would the next import pin?" -- the live check that
  // would have caught the v0.6.6 bug (imports silently pinned nothing because the
  // agentDefaultModel service was unreachable) without reading 33 artifacts.
  return { list, findOne, importSession, importAll, sync, renameAll, sessionsDir, hermesWorkspaceDir, unknownCwdDir, toPlatformPath, isUsableCwd, modelRoute: () => resolveImportModelSelection({ ctx }) }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Create (or reuse) the workspace for `cwd` and attach one session to it.
 * Membership requires session header cwd === workspace path. Never throws —
 * returns an error string when it cannot attach.
 */
export async function attachToWorkspace(ctx, cwd, sessionId) {
  try {
    const reg = ctx && ctx.workspaceRegistry
    if (!reg) return 'workspaceRegistry unavailable'
    if (!cwd || !existsSync(cwd)) return 'cwd missing: ' + (cwd || '(none)')
    const title = basenameOf(cwd)
    const ws = await reg.create(cwd, title)
    // v0.6.0 (D5) fix #6: attach FIRST, then evict the stale residue.
    //
    // dsh-workspace#attachSession() only validates the stored header cwd and
    // then pushes the id -- it never removes that id from the record which
    // already accounted for the session. So a re-import that corrects a cwd
    // (e.g. the old hermes-workspace fallback -> the real project dir) left the
    // id in BOTH records and the next boot died in
    // dsh-workspace#validateStoredState (fail-closed, never self-heals):
    //   "workspace domain is inconsistent: session 'X' is accounted by both
    //    workspace 'A' and workspace 'B'"
    //
    // Order matters, and fix #5 had it backwards: detaching BEFORE the attach
    // orphans the session whenever the attach then fails -- and it does fail
    // routinely, because the header index lags behind a fresh re-import
    // ("cannot attach ...: its cwd resolves to '<the OLD path>'"). Attaching
    // first means a failed attach changes nothing, and only a SUCCESSFUL attach
    // triggers the eviction below, at which point every other account of that id
    // is by definition stale. Read `record.sessionIds` (the persisted account)
    // instead of the `sessionIds` getter: that getter filters by the live header
    // index and hides exactly the stale entry being hunted. detachSession() is
    // idempotent and never touches the session's own stored log.
    await ws.attachSession(sessionId)
    if (typeof reg.list === 'function') {
      for (const other of reg.list()) {
        if (!other || typeof other.detachSession !== 'function') continue
        // Compare identity defensively: reg.list() may hand back fresh entity
        // objects, so `other === ws` alone is not enough to protect the record
        // we just attached to.
        if (other === ws || (ws.id && other.id && other.id === ws.id) || (ws.path && other.path === ws.path)) continue
        let raw = []
        try { raw = Array.from((other.record && other.record.sessionIds) || []) } catch (_e) { raw = [] }
        if (!raw.includes(sessionId)) {
          try { raw = Array.from(other.sessionIds || []) } catch (_e) { raw = [] }
        }
        if (!raw.includes(sessionId)) continue
        try { await other.detachSession(sessionId) } catch (_e) { /* best-effort */ }
      }
    }
    return null
  } catch (e) {
    return String(e && e.message || e)
  }
}

// -----------------------------------------------------------------------------
// v0.6.0 (D5) fix #6: duplicate workspace accounts block the next boot.
//
// dsh-workspace#validateStoredState() is fail-closed: when ONE session id is
// listed by TWO workspace records, the whole plugin tree refuses to load with
//   "workspace domain is inconsistent: session 'X' is accounted by both
//    workspace 'A' and workspace 'B'"
// and it never self-heals -- dsh stays down until workspace.json is edited by
// hand (see scripts/_fix-workspace-registry.py + scripts/_dump-session-cwds.mjs).
// The duplicate comes from
// re-importing a session whose cwd was corrected: the old record keeps the id.
// attachToWorkspace() now detaches the raw account before attaching, which
// stops NEW duplicates; this sweep cleans up ones already on disk. It is a
// no-op unless a record really holds an id it must not hold.
// -----------------------------------------------------------------------------

/**
 * Detach every session id that two workspace records both account.
 * The keeper is the record whose filtered view still shows the session (its
 * path equals the session's canonical cwd), else the most recently touched one.
 * @returns {Promise<number>} number of stale memberships detached
 */
export async function pruneDuplicateMemberships(ctx) {
  try {
    const reg = ctx && ctx.workspaceRegistry
    if (!reg || typeof reg.list !== 'function') return 0
    const holders = new Map()
    for (const ws of reg.list()) {
      let raw = []
      try { raw = Array.from((ws.record && ws.record.sessionIds) || []) } catch (_e) { raw = [] }
      let live = []
      try { live = Array.from(ws.sessionIds || []) } catch (_e) { live = [] }
      if (!raw.length) raw = live
      const liveSet = new Set(live)
      for (const sid of raw) {
        if (!holders.has(sid)) holders.set(sid, [])
        holders.get(sid).push({ ws, live: liveSet.has(sid) })
      }
    }
    let detached = 0
    for (const [sid, list] of holders) {
      if (list.length < 2) continue
      // The owner is the record whose filtered view still shows the session
      // (its path equals the session's canonical cwd); if the header is
      // unreadable -- or, which should be impossible, two records both claim it
      // -- fall back to the most recently touched record.
      const liveOnes = list.filter((h) => h.live)
      const keeper = (liveOnes.length ? liveOnes : list)
        .slice()
        .sort((a, b) => String(b.ws.updatedAt || '').localeCompare(String(a.ws.updatedAt || '')))[0]
      for (const h of list) {
        if (h.ws === keeper.ws) continue
        try {
          await h.ws.detachSession(sid)
          detached += 1
          console.log('[dsh-hermes-link] duplicate workspace account repaired: ' + sid +
            ' kept in ' + keeper.ws.path + ', detached from ' + h.ws.path)
        } catch (_e) { /* best-effort */ }
      }
    }
    return detached
  } catch (e) {
    console.warn('[dsh-hermes-link] pruneDuplicateMemberships skipped:', (e && e.message) || e)
    return 0
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

/**
 * Error classification is by `name`, never by matching message text: the
 * persistence errors carry stable names (SessionPersistenceNotFoundError,
 * SessionAlreadyExistsError, SessionPersistenceCorruptionError,
 * SessionFormatUnsupportedError) while messages are free to change. The old
 * `msg.includes('not found')` heuristic is what turned a TypeError from a
 * removed API into a fake "already imported".
 */
function isNotFoundError(e) {
  return !!e && e.name === 'SessionPersistenceNotFoundError'
}

function isAlreadyExistsError(e) {
  return !!e && e.name === 'SessionAlreadyExistsError'
}

/**
 * True when a stored log exists but this build cannot faithfully read it --
 * corruption, or a format/event vocabulary refusal. Such a session can never be
 * resumed, so rebuilding it from the request dump is the only recovery.
 */
function isUnreadableStoredLog(e) {
  if (!e) return false
  const name = String(e.name || '')
  if (name === 'SessionPersistenceCorruptionError' || name === 'SessionFormatUnsupportedError') return true
  const msg = String(e.message || '')
  return msg.includes('failed validation') || msg.includes('malformed')
}

/** Human-readable `Name: message` for a failure result (never `[object Object]`). */
function describeError(e) {
  if (!e) return 'unknown error'
  const name = e.name ? String(e.name) : 'Error'
  const msg = String(e.message || e)
  return msg ? name + ': ' + msg : name
}