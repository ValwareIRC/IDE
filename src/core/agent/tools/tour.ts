import type { CodeTour } from '@shared/types'
import { err, str, type AgentTool } from './types'

export const TOUR_DIR = '.prism/tours'

/** The line a step points at: the anchor's text where it is now, else the remembered line. */
export function findAnchor(content: string, anchor: string, line?: number): number | null {
  const want = anchor.trim()
  const lines = content.split(/\r?\n/)
  if (want) {
    const exact = lines.findIndex((l) => l.trim() === want)
    if (exact >= 0) return exact + 1
    const part = lines.findIndex((l) => l.includes(want))
    if (part >= 0) return part + 1
  }
  return line && line <= lines.length ? line : null
}

export const createTourTool: AgentTool = {
  spec: {
    name: 'create_tour',
    description:
      'Save a guided tour of the code: steps the user is walked through in the editor, each landing on one line with a short note. Use it when the user asks to be shown how something works. Order the steps the way a newcomer should read them (where it starts, then each place it goes). For each step give the file, the exact text of the line to land on (copied from the file, so the tour still finds it after the code moves), and a note of one to four plain sentences saying what happens here and why it matters. 4 to 12 steps.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the tour shows, e.g. "How saving works"' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { file: { type: 'string' }, anchor: { type: 'string', description: 'The exact text of the line to land on' }, note: { type: 'string', description: 'Markdown, one to four sentences' } },
            required: ['file', 'anchor', 'note']
          }
        }
      },
      required: ['title', 'steps']
    }
  },
  primaryArg: 'title',
  readOnly: false,
  risk: () => null,
  summary: (a) => `tour: ${str(a, 'title')}`,
  async execute(args, ctx) {
    const title = str(args, 'title').trim() || 'A tour'
    const raw = Array.isArray(args['steps']) ? (args['steps'] as Array<Record<string, unknown>>) : []
    if (raw.length < 2) return err('A tour needs at least two steps.')
    const steps: CodeTour['steps'] = []
    const problems: string[] = []
    for (const [i, s] of raw.slice(0, 30).entries()) {
      const file = String(s['file'] ?? '').split('\\').join('/').replace(/^\.\//, '')
      const anchor = String(s['anchor'] ?? '')
      try {
        const f = await ctx.workspace.read(file)
        const line = findAnchor(f.content, anchor)
        if (!line) problems.push(`step ${i + 1}: the line "${anchor.slice(0, 60)}" is not in ${file}`)
        steps.push({ file, anchor, note: String(s['note'] ?? '').trim(), line: line ?? 1 })
      } catch {
        problems.push(`step ${i + 1}: ${file} does not exist`)
      }
    }
    if (problems.length) return err(`Fix these steps and call create_tour again:\n${problems.join('\n')}`)
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'tour'
    const path = `${TOUR_DIR}/${slug}.json`
    const tour: CodeTour = { title, steps }
    await ctx.workspace.write(path, JSON.stringify(tour, null, 2))
    ctx.emit({ type: 'file-touched', path, op: 'write' })
    return { content: `Saved the tour "${title}" (${steps.length} steps) to ${path}. The user can play it now.`, isError: false, meta: { tour: path } }
  }
}
