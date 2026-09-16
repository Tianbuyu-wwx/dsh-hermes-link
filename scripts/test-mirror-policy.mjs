#!/usr/bin/env node
// scripts/test-mirror-policy.mjs
//
// v0.6.0 (B) - HERMES_LINK_MIRROR_POLICY + the echo/noise guard
// (docs/impl-brief-B-mirror-policy.md).
//
// Cases:
//   - policy resolution: unset -> scoped, off / scoped / all, case+space
//     tolerance, invalid value warns and falls back to scoped (never all)
//   - off      : a matching project is NOT auto-enabled (manual opt-in kept)
//   - scoped   : matching project auto-enables + mirrors; unrelated cwd stays
//                OFF; no cwd stays OFF; match via normalized separators / case,
//                via sessions.git_repo_root and via the git worktree root
//   - all      : every session auto-enables (with and without a cwd)
//   - echo     : hermes-* and hermes-imported sessions are never auto-enabled,
//                and an explicit enable of one still writes nothing
//   - noise    : lifecycle/bookkeeping event types are skipped (handleEvent AND
//                the enable() backfill); unknown types are mirrored
//   - opt-out  : an explicit disable outranks the policy and survives a restart
//   - metrics  : decisions/guard are counted through the real registry, are
//                registered in index.mjs registerMetricsShape(), and a THROWING
//                metrics sink cannot break mirroring

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { DatabaseSync } = await import('node:sqlite')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'packages', 'dsh-hermes-link')
const { createSessionMirror } = await import(pathToFileURL(join(pkg, 'services', 'session-mirror.mjs')).href)
const { createOutbox } = await import(pathToFileURL(join(pkg, 'services', 'outbox.mjs')).href)
const { createMetricsRegistry } = await import(pathToFileURL(join(pkg, 'services', 'metrics.mjs')).href)
const {
  DEFAULT_MIRROR_POLICY,
  MIRROR_PROJECTS_ENV_VAR,
  NOISE_EVENT_TYPES,
  POLICY_ENV_VAR,
  decideMirrorPolicy,
  foldCwd,
  isEchoSession,
  isNoiseEvent,
  parseMirrorProjects,
  resolveMirrorPolicy,
} = await import(pathToFileURL(join(pkg, 'services', 'mirror-policy.mjs')).href)
// The canonical path rule the mirror's local foldCwd must not drift from.
const { normalizeCwd } = await import(pathToFileURL(join(pkg, 'services', 'hermes-project-memory.mjs')).href)

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++ }
  catch (e) { console.log('  \u2717 ' + name + ': ' + (e && e.message || e)); failed++ }
}

const OLD_DSH_HOME = process.env.DSH_HOME

