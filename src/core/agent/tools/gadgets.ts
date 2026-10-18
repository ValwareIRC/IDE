import type { GadgetManager } from '../../gadgets/manager'
import { GADGET_SDK_DOC } from '../../gadgets/sdk'
import { GADGET_ID_RE, type GadgetFiles, type GadgetInfo } from '../../gadgets/types'
import { err, str, type AgentTool } from './types'

/** Everything one gadget offers, with each tool's parameters, for gadget_list with an id. */
function describe(g: GadgetInfo): string {
  const params = (p: Record<string, unknown>): string => {
    const props = (p['properties'] ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown[] }>
    const req = new Set((p['required'] as string[] | undefined) ?? [])
    const all = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.enum ? v.enum.map((e) => JSON.stringify(e)).join(' | ') : (v.type ?? 'any')}${v.description ? ` (${v.description})` : ''}`)
    return all.length ? all.join('; ') : 'none'
  }
  const where = g.scope === 'builtin' ? 'comes with Prism' : `${g.scope}${g.overrides ? ', a copy that replaces the one that comes with Prism' : ''}`
  return [
    `${g.name} (${g.id}, ${where}): ${g.description || '(no description)'}`,
    `backend: ${g.hasBackend ? `${g.state}${g.error ? ` · ${g.error}` : ''}` : 'none'}`,
    g.tools.length ? `Tools, run with gadget_call id="${g.id}" method="<tool>" args={...}:\n${g.tools.map((t) => `- ${t.name}: ${t.description}\n  args: ${params(t.parameters)}`).join('\n')}` : 'Tools: none',
    `Handlers its panel uses: ${g.handlers.join(', ') || 'none'}`
  ].join('\n')
}

/** Tools that let the agent build, inspect and drive gadgets. */
export function createGadgetTools(gm: GadgetManager): AgentTool[] {
  const list: AgentTool = {
    spec: {
      name: 'gadget_list',
      description:
        "List installed gadgets (mini-apps inside Prism) with their state and tools. Some come with Prism: give an id to see everything one can do, with each tool's parameters, then run its tools with gadget_call.",
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'One gadget to describe in full' } } }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => (str(a, 'id') ? `what gadget ${str(a, 'id')} can do` : 'list gadgets'),
    async execute(args) {
      const id = str(args, 'id')
      if (id) {
        let g = gm.get(id)
        if (!g) return err(`No gadget named ${id}`)
        // what it offers is known once its backend has started
        if (g.hasBackend && !g.tools.length && !g.handlers.length && g.state !== 'error') {
          await gm.start(id).catch(() => undefined)
          g = gm.get(id) ?? g
        }
        return { content: describe(g), isError: false }
      }
      const all = gm.list()
      if (!all.length) return { content: 'No gadgets installed. Read gadget_sdk and build one with gadget_write.', isError: false }
      const line = (g: GadgetInfo): string =>
        `- ${g.id} "${g.name}"${g.scope === 'builtin' ? '' : ` (${g.scope}${g.overrides ? ', replaces the one that comes with Prism' : ''})`}: ${g.description || '(no description)'}\n  backend: ${g.hasBackend ? `${g.state}${g.error ? ` · ${g.error}` : ''}` : 'none'}; tools: ${g.tools.map((t) => t.name).join(', ') || (g.hasBackend ? 'see gadget_list with its id' : '—')}`
      const theirs = all.filter((g) => g.scope !== 'builtin')
      const own = all.filter((g) => g.scope === 'builtin')
      return {
        content: [
          `Made for this user:\n${theirs.length ? theirs.map(line).join('\n') : '(none yet)'}`,
          own.length ? `Come with Prism (gadget_list with an id shows each one's tools):\n${own.map(line).join('\n')}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        isError: false
      }
    }
  }

  const suggest: AgentTool = {
    spec: {
      name: 'suggest_gadget',
      description:
        'Offer the user a gadget you have noticed would help: a small live panel the two of you can both use, for work with an ongoing or repeatable shape (a build or test run worth watching, a process, numbers that move, anything you keep reading out of scrollback). The user is shown a card and chooses; do not build anything until they say yes. Use it when you notice, not on every turn, and say nothing about having offered unless they answer. One-offs, output read once, and anything a gadget would only restate are not worth offering.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'The sort of gadget as a short slug, not this particular one: test-results, build-watch, log-tail, bundle-size. Refusing silences the sort.' },
          title: { type: 'string', description: 'Short and plain, as the user would say it.' },
          what: { type: 'string', description: 'One sentence: what it would show and do.' },
          why: { type: 'string', description: 'One sentence: why it earns its place here.' }
        },
        required: ['kind', 'title', 'what']
      }
    },
    primaryArg: 'kind',
    readOnly: true,
    risk: () => null,
    summary: (args) => `suggest a gadget: ${String(args['title'] ?? args['kind'] ?? '')}`,
    async execute(args, ctx) {
      const kind = String(args['kind'] ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      const title = String(args['title'] ?? '').trim().slice(0, 70)
      if (!kind || !title) return { content: 'A kind and a title are needed.', isError: true }
      const where = gm.suggest(ctx.sessionId, { kind, title, what: String(args['what'] ?? '').trim().slice(0, 300), why: String(args['why'] ?? '').trim().slice(0, 300) })
      if (where === 'silenced') return { content: `Not offered: the user has already turned down "${kind}" here, or there is one already. Do not raise it again.`, isError: false }
      if (where === 'nowhere') return { content: 'There is nowhere to show an offer in this session.', isError: false }
      return { content: `Offered. The user chooses: building it, putting it off, or never this kind. Carry on with what you were doing and do not wait for an answer; if they say yes you will be asked to build it.`, isError: false }
    }
  }

  const sdk: AgentTool = {
    spec: {
      name: 'gadget_sdk',
      description: 'The reference for writing gadgets: manifest, UI SDK (window.prism), backend module shape, lifecycle. Read it before gadget_write.',
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'read the gadget SDK',
    async execute() {
      return { content: GADGET_SDK_DOC, isError: false }
    }
  }

  const read: AgentTool = {
    spec: {
      name: 'gadget_read',
      description: "Read a gadget's files (gadget.json, index.html, backend.mjs, …) and its recent log.",
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => `read gadget ${str(a, 'id')}`,
    async execute(args) {
      const id = str(args, 'id')
      try {
        const files = await gm.readFiles(id)
        const log = gm.logOf(id).slice(-30)
        const parts = Object.entries(files).map(([n, c]) => `=== ${n} ===\n${c}`)
        if (log.length) parts.push(`=== log ===\n${log.join('\n')}`)
        return { content: parts.join('\n\n'), isError: false }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const write: AgentTool = {
    spec: {
      name: 'gadget_write',
      description:
        'Create or update a gadget by writing its files. files is an object of relative path → content (gadget.json, index.html, optional backend.mjs); ' +
        'send only the files that change. Backend changes restart the backend and return its start errors; UI-only changes refresh the panel and leave the backend running. Then call gadget_open.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lowercase letters, digits, dashes' },
          files: { type: 'object', description: 'relative path → file content', additionalProperties: { type: 'string' } },
          scope: { type: 'string', enum: ['project', 'global'], description: 'project (default, lives in .prism/gadgets) or global (every workspace)' }
        },
        required: ['id', 'files']
      }
    },
    primaryArg: 'id',
    readOnly: false,
    risk: (a) => {
      const files = (a['files'] ?? {}) as Record<string, unknown>
      return Object.keys(files).some((f) => /\.(mjs|cjs|js|ts)$/i.test(f) && !/^index\.html$/i.test(f)) ? 'high' : 'medium'
    },
    summary: (a) => {
      const files = Object.keys((a['files'] ?? {}) as Record<string, unknown>)
      return `write gadget ${str(a, 'id')} (${files.join(', ')})`
    },
    async execute(args) {
      const id = str(args, 'id').trim()
      if (!GADGET_ID_RE.test(id)) return err('id must be lowercase letters, digits and dashes (2-40 chars)')
      const raw = args['files']
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('files must be an object of path → content')
      const files: GadgetFiles = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v !== 'string') return err(`file ${k} must be a string`)
        files[k] = v
      }
      if (files['gadget.json']) {
        try {
          const m = JSON.parse(files['gadget.json']) as { id?: string }
          if (m.id && m.id !== id) return err(`gadget.json id "${m.id}" must match ${id}`)
        } catch (e) {
          return err(`gadget.json is not valid JSON: ${e instanceof Error ? e.message : e}`)
        }
      }
      const scope = str(args, 'scope') === 'global' ? 'global' : 'project'
      try {
        const was = gm.get(id)
        const info = await gm.write(id, files, scope)
        const copied = was?.scope === 'builtin' ? ` It is a copy of the one that comes with Prism, kept ${scope === 'project' ? 'in this project' : 'for every project'}, and takes its place; removing it brings the original back.` : ''
        const status = info.hasBackend ? `backend ${info.state}${info.error ? `: ${info.error}` : ''}` : 'UI only'
        const log = gm.logOf(id).slice(-8)
        return {
          content: `Gadget ${id} written (${info.scope}).${copied} ${status}. Tools: ${info.tools.map((t) => t.name).join(', ') || 'none'}. Handlers: ${info.handlers.join(', ') || 'none'}.${log.length ? `\nlog:\n${log.join('\n')}` : ''}`,
          isError: info.state === 'error',
          meta: { gadget: id }
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const open: AgentTool = {
    spec: {
      name: 'gadget_open',
      description: "Open a gadget's panel so the user can see it.",
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => `open gadget ${str(a, 'id')}`,
    async execute(args) {
      const id = str(args, 'id')
      if (!gm.get(id)) return err(`No gadget named ${id}`)
      return { content: `Opened gadget ${id} for the user.`, isError: false, meta: { openGadget: id } }
    }
  }

  const call: AgentTool = {
    spec: {
      name: 'gadget_call',
      description:
        "Call one of a gadget's handlers (the same ones its UI uses) or one of its tools by name. Use gadget_list to see the names. " +
        'A gadget written during this turn gets its direct gadget__<id>__<tool> tools from the next turn on; until then call them through here.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, method: { type: 'string' }, args: { type: 'object', additionalProperties: true } },
        required: ['id', 'method']
      }
    },
    primaryArg: 'id',
    readOnly: false,
    risk: () => 'medium',
    summary: (a) => `${str(a, 'id')}: ${str(a, 'method')}`,
    async execute(args) {
      try {
        // a built-in gadget does nothing in a project until the user turns it on there
        if (gm.isOff(str(args, 'id'))) return { content: `${str(args, 'id')} is not turned on in this project. Only the user can turn it on, by opening it from the Gadgets list; suggest it if it would help.`, isError: true }
        let g = gm.get(str(args, 'id'))
        // one that has never run has not said what it offers yet
        if (g && g.hasBackend && !g.tools.length && !g.handlers.length && g.state !== 'error') {
          await gm.start(g.id).catch(() => undefined)
          g = gm.get(g.id)
        }
        const method = str(args, 'method')
        const callArgs = (args['args'] as Record<string, unknown>) ?? {}
        if (g && !g.handlers.includes(method) && g.tools.some((t) => t.name === method)) return await gm.callTool(g.id, method, callArgs)
        const r = await gm.call(str(args, 'id'), method, callArgs)
        const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
        return { content: (text ?? 'null').slice(0, 60_000), isError: false }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const look: AgentTool = {
    spec: {
      name: 'gadget_look',
      description:
        "See a gadget's panel exactly as the user sees it right now (opens it if needed). Returns a picture plus a written layout check: what spills, hangs out of its box or is cut off, at the current size and at 340px wide. Use it after every UI change.",
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => `look at gadget ${str(a, 'id')}`,
    async execute(args) {
      const id = str(args, 'id')
      const g = gm.get(id)
      if (!g) return err(`No gadget named ${id}`)
      try {
        const shot = await gm.capture(id)
        if (!shot) return err('The gadget panel could not be captured (the Prism window may be minimised).')
        const state = g.hasBackend ? `backend ${g.state}${g.error ? `: ${g.error}` : ''}` : 'UI only'
        const check = await gm.inspect(id).catch(() => null)
        const words = (label: string, r: { width: number; height: number; issues: string[] } | null): string =>
          !r ? '' : `\n\nLayout check ${label} (${r.width}×${r.height}): ${r.issues.length ? `${r.issues.length} problem(s)\n${r.issues.map((i) => `- ${i}`).join('\n')}` : 'nothing spills or is cut off.'}`
        const layout = check ? words('at the current size', check.current) + words('squeezed to a narrow panel', check.narrow) : '\n\n(No layout check: the gadget page does not load prism.js.)'
        return { content: `Picture of gadget ${id} (${state}).${layout}`, isError: false, images: [shot], meta: { gadget: id, openGadget: id } }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const remove: AgentTool = {
    spec: {
      name: 'gadget_remove',
      description: 'Delete a gadget and its folder.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: false,
    risk: () => 'high',
    summary: (a) => `remove gadget ${str(a, 'id')}`,
    async execute(args) {
      const id = str(args, 'id')
      const g = gm.get(id)
      if (!g) return err(`No gadget named ${id}`)
      try {
        await gm.remove(id)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
      return { content: g.overrides ? `Removed the copy of ${id}; the one that comes with Prism is back.` : `Removed gadget ${id}.`, isError: false }
    }
  }

  return [list, sdk, read, write, open, look, call, remove, suggest]
}
