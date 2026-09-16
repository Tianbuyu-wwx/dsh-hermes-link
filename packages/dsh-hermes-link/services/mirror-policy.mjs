// services/mirror-policy.mjs
//
// v0.6.0 (B) - HERMES_LINK_MIRROR_POLICY: DSH->Hermes session mirroring that is
// ON by default, but only for sessions that provably belong to a project Hermes
// actually knows about.
//
// Why not simply flip the mirror on:
//   v0.2.1 shipped a global, cwd-agnostic injection of
//   ~/.dsh/hermes-inbox/session.jsonl into every main session; a DSH session for
//   project A inherited project B's Hermes transcript. Session.events is
//   append-only / deep-frozen, so that could not be undone. Every cross-project
//   channel was therefore made explicit opt-in - which is why the V4 mirror
//   (services/session-mirror.mjs) stayed OFF and 'bidirectional' remained a
//   promise instead of a behaviour.
//
// The policy keeps the safety property without the manual chore:
//
//   off    - unchanged v0.4.0 behaviour: mirror nothing until the user calls
//            session_mirror action=enable.
//   scoped - DEFAULT. Auto-enable a session only when its header.cwd matches a
//            real Hermes project: Hermes state.db sessions.cwd or
//            sessions.git_repo_root (normalized: case-insensitive, separator and
//            trailing-slash insensitive), or the same git worktree root as such
//            a row. No match -> stay OFF.
//   all    - auto-enable every session (for users who explicitly want that).
//
// The scope test is NOT re-implemented here: services/hermes-project-memory.mjs
// already matches agent.session.header.cwd against Hermes state.db, and the
// injected matcher (matchHermesProject) reuses that module's normalizeCwd() and
// the very same equality rule.
//
// This module is intentionally pure (no fs / no sqlite / no metrics): every
// branch is unit-testable, and session-mirror.mjs injects the real matcher.
//
// It also owns the echo/noise guard that docs/delivery-v0.6.0-20260821.md:21
// claimed existed but the code never had (v0.6.0 audit item B5).

/** Accepted policy values. */
export const MIRROR_POLICIES = Object.freeze(['off', 'scoped', 'all'])

/** Default policy: open the box, but only for the same project. */
export const DEFAULT_MIRROR_POLICY = 'scoped'

/** Environment variable that selects the policy. */
export const POLICY_ENV_VAR = 'HERMES_LINK_MIRROR_POLICY'

/**
 * Environment variable that lists LOCAL project paths which are in scope no
 * matter what Hermes' state.db says. `;` or `,` separated, absolute or not.
 */
export const MIRROR_PROJECTS_ENV_VAR = 'HERMES_LINK_MIRROR_PROJECTS'

/** Session ids created by import_hermes_session carry this prefix. */
export const ECHO_SESSION_PREFIX = 'hermes-'

/** agentPreset stamped on every imported Hermes session. */
export const ECHO_AGENT_PRESET = 'hermes-imported'

// -----------------------------------------------------------------------------
// Policy resolution
// -----------------------------------------------------------------------------

/**
 * Resolve HERMES_LINK_MIRROR_POLICY from an environment object.
 *
 * An invalid value NEVER silently becomes 'all' (that would turn a typo into
 * 'mirror every project into Hermes'); it warns and falls back to the safe
 * default, 'scoped'.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{policy: string, requested: string, source: string, invalid: boolean, warning: string|null}}
 */
export function resolveMirrorPolicy(env) {
  const raw = env ? env[POLICY_ENV_VAR] : undefined
  const requested = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!requested) {
    return { policy: DEFAULT_MIRROR_POLICY, requested: '', source: 'default', invalid: false, warning: null }
  }
  if (MIRROR_POLICIES.includes(requested)) {
    return { policy: requested, requested, source: 'env', invalid: false, warning: null }
  }
  return {
    policy: DEFAULT_MIRROR_POLICY,
    requested,
    source: 'default',
    invalid: true,
    warning: '[dsh-hermes-link] ' + POLICY_ENV_VAR + '=' + JSON.stringify(requested) +
      ' is not one of off|scoped|all - falling back to ' + JSON.stringify(DEFAULT_MIRROR_POLICY) +
      ' (never "all", so a typo cannot mirror every project)',
  }
}

