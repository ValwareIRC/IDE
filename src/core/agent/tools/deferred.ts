// Tools from MCP servers and gadgets can be many and wordy (one Blender server
// is ~28 tools and several thousand tokens). Sending all of them with every
// message crowds the model's memory and slows weaker models down. When they
// add up to more than a budget, each source is offered as one line instead, and
// load_tools brings a source's tools in for the rest of the session.
import { estimateJsonTokens } from '../../tokens'
import { err, str, type AgentTool } from './types'

/** Above this, outside tools are offered by name only. */
const BUDGET = 2500

/** The source a tool comes from, or null for Prism's own. */
export function groupOf(name: string): string | null {
  const m = /^(mcp|gadget)__([^_]+(?:_[^_]+)*?)__/.exec(name)
  return m ? `${m[1] === 'mcp' ? '' : 'gadget '}${m[2]}` : null
}

export interface Deferral {
  /** Sources held back, with their tools. */
  held: Map<string, AgentTool[]>
}

/**
 * Takes the held-back tools out of `tools` (in place) and, when there are any, adds load_tools.
 * `loaded` are sources already brought in for this session; `onLoad` records a new one.
 */
export function deferOutsideTools(tools: Map<string, AgentTool>, loaded: string[], onLoad: (group: string) => void): Deferral {
  const groups = new Map<string, AgentTool[]>()
  for (const t of tools.values()) {
    const g = groupOf(t.spec.name)
    if (!g) continue
    const list = groups.get(g) ?? []
    list.push(t)
    groups.set(g, list)
  }
  const held = new Map<string, AgentTool[]>()
  const total = [...groups.values()].flat().reduce((n, t) => n + estimateJsonTokens(t.spec), 0)
  if (total <= BUDGET) return { held }
  for (const [g, list] of groups) {
    if (loaded.includes(g)) continue
    held.set(g, list)
    for (const t of list) tools.delete(t.spec.name)
  }
  if (!held.size) return { held }
  const lines = [...held].map(([g, list]) => {
    const names = list.map((t) => t.spec.name.replace(/^(mcp|gadget)__.+?__/, ''))
    const shown = names.slice(0, 14).join(', ')
    return `- ${g} (${list.length} tools): ${shown}${names.length > 14 ? ', …' : ''}`
  })
  const load: AgentTool = {
    spec: {
      name: 'load_tools',
      description: `Bring in the tools of a connected source so you can call them. They stay available for the rest of this conversation. Load a source as soon as the task needs it; do not guess its tools' arguments without loading it. Sources:\n${lines.join('\n')}`,
      parameters: { type: 'object', properties: { source: { type: 'string', description: 'The source name, as listed' } }, required: ['source'] }
    },
    primaryArg: 'source',
    readOnly: true,
    risk: () => null,
    summary: (a) => `load tools: ${str(a, 'source')}`,
    async execute(args) {
      const want = str(args, 'source').trim().toLowerCase()
      const hit = [...held.keys()].find((g) => g.toLowerCase() === want) ?? [...held.keys()].find((g) => g.toLowerCase().includes(want))
      if (!hit) return err(`No source called "${want}". Sources: ${[...held.keys()].join(', ')}.`)
      const list = held.get(hit)!
      held.delete(hit)
      for (const t of list) tools.set(t.spec.name, t)
      onLoad(hit)
      return { content: `Loaded ${list.length} tools from ${hit}: ${list.map((t) => t.spec.name).join(', ')}. You can call them now.`, isError: false, meta: { loaded: hit } }
    }
  }
  tools.set(load.spec.name, load)
  return { held }
}
