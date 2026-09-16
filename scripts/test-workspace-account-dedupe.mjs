// Regression test for fix #6 -- workspace accounts.
//
// dsh-workspace#validateStoredState() is fail-closed: when ONE session id is
// listed by TWO workspace records, the whole plugin tree refuses to load with
//   "workspace domain is inconsistent: session 'X' is accounted by both
//    workspace 'A' and workspace 'B'"
// and it never self-heals -- dsh stays down until workspace.json is repaired.
//
// The duplicate is written by re-importing a session whose cwd was corrected:
// dsh-workspace#attachSession() validates the header cwd, then pushes the id,
// and never evicts it from the record that already accounted for the session.
// This test pins the two guards in import-hermes-session.mjs:
//   * attachToWorkspace()  -> attach first, then evict stale accounts
//   * pruneDuplicateMemberships() -> sweep what is already on disk
//
// Run: node scripts/test-workspace-account-dedupe.mjs
import assert from 'node:assert/strict'
import { attachToWorkspace, pruneDuplicateMemberships } from '../packages/dsh-hermes-link/import/import-hermes-session.mjs'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
    pass++
  } catch (e) {
    console.error('  FAIL ' + name + ': ' + (e && e.message || e))
    fail++
  }
}

/** Minimal stand-in for a dsh-workspace entity. */
function fakeWs(id, path, raw, live, updatedAt) {
  const state = { raw: [...raw] }
  return {
    id,
    path,
    updatedAt,
    detachCalls: [],
    get sessionIds() { return [...live] },
    get record() { return { sessionIds: [...state.raw] } },
    _raw: () => [...state.raw],
    async detachSession(sid) {
      this.detachCalls.push(sid)
      state.raw = state.raw.filter((x) => x !== sid)
    },
  }
}

// ---------------------------------------------------------------------------
// attachToWorkspace: attach first, evict stale accounts afterwards
// ---------------------------------------------------------------------------
const hostCtx = (registry) => ({ workspaceRegistry: registry })

await (async () => {
  // 1. stale residue gets evicted once the attach succeeded
  {
    const target = fakeWs('t', process.cwd(), [], [], '2026-09-15T12:00:00Z')
    target.attachSession = async () => { target._attached = true }
    const stale = fakeWs('s', 'C:\\ws-old', ['sid-1', 'sid-keep'], [], '2026-09-15T11:00:00Z')
    const reg = { create: async () => target, list: () => [target, stale] }
    const err = await attachToWorkspace(hostCtx(reg), process.cwd(), 'sid-1')
    check('attach ok -> stale account evicted, returns null', () => {
      assert.equal(err, null)
      assert.deepEqual(stale.detachCalls, ['sid-1'])
      assert.deepEqual(stale._raw(), ['sid-keep'])
    })
  }

  // 2. a FAILED attach must not touch anything (fix #5 used to orphan the
  //    session here, because it detached before attaching)
  {
    const target = fakeWs('t', process.cwd(), [], [], '2026-09-15T12:00:00Z')
    target.attachSession = async () => { throw new Error("cannot attach session 'sid-2' to workspace 'x': its cwd resolves to 'C:\\elsewhere'") }
    const holder = fakeWs('h', 'C:\\ws-old', ['sid-2'], [], '2026-09-15T11:00:00Z')
    const reg = { create: async () => target, list: () => [target, holder] }
    const err = await attachToWorkspace(hostCtx(reg), process.cwd(), 'sid-2')
    check('failed attach -> no detach, error string returned', () => {
      assert.match(String(err), /cwd resolves to/)
      assert.deepEqual(holder.detachCalls, [])
      assert.deepEqual(holder._raw(), ['sid-2'])
    })
  }

  // 3. the record we just attached to is never evicted (identity by path/id)
  {
    const target = fakeWs('t', process.cwd(), ['sid-3'], ['sid-3'], '2026-09-15T12:00:00Z')
    target.attachSession = async () => {}
    const twin = fakeWs('t', process.cwd(), ['sid-3'], ['sid-3'], '2026-09-15T12:00:00Z') // fresh object, same path
    const reg = { create: async () => target, list: () => [target, twin] }
    await attachToWorkspace(hostCtx(reg), process.cwd(), 'sid-3')
    check('target record is never detached from itself', () => {
      assert.deepEqual(twin.detachCalls, [])
      assert.deepEqual(twin._raw(), ['sid-3'])
    })
  }

  // 4. degraded registries / missing cwd
  {
    check('no workspaceRegistry -> error string, never throws', () => {
      const p = attachToWorkspace({}, process.cwd(), 'sid-4')
      return p.then((e) => assert.equal(e, 'workspaceRegistry unavailable'))
    })
    const reg = { create: async () => { throw new Error('should not be called') }, list: () => [] }
    const p = attachToWorkspace(hostCtx(reg), 'C:\\definitely\\missing\\dir', 'sid-5')
    return p.then((e) => check('missing cwd -> early error, no create()', () => assert.match(String(e), /cwd missing/)))
  }
})()