/**
 * Case- and separator-insensitive path identity. Deliberately the same rule as
 * `hermes-project-memory.normalizeCwd()` (v0.6.0 B folded separators as well),
 * kept local so this module stays PURE -- no fs, no sqlite. The cross-check
 * against the canonical normalizeCwd lives in scripts/test-mirror-policy.mjs.
 * @param {string} p
 * @returns {string}
 */
export function foldCwd(p) {
  if (!p || typeof p !== 'string') return ''
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Parse HERMES_LINK_MIRROR_PROJECTS into a folded, de-duplicated path set.
 *
 * WHY THIS EXISTS (v0.6.0, found live on 2026-09-16): the scoped policy keys a
 * project off the cwd a *Hermes* session ran in. Rename or move a directory and
 * that key goes stale -- the path may not even exist any more -- while every
 * newer Hermes row may carry cwd=null. The scope test then fails closed FOREVER
 * and the mirror silently never fires: the repo the user actually works in
 * (E:\u9879\u76ee\dsh-hermes-link) matched only the stale key
 * E:\u9879\u76ee\dsh-hermes -> out_of_scope, mirrored sessions 0.
 * This variable is the explicit, per-project way back in. It is still opt-in,
 * so the cross-project safety property the scoped policy exists for is intact.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} folded paths (may be empty)
 */
export function parseMirrorProjects(env) {
  const raw = env ? env[MIRROR_PROJECTS_ENV_VAR] : undefined
  if (typeof raw !== 'string' || !raw.trim()) return []
  const out = []
  for (const part of raw.split(/[;,]|\r?\n/)) {
    const folded = foldCwd(part.trim())
    if (folded && !out.includes(folded)) out.push(folded)
  }
  return out
}

// -----------------------------------------------------------------------------
// Echo / noise guard (v0.6.0 audit B5)
// -----------------------------------------------------------------------------

/**
 * Event types that carry no model-visible conversation content and only bloat
 * the Hermes-side JSONL / SSE feed.
 *
 * Evidence for each entry (merged SessionEventMap of @deepseek-ai/dsh-session,
 * lib/types/types.d.ts, plus the plugin-merged members declared across
 * @deepseek-ai/* plugins):
 *   - turn/start, turn/end, step/start, step/end : pure lifecycle boundaries;
 *     the .d.ts describes them as opening/closing markers only.
 *   - request/header, request/context : 'It is log-only' / route metadata.
 *   - session/end-seed : explicitly 'This log-only event is the durable
 *     projection of firstLiveSeq'.
 *   - assistant/attempt : 'One model attempt that committed no surface message'
 *     - the committed text arrives separately as assistant/message.
 *   - session/title : title bookkeeping (named in the v0.6.0 audit, B5).
 *   - model/selection, agent-preset/selected, sandbox/mode, approval/policy :
 *     session settings snapshots, not conversation.
 *
 * This is deliberately a DENYlist, not an allowlist. The SessionEvent contract
 * says a reader meeting an unrecognized event type WITHOUT ignorable: true
 * 'MUST refuse to reconstruct the session instead of silently dropping the
 * event': a DSH plugin-merged type this list has never heard of must therefore
 * be MIRRORED, not dropped. Unknown => mirror.
 */
export const NOISE_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
  'request/context',
  'session/end-seed',
  'assistant/attempt',
  'session/title',
  'model/selection',
  'agent-preset/selected',
  'sandbox/mode',
  'approval/policy',
])

const NOISE_SET = new Set(NOISE_EVENT_TYPES)

/**
 * True when an event is pure noise for a Hermes reader.
 * A missing/unknown type is NOT noise (see NOISE_EVENT_TYPES: unknown => mirror).
 * @param {{type?: string}|null|undefined} event
 */
export function isNoiseEvent(event) {
  if (!event || typeof event.type !== 'string') return false
  return NOISE_SET.has(event.type)
}

