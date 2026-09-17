// tools/doctor.mjs
//
// v0.6.2 - `hermes_link_doctor`: the runtime self-check, callable from inside a
// DSH session.
//
// Until now the doctor was reachable only from a shell (`npx hermes-link-doctor`)
// or with curl (`GET /mcp/collab/doctor`). The failures it exists to catch --
// a dead mirror, a consult backlog nobody consumes, an imported session whose
// model route no adapter serves -- are exactly the ones a user notices as
// "it just doesn't work", so the check belongs where the user already is.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runDoctor, renderDoctor } from '../services/doctor.mjs'
import { dshHome } from '../services/audit.mjs'

export function createDoctorTool({ hermesHome, sessionMirror, hermesOutbox, metrics }) {
  return defineTool({
    name: 'hermes_link_doctor',
    description: 'v0.6.2: run the dsh-hermes-link runtime self-check and return its report. Measures what source reading cannot: plugin heartbeat freshness, whether enabled session mirrors are still advancing, consult backlog with per-ticket age, amend-directory writability, the Hermes->DSH outbox state, and (optionally) whether every imported session still carries a routable model route. Use it whenever a channel "just does not work" before digging into code.',
    parameters: {
      json: { type: 'boolean', description: 'Return the raw report object as JSON instead of the rendered text (default false).' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    async execute(args) {
      const report = await runDoctor({
        hermesHome,
        dshHome: dshHome(),
        // v0.6.5: the same registry that backs GET /mcp/collab/metrics, so the
        // session tool reports the numbers as well as the health.
        metrics,
        live: {
          mirrorPolicy: sessionMirror && typeof sessionMirror.policyStatus === 'function' ? sessionMirror.policyStatus() : null,
          outboxStats: hermesOutbox && typeof hermesOutbox.stats === 'function' ? hermesOutbox.stats() : null,
        },
      })
      if (args && args.json === true) return JSON.stringify(report, null, 2)
      return renderDoctor(report)
    },
  })
}
