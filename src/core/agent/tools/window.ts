import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { err, str, type AgentTool } from './types'

/**
 * Opens a project in a new Prism window, so a big piece of work can have a window and a
 * session of its own, and the user (often on the phone, away from the computer) can
 * switch to it. A window is the only way a project becomes open, and the phone cannot
 * open one itself.
 */
export function createOpenProjectTool(open: (root: string) => void): AgentTool {
  return {
    spec: {
      name: 'open_project',
      description:
        "Open a folder as a project in a new Prism window, so the user can switch to it (from the phone too, through its project list). Use it when the user asks for work to happen in another project or window. Give the folder's full path; it must exist.",
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The folder, as a full path' } }, required: ['path'] }
    },
    primaryArg: 'path',
    readOnly: false,
    risk: () => 'low',
    summary: (a) => `open ${str(a, 'path')} in a new window`,
    async execute(args) {
      const path = str(args, 'path').trim()
      if (!path || !isAbsolute(path)) return err('Give the full path of the folder.')
      if (!existsSync(path) || !statSync(path).isDirectory()) return err(`${path} is not a folder on this computer.`)
      open(path)
      return { content: `Opened ${path} in a new Prism window. The user can switch to it, on the phone through the project list.`, isError: false }
    }
  }
}

/** What the window has open: its tab groups, where each sits, and the tabs in each. */
export interface TabsLayout {
  groups: Array<{ group: number; where: string; inFront: boolean; tabs: Array<{ title: string; kind: string; file?: string; gadget?: string; showing: boolean }> }>
}

/**
 * The user's tab groups, so the agent knows what they have on screen: which files are open and
 * where, a gadget kept in a group of its own, what is showing. Files the agent shows go beside the
 * user's other files by themselves (renderer/src/shell/dockPlace.ts).
 */
export function createTabsLookTool(read: () => Promise<TabsLayout | null>): AgentTool {
  return {
    spec: {
      name: 'tabs_look',
      description:
        "The tab groups open in the user's Prism window: where each group sits on the screen, its tabs (files with their paths, gadgets, other pages), which tab is showing in each group, and which group the user is in. Use it to know what the user has open and is looking at, before referring to 'the open file' or deciding what to show. Files you open with show join the group that already holds the user's files, so a gadget kept in its own group is left alone.",
      parameters: { type: 'object', properties: {} }
    },
    readOnly: true,
    risk: () => null,
    primaryArg: null,
    summary: () => 'look at the open tabs',
    async execute() {
      const t = await read()
      if (!t || !t.groups.length) return err('No Prism window is showing this project right now.')
      const lines = t.groups.map((g) => {
        const head = `Group ${g.group} (${g.where}${g.inFront ? ', the one the user is in' : ''}):`
        const tabs = g.tabs.map((x) => `  - ${x.title}${x.file ? ` [file ${x.file}]` : x.gadget ? ` [gadget ${x.gadget}]` : ` [${x.kind}]`}${x.showing ? ' (showing)' : ''}`)
        return [head, ...(tabs.length ? tabs : ['  (empty)'])].join('\n')
      })
      return { content: lines.join('\n'), isError: false }
    }
  }
}