/**
 * True for sessions whose content ORIGINATES from Hermes - mirroring them would
 * write Hermes' own transcript back into Hermes' own inbox (echo).
 *
 * Two independent signals, because either one alone can be missing:
 *   1. the hermes-<sid> session-id prefix used by import_hermes_session;
 *   2. agentPreset 'hermes-imported' (header.agentPreset / session.agentPreset).
 *
 * @param {string} sessionId
 * @param {object} [session] DSH Session (header.agentPreset) or a plain object
 */
export function isEchoSession(sessionId, session) {
  const id = sessionId == null ? '' : String(sessionId)
  if (id.toLowerCase().startsWith(ECHO_SESSION_PREFIX)) return true
  const preset = session && (
    session.agentPreset ||
    (session.header && session.header.agentPreset) ||
    (session.meta && session.meta.agentPreset)
  )
  return preset === ECHO_AGENT_PRESET
}

/**
 * Read a cwd off a DSH Session (or a plain object shaped like one).
 * @param {object} [session]
 * @returns {string}
 */
export function sessionCwd(session) {
  if (!session) return ''
  const c = (session.header && session.header.cwd) || session.cwd
  return typeof c === 'string' ? c : ''
}

// -----------------------------------------------------------------------------
// Decision
// -----------------------------------------------------------------------------

/**
 * Decide whether the policy wants this session mirrored. Pure: the caller owns
 * persistent state (opt_out), metrics and the actual enable().
 *
 * @param {object} args
 * @param {string} args.policy
 * @param {string} args.sessionId
 * @param {string} [args.cwd] session header cwd
 * @param {object} [args.session] DSH Session (for the agentPreset echo signal)
 * @param {boolean} [args.isOptedOut] user explicitly disabled this session
 * @param {Function} [args.matchProject] (cwd) => {matched, via?, matched_session_id?}
 * @param {string[]} [args.extraProjects] folded paths from HERMES_LINK_MIRROR_PROJECTS
 * @returns {{decision: string, reason: string, via?: string|null}}
 */
export function decideMirrorPolicy({ policy, sessionId, cwd, session, isOptedOut, matchProject, extraProjects } = {}) {
  const resolved = MIRROR_POLICIES.includes(policy) ? policy : DEFAULT_MIRROR_POLICY

  // Echo first: an imported Hermes session must never be mirrored back, not even
  // under 'all' and not even if some earlier version enabled it.
  if (isEchoSession(sessionId, session)) return { decision: 'skip', reason: 'echo_session' }

  // An explicit session_mirror action=disable outranks the policy, otherwise the
  // switch the user just flipped would be undone at the next session start.
  if (isOptedOut) return { decision: 'skip', reason: 'opted_out' }

  if (resolved === 'off') return { decision: 'skip', reason: 'policy_off' }
  if (resolved === 'all') return { decision: 'enable', reason: 'policy_all' }

  // scoped
  const dshCwd = typeof cwd === 'string' ? cwd : ''
  if (!dshCwd.trim()) return { decision: 'skip', reason: 'no_cwd' }
  if (typeof matchProject !== 'function') return { decision: 'skip', reason: 'no_matcher' }

  let match = null
  try {
    match = matchProject(dshCwd)
  } catch (_e) {
    // A broken state.db must never mirror an unrelated project into Hermes.
    return { decision: 'skip', reason: 'match_error' }
  }
  if (match && match.matched) {
    return { decision: 'enable', reason: 'scope_match', via: match.via || null }
  }
  // v0.6.0: the explicit per-project escape hatch (see parseMirrorProjects).
  // Checked AFTER the state.db match because the DB is the ground truth when it
  // has an opinion, and never before the off/opted-out/echo branches above --
  // an allowlisted path must not resurrect a policy the user switched off.
  if (Array.isArray(extraProjects) && extraProjects.includes(foldCwd(dshCwd))) {
    return { decision: 'enable', reason: 'extra_project' }
  }
  return { decision: 'skip', reason: 'out_of_scope' }
}
