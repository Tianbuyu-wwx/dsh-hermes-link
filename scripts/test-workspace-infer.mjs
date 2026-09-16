#!/usr/bin/env node
// scripts/test-workspace-infer.mjs
//
// v0.3.5 - Verify that a Hermes session with no state.db cwd can be imported
// into the original workspace inferred from `cd` tool calls, and that an
// existing hermes-workspace session with no post-import activity is migrated.
//
// v0.3.6 (D1): the fake sessionPersistence below models the CURRENT contract
// (create/open/stat/list + a write handle with append/flush/close). The old
// stub implemented inspect()/listArtifacts()/append(id, events), which no
// longer exist in @deepseek-ai/dsh-session-persistence 0.1.5-rc.2; the importer
// now (correctly) refuses to treat that as success, so the double had to move
// with it. Assertions are unchanged and additionally pin the header contract.

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// These suites pin the PER-SESSION cwd inference (state.db cwd / git root /
// '@folder:' hint). Since v0.6.0 the importer anchors every session to ONE
// 'Hermes' workspace by default (single sidebar group, and a cwd that never
// changes so DSH's session->cwd index cannot go stale). Inference is now
// opt-in, so these suites opt in explicitly rather than being weakened.
process.env.HERMES_LINK_IMPORT_PER_PROJECT = '1'


const root = dirname(dirname(fileURLToPath(import.meta.url)))
const importerUrl = pathToFileURL(join(root, 'packages/dsh-hermes-link/import/import-hermes-session.mjs')).href
const { createImporter } = await import(importerUrl)

let hermesHome
let passed = 0, failed = 0
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`  ok ${name}`)
    passed++
  }).catch((e) => {
    console.log(`  FAIL ${name}: ${e.message}`)
    failed++
  })
}

function normalize(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function notFoundError(id) {
  const e = new Error(`session "${id}" not found`)
  e.name = 'SessionPersistenceNotFoundError'
  return e
}

function alreadyExistsError(id) {
  const e = new Error(`session "${id}" already exists`)
  e.name = 'SessionAlreadyExistsError'
  return e
}

/**
 * Fake SessionPersistence implementing the 0.1.5 contract. Existence is modeled
 * by a REAL file on disk (like the jsonl backend): create() registers a path,
 * the write handle's append() materializes it, and rm()ing the file is what
 * makes the session disappear again.
 */
function makePersistence({ dir, seed } = {}) {
  const headers = new Map()
  const eventsBy = new Map()
  const paths = new Map()
  const handles = []
  const pathOf = (id) => join(dir, `${id}.jsonl.zstd`)
  const exists = (id) => paths.has(id) && existsSync(paths.get(id))
  if (seed) {
    headers.set(seed.id, seed.header)
    eventsBy.set(seed.id, seed.events)
    paths.set(seed.id, seed.path)
  }
  function makeHandle(id, access) {
    const h = {
      id,
      access,
      header: headers.get(id),
      appended: null,
      flushed: false,
      closed: false,
      async read(offset = 0) {
        return { eventState: 'detached', events: (eventsBy.get(id) || []).slice(offset) }
      },
      async append(events) {
        if (access !== 'write') throw new Error('read handle cannot append')
        h.appended = events
        eventsBy.set(id, [...events])
        writeFileSync(paths.get(id), JSON.stringify(events))
      },
      async flush() { h.flushed = true },
      async close() { h.closed = true },
    }
    handles.push(h)
    return h
  }
  return {
    headers, eventsBy, paths, handles,
    async stat(id) {
      if (!exists(id)) return undefined
      return { header: headers.get(id), revision: 'rev-1', eventCount: (eventsBy.get(id) || []).length }
    },
    async list() {
      return [...paths.keys()].filter(exists).map((id) => ({ header: headers.get(id), revision: 'rev-1' }))
    },
    async open(id, access) {
      if (!exists(id)) throw notFoundError(id)
      return makeHandle(id, access)
    },
    async create(header) {
      if (exists(header.id)) throw alreadyExistsError(header.id)
      headers.set(header.id, header)
      eventsBy.set(header.id, [])
      paths.set(header.id, pathOf(header.id))
      return makeHandle(header.id, 'write')
    },
    // Kept (feature-detected by the importer) only so a rebuild can locate and
    // rm() the physical artifact: stat()/list() snapshots carry no path.
    async listArtifacts() {
      return [...paths.keys()].filter(exists).map((id) => ({ header: headers.get(id), path: paths.get(id) }))
    },
  }
}

function makeDumpPath(hermesHome, sid) {
  const dir = join(hermesHome, 'sessions')
  mkdirSync(dir, { recursive: true })
  return join(dir, `request_dump_${sid}_1.json`)
}

function writeDump(sid, workspacePath) {
  const path = makeDumpPath(hermesHome, sid)
  const dump = {
    session_id: sid,
    request: {
      body: {
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'terminal',
                  arguments: JSON.stringify({ command: `cd "${workspacePath}" && pwd` }),
                },
              },
            ],
          },
        ],
      },
    },
  }
  writeFileSync(path, JSON.stringify(dump), 'utf8')
}

