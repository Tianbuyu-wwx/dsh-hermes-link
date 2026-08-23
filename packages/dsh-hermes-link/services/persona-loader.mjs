// services/persona-loader.mjs
//
// V3: read Hermes persona (SOUL.md) + relevant config.yaml slices, return
// as a single human-readable text blob the model can prepend to its working
// context.
//
// v0.2.3 (K.1): MEMORY.md is **no longer** part of this loader. Hermes
// MEMORY.md aggregates notes across many projects; reading it whole and
// handing it back through `load_hermes_persona` would re-introduce the same
// cross-project contamination that v0.2.1 closed for the main session and
// v0.2.2 closed for dispatch. To get Hermes memory that actually matches
// the current DSH session's working directory, use the
// `load_hermes_project_memory` tool (cwd-scoped via Hermes state.db).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES_PER_FILE = 64 * 1024   // 64KB cap per file
const MAX_BYTES_TOTAL    = 128 * 1024  // 128KB cap total

/**
 * Load Hermes persona (SOUL.md + relevant config.yaml slices) into a single
 * text block. Files that don't exist are silently skipped.
 *
 * v0.2.3: `scope` no longer accepts `'memory'` / `'all'` to mean "include
 * MEMORY.md". The supported values are `'all' | 'soul' | 'config'`, where
 * `'all'` means SOUL + config (NOT MEMORY). Callers wanting memory must use
 * `load_hermes_project_memory` which is cwd-scoped.
 *
 * @param {string} hermesHome
 * @param {object} [opts]
 * @param {'all'|'soul'|'config'} [opts.scope='all']
 * @returns {{ text: string, parts: Array<{ name: string, bytes: number, present: boolean }> }}
 */
export function loadPersona(hermesHome, { scope = 'all' } = {}) {
  // v0.2.3: legacy callers passing scope='memory' or scope='all' (with the old
  // intent of including MEMORY.md) get a polite no-op for that part — we
  // never read MEMORY.md here. The caller should switch to
  // load_hermes_project_memory. We do not throw — old tools keep working.
  const want = {
    soul:   scope === 'all' || scope === 'soul',
    config: scope === 'all' || scope === 'config',
  }
  const parts = []
  const used = []

  if (want.soul) {
    const p = join(hermesHome, 'SOUL.md')
    const r = readCapped(p)
    if (r.bytes > 0) {
      parts.push(`<!-- Hermes SOUL.md (${p}) -->\n${r.text}`)
      used.push({ name: 'SOUL.md', bytes: r.bytes, present: true })
    } else {
      used.push({ name: 'SOUL.md', bytes: 0, present: false })
    }
  }
  if (want.config) {
    const p = join(hermesHome, 'config.yaml')
    const r = readCapped(p)
    if (r.bytes > 0) {
      // Only include the slices a model would actually use; skip secrets/comments.
      const sliced = sliceRelevantConfig(r.text)
      parts.push(`<!-- Hermes config.yaml (relevant slices, ${p}) -->\n${sliced}`)
      used.push({ name: 'config.yaml', bytes: sliced.length, present: true })
    } else {
      used.push({ name: 'config.yaml', bytes: 0, present: false })
    }
  }

  // v0.2.3 — legacy scope='memory' no longer reads MEMORY.md; emit a one-line
  // migration hint so callers that still pass it see the right pointer.
  if (scope === 'memory') {
    parts.push('<!-- hermes-link: scope="memory" is retired in v0.2.3; use load_hermes_project_memory for cwd-scoped Hermes memory. -->')
    used.push({ name: 'MEMORY.md', bytes: 0, present: false, note: 'removed in v0.2.3 — use load_hermes_project_memory' })
  }

  let text = parts.join('\n\n')
  if (text.length > MAX_BYTES_TOTAL) {
    text = text.slice(0, MAX_BYTES_TOTAL) +
      `\n<!-- hermes-link: truncated at ${MAX_BYTES_TOTAL} bytes; fetch individual files for more -->`
  }
  return { text, parts: used }
}

function readCapped(p) {
  if (!existsSync(p)) return { text: '', bytes: 0 }
  try {
    const raw = readFileSync(p, 'utf8')
    if (raw.length > MAX_BYTES_PER_FILE) {
      return {
        text: raw.slice(0, MAX_BYTES_PER_FILE) +
          `\n<!-- truncated at ${MAX_BYTES_PER_FILE} bytes of ${raw.length} -->`,
        bytes: MAX_BYTES_PER_FILE,
      }
    }
    return { text: raw, bytes: raw.length }
  } catch { return { text: '', bytes: 0 } }
}

/**
 * Pull out only the model-relevant slices of config.yaml: model.default, agent,
 * display.skin, display.personality, memory. Skip mcp_servers, fallbacks, etc.
 */
function sliceRelevantConfig(text) {
  const wanted = ['model:', 'agent:', 'display:', 'memory:', 'compression:']
  const out = []
  const lines = text.split('\n')
  let inKept = false
  let kept = []
  for (const line of lines) {
    const top = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/)
    if (top) {
      if (inKept) {
        out.push(kept.join('\n'))
        out.push('')
      }
      inKept = wanted.includes(top[1] + ':')
      kept = inKept ? [line] : []
    } else if (inKept) {
      kept.push(line)
    }
  }
  if (inKept) out.push(kept.join('\n'))
  return out.join('\n').trim() || '(no relevant slices)'
}