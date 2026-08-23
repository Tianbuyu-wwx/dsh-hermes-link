// scripts/probe-persisted-session.mjs
// Directly open one persisted hermes-* session via the jsonl backend and try
// to reproduce the inspect/read error the DSH host sees.

import { DatabaseSync } from 'node:sqlite'  // no — we need the persistence backend

// The backend package lives in the npx cache; resolve it like node would from
// the profile's node_modules chain.
const npxRoot = process.env.LOCALAPPDATA + '/npm-cache/_npx/1e7f6d9597241db0'
const pkgRoot = npxRoot + '/node_modules/@deepseek-ai/dsh-session-persistence-jsonl'
const dshRoot  = npxRoot + '/node_modules/@deepseek-ai/dsh-session'

console.log('pkgRoot exists:', !!require('node:fs').existsSync(pkgRoot))

// Instead of mounting a full Cordis runtime, replicate the backend read path:
// backend.loadStored(id) -> decodeStorageRecord etc. We must import the ESM
// module directly.
const { decodeStorageRecord } = await import(
  'file:///' + dshRoot.replace(/\\/g, '/') + '/lib/index.js'
)
const backendMod = await import(
  'file:///' + pkgRoot.replace(/\\/g, '/') + '/lib/index.js'
)
console.log('backend exports:', Object.keys(backendMod).slice(0, 20))

const id = process.argv[2] || 'hermes-20260820_163800_d9d619'
const dir = 'C:/Users/Tianbuyu/.dsh/sessions/--C-Users-Tianbuyu-.dsh-hermes-workspace--/' + id
console.log('session dir:', dir)

// The jsonl backend stores session.jsonl.zstd under a directory; try to read it raw.
const fs = await import('node:fs')
const zstdPath = dir + '/session.jsonl.zstd'
if (!fs.existsSync(zstdPath)) {
  console.log('zstd file missing at', zstdPath)
  process.exit(1)
}

// Try koffi-based decompression used by the jsonl backend.
try {
  const koffi = await import('file:///' + npxRoot.replace(/\\/g, '/') + '/node_modules/koffi/index.js')
  console.log('koffi loaded')
  // backend uses zstd via @deepseek-ai/dsh-jsonl-zstd or koffi; inspect the backend source
} catch (e) {
  console.log('koffi import failed (expected):', e.message)
}

// Simplest robust check: what does the backend module's default export expose?
const def = backendMod.default
console.log('default export type:', typeof def, def && Object.keys(def).slice(0, 25))