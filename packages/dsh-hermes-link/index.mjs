// dsh-hermes-link 闁?DSH plugin entry (v0.2).
//
// What this plugin wires:
//
//   1. Skill provider so `skills/dsh-hermes-link/SKILL.md` is discoverable
//      (user can @skill dsh-hermes-link to read what it does).
//   2. Hermes Home auto-detect (HERMES_HOME env, then LOCALAPPDATA/hermes on Windows).
//   3. Sub-services:
//        - createImporter()           闁?request-dump 闁?DSH SessionEvent[] + ctx.sessions.create
//        - createWatcher()            闁?fs-poll Hermes Home/sessions/ for new dumps
//        - loadPersona()              闁?read SOUL/MEMORY/config slices
//        - createConsultClient()      闁?file-based Hermes consult + dispatch-result writer
//        - hermes-inbox               闁?shared conversation record (session.jsonl): tools
//                                       hermes_inbox / hermes_inbox_append + v0.7-style
//                                       session-start injection into the MAIN dsh session
//        - outbox()                   闁?D3 heartbeat / D6 usage / D7 memory-suggest / V4 mirror
//        - openContinuations()        闁?SQLite registry for continuable dispatch children
//        - createAmendWatcher()       闁?H4: deliver Hermes amendments to continuable children
//   4. Cordis tools (DSH-side): list_hermes_sessions, import_hermes_session,
//      load_hermes_persona, consult_hermes, hermes_inbox, hermes_inbox_append.
//   5. Foundation slice builder (闁?KB; auto-truncates) used for dispatch_task sub-agents.
//   6. HTTP routes on the DSH webserver:
//        POST /mcp/collab                 H1 JSON-RPC (dispatch_task, followup, interrupt,
//                                         list, get, get_dispatch)
//        GET  /mcp/collab/health
//        GET  /mcp/collab/sessions        V1 list Hermes archives
//        POST /mcp/collab/import          V2 import one archive as live DSH session
//        GET  /mcp/collab/persona         V3 load persona slices
//        POST /mcp/collab/consult         D2 ask Hermes (file-based, sync reply up to 30s)
//        POST /mcp/collab/memory-suggest  D7 write a memory suggestion for Hermes
//        GET  /mcp/hermes-inbox/health    hermes-push.mjs --status compatibility
//
// Hermes-side wiring:
//   config.yaml: mcp_servers.dsh-bridge.url 闁?http://127.0.0.1:3080/mcp/collab
//   (the install script edits this for the user.)

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { requestDumpToEvents, groupBySession, walkRequestDumps } from './import/request-dump-to-events.mjs'
import { createImporter } from './import/import-hermes-session.mjs'
import { createWatcher } from './services/hermes-session-watcher.mjs'
import { loadPersona } from './services/persona-loader.mjs'
import { createConsultClient } from './services/consult-hermes.mjs'
import { registerInboxTools, inboxHealthPayload, sessionHasHermesMarker } from './services/hermes-inbox.mjs'
import { createOutbox } from './services/outbox.mjs'
import { openContinuations, TERMINAL_STATUSES } from './services/continuations.mjs'
import { createSseBroker } from './services/sse-broker.mjs'
import { createAmendWatcher } from './services/amend-watcher.mjs'
import { stateDir as auditStateDir } from './services/audit.mjs'
import { register as registerHttp, pickParentAgent } from './http/dispatch.mjs'
import { createListHermesSessionsTool } from './tools/list-hermes-sessions.mjs'
import { createImportHermesSessionTool } from './tools/import-hermes-session.mjs'
import { createLoadHermesPersonaTool } from './tools/load-hermes-persona.mjs'
import { createConsultHermesTool } from './tools/consult-hermes.mjs'
import { createMirrorSessionToHermesTool } from './tools/mirror-session-to-hermes.mjs'
import { createLoadHermesProjectMemoryTool } from './tools/load-hermes-project-memory.mjs'

const skillDir = fileURLToPath(new URL('./skills/dsh-hermes-link', import.meta.url))
const MAX_FOUNDATION_SLICE_CHARS = 4096
const VERSION = '0.2.5'

// -----------------------------------------------------------------------------
// Hermes Home auto-detect
// -----------------------------------------------------------------------------

