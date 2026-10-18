// What this session changed and when, file by file, so the agent can take back one part of its work
// ("undo the part where it renamed the API") and keep the rest. Fed from Prism's file history.
import type { FileVersion } from '@shared/types'
import { countDiff } from './fs'
import { err, num, str, type AgentTool } from './types'

export interface ChangesHost {
  /** Every change this session made, oldest first. */
  versions(): FileVersion[]
  /** The user's request a change belongs to. */
  requestOf(turnItemId: string | null): string
}

export function createChangeTools(host: ChangesHost): AgentTool[] {
  const list: AgentTool = {
    spec: {
      name: 'change_history',
      description:
        'Every change made to files in this session, oldest first: an id, the file, when, the size of the change, and which of the user\'s requests it was for. Give a path to see one file only. ' +
        'Use with version_at to take back part of earlier work: find the changes that belong to the part to undo, read the file as it was, and put back just those lines with edit_file (keeping later work).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    },
    primaryArg: 'path',
    readOnly: true,
    risk: () => null,
    summary: (a) => `change history${str(a, 'path') ? ` of ${str(a, 'path')}` : ''}`,
    async execute(args) {
      const path = str(args, 'path').trim().replace(/\\/g, '/')
      const all = host.versions().filter((v) => !path || v.path === path)
      if (!all.length) return { content: path ? `This session has not changed ${path}.` : 'This session has not changed any files yet.', isError: false }
      let lastTurn: string | null | undefined
      const lines: string[] = []
      for (const v of all.slice(-300)) {
        if (v.turnItemId !== lastTurn) {
          lastTurn = v.turnItemId
          lines.push(`\nRequest: "${host.requestOf(v.turnItemId).replace(/\s+/g, ' ').slice(0, 160)}"`)
        }
        const d = countDiff(v.before, v.after)
        const what = v.before === null ? 'created' : v.after === null ? 'deleted' : `+${d.additions} −${d.deletions}`
        lines.push(`  #${v.id}  ${v.path}  ${new Date(v.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${what}`)
      }
      return { content: lines.join('\n').trim(), isError: false }
    }
  }

  const at: AgentTool = {
    spec: {
      name: 'version_at',
      description: 'A file as it was just before (or just after, with after=true) one change from change_history, by its id. Numbered lines.',
      parameters: { type: 'object', properties: { id: { type: 'number' }, after: { type: 'boolean' } }, required: ['id'] }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: (a) => `version ${a['after'] === true ? 'after' : 'before'} change #${num(a, 'id', 0)}`,
    async execute(args) {
      const id = Math.floor(num(args, 'id', -1))
      const v = host.versions().find((x) => x.id === id)
      if (!v) return err(`No change #${id} in this session. change_history lists them.`)
      const content = args['after'] === true ? v.after : v.before
      if (content === null) return { content: `${v.path} did not exist ${args['after'] === true ? 'after' : 'before'} change #${id}.`, isError: false }
      const numbered = content.split('\n').map((l, i) => `${String(i + 1).padStart(5)}\t${l}`).join('\n')
      return { content: `${v.path} ${args['after'] === true ? 'after' : 'before'} change #${id}:\n${numbered.slice(0, 120_000)}`, isError: false }
    }
  }
  return [list, at]
}