function makeDirs() {
  const hermesHome = mkdtempSync(join(tmpdir(), 'dsh-hl-pol-home-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-hl-pol-state-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hl-pol-project-'))
  const otherDir = mkdtempSync(join(tmpdir(), 'dsh-hl-pol-other-'))
  process.env.DSH_HOME = dshHome
  return {
    hermesHome, dshHome, projectDir, otherDir,
    cleanup() {
      if (OLD_DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = OLD_DSH_HOME
      for (const d of [hermesHome, dshHome, projectDir, otherDir]) {
        try { rmSync(d, { recursive: true, force: true }) } catch (_e) { /* best-effort */ }
      }
    },
  }
}

/** Seed a Hermes state.db. withGitRoot=false uses the minimal schema some
 *  fixtures use (no git_repo_root column) to prove the matcher probes for it. */
function seedStateDb(hermesHome, sessions, { withGitRoot = false } = {}) {
  const db = new DatabaseSync(join(hermesHome, 'state.db'))
  db.exec(withGitRoot
    ? 'CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, git_repo_root TEXT)'
    : 'CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, title TEXT)')
  const stmt = db.prepare(withGitRoot
    ? 'INSERT INTO sessions (id, cwd, git_repo_root) VALUES (?, ?, ?)'
    : 'INSERT INTO sessions (id, cwd, model, title) VALUES (?, ?, ?, ?)')
  for (const s of sessions) {
    if (withGitRoot) stmt.run(s.id, s.cwd == null ? null : s.cwd, s.git_repo_root == null ? null : s.git_repo_root)
    else stmt.run(s.id, s.cwd == null ? null : s.cwd, 'm', 't')
  }
  db.close()
}

const mirrorPath = (home, sid) => join(home, 'inbox', 'dsh', 'session-mirror', sid + '.jsonl')
const cleanEvent = (seq = 1) => ({ type: 'assistant/message', seq, data: { content: [{ type: 'text', text: 'hello' }] } })
const makeMirror = (env, policyValue, extra = {}) => {
  const ob = createOutbox({ hermesHome: env.hermesHome })
  const opts = { hermesHome: env.hermesHome, outbox: ob, ...extra }
  if (policyValue !== undefined) opts.env = { [POLICY_ENV_VAR]: policyValue }
  return { ob, sm: createSessionMirror(opts) }
}

// -----------------------------------------------------------------------------
// policy resolution
// -----------------------------------------------------------------------------

t('resolve: unset -> scoped (the documented default)', () => {
  const r = resolveMirrorPolicy({})
  assert.equal(DEFAULT_MIRROR_POLICY, 'scoped')
  assert.equal(POLICY_ENV_VAR, 'HERMES_LINK_MIRROR_POLICY')
  assert.equal(r.policy, 'scoped')
  assert.equal(r.source, 'default')
  assert.equal(r.invalid, false)
  assert.equal(r.warning, null)
})

t('resolve: off / scoped / all are accepted verbatim', () => {
  for (const v of ['off', 'scoped', 'all']) {
    const r = resolveMirrorPolicy({ [POLICY_ENV_VAR]: v })
    assert.equal(r.policy, v)
    assert.equal(r.source, 'env')
    assert.equal(r.invalid, false)
  }
})

t('resolve: surrounding whitespace and case are tolerated', () => {
  assert.equal(resolveMirrorPolicy({ [POLICY_ENV_VAR]: '  ALL ' }).policy, 'all')
  assert.equal(resolveMirrorPolicy({ [POLICY_ENV_VAR]: 'Off' }).policy, 'off')
  assert.equal(resolveMirrorPolicy({ [POLICY_ENV_VAR]: '' }).policy, 'scoped', 'empty == unset')
})

t('resolve: an invalid value warns and falls back to scoped - never all', () => {
  for (const bad of ['on', 'true', 'yes', 'everything', 'scope']) {
    const r = resolveMirrorPolicy({ [POLICY_ENV_VAR]: bad })
    assert.equal(r.policy, 'scoped', 'invalid value must not become ' + r.policy)
    assert.notEqual(r.policy, 'all', 'a typo must never mirror every project')
    assert.equal(r.invalid, true)
    assert.ok(r.warning && r.warning.includes('off|scoped|all'), 'warning explains the accepted values')
    assert.ok(r.warning.includes(POLICY_ENV_VAR), 'warning names the variable')
  }
})

// -----------------------------------------------------------------------------
// off
// -----------------------------------------------------------------------------

t('policy=off: even a matching project is NOT auto-enabled (manual opt-in kept)', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { ob, sm } = makeMirror(env, 'off')
    assert.equal(sm.policyStatus().policy, 'off')
    assert.equal(sm.isEnabled('sess-off', { cwd: env.projectDir }), false)
    assert.equal(sm.status('sess-off').default_off, true, 'off is the only policy that is off-by-default')
    assert.equal(sm.handleEvent('sess-off', cleanEvent()), false)
    ob.flushNow()
    assert.equal(existsSync(mirrorPath(env.hermesHome, 'sess-off')), false, 'no file under off')
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// scoped
// -----------------------------------------------------------------------------

t('policy=scoped: a cwd matching a real Hermes session auto-enables and mirrors', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { ob, sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-scoped', { cwd: env.projectDir }), true, 'auto-enabled on first sight')
    const st = sm.status('sess-scoped')
    assert.equal(st.enabled, true)
    assert.equal(st.auto, true, 'recorded as policy-driven, not user-driven')
    assert.equal(st.source, 'policy')
    assert.equal(st.enable_reason, 'scope_match')
    assert.equal(st.match_via, 'cwd')
    assert.equal(st.policy, 'scoped')
    assert.equal(st.default_off, false)
    assert.equal(sm.handleEvent('sess-scoped', cleanEvent()), true)
    ob.flushNow()
    const lines = readFileSync(mirrorPath(env.hermesHome, 'sess-scoped'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).event.type, 'assistant/message')
  } finally { env.cleanup() }
})

t('policy=scoped: case + separator + trailing-slash differences still match', () => {
  const env = makeDirs()
  try {
    // Hermes recorded the project with forward slashes and a trailing slash.
    seedStateDb(env.hermesHome, [{ id: 'h-sep', cwd: env.projectDir.replace(/\\/g, '/') + '/' }])
    const { sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-sep', { cwd: env.projectDir }), true, 'native separators must match')
    assert.equal(sm.status('sess-sep').match_via, 'cwd')
  } finally { env.cleanup() }
})

t('policy=scoped: match via sessions.git_repo_root (real state.db column)', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-git', cwd: env.otherDir, git_repo_root: env.projectDir }], { withGitRoot: true })
    const { sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-gitroot', { cwd: env.projectDir }), true)
    assert.equal(sm.status('sess-gitroot').match_via, 'git_repo_root')
    assert.equal(sm.isEnabled('sess-unrelated', { cwd: env.otherDir }), true, 'the row cwd matches this one')
  } finally { env.cleanup() }
})

t('policy=scoped: a DSH session in a SUBDIR of the project matches via the git worktree root', () => {
  const env = makeDirs()
  try {
    mkdirSync(join(env.projectDir, '.git'))
    mkdirSync(join(env.projectDir, 'sub', 'deep'), { recursive: true })
    seedStateDb(env.hermesHome, [{ id: 'h-root', cwd: env.projectDir }])
    const { sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-sub', { cwd: join(env.projectDir, 'sub', 'deep') }), true)
    assert.equal(sm.status('sess-sub').match_via, 'git_worktree_root')
  } finally { env.cleanup() }
})

t('policy=scoped: an unrelated cwd stays OFF and writes nothing', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { ob, sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-other', { cwd: env.otherDir }), false)
    assert.equal(sm.status('sess-other').enabled, false)
    assert.equal(sm.handleEvent('sess-other', cleanEvent()), false)
    ob.flushNow()
    assert.equal(existsSync(mirrorPath(env.hermesHome, 'sess-other')), false, 'cross-project session must not be mirrored')
  } finally { env.cleanup() }
})

t('policy=scoped: a session with no cwd stays OFF (no_cwd)', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-nocwd'), false)
    assert.equal(sm.isEnabled('sess-nocwd', { session: { id: 'x', header: {} } }), false)
    assert.equal(sm.status('sess-nocwd').enabled, false)
  } finally { env.cleanup() }
})

