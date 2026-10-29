import type { McpClient } from '../../mcp/client'
import type { GadgetManager } from '../../gadgets/manager'
import { attachFileTool } from './attach'
import { decisionRecordTool, decisionsLookTool } from './decisions'
import { createTabsLookTool } from './window'
import { gestureTool } from './gesture'
import { deletePathTool, editFileTool, globTool, grepTool, listDirTool, movePathTool, readFileTool, showTool, writeFileTool } from './fs'
import { createGadgetTools } from './gadgets'
import { checkProjectTool } from './checks'
import { proposeChangesTool } from './review'
import { presentPlanTool } from './plan'
import { rememberTool } from './remember'
import { findReferencesTool, renameSymbolTool } from './refactor'
import { createBrowserTools, type BrowserHost } from './browser'
import { createScratchTool, type ScratchHost } from './scratch'
import { createUseSkillTool, type SkillHost } from './skills'
import { createImpactTool, type ImpactHost } from './impact'
import { findBreakingCommitTool } from './bisect'
import { createTourTool } from './tour'
import { editNotebookTool } from './documents'
import { createBackgroundTools, createHelperTools } from '../background'
import { createMemoryTools, type MemoryHost } from './memory'
import { assumeTool, doneWhenTool } from '../guards'
import { DEBUG_TOOLS } from './debug'
import { createPrismTools, type PrismHost } from './prismctl'
import { createChangeTools, type ChangesHost } from './changes'
import { createThemeTool, type ThemeHost } from './theme'
import { askUserTool, spawnAgentTool, todoTool, webFetchTool, webSearchTool } from './misc'
import { createShellTools, type ShellConfig } from './shell'
import { str, type AgentTool } from './types'

export interface BuildToolsOptions {
  shell: ShellConfig
  readOnly: boolean
  allowSpawn: boolean
  mcp: Array<{ name: string; client: McpClient }>
  gadgets?: GadgetManager | null
  /** Prism's in-app browser, for the browser_* tools. */
  browser?: BrowserHost | null
  /** The scratchpad's runner, for run_snippet. */
  scratch?: ScratchHost | null
  /** The user's own tools (.prism/tools). */
  custom?: AgentTool[]
  /** For check_impact: the session's latest changes. */
  impact?: ImpactHost | null
  /** The session's skills, for use_skill. */
  skills?: SkillHost | null
  /** Prism's own appearance, for set_theme. */
  theme?: ThemeHost | null
  /** Plan mode: read-only tools plus present_plan. */
  plan?: boolean
  /** Timers, watchers and messages to other sessions (the lead agent only). */
  background?: boolean
  /** Messaging, stopping and merging helpers, and teams (the lead agent only). */
  helpers?: boolean
  /** Memories kept between sessions. */
  memory?: MemoryHost | null
  /** Prism's own settings and panels (prism_settings, prism_open). */
  prism?: PrismHost | null
  /** What this session changed, for taking back part of it. */
  changes?: ChangesHost | null
}

export function mcpToolName(server: string, tool: string): string {
  const s = server.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  return `mcp__${s}__${tool}`
}

function bridgeMcp(server: string, client: McpClient): AgentTool[] {
  return client.tools.map((t) => ({
    spec: {
      name: mcpToolName(server, t.name),
      description: `[${server}] ${t.description || t.name}`,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: false,
    risk: () => 'medium',
    summary: (a) => {
      const first = Object.values(a).find((v) => typeof v === 'string') as string | undefined
      return `${server}: ${t.name}${first ? ` · ${first.slice(0, 60)}` : ''}`
    },
    async execute(args) {
      try {
        const r = await client.call(t.name, args)
        return { content: r.content, isError: r.isError, images: r.images, meta: { mcp: server, tool: t.name } }
      } catch (e) {
        return { content: `MCP call failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
      }
    }
  }))
}

export function buildTools(o: BuildToolsOptions): Map<string, AgentTool> {
  const list: AgentTool[] = [readFileTool, listDirTool, globTool, grepTool, findReferencesTool, webFetchTool, webSearchTool, todoTool, showTool, attachFileTool, gestureTool, decisionRecordTool, decisionsLookTool]
  if (!o.readOnly) {
    list.push(writeFileTool, editFileTool, renameSymbolTool, movePathTool, deletePathTool, proposeChangesTool, ...createShellTools(o.shell), checkProjectTool, rememberTool, askUserTool, findBreakingCommitTool, createTourTool, editNotebookTool, ...DEBUG_TOOLS)
    for (const m of o.mcp) list.push(...bridgeMcp(m.name, m.client))
    if (o.gadgets) list.push(...createGadgetTools(o.gadgets), ...o.gadgets.agentTools())
    if (o.browser) list.push(...createBrowserTools(o.browser))
    if (o.scratch) list.push(createScratchTool(o.scratch))
    if (o.impact) list.push(createImpactTool(o.impact))
    if (o.theme) list.push(createThemeTool(o.theme))
  }
  // assumptions are worth writing down in plan mode too; proof belongs to the lead agent's own work
  if (!o.readOnly || o.plan) list.push(assumeTool)
  if (!o.readOnly && o.allowSpawn) list.push(doneWhenTool)
  if (o.changes) list.push(...createChangeTools(o.changes))
  if (o.prism) {
    const [settingsTool, openTool] = createPrismTools(o.prism)
    list.push(openTool!)
    const tabs = o.prism.tabs?.bind(o.prism)
    if (tabs) list.push(createTabsLookTool(tabs))
    if (!o.readOnly) list.push(settingsTool!)
  }
  if (o.background) list.push(...createBackgroundTools())
  if (o.helpers && o.allowSpawn && !o.readOnly) list.push(...createHelperTools())
  if (o.memory) {
    const [save, read, remove] = createMemoryTools(o.memory)
    list.push(read!)
    if (!o.readOnly) list.push(save!, remove!)
  }
  if (o.skills) list.push(createUseSkillTool(o.skills))
  if (o.plan) list.push(presentPlanTool, askUserTool)
  if (o.allowSpawn && !o.readOnly) list.push(spawnAgentTool)
  const map = new Map(list.map((t) => [t.spec.name, t]))
  // a tool of the user's never replaces one of Prism's
  if (!o.readOnly) for (const t of o.custom ?? []) if (!map.has(t.spec.name)) map.set(t.spec.name, t)
  return map
}

export function primaryOf(tool: AgentTool, args: Record<string, unknown>): string | null {
  return tool.primaryArg ? str(args, tool.primaryArg) : null
}

export type { AgentTool, ToolContext, ToolResult } from './types'
