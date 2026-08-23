// tools/load-hermes-project-memory.mjs
//
// v0.2.2 — cwd-scoped Hermes memory loader (DSH-side view).
//
// Reads Hermes state.db and returns MEMORY.md lines that match the current
// DSH session's cwd. The auto-injected foundation slice no longer carries
// MEMORY.md (per-project contamination class of bug, v0.2.1 fix). This tool
// is the manual escape valve: the user (or the model on their explicit
// request) loads ONLY the Hermes memory that pertains to the current project.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildProjectMemorySlice } from '../services/hermes-project-memory.mjs'

export function createLoadHermesProjectMemoryTool({ hermesHome }) {
  return defineTool({
    name: 'load_hermes_project_memory',
    description: 'Read Hermes MEMORY.md entries that match the current DSH session\'s working directory. cwd-scoped: returns nothing if no Hermes state.db session has cwd === current cwd. Use when the user wants to know what Hermes remembers about THIS project (not other projects).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value || '') }]
      },
    },
    async execute(_args, exec) {
      const agent = exec && exec.agent
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      if (!cwd) return '(no session cwd available; cannot match Hermes state.db sessions)'
      const slice = await buildProjectMemorySlice(hermesHome, cwd)
      return slice || '(no Hermes state.db sessions matched this cwd; nothing relevant in MEMORY.md)'
    },
  })
}