t('policy=scoped: a missing state.db fails closed (no match, no mirror)', () => {
  const env = makeDirs()
  try {
    const { sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-nodb', { cwd: env.projectDir }), false)
  } finally { env.cleanup() }
})

t('policy=scoped: header.cwd on the Session object is used when no cwd arg is given', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { sm } = makeMirror(env, 'scoped')
    const session = { id: 'sess-hdr', header: { cwd: env.projectDir } }
    assert.equal(sm.isEnabled('sess-hdr', { session }), true)
    assert.equal(sm.status('sess-hdr').enabled, true)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// all
// -----------------------------------------------------------------------------

t('policy=all: every session auto-enables, even with no Hermes project at all', () => {
  const env = makeDirs()
  try {
    const { ob, sm } = makeMirror(env, 'all')
    assert.equal(sm.isEnabled('sess-any', { cwd: env.otherDir }), true)
    assert.equal(sm.status('sess-any').enable_reason, 'policy_all')
    assert.equal(sm.isEnabled('sess-any-nocwd'), true)
    assert.equal(sm.handleEvent('sess-any', cleanEvent()), true)
    ob.flushNow()
    assert.ok(existsSync(mirrorPath(env.hermesHome, 'sess-any')))
  } finally { env.cleanup() }
})

t('policy=all from process.env (no env option) is honoured', () => {
  const env = makeDirs()
  const prev = process.env[POLICY_ENV_VAR]
  process.env[POLICY_ENV_VAR] = 'all'
  try {
    const { sm } = makeMirror(env, undefined)
    assert.equal(sm.policyStatus().policy, 'all')
    assert.equal(sm.policyStatus().source, 'env')
    assert.equal(sm.isEnabled('sess-env-all'), true)
  } finally {
    if (prev === undefined) delete process.env[POLICY_ENV_VAR]; else process.env[POLICY_ENV_VAR] = prev
    env.cleanup()
  }
})

t('no env option + no HERMES_LINK_MIRROR_POLICY -> scoped from process.env', () => {
  const env = makeDirs()
  const prev = process.env[POLICY_ENV_VAR]
  delete process.env[POLICY_ENV_VAR]
  try {
    const { sm } = makeMirror(env, undefined)
    assert.equal(sm.policyStatus().policy, 'scoped')
    assert.equal(sm.policyStatus().source, 'default')
    assert.equal(sm.policyStatus().invalid, false)
  } finally {
    if (prev !== undefined) process.env[POLICY_ENV_VAR] = prev
    env.cleanup()
  }
})

t('an invalid policy at service level falls back to scoped, never all', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { sm } = makeMirror(env, 'everything')
    assert.equal(sm.policyStatus().policy, 'scoped')
    assert.equal(sm.policyStatus().invalid, true)
    assert.equal(sm.policyStatus().requested, 'everything')
    assert.equal(sm.isEnabled('sess-inv'), false, 'fell back to scoped: no cwd -> no mirror')
    assert.equal(sm.isEnabled('sess-inv2', { cwd: env.projectDir }), true, 'scoped still works for a real project')
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// echo guard
// -----------------------------------------------------------------------------

t('echo: isEchoSession covers the id prefix AND the hermes-imported preset', () => {
  assert.equal(isEchoSession('hermes-20260906_203440_a4534d', null), true)
  assert.equal(isEchoSession('sess-1', null), false)
  assert.equal(isEchoSession('sess-1', { header: { agentPreset: 'hermes-imported' } }), true)
  assert.equal(isEchoSession('sess-1', { agentPreset: 'hermes-imported' }), true)
  assert.equal(isEchoSession('sess-1', { header: { agentPreset: 'default' } }), false)
})

t('echo: a hermes-* session is never auto-enabled, not even under all', () => {
  const env = makeDirs()
  try {
    const { sm } = makeMirror(env, 'all')
    assert.equal(sm.isEnabled('hermes-20260906_203440_a4534d'), false)
    assert.equal(sm.status('hermes-20260906_203440_a4534d').echo_guard, true)
    const { sm: sm2 } = makeMirror(env, 'scoped', {})
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    assert.equal(sm2.isEnabled('hermes-x', { cwd: env.projectDir }), false)
  } finally { env.cleanup() }
})

t('echo: a hermes-imported session is refused even without the id prefix', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { sm } = makeMirror(env, 'scoped')
    const session = { id: 'plain-id', header: { cwd: env.projectDir, agentPreset: 'hermes-imported' } }
    assert.equal(sm.isEnabled('plain-id', { session }), false)
  } finally { env.cleanup() }
})

t('echo: an explicit enable of a hermes-* session still writes nothing', () => {
  const env = makeDirs()
  try {
    const { ob, sm } = makeMirror(env, 'off')
    sm.enable('hermes-echo')
    assert.equal(sm.handleEvent('hermes-echo', cleanEvent()), false, 'echo guard runs even when explicitly enabled')
    const st = sm.status('hermes-echo')
    assert.equal(st.events_skipped, 1)
    assert.equal(st.last_skip_reason, 'echo_session')
    assert.equal(st.event_count, 0)
    ob.flushNow()
    assert.equal(existsSync(mirrorPath(env.hermesHome, 'hermes-echo')), false)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// noise guard
// -----------------------------------------------------------------------------

t('noise: the documented lifecycle/bookkeeping types are noise; content is not', () => {
  for (const ty of ['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header',
    'request/context', 'session/end-seed', 'assistant/attempt', 'session/title',
    'model/selection', 'agent-preset/selected', 'sandbox/mode', 'approval/policy']) {
    assert.ok(NOISE_EVENT_TYPES.includes(ty), ty + ' must be classified as noise')
    assert.equal(isNoiseEvent({ type: ty, seq: 1, data: {} }), true, ty)
  }
  for (const ty of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'system/message', 'compaction/summary']) {
    assert.equal(isNoiseEvent({ type: ty, seq: 1, data: {} }), false, ty + ' carries content')
  }
  assert.equal(isNoiseEvent(null), false)
  assert.equal(isNoiseEvent({}), false, 'unknown/missing type => mirror, never drop')
  assert.equal(isNoiseEvent({ type: 'some/plugin-merged-type' }), false)
})

t('noise: handleEvent skips noise, mirrors content and unknown types, publishes only writes', () => {
  const env = makeDirs()
  try {
    const published = []
    const broker = { attachTask() {}, publish(ch, ev) { published.push({ ch, ev }) } }
    const { ob, sm } = makeMirror(env, 'off', { sseBroker: broker })
    sm.enable('sess-noise')
    for (const ty of NOISE_EVENT_TYPES) {
      assert.equal(sm.handleEvent('sess-noise', { type: ty, seq: 1, data: {} }), false, ty + ' must be skipped')
    }
    assert.equal(published.length, 0, 'a skipped event must not be published on SSE')
    assert.equal(sm.handleEvent('sess-noise', cleanEvent(2)), true)
    assert.equal(sm.handleEvent('sess-noise', { type: 'some/plugin-merged-type', seq: 3, data: { x: 1 } }), true, 'unknown => mirrored')
    ob.flushNow()
    const lines = readFileSync(mirrorPath(env.hermesHome, 'sess-noise'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).event.type, 'assistant/message')
    assert.equal(JSON.parse(lines[1]).event.type, 'some/plugin-merged-type')
    assert.equal(published.length, 2)
    const st = sm.status('sess-noise')
    assert.equal(st.event_count, 2)
    assert.equal(st.events_skipped, NOISE_EVENT_TYPES.length)
    assert.equal(st.last_skip_reason, 'noise_event')
  } finally { env.cleanup() }
})

t('noise: the enable() backfill applies the same filter', () => {
  const env = makeDirs()
  try {
    const { ob, sm } = makeMirror(env, 'off')
    const events = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      cleanEvent(1),
      { type: 'session/title', seq: 2, data: { title: 'x' } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'hi' }] } },
    ]
    const st = sm.enable('sess-backfill', { events })
    ob.flushNow()
    assert.equal(st.event_count, 2, 'only the two content events are mirrored')
    assert.equal(st.events_skipped, 2)
    const lines = readFileSync(mirrorPath(env.hermesHome, 'sess-backfill'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// explicit opt-out outranks the policy
// -----------------------------------------------------------------------------

t('opt-out: an explicit disable outranks the policy and survives a restart', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const { ob, sm } = makeMirror(env, 'scoped')
    assert.equal(sm.isEnabled('sess-off-out', { cwd: env.projectDir }), true, 'policy enabled it first')
    sm.disable('sess-off-out')
    assert.equal(sm.isEnabled('sess-off-out', { cwd: env.projectDir }), false, 'disable must win over the policy')
    assert.equal(sm.status('sess-off-out').opted_out, true)
    ob.flushNow()
    // A fresh instance stands in for a DSH restart (state file on disk).
    const ob2 = createOutbox({ hermesHome: env.hermesHome })
    const sm2 = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob2, env: { [POLICY_ENV_VAR]: 'scoped' } })
    assert.equal(sm2.isEnabled('sess-off-out', { cwd: env.projectDir }), false, 'policy must not silently undo the disable')
    assert.equal(sm2.status('sess-off-out').opted_out, true)
    // ...and an explicit enable clears the tombstone again.
    sm2.enable('sess-off-out')
    assert.equal(sm2.isEnabled('sess-off-out', { cwd: env.projectDir }), true)
    assert.equal(sm2.status('sess-off-out').opted_out, false)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// metrics (observed + must never be load-bearing)
// -----------------------------------------------------------------------------

t('metrics: decisions and guard skips are counted through the real registry', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const m = createMetricsRegistry()
    m.registerCounter('hermes_link_mirror_policy_auto_enabled_total', 'h', ['policy'])
    m.registerCounter('hermes_link_mirror_policy_auto_skipped_total', 'h', ['policy', 'reason'])
    m.registerCounter('hermes_link_mirror_events_skipped_total', 'h', ['reason'])
    m.registerGauge('hermes_link_mirror_policy_info', 'h', ['policy'])
    const { ob, sm } = makeMirror(env, 'scoped', { metrics: m })
    assert.equal(m.get('hermes_link_mirror_policy_info', { policy: 'scoped' }), 1)
    assert.equal(sm.isEnabled('sess-m1', { cwd: env.projectDir }), true)
    assert.equal(m.get('hermes_link_mirror_policy_auto_enabled_total', { policy: 'scoped' }), 1)
    assert.equal(sm.isEnabled('sess-m2', { cwd: env.otherDir }), false)
    assert.equal(m.get('hermes_link_mirror_policy_auto_skipped_total', { policy: 'scoped', reason: 'out_of_scope' }), 1)
    assert.equal(sm.isEnabled('sess-m3'), false)
    assert.equal(m.get('hermes_link_mirror_policy_auto_skipped_total', { policy: 'scoped', reason: 'no_cwd' }), 1)
    assert.equal(sm.isEnabled('sess-m4', { cwd: env.projectDir }), true)
    assert.equal(sm.isEnabled('sess-m4', { cwd: env.projectDir }), true, 'cached decision')
    assert.equal(m.get('hermes_link_mirror_policy_auto_enabled_total', { policy: 'scoped' }), 2, 'no double counting')
    sm.enable('sess-m5')
    sm.handleEvent('sess-m5', { type: 'turn/start', seq: 1, data: {} })
    sm.handleEvent('sess-m5', { type: 'session/title', seq: 2, data: {} })
    assert.equal(m.get('hermes_link_mirror_events_skipped_total', { reason: 'noise_event' }), 2)
    assert.ok(m.serialize().includes('hermes_link_mirror_policy_auto_enabled_total'))
    ob.flushNow()
  } finally { env.cleanup() }
})

t('metrics: a THROWING sink cannot break the policy or the mirror', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const boom = { inc() { throw new Error('inc on unregistered metric') }, set() { throw new Error('set on unregistered metric') } }
    const { ob, sm } = makeMirror(env, 'scoped', { metrics: boom })
    assert.equal(sm.isEnabled('sess-t', { cwd: env.projectDir }), true, 'auto-enable survived a throwing sink')
    assert.equal(sm.handleEvent('sess-t', { type: 'turn/start', seq: 1, data: {} }), false)
    assert.equal(sm.handleEvent('sess-t', cleanEvent(2)), true, 'mirroring survived a throwing sink')
    ob.flushNow()
    const lines = readFileSync(mirrorPath(env.hermesHome, 'sess-t'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
  } finally { env.cleanup() }
})

t('metrics: every metric name the mirror service emits is registered in index.mjs', () => {
  // services/metrics.mjs THROWS on inc()/set() of an unregistered metric; the
  // v0.6.0 (B1) incident was exactly this drift taking the JSON-RPC surface down.
  const svc = readFileSync(join(pkg, 'services', 'session-mirror.mjs'), 'utf8')
  const names = [...new Set([...svc.matchAll(/hermes_link_[a-z0-9_]+/g)].map((mm) => mm[0]))]
  assert.ok(names.length >= 4, 'expected the policy metrics in the service source, found ' + names.length)
  const idx = readFileSync(join(pkg, 'index.mjs'), 'utf8')
  const start = idx.indexOf('function registerMetricsShape')
  assert.ok(start > 0, 'registerMetricsShape() not found in index.mjs')
  const end = idx.indexOf('\n}', start)
  const shape = idx.slice(start, end > start ? end : idx.length)
  for (const n of names) {
    assert.ok(shape.includes(n), n + ' is used by session-mirror.mjs but NOT registered in index.mjs registerMetricsShape()')
  }
})

t('outbox gate: the write path itself refuses echo sessions and noise events', () => {
  const env = makeDirs()
  try {
    const ob = createOutbox({ hermesHome: env.hermesHome })
    assert.equal(ob.appendSessionEvent('hermes-one-shot', cleanEvent()), false, 'hermes-* never written')
    assert.equal(ob.appendSessionEvent('sess-gate', { type: 'turn/start', seq: 1, data: {} }), false, 'noise never written')
    assert.equal(ob.appendSessionEvent('sess-gate', cleanEvent(2)), true, 'content still written')
    ob.flushNow()
    const dir = join(env.hermesHome, 'inbox', 'dsh', 'session-mirror')
    assert.equal(existsSync(join(dir, 'hermes-one-shot.jsonl')), false)
    const lines = readFileSync(join(dir, 'sess-gate.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
  } finally { env.cleanup() }
})

// -----------------------------------------------------------------------------
// v0.6.0: HERMES_LINK_MIRROR_PROJECTS - the explicit per-project escape hatch
//
// Live evidence (2026-09-16): the scoped policy mirrored NOTHING for the repo the
// user actually works in. Hermes' state.db only keyed that project by the stale
// path E:\u9879\u76ee\dsh-hermes (directory since renamed and no longer on disk)
// while every recent Hermes row carried cwd=null, so every session resolved to
// out_of_scope -- invisibly, with /session-mirror/status reporting count:0.
// -----------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92)

t('projects: parseMirrorProjects splits, trims, folds and de-duplicates', () => {
  assert.equal(MIRROR_PROJECTS_ENV_VAR, 'HERMES_LINK_MIRROR_PROJECTS')
  assert.deepEqual(parseMirrorProjects({}), [])
  assert.deepEqual(parseMirrorProjects({ [MIRROR_PROJECTS_ENV_VAR]: '   ' }), [])
  assert.deepEqual(
    parseMirrorProjects({ [MIRROR_PROJECTS_ENV_VAR]: 'E:' + BACKSLASH + 'A' + BACKSLASH + 'b ; e:/a/B/ , ,E:/x' }),
    ['e:/a/b', 'e:/x'],
  )
  assert.deepEqual(parseMirrorProjects({ [MIRROR_PROJECTS_ENV_VAR]: 'E:/a' + String.fromCharCode(10) + 'E:/b' }), ['e:/a', 'e:/b'])
})

t('projects: the local foldCwd agrees with the canonical normalizeCwd', () => {
  const samples = [
    'E:' + BACKSLASH + '\u9879\u76ee' + BACKSLASH + 'dsh-hermes-link',
    'E:/\u9879\u76ee/dsh-hermes-link/',
    'C:' + BACKSLASH + 'Users' + BACKSLASH + 'X',
    '/tmp/a//',
    '',
  ]
  for (const p of samples) {
    assert.equal(foldCwd(p), normalizeCwd(p), 'fold rules drifted for ' + JSON.stringify(p))
  }
})

t('projects: scoped + no state.db match + allowlisted cwd -> enabled (extra_project)', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [{ id: 'h-1', cwd: env.projectDir }])
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({
      hermesHome: env.hermesHome,
      outbox: ob,
      env: { [POLICY_ENV_VAR]: 'scoped', [MIRROR_PROJECTS_ENV_VAR]: env.otherDir },
    })
    assert.equal(sm.isEnabled('sess-ep', { cwd: env.otherDir }), true)
    const st = sm.status('sess-ep')
    assert.equal(st.enabled, true)
    assert.equal(st.source, 'policy')
    assert.equal(st.enable_reason, 'extra_project')
    assert.equal(sm.decisionFor('sess-ep').reason, 'extra_project')
    assert.deepEqual(sm.policyStatus().extra_projects, [foldCwd(env.otherDir)])
    assert.equal(sm.policyStatus().projects_env_var, MIRROR_PROJECTS_ENV_VAR)
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: the allowlist is path-exact - a sibling directory stays out of scope', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({
      hermesHome: env.hermesHome,
      outbox: ob,
      env: { [POLICY_ENV_VAR]: 'scoped', [MIRROR_PROJECTS_ENV_VAR]: env.otherDir },
    })
    assert.equal(sm.isEnabled('sess-sib', { cwd: env.otherDir + '-sibling' }), false)
    assert.equal(sm.decisionFor('sess-sib').reason, 'out_of_scope')
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: policy=off still outranks the allowlist', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({
      hermesHome: env.hermesHome,
      outbox: ob,
      env: { [POLICY_ENV_VAR]: 'off', [MIRROR_PROJECTS_ENV_VAR]: env.otherDir },
    })
    assert.equal(sm.isEnabled('sess-off', { cwd: env.otherDir }), false)
    assert.equal(sm.decisionFor('sess-off').reason, 'policy_off')
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: echo sessions and explicit opt-outs are never resurrected by the allowlist', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({
      hermesHome: env.hermesHome,
      outbox: ob,
      env: { [POLICY_ENV_VAR]: 'scoped', [MIRROR_PROJECTS_ENV_VAR]: env.otherDir },
    })
    assert.equal(sm.isEnabled('hermes-echo', { cwd: env.otherDir }), false)
    assert.equal(sm.decisionFor('hermes-echo').reason, 'echo_session')
    sm.disable('sess-opt')
    assert.equal(sm.isEnabled('sess-opt', { cwd: env.otherDir }), false)
    // isEnabled() short-circuits on the opt-out tombstone BEFORE the policy runs
    // (session-mirror.mjs isEnabled line ~228), so there is no cached decision to
    // report here -- the tombstone itself is the evidence.
    assert.equal(sm.status('sess-opt').opted_out, true)
    assert.equal(sm.decisionFor('sess-opt'), null)
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: the pure decision function accepts extraProjects directly', () => {
  const inScope = decideMirrorPolicy({
    policy: 'scoped',
    sessionId: 'sess-pure',
    cwd: 'E:' + BACKSLASH + 'P' + BACKSLASH + 'p',
    matchProject: () => ({ matched: false }),
    extraProjects: ['e:/p/p'],
  })
  assert.equal(inScope.decision, 'enable')
  assert.equal(inScope.reason, 'extra_project')
  const outOfScope = decideMirrorPolicy({
    policy: 'scoped',
    sessionId: 'sess-pure',
    cwd: 'E:' + BACKSLASH + 'P' + BACKSLASH + 'q',
    matchProject: () => ({ matched: false }),
    extraProjects: ['e:/p/p'],
  })
  assert.equal(outOfScope.decision, 'skip')
  assert.equal(outOfScope.reason, 'out_of_scope')
  assert.equal(decideMirrorPolicy({ policy: 'all', sessionId: 'sess-pure', extraProjects: ['e:/p/p'] }).reason, 'policy_all')
})