// ---------------------------------------------------------------------------
// pruneDuplicateMemberships: repair duplicates already persisted on disk
// ---------------------------------------------------------------------------
await (async () => {
  {
    const a = fakeWs('a', 'C:\\ws-old', ['sid-x', 'sid-other'], ['sid-other'], '2026-09-15T12:00:00Z')
    const b = fakeWs('b', 'C:\\ws-new', ['sid-x'], ['sid-x'], '2026-09-15T12:05:00Z')
    const n = await pruneDuplicateMemberships({ workspaceRegistry: { list: () => [a, b] } })
    check('duplicate -> stale side detached, live side kept', () => {
      assert.equal(n, 1)
      assert.deepEqual(a._raw(), ['sid-other'])
      assert.deepEqual(b._raw(), ['sid-x'])
    })
  }
  {
    const a = fakeWs('a', 'C:\\ws-a', ['sid-1'], ['sid-1'], '2026-09-15T12:00:00Z')
    const b = fakeWs('b', 'C:\\ws-b', ['sid-2'], ['sid-2'], '2026-09-15T12:00:00Z')
    const n = await pruneDuplicateMemberships({ workspaceRegistry: { list: () => [a, b] } })
    check('clean registry -> no write, returns 0', () => {
      assert.equal(n, 0)
      assert.deepEqual(a.detachCalls, [])
      assert.deepEqual(b.detachCalls, [])
    })
  }
  {
    const n = await pruneDuplicateMemberships({})
    check('missing workspaceRegistry -> 0, never throws', () => assert.equal(n, 0))
  }
  {
    const a = fakeWs('a', 'C:\\ws-old', ['sid-y'], ['sid-y'], '2026-09-15T11:00:00Z')
    const b = fakeWs('b', 'C:\\ws-new', ['sid-y'], ['sid-y'], '2026-09-15T12:00:00Z')
    const n = await pruneDuplicateMemberships({ workspaceRegistry: { list: () => [a, b] } })
    check('keeps the newest record when both look live', () => {
      assert.equal(n, 1)
      assert.deepEqual(a.detachCalls, ['sid-y'])
      assert.deepEqual(b.detachCalls, [])
    })
  }
  {
    const bad = fakeWs('bad', 'C:\\ws-old', ['sid-z'], [], '2026-09-15T11:00:00Z')
    bad.detachSession = async () => { throw new Error('storage offline') }
    const good = fakeWs('good', 'C:\\ws-new', ['sid-z'], ['sid-z'], '2026-09-15T12:00:00Z')
    const n = await pruneDuplicateMemberships({ workspaceRegistry: { list: () => [bad, good] } })
    check('swallows detach errors (best-effort, no throw)', () => assert.equal(n, 0))
  }
})()

console.log('\nworkspace account dedupe: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
