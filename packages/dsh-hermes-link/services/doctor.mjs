// services/doctor.mjs
//
// D (v0.6.0) -- the runtime probe that would have caught the three silently
// broken channels the 2026-09-15 audit found by hand:
//   * 3 consult tickets sitting in inbox/dsh/consult/ for three weeks with no
//     reply and nothing reporting it,
//   * a session-mirror directory containing only archive/ (the policy refused
//     every session and /status said count:0 without a reason),
//   * 145 imported sessions whose model selection no adapter could serve.
// None of that is visible by reading source, so it has to be MEASURED. This
// module measures: filesystem freshness, backlog, writability, and -- when the
// caller supplies the live services -- the in-process policy decisions.
//
// It is deliberately plain (no cordis, no imports from the plugin) so the same
// code backs all three surfaces:
//   * scripts/hermes-link-doctor.mjs   (CLI, filesystem truth)
//   * GET /mcp/collab/doctor           (in-process truth, via index.mjs services)
//
// Every check returns { id, status: 'ok'|'warn'|'fail', title, detail, hint? }.
// A 'fail' means a channel cannot work at all; 'warn' means it is not working
// right now and the hint says what to look at.

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Freshness thresholds; override per call (tests) or with the CLI flags. */
export const DOCTOR_TTLS = Object.freeze({
  heartbeatMs: 180_000,          // 3 missed 60s beats
  mirrorIdleMs: 900_000,         // an ENABLED mirror that has not grown in 15 min
  consultMs: 24 * 60 * 60 * 1000, // a ticket older than a day is backlog
})

const ok = (id, title, detail, extra) => ({ id, status: 'ok', title, detail, ...extra })
const warn = (id, title, detail, hint, extra) => ({ id, status: 'warn', title, detail, ...(hint ? { hint } : {}), ...extra })
const fail = (id, title, detail, hint, extra) => ({ id, status: 'fail', title, detail, ...(hint ? { hint } : {}), ...extra })

function safeList(dir, filter) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (filter ? filter(e) : true))
      .map((e) => e.name)
  } catch { return null }   // null = unreadable, [] = empty
}

function ageMs(now, ts) { return Number.isFinite(ts) ? now - ts : null }
function humanAge(ms) {
  if (ms == null) return 'unknown'
  const s = Math.round(ms / 1000)
  if (s < 90) return s + 's'
  const m = Math.round(s / 60)
  if (m < 90) return m + 'm'
  const h = Math.round(m / 60)
  if (h < 48) return h + 'h'
  return Math.round(h / 24) + 'd'
}
// BOM-tolerant (Windows tooling writes UTF-8 BOMs; JSON.parse refuses them).
function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
  } catch { return null }
}

/**
 * @param {object} args
 * @param {string} args.hermesHome
 * @param {string} [args.dshHome]            DSH home (state dir parent)
 * @param {object} [args.live]               { mirrorPolicy, mirrorDecisions, outboxStats }
 * @param {number} [args.now]
 * @param {object} [args.ttl]
 * @param {Function} [args.scanImportedPins] optional async (stateDir) => {scanned, missing:[ids], error?}
 * @returns {Promise<object>} report
 */
