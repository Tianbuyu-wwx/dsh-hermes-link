// tools/status.mjs
//
// v0.6.9 - `hermes_link_status`: the one-glance answer, callable from inside a DSH
// session. Ask "are Hermes and DSH talking?" and get one screen instead of curling
// four endpoints (or reading eleven doctor checks).

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runDoctor } from '../services/doctor.mjs'
import { summariseStatus, renderStatus } from '../services/status.mjs'
import { dshHome } from '../services/audit.mjs'

export function createStatusTool({ hermesHome, sessionMirror, hermesOutbox, consultClient, metrics, importer }) {
  return defineTool({
    name: 'hermes_link_status',
    description: 'v0.6.9: one-glance status of the dsh-hermes-link bridge -- whether Hermes notifications, session import, session mirror and the consult channel are working right now, the counters since the plugin loaded (including consult token usage), and what to do next if something is off. Cheaper and friendlier than hermes_link_doctor when you just want to know "is it working?".',
    parameters: {
      json: { type: 'boolean', description: 'Return the structured status object as JSON instead of the rendered text (default false).' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    async execute(args) {
      let outboxStats = null
      try { if (hermesOutbox && typeof hermesOutbox.stats === 'function') outboxStats = hermesOutbox.stats() } catch (_e) { outboxStats = null }
      let consultHealth = null
      try { if (consultClient && typeof consultClient.channelHealth === 'function') consultHealth = consultClient.channelHealth() } catch (_e) { consultHealth = null }
      let mirror = null
      try { if (sessionMirror && typeof sessionMirror.policyStatus === 'function') mirror = sessionMirror.policyStatus() } catch (_e) { mirror = null }

      const report = await runDoctor({
        hermesHome,
        dshHome: dshHome(),
        metrics,
        live: { mirrorPolicy: mirror, outboxStats },
      })
      const status = summariseStatus({ report, outboxStats, consultHealth, mirror })
      if (args && args.json === true) return JSON.stringify(status, null, 2)
      return renderStatus(status)
    },
  })
}
