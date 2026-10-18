import { err, str, type AgentTool } from './types'

export const NOTES_FILE = 'PRISM.md'

/** Append one lasting note to the project's notes file, creating it when needed. */
export async function appendNote(read: (p: string) => Promise<string | null>, write: (p: string, content: string) => Promise<void>, note: string): Promise<string> {
  const line = `- ${note.trim().replace(/\s*\n\s*/g, ' ')}`
  const cur = await read(NOTES_FILE)
  let next: string
  if (cur === null || !cur.trim()) {
    next = `# Project notes\n\nThings Prism should know every time it works on this project.\n\n## Notes\n\n${line}\n`
  } else if (/^## Notes\s*$/m.test(cur)) {
    // keep notes together under their heading, before whatever section follows it
    const at = cur.search(/^## Notes\s*$/m)
    const rest = cur.slice(at)
    const nextHeading = rest.slice(8).search(/^## /m)
    const end = nextHeading < 0 ? cur.length : at + 8 + nextHeading
    next = `${cur.slice(0, end).replace(/\s*$/, '')}\n${line}\n${end < cur.length ? `\n${cur.slice(end)}` : ''}`
  } else {
    next = `${cur.replace(/\s*$/, '')}\n\n## Notes\n\n${line}\n`
  }
  await write(NOTES_FILE, next)
  return line
}

export const rememberTool: AgentTool = {
  spec: {
    name: 'remember',
    description:
      `Save one lasting fact about this project to ${NOTES_FILE}, which is read at the start of every session: a convention, a command, a decision, something the user told you to always or never do. ` +
      'Use it when the user says "remember…", and for things you had to find out the hard way that a future session would need. One clear sentence. Not for temporary task state.',
    parameters: { type: 'object', properties: { note: { type: 'string', description: 'The fact, as one self-contained sentence' } }, required: ['note'] }
  },
  primaryArg: 'note',
  readOnly: false,
  risk: () => 'low',
  summary: (a) => `remember: ${str(a, 'note').slice(0, 70)}`,
  async execute(args, ctx) {
    const note = str(args, 'note').trim()
    if (note.length < 4) return err('The note is empty.')
    try {
      await ctx.checkpoint([NOTES_FILE])
      const line = await appendNote(
        async (p) => {
          try {
            return (await ctx.workspace.read(p)).content
          } catch {
            return null
          }
        },
        (p, c) => ctx.workspace.write(p, c),
        note
      )
      ctx.emit({ type: 'file-touched', path: NOTES_FILE, op: 'edit' })
      return { content: `Saved to ${NOTES_FILE}: ${line}`, isError: false }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}