await t('infer original workspace from dump when state.db cwd is null', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-ws-infer-'))
  hermesHome = join(base, 'hermes')
  const workspaceDir = join(base, 'hermes-workspace')
  const projectA = join(base, 'project-a')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(projectA, { recursive: true })
  writeDump('s1', projectA)

  const persistence = makePersistence({ dir: base })
  const ctx = {
    sessionPersistence: persistence,
    sessions: null,
    workspaceRegistry: { create: async () => ({ ok: true }) },
  }
  const importer = createImporter({ ctx, hermesHome, workspaceDir })
  const r = await importer.importSession('s1')
  assert.equal(r.status, 'created')
  assert.equal(normalize(r.cwd), normalize(projectA))
  const header = persistence.headers.get('hermes-s1')
  assert.equal(normalize(header.cwd), normalize(projectA))
  // D1 header contract
  assert.equal(header.version, 3, 'header.version must be SESSION_FORMAT_VERSION')
  assert.equal(header.isSeeded, false, 'header.isSeeded is required')
  assert.equal(header.delegationDepth, 0)
  // the write handle from create() received the events
  const write = persistence.handles.find((h) => h.access === 'write')
  assert.ok(write, 'create() returned a write handle')
  assert.equal(write.appended.length, r.eventCount)
  assert.equal(write.flushed, true, 'handle.flush() called')
  assert.equal(write.closed, true, 'handle.close() called')
})

await t('migrate safe hermes-workspace session to inferred original workspace', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-ws-migrate-'))
  hermesHome = join(base, 'hermes')
  const workspaceDir = join(base, 'hermes-workspace')
  const projectB = join(base, 'project-b')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  writeDump('s2', projectB)

  const oldHeader = {
    type: 'session', version: 3, id: 'hermes-s2', createdAt: 1, delegationDepth: 0,
    isSeeded: false, cwd: workspaceDir, agentPreset: 'hermes-imported',
  }
  const oldEvents = [
    { type: 'session/end-seed', seq: 0, time: 1, data: {} },
    { type: 'session/title', seq: 1, time: 1, ignorable: true, data: { title: 'x' } },
  ]
  // The stale artifact lives at a DIFFERENT path than a rebuilt session gets,
  // so its disappearance can only be caused by the importer's rm().
  const staleDir = join(base, 'stale')
  mkdirSync(staleDir, { recursive: true })
  const artifactPath = join(staleDir, 'hermes-s2.jsonl.zstd')
  writeFileSync(artifactPath, 'stored') // the artifact must really exist to be removed
  const persistence = makePersistence({
    dir: base,
    seed: { id: oldHeader.id, header: oldHeader, events: oldEvents, path: artifactPath },
  })
  const ctx = {
    sessionPersistence: persistence,
    sessions: null,
    workspaceRegistry: { create: async () => ({ ok: true }) },
  }
  const importer = createImporter({ ctx, hermesHome, workspaceDir })
  const r = await importer.importSession('s2')
  assert.equal(r.status, 'created')
  assert.equal(normalize(r.cwd), normalize(projectB))
  assert.equal(normalize(persistence.headers.get('hermes-s2').cwd), normalize(projectB))
  assert.equal(persistence.headers.get('hermes-s2').version, 3)
  assert.equal(existsSync(artifactPath), false, 'the stale artifact was removed before the rebuild')
  assert.equal(existsSync(join(base, 'hermes-s2.jsonl.zstd')), true, 'the rebuilt session was materialized')
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