export function detectHermesHome() {
  if (process.env.HERMES_HOME && existsSync(process.env.HERMES_HOME)) {
    return process.env.HERMES_HOME
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const candidate = join(local, 'hermes')
    if (existsSync(candidate)) return candidate
  }
  // POSIX fallback (Hermes Home is hermes-agent's venv root, not ~/.hermes)
  return join(homedir(), '.local', 'share', 'hermes')
}

function readText(p) {
  if (!p || !existsSync(p)) return ''
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

export function buildFoundationSlice(hermesHome) {
  // v0.2.2 闁?foundation is SOUL only. MEMORY.md is no longer broadcast to
  // every dispatched sub-agent because it aggregates notes across many
  // projects and routinely contaminated unrelated sub-agents. Use the
  // load_hermes_project_memory tool (cwd-scoped) instead, or set
  // dispatch_task { include_project_memory: true } to opt in per task.
  const soulPath = join(hermesHome, 'SOUL.md')
  const soul = readText(soulPath)
  if (!soul) return ''
  let s = `<!-- Hermes SOUL.md (${soulPath}) -->\n` + soul
  if (s.length > MAX_FOUNDATION_SLICE_CHARS) {
    s = s.slice(0, MAX_FOUNDATION_SLICE_CHARS) +
      `\n<!-- dsh-hermes-link: truncated at ${MAX_FOUNDATION_SLICE_CHARS} chars; source at ${soulPath} -->`
  }
  return s
}

// -----------------------------------------------------------------------------
// Plugin shape
// -----------------------------------------------------------------------------

export const name = 'dsh-hermes-link'
export const inject = ['skills', 'webServer', 'sessions', 'agents', 'subagents', 'tokenMeter', 'workspaceRegistry', 'sessionTitle', 'sessionPersistence', 'tools']

export function apply(ctx) {
  const hermesHome = detectHermesHome()
  console.log('[dsh-hermes-link v' + VERSION + '] applying; hermes_home=' + hermesHome)

  // 1. skill provider 闁?makes `@skill dsh-hermes-link` work
  try {
    ctx.skills.registerProvider((control) =>
      new FileSystemSkillProvider(ctx, control, {
        providerName: 'dsh-hermes-link',
        customSkillDirs: [skillDir],
      }),
    )
  } catch (e) {
    console.error('[dsh-hermes-link v' + VERSION + '] skill provider registration failed:', e && e.message || e)
  }

  // 2. sub-services (factories 闁?pure, hold no Cordis resources until used)
  const foundationSlice = buildFoundationSlice(hermesHome)
  const hermesWorkspaceDir = (process.env.DSH_HOME || join(homedir(), '.dsh')) + '/hermes-workspace'
  const importer = ctx.sessions ? createImporter({ ctx, hermesHome, workspaceDir: hermesWorkspaceDir }) : null
  const personaLoader = { loadPersona: (h, opts) => loadPersona(h || hermesHome, opts) }
  const consultClient = createConsultClient({ hermesHome })
  const outbox = createOutbox({ hermesHome })
  // v0.3.0 F1 - SSE broker (per-process singleton, also stashed on globalThis
  // so services/amend-watcher.mjs can publish without going through cordis locator).
  const sseBroker = createSseBroker({ ringSize: 1000, heartbeatMs: 15000 })
  globalThis.__dsh_hermes_link_broker__ = sseBroker

  const continuations = openContinuations(auditStateDir(), {
    onChange: ({ kind, child_id, task_id, fields, entry }) => {
      if (kind === 'register') {
        sseBroker.attachTask(task_id, { child_id, parent_agent_id: entry.parent_agent_id, skill: entry.skill, model: entry.model })
        sseBroker.publish(task_id, { kind: 'lifecycle', data: { status: 'started', child_id } })
      } else if (kind === 'update') {
        const status = fields && fields.status
        sseBroker.publish(task_id, { kind: 'lifecycle', data: { status, stop_reason: fields && fields.stop_reason } })
        if (status && TERMINAL_STATUSES.has(status)) {
          setTimeout(() => sseBroker.detachTask(task_id, status), 5000)
        }
      }
    },
  })

  if (!ctx.sessions) {
    console.warn('[dsh-hermes-link v' + VERSION + '] ctx.sessions not in inject graph; /mcp/collab/import will 503 until dsh-session is mounted')
  }

  // 3. fs watcher 闁?emits 'change' for new stable request_dump files.
  let watcher
  try {
    watcher = createWatcher(join(hermesHome, 'sessions'))
    watcher.on('change', async ({ sessionIds }) => {
      console.log('[dsh-hermes-link] hermes-sessions changed: ' + sessionIds.join(', ') + ' 闁?syncing')
      if (importer && typeof importer.sync === 'function') {
        const r = await importer.sync()
        console.log('[dsh-hermes-link] auto-sync: imported=' + r.imported + ' skipped=' + r.skipped + ' failed=' + r.failed)
      }
    })
    watcher.on('error', (e) => {
      console.warn('[dsh-hermes-link] watcher error: ' + (e && e.message || e))
    })
  } catch (e) {
    console.warn('[dsh-hermes-link] watcher init failed:', e && e.message || e)
  }

  // 4. shared conversation record (hermes-inbox, migrated from hermes-foundation):
  //    tools + main-session injection on every fresh session start.
  try {
    if (ctx.tools && ctx.tools.register) {
      registerInboxTools(ctx)
    }
  } catch (e) {
    console.error('[dsh-hermes-link] inbox tools registration failed:', e && e.message || e)
  }

  // v0.2.1 闁?AUTOMATIC INJECTION OF Hermes turns INTO THE MAIN SESSION IS DISABLED.
  //
  // Earlier versions (hermes-foundation v0.7 闁?dsh-hermes-link v0.2.0) appended
  // recent Hermes turns from the global session.jsonl straight into the new
  // main session's events log on every session-start. That proved unsound:
  // session.jsonl is project-agnostic and Hermed-push writes into it without a
  // cwd tag, so a DSH session that simply happens to live in another working
  // directory (or a different project altogether) would inherit another
  // project's Hermes transcript as its own opening context.
  //
  // The fix is two-sided:
  //   1. Stop writing Hermes turns into the session event log automatically.
  //      Anyone who actually wants them reads them on demand via hermes_inbox
  //      (tool, no side effect on history).
  //   2. Provide hermes_clear_injected (services/hermes-inbox.mjs) so a user
  //      who inherited injected events from a prior version can see what was
  //      written and get an explicit, honest pointer to "start a new session"
  //      闁?the only way to truly drop them, since Session.events is append-
  //      only / deep-frozen and cannot be mutated retroactively.
  //
  // injectHermesTurns is still exported from services/hermes-inbox.mjs so a
  // future feature-gated re-introduction (cwd-scoped / opt-in tool call) is
  // possible without re-implementing the shape.
  ctx.on('agent/session-start', (event) => {
    try {
      const agent = event && event.agent ? event.agent
        : (event && event.agentId ? ctx.agents.get(event.agentId) : null)
      if (!agent) return
      // Defensive: if a prior session somehow has the injection marker, log
      // it so the user knows. No automatic injection in this version.
      const session = ctx.sessions && ctx.sessions.get(agent.id)
      if (session && sessionHasHermesMarker(session)) {
        console.log('[dsh-hermes-link v0.2.1] main session ' + agent.id + ' still carries the hermes-injection marker from an earlier version; call hermes_clear_injected for details')
      }
    } catch (e) {
      console.error('[dsh-hermes-link] session-start hook failed:', e && e.message || e)
    }
  })

  // 5. v0.2.2 闁?V4 session-mirror hook REMOVED. Was:
  //      ctx.on('session/event', (session, event) => outbox.appendSessionEvent(...))
  //    It mirrored every DSH session event (including user inputs) into Hermes
  //    Home by default 闁?same class of bug as the v0.7 闁?v0.2.0 main-session
  //    injection that v0.2.1 disabled, just in the other direction. Replaced
  //    by the explicit `mirror_session_to_hermes` tool (opt-in, with secret
  //    redaction). The outbox service still exposes appendSessionEvent for the
  //    opt-in tool to call.

  // 6. D3 heartbeat (60s), H4 amend watcher (2s poll).
  const heartbeat = outbox.startHeartbeat(60_000, { version: 'dsh-hermes-link/' + VERSION })
  let amendWatcher = null
  try {
    amendWatcher = createAmendWatcher({
      hermesHome,
      ctx,
      continuations,
      pickParentAgent,
    })
  } catch (e) {
    console.warn('[dsh-hermes-link] amend watcher init failed:', e && e.message || e)
  }

  // 7. Cordis tools (DSH-side columns of the link).
  try {
    if (ctx.tools && ctx.tools.register) {
      ctx.tools.register(createListHermesSessionsTool({ importer }))
      ctx.tools.register(createImportHermesSessionTool({ importer }))
      ctx.tools.register(createLoadHermesPersonaTool({ personaLoader, hermesHome }))
      ctx.tools.register(createConsultHermesTool({ consultClient }))
      ctx.tools.register(createMirrorSessionToHermesTool({ outbox }))
      ctx.tools.register(createLoadHermesProjectMemoryTool({ hermesHome }))
      console.log('[dsh-hermes-link v' + VERSION + '] tools registered: list_hermes_sessions, import_hermes_session, load_hermes_persona, consult_hermes, mirror_session_to_hermes, load_hermes_project_memory')
    }
  } catch (e) {
    console.error('[dsh-hermes-link v' + VERSION + '] tool registration failed:', e && e.message || e)
  }

  // 8. HTTP routes 闁?single register call delegates all routes.
  try {
    registerHttp(ctx, {
      hermesHome,
      importer,
      personaLoader,
      consultClient,
      foundationSlice,
      continuations,
      outbox,
      sseBroker,
    })
  } catch (e) {
    console.error('[dsh-hermes-link] HTTP route registration failed:', e && e.message || e)
  }

  // 8b. hermes-push.mjs --status compatibility: GET /mcp/hermes-inbox/health
  try {
    const webServer = ctx.get('webServer')
    if (webServer) {
      webServer.register({
        kind: 'exact',
        path: '/mcp/hermes-inbox/health',
        handler: async (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(inboxHealthPayload()))
        },
      })
    }
  } catch (e) {
    console.warn('[dsh-hermes-link] hermes-inbox health route failed:', e && e.message || e)
  }

  // 9. startup auto-sync 闁?import all Hermes sessions shortly after startup.
  if (importer && typeof importer.sync === 'function') {
    setTimeout(async () => {
      try {
        const r = await importer.sync()
        console.log('[dsh-hermes-link] startup auto-sync: imported=' + r.imported + ' skipped=' + r.skipped + ' failed=' + r.failed)
      } catch (e) {
        console.warn('[dsh-hermes-link] startup auto-sync failed:', e && e.message || e)
      }
    }, 8000)
  }

  // 10. console confirmation banner
  console.log('[dsh-hermes-link v' + VERSION + '] loaded; hermes_home=' + hermesHome +
    '  foundation=' + foundationSlice.length + 'chars' +
    (importer ? '  importer=on' : '  importer=off (no ctx.sessions)') +
    '  consult=on  watcher=' + (watcher ? 'on' : 'off') +
    '  continuables=' + continuations.count() +
    '  amend=' + (amendWatcher ? 'on' : 'off') +
    '  heartbeat=on' +
    '  autosync=' + (importer && typeof importer.sync === 'function' ? 'on' : 'off'))

  // Disposable: on plugin unload, stop watchers + timers + DB.
  ctx.on('dispose', () => {
    if (watcher && watcher.dispose) try { watcher.dispose() } catch {}
    if (amendWatcher && amendWatcher.dispose) try { amendWatcher.dispose() } catch {}
    if (heartbeat && heartbeat.stop) try { heartbeat.stop() } catch {}
    if (continuations && continuations.close) try { continuations.close() } catch {}
  })

  // Test-only escape hatch: stash internals as a provided service.
  ctx.provide('hermesLinkState', {
    hermesHome,
    foundationSlice,
    importer,
    personaLoader,
    consultClient,
    watcher,
    outbox,
    continuations,
    amendWatcher,
    version: VERSION,
  })
}

// re-export public helpers for testing / direct use
export { requestDumpToEvents, groupBySession, walkRequestDumps }
export { injectHermesTurns, loadHermesInbox, loadHermesSession, readHermesSessionTurns } from './services/hermes-inbox.mjs'
// buildFoundationSlice is already exported at its declaration site (above).