// services/outbox-rotation.mjs
//
// v0.3.1 (F2) - File rotation for the outbox (D3/D6/D7/V4) so a long-running
// DSH does not fill Hermes Home with unbounded append-only / per-event files.
//
// Triggers:
//   - Size:  usage.jsonl / session-mirror/<sid>.jsonl  >  sizeBytes
//   - Time:  files older than archiveAfterDays get moved to archive/ subdirs
//   - Prune: archive/ files older than purgeAfterDays are deleted
//
// All paths are relative to Hermes Home. The rotation service never throws;
// failures are reported via stats().counters.
//
// File layout produced:
//   heartbeat/                  (per-beat, one file per timestamp)
//     <ts>.json
//     latest.json
//     archive/<YYYY-MM-DD>/<ts>.json     <- after archiveAfterDays heartbeat (1d)
//   memory-suggest/<ts>.json
//     archive/<YYYY-MM-DD>/<ts>.json     <- after 7d
//   usage.jsonl                                <- append-only
//     usage-YYYY-MM-DD.jsonl                   <- rotated when > sizeBytes
//   session-mirror/<sid>.jsonl                 <- append-only
//     archive/<sid>/<sid>-YYYY-MM-DD.jsonl    <- rotated per session

import { existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_SIZE_LIMITS = {
  heartbeat: 0,            // heartbeat files are tiny; no size rotation
  memorySuggest: 10 * 1024 * 1024,
  usage: 10 * 1024 * 1024,
  sessionMirror: 50 * 1024 * 1024,
}

const DEFAULT_ARCHIVE_DAYS = {
  heartbeat: 1,
  memorySuggest: 7,
  usage: 0,                // 0 = size-only; no age archive
  sessionMirror: 7,
}

const DEFAULT_PURGE_DAYS = {
  heartbeat: 7,
  memorySuggest: 30,
  usage: 90,
  sessionMirror: 30,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Create an outbox rotation service.
 *
 * @param {object} opts
 * @param {string} opts.hermesHome
 * @param {object} [opts.sizeLimits]      bytes per kind (0 = no size rotation)
 * @param {object} [opts.archiveAfterDays] age in days before archive (0 = skip)
 * @param {object} [opts.purgeAfterDays]   age in days before deletion (0 = keep)
 * @param {number} [opts.checkIntervalMs] periodic timer (default 1h)
 * @returns {{
 *   rotateNow: () => Promise<RotationResult>,
 *   startInterval: () => void,
 *   stop: () => void,
 *   stats: () => RotationStats,
 * }}
 */
export function createOutboxRotation({
  hermesHome,
  sizeLimits      = DEFAULT_SIZE_LIMITS,
  archiveAfterDays = DEFAULT_ARCHIVE_DAYS,
  purgeAfterDays   = DEFAULT_PURGE_DAYS,
  checkIntervalMs = 60 * 60 * 1000,
} = {}) {
  const root = join(hermesHome, 'inbox', 'dsh')
  const heartbeatDir = join(root, 'heartbeat')
  const usagePath    = join(root, 'usage.jsonl')
  const suggestDir   = join(root, 'memory-suggest')
  const mirrorDir    = join(root, 'session-mirror')

  const counters = {
    rotations: 0,
    archives: 0,
    purges: 0,
    errors: 0,
    lastRunAt: null,
    lastDurationMs: 0,
  }

  let timer = null

  function ensureDir(d) { try { mkdirSync(d, { recursive: true }) } catch {} }
  ensureDir(join(heartbeatDir, 'archive'))
  ensureDir(join(suggestDir, 'archive'))

  /**
   * Move files in `dir` older than `ageDays` to `dir/archive/YYYY-MM-DD/`.
   * Returns the number of files archived.
   */
  function archiveDirByAge(dir, ageDays, label) {
    if (ageDays <= 0) return 0
    const cutoff = Date.now() - ageDays * MS_PER_DAY
    let n = 0
    let entries
    try { entries = readdirSync(dir) } catch { return 0 }
    for (const name of entries) {
      if (name === 'archive' || name === 'latest.json') continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      if (st.mtimeMs >= cutoff) continue
      const day = new Date(st.mtimeMs).toISOString().slice(0, 10)
      const destDir = join(dir, 'archive', day)
      ensureDir(destDir)
      const dest = join(destDir, name)
      try {
        renameSync(full, dest)
        n++
        counters.archives++
      } catch (e) {
        counters.errors++
        console.warn('[dsh-hermes-link] rotation: archive failed', label, name, e && e.message || e)
      }
    }
    return n
  }

  /**
   * Delete files in `archiveDir` (recursively) older than `purgeDays`.
   * Returns the number of files purged.
   */
  function purgeDirByAge(archiveRoot, purgeDays, label) {
    if (purgeDays <= 0) return 0
    const cutoff = Date.now() - purgeDays * MS_PER_DAY
    let n = 0
    let entries
    try { entries = readdirSync(archiveRoot, { withFileTypes: true }) } catch { return 0 }
    for (const entry of entries) {
      const full = join(archiveRoot, entry.name)
      if (entry.isDirectory()) {
        // recurse into YYYY-MM-DD subdirs
        let inner
        try { inner = readdirSync(full) } catch { continue }
        for (const file of inner) {
          const fp = join(full, file)
          let st
          try { st = statSync(fp) } catch { continue }
          if (!st.isFile()) continue
          if (st.mtimeMs >= cutoff) continue
          try { unlinkSync(fp); n++; counters.purges++ } catch (e) {
            counters.errors++
            console.warn('[dsh-hermes-link] rotation: purge failed', label, fp, e && e.message || e)
          }
        }
        // remove now-empty day dir
        try {
          const stillThere = readdirSync(full)
          if (stillThere.length === 0) {
            try { unlinkSync(full) } catch {}
          }
        } catch {}
      } else if (entry.isFile()) {
        let st
        try { st = statSync(full) } catch { continue }
        if (st.mtimeMs < cutoff) {
          try { unlinkSync(full); n++; counters.purges++ } catch (e) {
            counters.errors++
            console.warn('[dsh-hermes-link] rotation: purge failed', label, full, e && e.message || e)
          }
        }
      }
    }
    return n
  }

  /**
   * If `path` is larger than `limitBytes`, rotate to a date-stamped sibling.
   * Returns the new path or null if no rotation occurred.
   */
  function rotateBySize(path, limitBytes, label) {
    if (limitBytes <= 0) return null
    let st
    try { st = statSync(path) } catch { return null }
    if (st.size <= limitBytes) return null
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.replace(/[\\/][^\\/]+$/, '')  // dirname via regex (avoids node:path import cycles)
    const base = path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
    const ext = path.match(/\.[^.]+$/)?.[0] || ''
    const dest = join(dir, `${base}-${day}${ext}`)
    // If dest exists from a previous rotation today, append a counter
    let final = dest, n = 1
    while (existsSync(final)) {
      final = join(dir, `${base}-${day}-${n}${ext}`)
      n++
    }
    try {
      renameSync(path, final)
      counters.rotations++
      return final
    } catch (e) {
      counters.errors++
      console.warn('[dsh-hermes-link] rotation: size-rotate failed', label, path, e && e.message || e)
      return null
    }
  }

  /** Rotate a per-session mirror file: moves to archive/<sid>/<sid>-YYYY-MM-DD.jsonl */
  function rotateSessionMirrorFile(mirrorPath, sid, limitBytes) {
    if (limitBytes <= 0) return null
    let st
    try { st = statSync(mirrorPath) } catch { return null }
    if (st.size <= limitBytes) return null
    const day = new Date().toISOString().slice(0, 10)
    const archiveDir = join(mirrorDir, 'archive', sanitize(sid))
    ensureDir(archiveDir)
    let final = join(archiveDir, `${sanitize(sid)}-${day}.jsonl`)
    let n = 1
    while (existsSync(final)) {
      final = join(archiveDir, `${sanitize(sid)}-${day}-${n}.jsonl`)
      n++
    }
    try {
      renameSync(mirrorPath, final)
      counters.rotations++
      return final
    } catch (e) {
      counters.errors++
      console.warn('[dsh-hermes-link] rotation: session-mirror rotate failed', sid, e && e.message || e)
      return null
    }
  }

  function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) }

  /**
   * Run all rotation passes once. Returns a structured summary.
   */
  async function rotateNow() {
    const t0 = Date.now()
    const result = {
      archived: { heartbeat: 0, memorySuggest: 0, usage: 0, sessionMirror: 0 },
      rotated:  { usage: null, sessionMirror: {} },
      purged:   { heartbeat: 0, memorySuggest: 0, usage: 0, sessionMirror: 0 },
    }

    // 1. heartbeat: archive by age, then prune by age
    result.archived.heartbeat = archiveDirByAge(heartbeatDir, archiveAfterDays.heartbeat, 'heartbeat')
    result.purged.heartbeat   = purgeDirByAge(join(heartbeatDir, 'archive'), purgeAfterDays.heartbeat, 'heartbeat')

    // 2. memory-suggest: archive by age, then prune
    result.archived.memorySuggest = archiveDirByAge(suggestDir, archiveAfterDays.memorySuggest, 'memory-suggest')
    result.purged.memorySuggest   = purgeDirByAge(join(suggestDir, 'archive'), purgeAfterDays.memorySuggest, 'memory-suggest')

    // 3. usage: size-based rotation (no archive step)
    result.rotated.usage = rotateBySize(usagePath, sizeLimits.usage, 'usage')
    if (result.rotated.usage) {
      // usage has no archive step; pruning is by date in filename (handled separately)
      purgeUsageByAge()
    }

    // 4. session-mirror: per-file size rotation + age purge
    let mirrorEntries
    try { mirrorEntries = readdirSync(mirrorDir) } catch { mirrorEntries = [] }
    for (const name of mirrorEntries) {
      if (name === 'archive') continue
      const full = join(mirrorDir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      const sid = name.replace(/\.jsonl$/, '')
      const rotatedTo = rotateSessionMirrorFile(full, sid, sizeLimits.sessionMirror)
      if (rotatedTo) result.rotated.sessionMirror[sid] = rotatedTo
    }
    // Also archive any "live" mirror files older than archiveAfterDays.sessionMirror
    result.archived.sessionMirror = archiveDirByAge(mirrorDir, archiveAfterDays.sessionMirror, 'session-mirror')
    // And purge archive
    result.purged.sessionMirror = purgeDirByAge(join(mirrorDir, 'archive'), purgeAfterDays.sessionMirror, 'session-mirror')

    counters.lastRunAt = Date.now()
    counters.lastDurationMs = counters.lastRunAt - t0
    return result
  }

  /**
   * Delete usage-YYYY-MM-DD.jsonl files older than purgeAfterDays.usage.
   */
  function purgeUsageByAge() {
    if (purgeAfterDays.usage <= 0) return
    const cutoff = Date.now() - purgeAfterDays.usage * MS_PER_DAY
    const parent = usagePath.replace(/[\\/][^\\/]+$/, '')
    let entries
    try { entries = readdirSync(parent) } catch { return }
    let n = 0
    for (const name of entries) {
      if (!name.startsWith('usage-') || !name.endsWith('.jsonl')) continue
      const full = join(parent, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.mtimeMs < cutoff) {
        try { unlinkSync(full); n++; counters.purges++ } catch (e) {
          counters.errors++
          console.warn('[dsh-hermes-link] rotation: usage purge failed', full, e && e.message || e)
        }
      }
    }
    counters.rotations += 0  // not a rotation, but counted
    return n
  }

  function startInterval() {
    if (timer) return
    // First run after 5s (so DSH startup isn't slow), then every checkIntervalMs.
    setTimeout(() => rotateNow().catch(() => {}), 5_000)
    timer = setInterval(() => rotateNow().catch(() => {}), checkIntervalMs)
    timer.unref?.()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  function stats() {
    return {
      counters: { ...counters },
      config: {
        sizeLimits: { ...sizeLimits },
        archiveAfterDays: { ...archiveAfterDays },
        purgeAfterDays: { ...purgeAfterDays },
        checkIntervalMs,
      },
      paths: { root, heartbeatDir, usagePath, suggestDir, mirrorDir },
    }
  }

  return { rotateNow, startInterval, stop, stats }
}
