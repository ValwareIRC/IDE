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
