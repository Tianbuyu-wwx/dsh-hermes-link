// services/status.mjs
//
// v0.6.9 - the one-glance answer to "is this thing working, and what should I do
// next?".
//
// WHY IT EXISTS (and how it differs from the doctor)
//   The doctor is a CHECK LIST: eleven probes, each with a status and a hint, built
//   for scripts and for the CLI. It is the right thing to hand to a machine and the
//   wrong thing to hand to a person who just wants to know whether their two agents
//   are talking. Worse, the useful numbers (how many notifications arrived, how many
//   tokens a consult cost, when the mirror last grew) were spread across four
//   endpoints that nobody thinks to curl.
//
//   This module is deliberately pure: give it the doctor report plus whatever live
//   state the caller has, get back a headline, one line per channel, the signals, and
//   a short list of next actions. No filesystem, no cordis -- so the session tool,
//   the HTTP route and the tests all render exactly the same thing.

const fmtAge = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return 'unknown'
  if (ms < 1000) return 'just now'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's ago'
  const m = Math.round(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 48) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}

const checkOf = (report, id) => (report && Array.isArray(report.checks) ? report.checks.find((c) => c && c.id === id) : null)

/**
 * @param {object} input
 * @param {object} input.report          runDoctor() output (required-ish; null tolerated)
 * @param {object} [input.outboxStats]   hermesOutbox.stats()
 * @param {object} [input.consultHealth] consultClient.channelHealth()
 * @param {object} [input.mirror]        sessionMirror.policyStatus()
 * @param {object} [input.signals]       parsed metric signals (doctor 'signals' data)
 * @returns {{headline:string, counters:object, channels:Array, signals:object, next_actions:string[]}}
 */
export function summariseStatus({ report = null, outboxStats = null, consultHealth = null, mirror = null, signals = null } = {}) {
  const summary = (report && report.summary) || { ok: 0, warn: 0, fail: 0 }
  const channels = []
  const next = []

  // 1. Hermes -> DSH notifications
  const outbox = checkOf(report, 'hermes_outbox')
  const stats = outboxStats || {}
  channels.push({
    id: 'notifications',
    title: 'Hermes notifications',
    state: outbox ? outbox.status : 'unknown',
    detail: 'pending=' + (stats.pending_retries || 0) + ' archived=' + (stats.archived || 0) +
      ' failed_attempts=' + (stats.failed || 0) + (stats.last_error ? ' last_error=' + stats.last_error : ''),
  })

  // 2. session import
  const pins = checkOf(report, 'imported_model_pin')
  const producer = checkOf(report, 'hermes_producer')
  channels.push({
    id: 'import',
    title: 'Session import',
    state: producer ? producer.status : 'unknown',
    detail: producer ? producer.detail : 'not measured',
  })
  if (pins && pins.status !== 'ok') {
    channels.push({ id: 'model_pin', title: 'Imported model pins', state: pins.status, detail: pins.detail })
    if (pins.hint) next.push(pins.hint.replace(/^run: /, ''))
  }

  // 3. mirror
  const mirrorCheck = checkOf(report, 'mirror_active')
  channels.push({
    id: 'mirror',
    title: 'Session mirror',
    state: mirrorCheck ? mirrorCheck.status : 'unknown',
    detail: (mirrorCheck ? mirrorCheck.detail : 'not measured') +
      (mirror && mirror.policy ? ' [policy=' + mirror.policy + ']' : ''),
  })

  // 4. consult
  const consult = consultHealth || null
  channels.push({
    id: 'consult',
    title: 'Consult channel',
    state: consult ? (consult.verdict === 'healthy' ? 'ok' : consult.verdict === 'degraded' ? 'warn' : 'fail') : 'unknown',
    detail: consult ? consult.note : 'not measured',
  })
  if (consult && consult.verdict === 'dead') next.push('Hermes is not answering consult tickets -- start its gateway, or run: npx hermes-link-consult-admin')

  // 5. the bridge plugin itself
  const bridge = checkOf(report, 'hermes_producer')
  if (bridge && bridge.status !== 'ok' && bridge.hint) next.push(bridge.hint.replace(/^run: /, ''))

  const s = signals || (checkOf(report, 'signals') ? checkOf(report, 'signals').data : null) || {}
  const headline = summary.fail > 0
    ? summary.fail + ' channel(s) BROKEN, ' + summary.warn + ' warning(s)'
    : summary.warn > 0
      ? 'working, ' + summary.warn + ' warning(s)'
      : 'all channels working'

  return {
    headline,
    counters: { ok: summary.ok, warn: summary.warn, fail: summary.fail },
    channels,
    signals: s,
    next_actions: [...new Set(next)],
  }
}

/** Human-readable rendering; the shape the session tool and the HTTP route both use. */
export function renderStatus(status) {
  if (!status) return 'no status available'
  const lines = []
  lines.push('dsh-hermes-link: ' + status.headline)
  for (const c of status.channels) {
    const tag = c.state === 'ok' ? 'ok  ' : c.state === 'warn' ? 'WARN' : c.state === 'fail' ? 'FAIL' : '?   '
    lines.push('  [' + tag + '] ' + c.title.padEnd(20) + ' ' + c.detail)
  }
  const s = status.signals || {}
  const keys = ['hermes_link_dispatch_total', 'hermes_link_import_total', 'hermes_link_consult_total', 'hermes_link_consult_tokens_total', 'hermes_link_hermes_outbox_total', 'hermes_link_mirror_policy_auto_enabled_total', 'hermes_link_uptime_seconds']
  const present = keys.filter((k) => Number.isFinite(s[k]))
  if (present.length) {
    lines.push('  since load: ' + present.map((k) => k.replace(/^hermes_link_|_total$/g, '') + '=' + s[k]).join(' '))
  }
  if (status.next_actions.length) {
    lines.push('  next:')
    for (const a of status.next_actions) lines.push('    - ' + a)
  } else if (status.counters.fail === 0) {
    lines.push('  next: nothing to do')
  }
  return lines.join('\n')
}

export { fmtAge }
