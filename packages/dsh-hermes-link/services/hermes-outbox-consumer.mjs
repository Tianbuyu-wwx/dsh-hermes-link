// services/hermes-outbox-consumer.mjs
//
// C1 (v0.6.0) -- the missing reverse direction: Hermes Home/outbox/hermes/.
//
// docs/DSH-HERMES-LINK-PLAN.md:95 has promised this directory since the design
// ("outbox/hermes/ # NEW: Hermes 给 DSH 的主动通知 (D1/H4)") and no code ever
// read it, so Hermes could not notify DSH of anything -- every Hermes->DSH
// signal had to be discovered by DSH polling. This service is the consumer, and
// it deliberately copies the ALREADY-VERIFIED services/amend-watcher.mjs shape
// instead of inventing a new one (audit phase C, item 1): fs.watch + debounce,
// a slow safety-net poll, fs.watch fallback to 2s polling, and processed files
// renamed into a done/ subdirectory.
//
// PROTOCOL (file-based, no HTTP)
//   Hermes Home/outbox/hermes/<name>.json
//   Hermes Home/outbox/hermes/task-event/<name>.json      (planned layout)
//   {
//     "id":         "<unique>",        // REQUIRED: the idempotency key (C3)
//     "source":     "hermes",          // 'dsh' = our own echo -> never executed
//     "kind":       "import" | "notify" | "ping",
//     "session_id": "<hermes sid>",    // REQUIRED for kind=import
//     "task_id":    "<optional correlation>",
//     "created_at": 1234567890,
//     "payload":    { ... }
//   }
//
// OUTCOMES (every file leaves the scan set one way or another, so a scan can
// never spin forever on one bad file -- the amend-watcher convention):
//   executed            -> outbox/hermes/done/<name>.json
//   duplicate (C3)      -> done/duplicate-<ts>-<name>.json
//   echo (source=dsh)   -> done/echo-<ts>-<name>.json
//   malformed / bad id  -> done/malformed-* / done/no-id-*
//   unsupported kind    -> done/unsupported-<ts>-<name>.json
//   failed N times      -> done/failed-<ts>-<name>.json
//   failed, retries left-> LEFT IN PLACE (retried on the next scan)
//
// IDEMPOTENCY (C3): (source,id) pairs are remembered in
// ~/.dsh/dsh-hermes-link/hermes-outbox-consumed.json, so a redelivered
// notification executes at most once -- across restarts too.

import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendAudit, stateDir } from './audit.mjs'

let metricsSink = null
export function setMetricsSink(m) { metricsSink = m }

const POLL_INTERVAL_MS = 2000      // legacy fallback (when fs.watch is unavailable)
const FS_WATCH_DEBOUNCE_MS = 200    // collect burst events into one batch
const FS_WATCH_FALLBACK_MS = 5000  // slow safety-net poll even when fs.watch is active

/** Retries before a failing notification is parked in done/ as failed-*. */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * How long a failing notification may keep retrying before it is parked.
 *
 * WHY (live evidence 2026-09-18): the Hermes bridge notifies on every turn end,
 * but the `request_dump` the importer needs is written later -- the cron session
 * `..._233221` ended around 23:32 and its dump only appeared at 23:52. Three
 * attempts inside ~10s therefore parked the notification as `failed-*` with
 * `not_found`, and that session stayed invisible in DSH until a second
 * notification arrived. Attempts alone are the wrong knob: `not_found` is a
 * "not yet", not a "never".
 */
export const DEFAULT_RETRY_WINDOW_MS = 30 * 60 * 1000

/** Kinds this build knows how to execute. Anything else is archived loudly. */
export const SUPPORTED_KINDS = Object.freeze(['import', 'notify', 'ping'])

/** State file (idempotency + retry budget) inside the plugin state dir. */
export const STATE_FILE_NAME = 'hermes-outbox-consumed.json'

const MAX_ID_LENGTH = 200
const MAX_REMEMBERED = 5000

