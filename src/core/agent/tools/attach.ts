import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { placeOf } from '@shared/place'
import { err, str, type AgentTool } from './types'

/**
 * Hands the user a file: it appears as a card under the answer. On the computer the card
 * opens the file; on the phone it fetches it through the paired connection and opens it
 * there, so a new APK goes straight to the installer without being put on the internet.
 * The file can be anywhere on this computer, not only in the project (builds often land
 * elsewhere), which is why the path is resolved here rather than through the workspace.
 */
export const attachFileTool: AgentTool = {
  spec: {
    name: 'attach_file',
    description:
      'Hand the user a file: it appears as an attachment card under your answer, which they can open on the computer or download on their phone. Use it whenever you give them something to keep, install or send on (an APK, an installer, a video, a document) instead of uploading it somewhere. The path may be relative to the project or absolute.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string', description: 'Optional one-line caption' } }, required: ['path'] }
  },
  primaryArg: 'path',
  readOnly: true,
  risk: () => null,
  summary: (a) => `attach ${str(a, 'path')}`,
  async execute(args, ctx) {
    const given = str(args, 'path')
    if (!given) return err('Say which file.')
    if (placeOf(ctx.workspace.root).kind === 'ssh') return err('Files can only be attached from a project on this computer.')
    const path = isAbsolute(given) ? given : resolve(ctx.workspace.root, given)
    try {
      const s = await stat(path)
      if (!s.isFile()) return err(`${given} is not a file.`)
      return { content: `Attached ${basename(path)} (${s.size} bytes) for the user.`, isError: false, meta: { attach: { path, name: basename(path), size: s.size, note: str(args, 'note') } } }
    } catch {
      return err(`${given} does not exist.`)
    }
  }
}
