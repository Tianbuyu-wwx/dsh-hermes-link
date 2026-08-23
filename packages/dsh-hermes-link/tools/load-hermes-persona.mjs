// tools/load-hermes-persona.mjs
//
// V3 tool: load Hermes persona (SOUL.md + relevant config.yaml slices) into the
// current session's working context. Returns text; the model decides how to use it.
// Off by default — the user opts in.
//
// v0.2.3 (K.1): scope no longer accepts 'memory'. Reading Hermes MEMORY.md whole
// re-introduces the same cross-project contamination that v0.2.1 closed for the
// main session and v0.2.2 closed for dispatch. To get Hermes memory that actually
// matches the current DSH session's working directory, use
// load_hermes_project_memory (cwd-scoped via Hermes state.db).

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createLoadHermesPersonaTool({ personaLoader, hermesHome }) {
  return defineTool({
    name: 'load_hermes_persona',
    description: 'Load Hermes persona (SOUL.md + relevant config.yaml model/agent/display/memory sections). Returns text so you can adopt Hermes\'s personality and known facts. Note: this tool does NOT load Hermes MEMORY.md since v0.2.3 — to load memory scoped to the current DSH session\'s working directory, use load_hermes_project_memory. Use when the user asks to "use Hermes persona" or wants you to behave as Hermes.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['all', 'soul', 'config'],
        default: 'all',
        description: 'Which slices to load. v0.2.3: "memory" was removed — use load_hermes_project_memory for cwd-scoped Hermes memory.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    execute(args) {
      if (!personaLoader) return '(persona loader not available)'
      // Defensive: reject legacy 'memory' scope at the tool surface too.
      const requested = args.scope || 'all'
      const scope = (requested === 'memory') ? 'all' : requested
      const out = personaLoader.loadPersona(hermesHome, { scope })
      const present = out.parts.filter((p) => p.present).map((p) => p.name)
      const hint = (requested === 'memory')
        ? '\n\n<!-- dsh-hermes-link: scope="memory" was retired in v0.2.3; use load_hermes_project_memory for cwd-scoped Hermes memory. -->'
        : ''
      return out.text + hint + `\n\n<!-- dsh-hermes-link: parts=${JSON.stringify(present)} -->`
    },
  })
}