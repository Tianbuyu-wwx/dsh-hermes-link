// scripts/test-cwd-platform-paths.mjs
//
// v0.6.0 (D1) regression gate - a cwd handed to DSH must be a path the platform
// can actually address as a workspace.
//
// Why this test exists: Hermes shells out through Git Bash, so dumps can carry
// POSIX-style absolute paths like '/c/Users/me/Downloads'. isSafeCwd()
// deliberately accepts POSIX-absolute paths (right on macOS/Linux), so on
// Windows that value flowed into SessionHeader.cwd and then into
// workspaceRegistry.create(), which refuses it:
//   "Workspace path is not fully qualified: '/c/Users/me/Downloads'"
// The session was written but never attached - invisible in the sidebar. 90 of
// 145 imported sessions were stranded exactly this way.

import { join, dirname } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const { createImporter } = await import(
  pathToFileURL(join(repo, 'packages', 'dsh-hermes-link', 'import', 'import-hermes-session.mjs')).href
)

// Pure helpers only: no ctx, no Hermes home needed.
//
// DSH_HOME is redirected into a temp dir first: createImporter() mkdirs its
// workspace directories at construction time, so without this the test would
// create directories under the developer's real ~/.dsh as a side effect.
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-cwdpaths-'))
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome
let importer
try {
  importer = createImporter({ ctx: {}, hermesHome: join(repo, 'scripts'), workspaceDir: join(tmpHome, 'hermes-workspace') })
} finally {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
}
const { toPlatformPath, isUsableCwd } = importer

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message || e)); fail++ }
}

const isWin = process.platform === 'win32'

t('case 1: exposes the path helpers', () => {
  assert.equal(typeof toPlatformPath, 'function')
  assert.equal(typeof isUsableCwd, 'function')
})

if (isWin) {
  t('case 2: MSYS drive path /c/Users/me -> C:\\Users\\me', () => {
    assert.equal(toPlatformPath('/c/Users/me'), 'C:\\Users\\me')
    assert.equal(toPlatformPath('/c/Users/me/Downloads'), 'C:\\Users\\me\\Downloads')
  })
  t('case 3: drive letter is upper-cased and bare drive root handled', () => {
    assert.equal(toPlatformPath('/d/projects'), 'D:\\projects')
    assert.equal(toPlatformPath('/e'), 'E:\\')
  })
  t('case 4: /cygdrive/c/... form is translated too', () => {
    assert.equal(toPlatformPath('/cygdrive/c/Users/me'), 'C:\\Users\\me')
  })
  t('case 5: already-native Windows paths are untouched', () => {
    assert.equal(toPlatformPath('C:\\Users\\me'), 'C:\\Users\\me')
    assert.equal(toPlatformPath('E:/项目/x'), 'E:/项目/x')
  })
  t('case 6: a bare POSIX path is NOT usable on Windows (DSH would refuse it)', () => {
    assert.equal(isUsableCwd('/usr'), false)
    assert.equal(isUsableCwd('/definitely/not/here'), false)
  })
  t('case 7: a translated path to a real directory IS usable', () => {
    const home = process.env.USERPROFILE || ''
    if (!home) return
    // 'C:\Users\me' -> '/c/Users/me'
    const msys = '/' + home[0].toLowerCase() + home.slice(2).replace(/\\/g, '/')
    assert.equal(isUsableCwd(msys), true, 'expected ' + msys + ' to resolve to a real dir')
  })
  t('case 8: non-strings and empty values are rejected, never thrown on', () => {
    for (const v of [undefined, null, '', 0, {}, []]) assert.equal(isUsableCwd(v), false)
  })
} else {
  t('case 2: on POSIX the path is passed through unchanged', () => {
    assert.equal(toPlatformPath('/c/Users/me'), '/c/Users/me')
  })
}

console.log('')
console.log('Total: ' + (pass + fail) + '  Passed: ' + pass + '  Failed: ' + fail)
process.exit(fail === 0 ? 0 : 1)