function incMetric(name, labels) {
  try { if (metricsSink && typeof metricsSink.inc === 'function') metricsSink.inc(name, labels) } catch (_e) { /* never load-bearing */ }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Strip a UTF-8 BOM before JSON.parse.
 *
 * Live evidence (2026-09-16): the very first real notification dropped into
 * outbox/hermes/ was rejected as malformed -- PowerShell's `Set-Content
 * -Encoding utf8` (and Notepad, and plenty of Windows tooling) writes a BOM and
 * JSON.parse refuses it. The producer here is Hermes on Windows, so a BOM is a
 * normal accident, not corruption: tolerate it instead of parking the file.
 */
const stripBom = (text) => (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)

/**
 * Validate one parsed notification. Pure, so the whole matrix is unit-testable.
 * @param {unknown} raw parsed JSON
 * @returns {{ok: true, value: object}|{ok: false, reason: string, archiveAs: string}}
 */
export function validateNotification(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_an_object', archiveAs: 'malformed' }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return { ok: false, reason: 'missing_id', archiveAs: 'no-id' }
  if (id.length > MAX_ID_LENGTH) return { ok: false, reason: 'id_too_long', archiveAs: 'no-id' }
  const source = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : ''
  // C3 echo guard: never execute what this side wrote. Same property as the
  // mirror's echo guard (mirror-policy.isEchoSession), other direction.
  if (source === 'dsh') return { ok: false, reason: 'echo_source_dsh', archiveAs: 'echo' }
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : ''
  if (!kind) return { ok: false, reason: 'missing_kind', archiveAs: 'unsupported' }
  if (!SUPPORTED_KINDS.includes(kind)) return { ok: false, reason: 'unsupported_kind:' + kind, archiveAs: 'unsupported' }
  if (kind === 'import') {
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : ''
    if (!sessionId) return { ok: false, reason: 'import_without_session_id', archiveAs: 'bad-payload' }
    return { ok: true, value: { id, source: source || 'hermes', kind, session_id: sessionId, task_id: raw.task_id == null ? null : String(raw.task_id), created_at: raw.created_at == null ? null : raw.created_at, payload: isPlainObject(raw.payload) ? raw.payload : null } }
  }
  return { ok: true, value: { id, source: source || 'hermes', kind, task_id: raw.task_id == null ? null : String(raw.task_id), created_at: raw.created_at == null ? null : raw.created_at, payload: isPlainObject(raw.payload) ? raw.payload : null } }
}

/**
 * @param {object} deps
 * @param {string} deps.hermesHome
 * @param {object} [deps.ctx]        Cordis ctx (unused today; kept for parity with the other watchers)
 * @param {object} [deps.importer]   importer from import/import-hermes-session.mjs (kind=import)
 * @param {object} [deps.broker]     SSE broker (kind=notify publishes here)
 * @param {object} [deps.metrics]    metrics registry
 * @param {Record<string,string>} [deps.env]   env for tests
 * @param {boolean} [deps.autoStart] false = construct without timers/watchers (tests)
 * @param {number} [deps.maxAttempts]
 * @returns {{dispose: Function, scanOnce: Function, handleFile: Function, stats: Function, dirs: object}}
 */
export function createHermesOutboxConsumer({ hermesHome, ctx, importer, broker, metrics, env, autoStart = true, maxAttempts = DEFAULT_MAX_ATTEMPTS, retryWindowMs = DEFAULT_RETRY_WINDOW_MS } = {}) {
  if (metrics && typeof metrics.inc === 'function') metricsSink = metrics
  const outboxDir = join(hermesHome, 'outbox', 'hermes')
  const doneDir = join(outboxDir, 'done')
  const statePath = join(stateDir(), STATE_FILE_NAME)

  try { mkdirSync(outboxDir, { recursive: true }) } catch { /* best-effort */ }
  try { mkdirSync(doneDir, { recursive: true }) } catch { /* best-effort */ }

  const state = loadState()
  const counters = { scanned: 0, executed: 0, duplicates: 0, archived: 0, failed: 0 }
  let lastError = null
  let lastAt = null
  let stopped = false

  function loadState() {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (isPlainObject(parsed)) {
        return {
          version: 1,
          consumed: isPlainObject(parsed.consumed) ? parsed.consumed : {},
          attempts: isPlainObject(parsed.attempts) ? parsed.attempts : {},
        }
      }
    } catch (_e) { /* absent or unreadable: start empty, never fail the plugin */ }
    return { version: 1, consumed: {}, attempts: {} }
  }

  function persist() {
    try {
      mkdirSync(stateDir(), { recursive: true })
      // Bound the remembered set: the map is a dedupe window, not a ledger.
      const keys = Object.keys(state.consumed)
      if (keys.length > MAX_REMEMBERED) {
        const ordered = keys.sort((a, b) => (state.consumed[a] || 0) - (state.consumed[b] || 0))
        for (const k of ordered.slice(0, keys.length - MAX_REMEMBERED)) delete state.consumed[k]
      }
      writeFileSync(statePath, JSON.stringify(state), 'utf8')
    } catch (e) {
      console.warn('[dsh-hermes-link] hermes-outbox state write failed:', e && e.message || e)
    }
  }

  function archive(full, name, prefix) {
    const target = join(doneDir, prefix ? prefix + '-' + Date.now() + '-' + name : name)
    try { renameSync(full, target); return target } catch (_e) { return null }
  }

  async function execute(notification) {
    if (notification.kind === 'import') {
      if (!importer || typeof importer.importSession !== 'function') {
        return { ok: false, error: 'importer unavailable (ctx.sessions not mounted)' }
      }
      const result = await importer.importSession(notification.session_id, notification.payload && notification.payload.workspace ? { workspace: notification.payload.workspace } : undefined)
      const status = result && result.status
      // created / already_imported are both terminal successes: the projection
      // exists either way, which is all a "session-ready" notification promises.
      if (status === 'created' || status === 'already_imported') return { ok: true, result: { status, sessionId: result.sessionId || null } }
      return { ok: false, error: status + (result && result.error ? ': ' + result.error : '') }
    }
    // notify / ping: no side effect beyond observability.
    if (broker && typeof broker.publish === 'function') {
      try {
        broker.publish('hermes-outbox', { kind: 'hermes/' + notification.kind, data: { id: notification.id, task_id: notification.task_id, source: notification.source, payload: notification.payload } })
      } catch (_e) { /* never load-bearing */ }
    }
    return { ok: true, result: { status: 'notified' } }
  }

  /**
   * Read + validate + execute ONE notification file.
   * @returns {Promise<{outcome: string, reason?: string, target?: string|null}>}
   */
  async function handleFile(full, name) {
    let raw
    try { raw = JSON.parse(stripBom(readFileSync(full, 'utf8'))) } catch (e) {
      const message = String((e && e.message) || e)
      // A file that vanished between listing and reading was already taken by a
      // concurrent scan (the debounce, the safety poll and the start-up pass can
      // overlap). That is not an error and must not stick in last_error -- it
      // used to raise a doctor warning for a benign race.
      if ((e && e.code === 'ENOENT') || /ENOENT/.test(message)) {
        counters.gone = (counters.gone || 0) + 1
        return { outcome: 'gone', reason: 'file disappeared before it could be read', target: null }
      }
      lastError = message
      counters.archived++
      const target = archive(full, name, 'malformed')
      incMetric('hermes_link_hermes_outbox_total', { kind: 'unknown', result: 'malformed' })
      return { outcome: 'malformed', reason: lastError, target }
    }
    const verdict = validateNotification(raw)
    if (!verdict.ok) {
      counters.archived++
      const target = archive(full, name, verdict.archiveAs)
      incMetric('hermes_link_hermes_outbox_total', { kind: verdict.archiveAs, result: verdict.reason })
      appendAudit({ ts: Date.now(), source: 'hermes-outbox', action: 'rejected', reason: verdict.reason, file: name })
      return { outcome: verdict.archiveAs, reason: verdict.reason, target }
    }
    const notification = verdict.value
    const key = notification.source + ':' + notification.id
    if (state.consumed[key]) {
      counters.duplicates++
      const target = archive(full, name, 'duplicate')
      incMetric('hermes_link_hermes_outbox_total', { kind: notification.kind, result: 'duplicate' })
      return { outcome: 'duplicate', reason: 'already_consumed', target }
    }
    let outcome
    try {
      outcome = await execute(notification)
    } catch (e) {
      outcome = { ok: false, error: String(e && e.message || e) }
    }
    if (outcome.ok) {
      // A sticky last_error made the doctor warn forever about a failure that had
      // already been resolved (live: ten parked `not_found` notifications kept
      // "[warn] Hermes->DSH outbox" on screen long after imports worked again).
      lastError = null
      state.consumed[key] = Date.now()
      persist()
      counters.executed++
      const target = archive(full, name, null)
      incMetric('hermes_link_hermes_outbox_total', { kind: notification.kind, result: 'executed' })
      appendAudit({ ts: Date.now(), source: 'hermes-outbox', action: 'consumed', kind: notification.kind, id: notification.id, result: outcome.result || null })
      return { outcome: 'executed', target }
    }
    // Attempt records are {n, first}; older state files stored a bare number.
    const previous = state.attempts[name]
    const record = typeof previous === 'number'
      ? { n: previous, first: Date.now() }
      : (isPlainObject(previous) ? previous : { n: 0, first: Date.now() })
    record.n = (record.n || 0) + 1
    state.attempts[name] = record
    persist()
    lastError = outcome.error || 'unknown failure'
    counters.failed++
    incMetric('hermes_link_hermes_outbox_total', { kind: notification.kind, result: 'failed' })
    // Park only when BOTH budgets are spent: enough attempts AND enough wall-clock
    // time for the producer to catch up (a Hermes dump can land 20 minutes later).
    const outOfAttempts = record.n >= maxAttempts
    const outOfTime = Date.now() - (record.first || Date.now()) >= retryWindowMs
    if (outOfAttempts && outOfTime) {
      delete state.attempts[name]
      persist()
      counters.archived++
      const target = archive(full, name, 'failed')
      appendAudit({ ts: Date.now(), source: 'hermes-outbox', action: 'give_up', kind: notification.kind, id: notification.id, attempts: record.n, error: lastError })
      return { outcome: 'failed_parked', reason: lastError, target }
    }
    console.warn('[dsh-hermes-link] hermes-outbox delivery failed (' + record.n + '/' + maxAttempts +
      ' attempts, retrying for up to ' + Math.round(retryWindowMs / 60000) + 'm), keeping file for retry:', name, '-', lastError)
    return { outcome: 'failed_retry', reason: lastError, target: null }
  }

  /** Every *.json directly in outbox/hermes/ plus one level of subdirectories. */
  function listNotificationFiles() {
    const out = []
    let entries = []
    try { entries = readdirSync(outboxDir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) { out.push({ full: join(outboxDir, e.name), name: e.name }); continue }
      if (!e.isDirectory() || e.name === 'done') continue
      let sub = []
      try { sub = readdirSync(join(outboxDir, e.name), { withFileTypes: true }) } catch { continue }
      for (const s of sub) {
        if (s.isFile() && s.name.endsWith('.json')) out.push({ full: join(outboxDir, e.name, s.name), name: e.name + '__' + s.name })
      }
    }
    return out
  }

  let scanning = false

  async function scanOnce() {
    if (stopped) return { scanned: 0 }
    // One scan at a time: the fs.watch debounce, the safety poll and the start-up
    // pass used to overlap, which produced ENOENT races on files another pass had
    // already archived.
    if (scanning) return { scanned: 0, skipped: 'scan_in_progress' }
    scanning = true
    try {
      return await scanPass()
    } finally {
      scanning = false
    }
  }

  async function scanPass() {
    const files = listNotificationFiles()
    counters.scanned += files.length
    lastAt = Date.now()
    for (const f of files) {
      if (stopped) break
      try { await handleFile(f.full, f.name) } catch (e) {
        lastError = String(e && e.message || e)
        console.warn('[dsh-hermes-link] hermes-outbox scan error:', lastError)
      }
    }
    return { scanned: files.length }
  }

  let pollHandle = null
  let watchHandle = null
  let debounceTimer = null
  let initialScan = null

  function scheduleScan() {
    if (stopped || debounceTimer) return
    debounceTimer = setTimeout(() => { debounceTimer = null; scanOnce().catch(() => {}) }, FS_WATCH_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  function installPollingFallback() {
    if (pollHandle) return
    pollHandle = setInterval(() => { if (!stopped) scanOnce().catch(() => {}) }, POLL_INTERVAL_MS)
    pollHandle.unref?.()
  }

  if (autoStart) {
    initialScan = setTimeout(() => { scanOnce().catch(() => {}) }, 3000)
    initialScan.unref?.()
    try {
      watchHandle = watch(outboxDir, { persistent: false }, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.json')) scheduleScan()
      })
      watchHandle.on('error', (err) => {
        console.warn('[dsh-hermes-link] hermes-outbox fs.watch error, falling back to polling:', err && err.message || err)
        try { watchHandle.close() } catch (_e) {}
        watchHandle = null
        installPollingFallback()
      })
      pollHandle = setInterval(() => { if (!stopped) scanOnce().catch(() => {}) }, FS_WATCH_FALLBACK_MS)
      pollHandle.unref?.()
    } catch (e) {
      console.warn('[dsh-hermes-link] hermes-outbox fs.watch unavailable, using polling:', e && e.message || e)
      installPollingFallback()
    }
  }

  return {
    dirs: { outboxDir, doneDir },
    scanOnce,
    handleFile,
    stats: () => ({ ...counters, last_error: lastError, last_scan_at: lastAt, consumed_ids: Object.keys(state.consumed).length, pending_retries: Object.keys(state.attempts).length }),
    dispose() {
      stopped = true
      if (initialScan) clearTimeout(initialScan)
      if (debounceTimer) clearTimeout(debounceTimer)
      if (pollHandle) clearInterval(pollHandle)
      try { if (watchHandle) watchHandle.close() } catch (_e) {}
      persist()
    },
  }
}
