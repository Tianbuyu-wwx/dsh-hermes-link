#!/usr/bin/env node
// scripts/test-workspace-infer.mjs
//
// v0.3.5 - Verify that a Hermes session with no state.db cwd can be imported
// into the original workspace inferred from `cd` tool calls, and that an
// existing hermes-workspace session with no post-import activity is migrated.

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function makePersistence(existing) {
  const headers = new Map()
  const eventsBy = new Map()
  const artifacts = []
  if (existing) {
    headers.set(existing.id, existing.header)
    eventsBy.set(existing.id, existing.events)
    artifacts.push({ header: { id: existing.id }, path: existing.path })
  }
  return {
    headers,
    eventsBy,
    artifacts,
    async inspect(id) {
      if (!headers.has(id)) throw new Error('not found')
      return { meta: headers.get(id), events: eventsBy.get(id) || [] }
    },
    async create(header) { headers.set(header.id, header) },
    async append(id, events) { eventsBy.set(id, events) },
    async listArtifacts() { return artifacts },
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

  const ctx = {
    sessionPersistence: makePersistence(),
    sessions: null,
    workspaceRegistry: { create: async () => ({ ok: true }) },
  }
  const importer = createImporter({ ctx, hermesHome, workspaceDir })
  const r = await importer.importSession('s1')
  assert.equal(r.status, 'created')
  assert.equal(normalize(r.cwd), normalize(projectA))
  assert.equal(normalize(ctx.sessionPersistence.headers.get('hermes-s1').cwd), normalize(projectA))
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
    type: 'session', version: 0, id: 'hermes-s2', createdAt: 1, delegationDepth: 0,
    cwd: workspaceDir, agentPreset: 'hermes-imported',
  }
  const oldEvents = [
    { type: 'session/end-seed', seq: 0, time: 1, data: {} },
    { type: 'session/title', seq: 1, time: 1, ignorable: true, data: { title: 'x' } },
  ]
  const persistence = makePersistence({
    id: oldHeader.id,
    header: oldHeader,
    events: oldEvents,
    path: join(base, 'hermes-s2.jsonl.zstd'),
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
})

console.log('')
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
