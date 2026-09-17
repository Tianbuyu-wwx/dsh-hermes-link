// services/session-mirror.mjs
//
// v0.4.0 - automatic DSH session mirror (V4).
// v0.6.0 (B) - HERMES_LINK_MIRROR_POLICY: the mirror is ON by default, but only
// for sessions whose cwd provably belongs to a project Hermes already has a
// session for (policy 'scoped'); 'off' restores the old manual opt-in and 'all'
// mirrors every session. services/mirror-policy.mjs owns the policy + the echo/
// noise guard; docs/impl-brief-B-mirror-policy.md has the rationale.
//
// Once a session is mirrored, every new session event is:
//   1. dropped when the echo/noise guard rejects it (hermes-* / hermes-imported
//      sessions, or a lifecycle/bookkeeping type - see NOISE_EVENT_TYPES),
//   2. redacted with the shared redactor (services/redact.mjs),
//   3. appended to Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl,
//   4. published on the session SSE channel when an sseBroker is supplied, so
//      Hermes can subscribe in real time.
//
// An explicit 'session_mirror action=disable' is durable: it is recorded as an
// opt-out so the policy cannot silently re-enable that session later.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './audit.mjs'
import { safeSessionId } from './outbox.mjs'
import { redactEvent } from './redact.mjs'
import { matchHermesProject } from './hermes-project-memory.mjs'
import {
  MIRROR_PROJECTS_ENV_VAR,
  POLICY_ENV_VAR,
  decideMirrorPolicy,
  isEchoSession,
  isNoiseEvent,
  foldCwd,
  parseMirrorProjects,
  resolveMirrorPolicy,
  sessionCwd,
} from './mirror-policy.mjs'

const PERSIST_EVERY_N_EVENTS = 25
const MAX_DECISION_CACHE = 2000

