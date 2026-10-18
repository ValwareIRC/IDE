import { MemoryStore, PROJECT_MEMORY_DIR, memorySlug, type MemoryScope } from '../../memory/memory'
import { err, str, type AgentTool } from './types'

export interface MemoryHost {
  /** Prism's own folder for memories that apply to every project. */
  personalDir: string
}

export function createMemoryTools(host: MemoryHost): AgentTool[] {
  const store = (ctx: Parameters<AgentTool['execute']>[1]): MemoryStore => new MemoryStore(ctx.workspace, host.personalDir)

  const save: AgentTool = {
    spec: {
      name: 'memory_save',
      description:
        'Remember something for future sessions, or update a memory (same name replaces it). One fact per memory. ' +
        'scope "personal" is about the user and applies in every project (who they are, how they like you to work, corrections they gave you, and why). ' +
        'scope "project" is about this project and is kept in .prism/memory (decisions, constraints, where things are, gotchas found the hard way). ' +
        'Do not save what the code or git history already says, or what only matters to this conversation. ' +
        'description is the one line you will see in every future session to decide whether to read it: make it specific.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short and distinctive, e.g. "deploy needs vpn"' },
          description: { type: 'string', description: 'One line: what this memory is about' },
          body: { type: 'string', description: 'The memory itself, in markdown. For a correction or a rule, say why.' },
          scope: { type: 'string', enum: ['personal', 'project'] }
        },
        required: ['name', 'description', 'body', 'scope']
      }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: () => null,
    summary: (a) => `remember: ${str(a, 'name')}`,
    async execute(args, ctx) {
      const scope: MemoryScope = str(args, 'scope') === 'personal' ? 'personal' : 'project'
      const name = str(args, 'name').trim()
      const body = str(args, 'body').trim()
      if (!name || !body) return err('A memory needs a name and a body.')
      try {
        const s = store(ctx)
        const existed = await s.find(name)
        const where = await s.save({ name, description: str(args, 'description'), body, scope })
        if (scope === 'project') ctx.emit({ type: 'file-touched', path: where, op: 'write' })
        return { content: `${existed ? 'Updated' : 'Saved'} "${name}" (${scope}).`, isError: false, meta: { memory: name, scope } }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const read: AgentTool = {
    spec: {
      name: 'memory_read',
      description: 'Read a memory in full by its name (from the list in your instructions). name "*" lists every memory with its description.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    },
    primaryArg: 'name',
    readOnly: true,
    risk: () => null,
    summary: (a) => `recall: ${str(a, 'name')}`,
    async execute(args, ctx) {
      const name = str(args, 'name').trim()
      const s = store(ctx)
      if (name === '*' || !name) {
        const all = await s.list()
        return { content: all.length ? all.map((m) => `- ${m.name} (${m.scope}): ${m.description}`).join('\n') : 'Nothing remembered yet.', isError: false }
      }
      const m = await s.find(name)
      if (!m) return err(`No memory called "${name}". memory_read "*" lists them.`)
      return { content: `# ${m.name} (${m.scope})\n${m.description}\n\n${m.body}`, isError: false }
    }
  }

  const remove: AgentTool = {
    spec: {
      name: 'memory_delete',
      description: 'Forget a memory that is wrong or no longer true.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: () => null,
    summary: (a) => `forget: ${str(a, 'name')}`,
    async execute(args, ctx) {
      const name = str(args, 'name').trim()
      const s = store(ctx)
      const m = await s.find(name)
      if (!m) return err(`No memory called "${name}".`)
      await s.remove(name)
      if (m.scope === 'project') ctx.emit({ type: 'file-touched', path: `${PROJECT_MEMORY_DIR}/${memorySlug(m.name)}.md`, op: 'delete' })
      return { content: `Forgot "${m.name}".`, isError: false }
    }
  }

  return [save, read, remove]
}