export async function runDoctor({ hermesHome, dshHome, live = null, now = Date.now(), ttl = {}, scanImportedPins = null } = {}) {
  const T = { ...DOCTOR_TTLS, ...ttl }
  const checks = []
  const inboxDsh = join(hermesHome, 'inbox', 'dsh')
  const stateDir = dshHome ? join(dshHome, 'dsh-hermes-link') : null

  // ---- 0. the shared root + our state dir -----------------------------------
  if (!hermesHome || !existsSync(hermesHome)) {
    checks.push(fail('hermes_home', 'Hermes home exists', String(hermesHome || '(unset)'), 'set HERMES_HOME or install Hermes'))
  } else {
    checks.push(ok('hermes_home', 'Hermes home exists', hermesHome))
  }
  if (stateDir) {
    let writable = false
    try { mkdirSync(stateDir, { recursive: true }); const probe = join(stateDir, '.doctor-probe'); writeFileSync(probe, 'ok'); unlinkSync(probe); writable = true } catch (_e) { writable = false }
    checks.push(writable
      ? ok('state_dir', 'plugin state dir writable', stateDir)
      : fail('state_dir', 'plugin state dir writable', stateDir, 'check permissions on ' + stateDir))
  }

  // ---- 1. heartbeat: is the plugin actually alive? --------------------------
  const heartbeatDir = join(inboxDsh, 'heartbeat')
  // latest.json is the canonical "last beat" file, so it counts as a beat
  // source even when the timestamped copies have been rotated away.
  const beats = safeList(heartbeatDir, (e) => e.isFile() && e.name.endsWith('.json'))
  if (beats === null) {
    checks.push(fail('heartbeat', 'plugin heartbeat', 'no heartbeat directory at ' + heartbeatDir, 'the plugin has never run against this Hermes home'))
  } else {
    let newest = 0
    for (const b of beats) {
      try { const st = statSync(join(heartbeatDir, b)); if (st.mtimeMs > newest) newest = st.mtimeMs } catch (_e) { /* skip */ }
    }
    const latest = readJson(join(heartbeatDir, 'latest.json'))
    if (latest && Number.isFinite(latest.ts) && latest.ts > newest) newest = latest.ts
    const age = newest ? ageMs(now, newest) : null
    const stamped = beats.filter((b) => b !== 'latest.json').length
    const detail = stamped + ' beats; newest ' + humanAge(age) + ' ago' + (latest && latest.pid ? '; last pid ' + latest.pid : '')
    checks.push(age != null && age <= T.heartbeatMs
      ? ok('heartbeat', 'plugin heartbeat', detail)
      : warn('heartbeat', 'plugin heartbeat', detail, 'DSH is not running (or the plugin is unloaded) -- every file channel below is frozen until it is'))
  }

  // ---- 2. mirror policy + active mirrors ------------------------------------
  const mirrorDir = join(inboxDsh, 'session-mirror')
  const activeMirrors = safeList(mirrorDir, (e) => e.isFile() && e.name.endsWith('.jsonl')) || []
  const archiveDir = join(mirrorDir, 'archive')
  const archiveDays = safeList(archiveDir, (e) => e.isDirectory()) || []
  const mirrorState = stateDir ? readJson(join(stateDir, 'session-mirror-state.json')) : null
  const enabledSessions = mirrorState && mirrorState.sessions ? Object.keys(mirrorState.sessions) : []

  if (live && live.mirrorPolicy) {
    const p = live.mirrorPolicy
    const detail = 'policy=' + p.policy +
      (p.extra_projects && p.extra_projects.length ? ' extra_projects=' + p.extra_projects.length : '') +
      '; auto-enabled=' + (p.auto_enabled_sessions || 0) + '; opted-out=' + (p.opted_out_sessions || 0) +
      (p.projects_file ? '; projects_file=' + p.projects_file : '')
    if (p.projects_file_error) {
      // The state that was silent until 2026-09-17: a config file that exists but
      // cannot be parsed leaves the mirror on the env list alone, so the scope is
      // NOT what the file says -- and nothing used to report it.
      checks.push(warn('mirror_policy', 'mirror policy', detail + '; projects file UNREADABLE: ' + p.projects_file_error,
        'the mirror is running on ' + (p.projects_env_var || 'HERMES_LINK_MIRROR_PROJECTS') + ' alone -- fix or remove ' + p.projects_file))
    } else if (p.policy === 'off') {
      checks.push(warn('mirror_policy', 'mirror policy', detail, 'HERMES_LINK_MIRROR_POLICY=off mirrors nothing unless a session opts in explicitly'))
    } else {
      checks.push(ok('mirror_policy', 'mirror policy', detail))
    }
  } else {
    checks.push(ok('mirror_policy', 'mirror policy', '(not resolved in-process; run the doctor through DSH for the live policy)'))
  }

  if (activeMirrors.length === 0) {
    checks.push(warn('mirror_active', 'active session mirrors',
      enabledSessions.length + ' session(s) enabled in state, 0 active .jsonl file(s)' + (archiveDays.length ? '; archive has ' + archiveDays.length + ' day(s)' : ''),
      'a matching session must produce events before a file appears; if you expect one, check the policy scope (HERMES_LINK_MIRROR_PROJECTS)'))
  } else {
    const stale = []
    const fresh = []
    for (const f of activeMirrors) {
      try {
        const st = statSync(join(mirrorDir, f))
        const age = ageMs(now, st.mtimeMs)
        const enabled = enabledSessions.includes(f.replace(/\.jsonl$/, ''))
        if (enabled && age > T.mirrorIdleMs) stale.push({ file: f, age_ms: age, size: st.size })
        else fresh.push({ file: f, age_ms: age, size: st.size })
      } catch (_e) { /* skip */ }
    }
    if (stale.length > 0) {
      checks.push(warn('mirror_active', 'active session mirrors',
        activeMirrors.length + ' file(s); ' + stale.length + ' enabled but idle: ' + stale.map((s) => s.file + ' (' + humanAge(s.age_ms) + ')').join(', '),
        'an enabled session whose file stopped growing means events stopped reaching the mirror',
        { data: { stale, fresh: fresh.slice(0, 10) } }))
    } else {
      checks.push(ok('mirror_active', 'active session mirrors', activeMirrors.length + ' file(s), all advancing'))
    }
  }

  // ---- 3. consult backlog ---------------------------------------------------
  const consultDir = join(inboxDsh, 'consult')
  const replyDir = join(inboxDsh, 'consult-reply')
  const tickets = safeList(consultDir, (e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.expired.json')) || []
  const replies = safeList(replyDir, (e) => e.isFile() && e.name.endsWith('.json')) || []
  const staleTickets = []
  const freshTickets = []
  const repliedTickets = []
  for (const t of tickets) {
    let ts = null
    const parsed = readJson(join(consultDir, t))
    if (parsed && Number.isFinite(parsed.ts)) ts = parsed.ts
    else { const m = /^(\d{10,})/.exec(t); if (m) ts = Number(m[1]) }
    const age = ageMs(now, ts)
    const entry = { file: t, age_ms: age, ticket: parsed && parsed.ticket ? parsed.ticket : null }
    // A ticket with a reply on disk is answered, however late: the reply is only
    // deleted when a consult consumes it, so an unconsumed late reply must not be
    // reported as backlog forever.
    // A reply file is deleted when DSH consumes it, so the answered marker the
    // Hermes-side plugin leaves behind is the durable evidence.
    const replied = entry.ticket
      ? replies.some((r) => r === entry.ticket + '.json' || r.startsWith(entry.ticket + '-')) ||
        (safeList(consultDir, (e) => e.isFile() && e.name === entry.ticket + '.answered.json') || []).length > 0
      : false
    if (replied) repliedTickets.push(entry)
    else if (age != null && age > T.consultMs) staleTickets.push(entry)
    else freshTickets.push(entry)
  }
  if (staleTickets.length > 0) {
    const oldest = staleTickets.reduce((a, b) => ((a.age_ms || 0) > (b.age_ms || 0) ? a : b))
    checks.push(warn('consult', 'consult backlog',
      staleTickets.length + ' ticket(s) older than ' + humanAge(T.consultMs) + ' with no reply; oldest ' + humanAge(oldest.age_ms) + ' (' + oldest.file + '); replies waiting: ' + replies.length,
      'Hermes is not consuming inbox/dsh/consult/ -- start its gateway/poller, or the ticket is abandoned',
      { data: { stale: staleTickets.slice(0, 10), fresh: freshTickets.length } }))
  } else {
    checks.push(ok('consult', 'consult backlog', tickets.length + ' ticket(s), none stale; replies waiting: ' + replies.length +
      (repliedTickets.length ? ' (' + repliedTickets.length + ' already answered)' : '')))
  }

  // ---- 4. amend directory writability --------------------------------------
  const amendDir = join(inboxDsh, 'amend')
  let amendWritable = false
  try {
    mkdirSync(amendDir, { recursive: true })
    const probe = join(amendDir, '.doctor-probe')
    writeFileSync(probe, 'ok'); unlinkSync(probe)
    amendWritable = true
  } catch (_e) { amendWritable = false }
  checks.push(amendWritable
    ? ok('amend_dir', 'amend directory writable', amendDir)
    : fail('amend_dir', 'amend directory writable', amendDir, 'Hermes cannot amend a running child until this path is writable'))

  // ---- 5. Hermes -> DSH notification consumer -------------------------------
  const outboxDir = join(hermesHome, 'outbox', 'hermes')
  const doneDir = join(outboxDir, 'done')
  const outboxState = stateDir ? readJson(join(stateDir, 'hermes-outbox-consumed.json')) : null
  const pendingRetries = outboxState && outboxState.attempts ? Object.keys(outboxState.attempts).length : 0
  const consumedIds = outboxState && outboxState.consumed ? Object.keys(outboxState.consumed).length : 0
  const doneFiles = safeList(doneDir, (e) => e.isFile()) || []
  const waiting = safeList(outboxDir, (e) => e.isFile() && e.name.endsWith('.json')) || []
  const outboxDetail = 'waiting=' + waiting.length + '; consumed ids=' + consumedIds + '; archived=' + doneFiles.length + '; pending retries=' + pendingRetries
  if (live && live.outboxStats && live.outboxStats.last_error) {
    checks.push(warn('hermes_outbox', 'Hermes->DSH outbox', outboxDetail + '; last_error=' + live.outboxStats.last_error,
      'a notification failed to execute; it is retried in place and then parked as done/failed-*'))
  } else if (pendingRetries > 0) {
    checks.push(warn('hermes_outbox', 'Hermes->DSH outbox', outboxDetail, 'retrying a notification that keeps failing'))
  } else {
    checks.push(ok('hermes_outbox', 'Hermes->DSH outbox', outboxDetail))
  }

  // ---- 5b. the Hermes-side producer (the other half of the reverse channel) --
  // A consumer with no producer looks exactly like "nothing to do": this is the
  // check that tells the two apart.
  const producerDir = join(hermesHome, 'plugins', 'dsh-outbox')
  const producerInstalled = existsSync(join(producerDir, 'plugin.yaml')) && existsSync(join(producerDir, '__init__.py'))
  const produced = doneFiles.length + waiting.length
  if (producerInstalled) {
    checks.push(ok('hermes_producer', 'Hermes producer plugin', 'installed at ' + producerDir + '; ' + produced + ' notification file(s) seen (pending + archived)'))
  } else {
    checks.push(warn('hermes_producer', 'Hermes producer plugin',
      'not installed (' + producerDir + ' missing)',
      'run: npx hermes-link-install-hermes-plugin (then restart Hermes) -- without it nothing writes outbox/hermes/, so the reverse channel stays idle',
      { data: { plugin_dir: producerDir, produced_files: produced } }))
  }

  // ---- 6. optional: imported sessions whose model route is unavailable ------
  if (typeof scanImportedPins === 'function' && dshHome) {
    try {
      const scan = await scanImportedPins(join(dshHome, 'sessions'))
      if (scan && scan.error) checks.push(warn('imported_model_pin', 'imported session model pins', 'scan failed: ' + scan.error))
      else if (scan && scan.missing && scan.missing.length > 0) {
        checks.push(warn('imported_model_pin', 'imported session model pins',
          scan.missing.length + '/' + scan.scanned + ' imported session(s) have no routable model/selection; e.g. ' + scan.missing.slice(0, 3).join(', '),
          'run: node scripts/repair-imported-model-selection.mjs --apply',
          { data: { missing: scan.missing.slice(0, 20) } }))
      } else if (scan) {
        checks.push(ok('imported_model_pin', 'imported session model pins', scan.scanned + ' session(s) checked, all pinned'))
      }
    } catch (e) {
      checks.push(warn('imported_model_pin', 'imported session model pins', 'scan threw: ' + (e && e.message || e)))
    }
  }

  const summary = checks.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc }, { ok: 0, warn: 0, fail: 0 })
  return {
    generated_at: now,
    hermes_home: hermesHome,
    dsh_home: dshHome || null,
    ok: summary.fail === 0,
    summary,
    checks,
  }
}

/** One-line-per-check renderer shared by the CLI (and handy in logs). */
export function renderDoctor(report) {
  const icon = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' }
  const lines = []
  lines.push('dsh-hermes-link doctor  ' + new Date(report.generated_at).toISOString())
  lines.push('  hermes home: ' + report.hermes_home)
  if (report.dsh_home) lines.push('  dsh home   : ' + report.dsh_home)
  lines.push('')
  for (const c of report.checks) {
    lines.push('  [' + icon[c.status] + '] ' + c.title + ' -- ' + c.detail)
    if (c.hint) lines.push('           hint: ' + c.hint)
  }
  lines.push('')
  lines.push('  ' + report.summary.ok + ' ok, ' + report.summary.warn + ' warn, ' + report.summary.fail + ' fail')
  return lines.join('\n')
}