t('projects: <state>/mirror-projects.json is honoured with no env var at all', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const stateDir = join(env.dshHome, 'dsh-hermes-link')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'mirror-projects.json'), JSON.stringify({ projects: [env.otherDir] }), 'utf8')
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob, env: { [POLICY_ENV_VAR]: 'scoped' } })
    assert.equal(sm.isEnabled('sess-file', { cwd: env.otherDir }), true)
    assert.equal(sm.status('sess-file').enable_reason, 'extra_project')
    const p = sm.policyStatus()
    assert.deepEqual(p.extra_projects, [foldCwd(env.otherDir)])
    assert.ok(p.projects_file.endsWith('mirror-projects.json'))
    assert.ok(p.projects_file_revision >= 1)
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: editing that file re-decides a session already cached as out_of_scope (no restart)', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob, env: { [POLICY_ENV_VAR]: 'scoped' } })
    // 1. no config yet -> skip, and the decision is cached
    assert.equal(sm.isEnabled('sess-live', { cwd: env.otherDir }), false)
    assert.equal(sm.decisionFor('sess-live').reason, 'out_of_scope')
    // 2. the user adds the path while DSH is running
    const stateDir = join(env.dshHome, 'dsh-hermes-link')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'mirror-projects.json'), JSON.stringify({ projects: [env.otherDir] }), 'utf8')
    // 3. the very next event re-decides: the cached skip is keyed by revision
    assert.equal(sm.isEnabled('sess-live', { cwd: env.otherDir }), true, 'config change must not need a restart')
    assert.equal(sm.status('sess-live').enable_reason, 'extra_project')
    ob.flushNow()
  } finally { env.cleanup() }
})

t('projects: a malformed projects file never breaks the env list', () => {
  const env = makeDirs()
  try {
    seedStateDb(env.hermesHome, [])
    const stateDir = join(env.dshHome, 'dsh-hermes-link')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'mirror-projects.json'), '{ not json', 'utf8')
    const ob = createOutbox({ hermesHome: env.hermesHome })
    const sm = createSessionMirror({ hermesHome: env.hermesHome, outbox: ob, env: { [POLICY_ENV_VAR]: 'scoped', [MIRROR_PROJECTS_ENV_VAR]: env.projectDir } })
    assert.deepEqual(sm.policyStatus().extra_projects, [foldCwd(env.projectDir)])
    assert.equal(sm.isEnabled('sess-env', { cwd: env.projectDir }), true)
    ob.flushNow()
  } finally { env.cleanup() }
})

console.log('')
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
