import type { ScratchLang, ScratchOutput } from '@shared/types'
import type { ImagePart } from '../../providers/types'
import { clipOutput, err, str, type AgentTool } from './types'

/** The scratchpad's runner, as the tool needs it (core/scratch/manager.ts implements this). */
export interface ScratchHost {
  run(session: string, root: string, cell: string, lang: ScratchLang, code: string, onOutput: (o: ScratchOutput) => void): Promise<{ ok: boolean; ms: number }>
}

function asText(o: ScratchOutput): string {
  switch (o.kind) {
    case 'table':
      return `${o.columns.join(' | ')}\n${o.rows.slice(0, 40).map((r) => r.map((v) => (v === null ? '' : String(v))).join(' | ')).join('\n')}${o.total > 40 ? `\n… ${o.total} rows in all` : ''}\n`
    case 'image':
      return '[a picture, attached]\n'
    case 'html':
      // the tags are of no use to a reader of plain text
      return `${o.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)}\n`
    case 'error':
      return `${o.text}\n`
    default:
      return o.text
  }
}

/** Lets the agent run a snippet against the project and see what it gives, without writing a throwaway file. */
export function createScratchTool(host: ScratchHost): AgentTool {
  return {
    spec: {
      name: 'run_snippet',
      description:
        'Run a short JavaScript, TypeScript or Python snippet against the project and get back what it prints and its value. Use it to try an idea, call a project function, inspect data or compute something, instead of writing a throwaway script file. ' +
        'It behaves like a notebook: what one call defines (variables, imports, functions) is still there for the next call in this conversation. ' +
        "JavaScript/TypeScript: top-level await works; `import { x } from './src/file.js'` is resolved from the project folder; the value of the last expression is returned; show.table(rows) and show.image(pathOrBytes) give tables and pictures. " +
        "Python: the project's own .venv is used when it has one; the value of the last expression is returned; matplotlib charts come back as pictures.",
      parameters: {
        type: 'object',
        properties: { language: { type: 'string', enum: ['js', 'ts', 'python'] }, code: { type: 'string' } },
        required: ['language', 'code']
      }
    },
    primaryArg: 'code',
    readOnly: false,
    // it is code running on the user's machine, like a shell command
    risk: () => 'medium',
    summary: (a) => `run ${str(a, 'language')}: ${str(a, 'code').split('\n')[0]?.slice(0, 60) ?? ''}`,
    async execute(args, ctx) {
      const lang = str(args, 'language') as ScratchLang
      if (!['js', 'ts', 'python'].includes(lang)) return err('language must be js, ts or python.')
      const outputs: ScratchOutput[] = []
      const r = await host.run(`agent:${ctx.sessionId}`, ctx.workspace.root, ctx.callId || 'agent', lang, str(args, 'code'), (o) => {
        outputs.push(o)
        if (o.kind === 'text' || o.kind === 'stderr') ctx.output(ctx.callId, o.text)
      })
      const images: ImagePart[] = []
      for (const o of outputs) {
        const m = o.kind === 'image' ? /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(o.src) : null
        if (m && images.length < 4) images.push({ mime: m[1]!, base64: m[2]! })
      }
      const text = outputs.map(asText).join('').trim()
      return { content: clipOutput(text || (r.ok ? '(ran, with no output and no value)' : '(failed with no message)'), 30_000), isError: !r.ok, ...(images.length ? { images } : {}), meta: { ms: r.ms, language: lang } }
    }
  }
}