export function createSessionMirror({ hermesHome, outbox, sseBroker, metrics, matchProject, env } = {}) {
  const statePath = join(stateDir(), 'session-mirror-state.json')
  const mirrorDir = join(hermesHome, 'inbox', 'dsh', 'session-mirror')

  // --- policy (v0.6.0 B) --------------------------------------------------
  const policyInfo = resolveMirrorPolicy(env || process.env)
  // v0.6.0: local paths that are in scope even when Hermes' recorded project key
  // is stale (directory renamed/moved) or missing (cwd=null rows). See
  // parseMirrorProjects() for the live evidence that motivated this.
  //
  // TWO sources, merged:
  //   1. HERMES_LINK_MIRROR_PROJECTS (process env) -- frozen at process start;
  //      on Windows a user-level var only reaches processes started from a NEW
  //      shell (setx does NOT update an open one), which is exactly how the
  //      first live attempt to enable this repo failed: extra_projects was still
  //      [] after a restart.
  //   2. <state>/mirror-projects.json ({"projects":[...]}) owned by this plugin.
  //      It is re-read when its mtime changes, and the decision cache below is
  //      keyed by that revision -- so adding a project takes effect on the NEXT
  //      EVENT, without restarting DSH at all.
  const projectsFile = join(stateDir(), 'mirror-projects.json')
  const envProjects = parseMirrorProjects(env || process.env)
  let projectsFileCache = { mtimeMs: -1, revision: 0, list: [] }

  function projectsFromFile() {
    let mtimeMs = -1
    let text = null
    try {
      const st = statSync(projectsFile)
      mtimeMs = st.mtimeMs
      if (mtimeMs === projectsFileCache.mtimeMs) return projectsFileCache
      text = readFileSync(projectsFile, 'utf8')
    } catch (_e) {
      // Absent/unreadable file: fall back to the env list, never fail the mirror.
      // A file that DISAPPEARS (or one whose error clears) must bump the revision
      // so cached decisions stop applying.
      if (projectsFileCache.mtimeMs !== -1 || projectsFileCache.error) {
        projectsFileCache = { mtimeMs: -1, revision: projectsFileCache.revision + 1, list: [], error: null }
      }
      return projectsFileCache
    }
    let list = []
    let error = null
    try {
      // BOM-tolerant. Windows tooling (PowerShell `Set-Content -Encoding utf8`,
      // Notepad) writes UTF-8 WITH a BOM and JSON.parse refuses it. Live evidence
      // 2026-09-17: the first real mirror-projects.json was written exactly that
      // way, and the mirror stayed silently OFF with the file sitting right there
      // (extra_projects: [], projects_file_revision: 0) -- the same BOM trap that
      // already bit the outbox consumer, consult sweep and doctor.
      const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
      const parsed = JSON.parse(stripped)
      const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.projects) ? parsed.projects : [])
      for (const p of raw) { const folded = foldCwd(p); if (folded && !list.includes(folded)) list.push(folded) }
    } catch (e) {
      error = String((e && e.message) || e)
      // A broken config must be VISIBLE, never a silent no-op: warn once per change.
      console.warn('[dsh-hermes-link] ' + projectsFile + ' is unreadable (' + error + ') -- falling back to ' +
        MIRROR_PROJECTS_ENV_VAR + ' only; the mirror scope is NOT what the file says')
    }
    if (mtimeMs === projectsFileCache.mtimeMs && error === projectsFileCache.error) return projectsFileCache
    projectsFileCache = { mtimeMs, revision: projectsFileCache.revision + 1, list, error }
    return projectsFileCache
  }

  /** Merged, folded in-scope list (env first, then the plugin-owned file). */
  function currentExtraProjects() {
    const merged = [...envProjects]
    for (const p of projectsFromFile().list) if (!merged.includes(p)) merged.push(p)
    return merged
  }
  const matchProjectFn = typeof matchProject === 'function'
    ? matchProject
    : (cwd) => matchHermesProject(hermesHome, cwd)
  // Sessions already decided by the policy. Without this cache every single
  // session event would re-open Hermes state.db; the key carries the cwd so a
  // session whose cwd only becomes known later is re-evaluated.
  const decisions = new Map()

  // Telemetry is best-effort and NEVER load-bearing: services/metrics.mjs
  // throws on inc()/set() of an unregistered metric, so an embedder with a
  // different registry shape must not be able to break mirroring (same
  // contract as http/_util.mjs incMetric).
  function incMetric(name, labels) {
    try { if (metrics && typeof metrics.inc === 'function') metrics.inc(name, labels) } catch (_e) { /* never load-bearing */ }
  }
  function setMetric(name, value, labels) {
    try { if (metrics && typeof metrics.set === 'function') metrics.set(name, value, labels) } catch (_e) { /* never load-bearing */ }
  }

  if (policyInfo.invalid) console.warn(policyInfo.warning)
  console.log('[dsh-hermes-link] session-mirror policy=' + policyInfo.policy + ' (' + POLICY_ENV_VAR +
    (policyInfo.source === 'env' ? '=' + policyInfo.requested : ' unset -> default') + ')')
  setMetric('hermes_link_mirror_policy_info', 1, { policy: policyInfo.policy })

  let state = loadState()
  function loadState() {
    try {
      if (existsSync(statePath)) {
        const data = JSON.parse(readFileSync(statePath, 'utf8'))
        if (data && data.sessions && typeof data.sessions === 'object') {
          return {
            sessions: data.sessions,
            // v0.6.0 (B): explicit opt-outs. Pre-v0.6.0 state files have none.
            opt_out: (data.opt_out && typeof data.opt_out === 'object') ? data.opt_out : {},
          }
        }
      }
    } catch (e) {
      console.warn('[dsh-hermes-link] session-mirror state load failed, starting empty:', e && e.message || e)
    }
    return { sessions: {}, opt_out: {} }
  }

  function persist() {
    try {
      mkdirSync(stateDir(), { recursive: true })
      const tmp = statePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, statePath)
    } catch (e) {
      console.error('[dsh-hermes-link] session-mirror state save failed:', e && e.message || e)
    }
  }

  function recFor(sessionId) {
    const safeId = safeSessionId(sessionId)
    return { safeId, rec: state.sessions[safeId] || null }
  }

  function isOptedOut(safeId) {
    return !!(state.opt_out && state.opt_out[safeId])
  }

  /** Echo/noise guard shared by handleEvent() and the enable() backfill.
   *  Returns a reason string, or null when the event may be mirrored. */
  function guardReason(sessionId, event, session) {
    if (isEchoSession(sessionId, session || null)) return 'echo_session'
    if (isNoiseEvent(event)) return 'noise_event'
    return null
  }

  function status(sessionId) {
    const { safeId, rec } = recFor(sessionId)
    const path = join(mirrorDir, safeId + '.jsonl')
    let file = null
    try {
      if (existsSync(path)) {
        const st = statSync(path)
        file = {
          size_bytes: st.size,
          mtime_ms: st.mtimeMs,
          updated_at: new Date(st.mtimeMs).toISOString(),
        }
      }
    } catch (_e) { /* best-effort */ }
    return {
      session_id: rec && rec.session_id ? rec.session_id : String(sessionId),
      safe_session_id: safeId,
      enabled: !!rec,
      enabled_at: rec ? rec.enabled_at : null,
      mirror_path: path,
      file_exists: !!file,
      file,
      event_count: rec ? rec.event_count || 0 : 0,
      last_event_at: rec ? rec.last_event_at || null : null,
      redacted_blocks: rec ? rec.redacted_blocks || 0 : 0,
      // v0.6.0 (B): default_off now means 'the mirror is globally off by
      // default' (HERMES_LINK_MIRROR_POLICY=off), i.e. every session needs an
      // explicit action=enable - the pre-v0.6.0 behaviour. Under the default
      // 'scoped' policy some sessions are mirrored without any user action, so
      // reporting true here would be a lie. The per-session truth is in
      // enabled / auto / policy.
      default_off: policyInfo.policy === 'off',
      policy: policyInfo.policy,
      source: rec ? (rec.source || 'explicit') : null,
      auto: !!(rec && rec.source === 'policy'),
      enable_reason: rec ? (rec.reason || null) : null,
      match_via: rec ? (rec.via || null) : null,
      opted_out: isOptedOut(safeId),
      echo_guard: isEchoSession(sessionId, null),
      events_skipped: rec ? rec.events_skipped || 0 : 0,
      last_skip_reason: rec ? (rec.last_skip_reason || null) : null,
    }
  }

  /** What the resolved policy is (used by status output / doctor / tests). */
  function policyStatus() {
    let autoEnabled = 0
    for (const k of Object.keys(state.sessions)) {
      if (state.sessions[k] && state.sessions[k].source === 'policy') autoEnabled++
    }
    return {
      policy: policyInfo.policy,
      requested: policyInfo.requested,
      source: policyInfo.source,
      invalid: policyInfo.invalid,
      env_var: POLICY_ENV_VAR,
      auto_enabled_sessions: autoEnabled,
      opted_out_sessions: Object.keys(state.opt_out || {}).length,
      // v0.6.0: the explicit in-scope paths, so "why is nothing mirrored?" can
      // be answered without reading the process environment.
      extra_projects: currentExtraProjects(),
      projects_env_var: MIRROR_PROJECTS_ENV_VAR,
      projects_file: projectsFile,
      projects_file_revision: projectsFromFile().revision,
      // Non-null when the file exists but could not be parsed: the mirror is
      // then running on the env list alone, which is exactly the state that must
      // never be silent again.
      projects_file_error: projectsFromFile().error || null,
    }
  }

  /** Run the policy for one session id; enable() when it says so. */
  function policyDecision(sessionId, opts) {
    const session = (opts && opts.session) || null
    const cwd = (opts && typeof opts.cwd === 'string' && opts.cwd) || sessionCwd(session)
    const safeId = safeSessionId(sessionId)
    const projectConfig = projectsFromFile()
    // The config revision is part of the cache key: editing mirror-projects.json
    // must re-decide every affected session instead of serving a cached "skip".
    const key = safeId + '\u0000' + cwd + '\u0000' + projectConfig.revision
    const cached = decisions.get(key)
    if (cached) return cached

    const decision = decideMirrorPolicy({
      policy: policyInfo.policy,
      sessionId,
      cwd,
      session,
      isOptedOut: isOptedOut(safeId),
      matchProject: matchProjectFn,
      extraProjects: currentExtraProjects(),
    })
    if (decisions.size >= MAX_DECISION_CACHE) decisions.clear()
    decisions.set(key, decision)

    if (decision.decision === 'enable') {
      incMetric('hermes_link_mirror_policy_auto_enabled_total', { policy: policyInfo.policy })
      enable(sessionId, { source: 'policy', cwd, reason: decision.reason, via: decision.via })
    } else {
      incMetric('hermes_link_mirror_policy_auto_skipped_total', { policy: policyInfo.policy, reason: decision.reason })
    }
    return decision
  }

  /**
   * Is this session mirrored? With HERMES_LINK_MIRROR_POLICY=scoped (default)
   * the first call for an in-scope session auto-enables it.
   * opts: { cwd, session } - the DSH Session is used for header.cwd and for the
   * hermes-imported agentPreset echo signal.
   */
  function isEnabled(sessionId, opts) {
    const { safeId, rec } = recFor(sessionId)
    if (rec) return true
    // An explicit disable outranks the policy, otherwise the switch the user
    // just flipped would be undone by the next session event or DSH restart.
    if (isOptedOut(safeId)) return false
    return policyDecision(sessionId, opts).decision === 'enable'
  }

  function enable(sessionId, { events, redact = true, source = 'explicit', cwd, reason, via } = {}) {
    const { safeId } = recFor(sessionId)
    // An explicit enable clears a previous opt-out. The policy path never
    // reaches here for an opted-out session (decideMirrorPolicy skips first).
    if (state.opt_out && state.opt_out[safeId]) delete state.opt_out[safeId]
    if (!state.sessions[safeId]) {
      state.sessions[safeId] = {
        session_id: String(sessionId),
        enabled_at: Date.now(),
        event_count: 0,
        redacted_blocks: 0,
        events_skipped: 0,
        last_event_at: null,
      }
    }
    const rec = state.sessions[safeId]
    rec.source = source
    if (cwd) rec.cwd = cwd
    if (reason) rec.reason = reason
    if (via) rec.via = via
    persist()
    if (sseBroker && typeof sseBroker.attachTask === 'function') {
      sseBroker.attachTask('session:' + safeId, {
        kind: 'session-mirror',
        session_id: String(sessionId),
        attached_at: Date.now(),
      })
    }
    if (Array.isArray(events) && events.length > 0) {
      for (const ev of events) {
        const skip = guardReason(sessionId, ev)
        if (skip) {
          rec.events_skipped = (rec.events_skipped || 0) + 1
          rec.last_skip_reason = skip
          incMetric('hermes_link_mirror_events_skipped_total', { reason: skip })
          continue
        }
        const { event: cleaned, redacted_blocks } = redact ? redactEvent(ev) : { event: ev, redacted_blocks: 0 }
        if (outbox && outbox.appendSessionEvent(sessionId, cleaned)) {
          rec.event_count = (rec.event_count || 0) + 1
          rec.redacted_blocks = (rec.redacted_blocks || 0) + redacted_blocks
          rec.last_event_at = Date.now()
        }
      }
      persist()
    }
    return status(sessionId)
  }

  function disable(sessionId) {
    const { safeId } = recFor(sessionId)
    delete state.sessions[safeId]
    // Durable opt-out (v0.6.0 B): without the tombstone the scoped/all policy
    // would re-enable this session on the next event or after a DSH restart,
    // silently undoing the user's explicit disable.
    state.opt_out[safeId] = { disabled_at: Date.now() }
    persist()
    return status(sessionId)
  }

  /** Handle one new session event when automatic mirroring is enabled. */
  function handleEvent(sessionId, event, opts) {
    const { safeId, rec } = recFor(sessionId)
    if (!rec) return false
    // Echo/noise guard (v0.6.0 B5). A skipped event is counted, never written
    // and never published - this is the loop that used to write Hermes' own
    // imported transcript back into Hermes.
    const skip = guardReason(sessionId, event, opts && opts.session)
    if (skip) {
      rec.events_skipped = (rec.events_skipped || 0) + 1
      rec.last_skip_reason = skip
      incMetric('hermes_link_mirror_events_skipped_total', { reason: skip })
      if (rec.events_skipped % PERSIST_EVERY_N_EVENTS === 0) persist()
      return false
    }
    // Automatic mirroring always redacts. The one-shot tool can still opt out
    // explicitly when the caller has already audited the payload.
    const { event: cleaned, redacted_blocks } = redactEvent(event)
    let ok = false
    if (outbox) ok = outbox.appendSessionEvent(sessionId, cleaned)
    if (ok) {
      rec.event_count = (rec.event_count || 0) + 1
      rec.redacted_blocks = (rec.redacted_blocks || 0) + redacted_blocks
      rec.last_event_at = Date.now()
      if (rec.event_count % PERSIST_EVERY_N_EVENTS === 0) persist()
      if (sseBroker && typeof sseBroker.attachTask === 'function' && typeof sseBroker.publish === 'function') {
        sseBroker.attachTask('session:' + safeId, {
          kind: 'session-mirror',
          session_id: String(sessionId),
        })
        sseBroker.publish('session:' + safeId, {
          kind: 'session/event',
          data: {
            session_id: String(sessionId),
            ts: Date.now(),
            event_type: event && event.type || null,
            seq: event && event.seq != null ? event.seq : null,
            redacted_blocks,
          },
        })
      }
    }
    return ok
  }

  function listStatus() {
    return Object.keys(state.sessions)
      .map((safeId) => status(safeId))
      .sort((a, b) => (b.enabled_at || 0) - (a.enabled_at || 0))
  }

  /**
   * v0.6.0 diagnostics: the cached policy decision for ONE session, so a caller
   * can answer "why is this session NOT mirrored?". Before this, a live check
   * could only see count:0 -- indistinguishable from "the scope test refuses
   * every session", which is exactly what was happening.
   * @param {string} sessionId
   * @returns {{decision: string, reason: string, via?: string|null, cwd: string}|null}
   */
  /**
   * Decision keys are packed as `<safeId>\u0000<cwd>\u0000<configRevision>`.
   * Split on the separator instead of slicing: a slice left the revision glued
   * to the cwd in every diagnostic (`...dsh-hermes-link\u00000`), which made the
   * new "why is nothing mirrored?" output look broken.
   */
  function parseDecisionKey(key) {
    const parts = String(key).split('\u0000')
    return { session_id: parts[0] || '', cwd: parts[1] || '', revision: parts[2] === undefined ? null : Number(parts[2]) }
  }

  function decisionFor(sessionId) {
    const safeId = safeSessionId(sessionId)
    for (const [key, decision] of decisions) {
      if (key.startsWith(safeId + '\u0000')) {
        const parsed = parseDecisionKey(key)
        return { ...decision, cwd: parsed.cwd, revision: parsed.revision }
      }
    }
    return null
  }

  /** Bounded snapshot of every cached policy decision (diagnostics surface). */
  function decisionLog() {
    const out = []
    for (const [key, decision] of decisions) {
      const parsed = parseDecisionKey(key)
      out.push({ ...parsed, ...decision, cwd: parsed.cwd })
    }
    return out
  }

  function stop() {
    persist()
  }

  return {
    enable,
    disable,
    status,
    isEnabled,
    handleEvent,
    listStatus,
    statePath,
    policyStatus,
    decisionFor,
    decisionLog,
    stop,
  }
}
