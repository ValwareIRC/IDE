import type { TodoItem } from '@shared/types'
import { bool, clipOutput, err, num, str, type AgentTool } from './types'

function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
}

export const webFetchTool: AgentTool = {
  spec: {
    name: 'web_fetch',
    description: 'Fetch a URL and return its readable text (HTML is converted to plain text). Use for docs, APIs and references.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, max_chars: { type: 'number', description: 'Default 40000' } },
      required: ['url']
    }
  },
  primaryArg: 'url',
  readOnly: true,
  risk: () => 'low',
  summary: (a) => `fetch ${str(a, 'url')}`,
  async execute(args, ctx) {
    const url = str(args, 'url').trim()
    if (!/^https?:\/\//i.test(url)) return err('Only http(s) URLs are supported.')
    const max = Math.max(1000, Math.min(200_000, Math.floor(num(args, 'max_chars', 40_000))))
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Prism/0.2; +https://github.com/valware)', Accept: 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
        redirect: 'follow'
      })
      const ctype = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      const text = /html/i.test(ctype) ? htmlToText(raw) : raw
      const body = clipOutput(text, max)
      return { content: `${res.status} ${ctype.split(';')[0]}\n\n${body}`, isError: !res.ok, meta: { status: res.status, chars: text.length } }
    } catch (e) {
      return err(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
}

export const webSearchTool: AgentTool = {
  spec: {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo) and return the top results with titles, URLs and snippets. Follow up with web_fetch to read a page.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'number', description: 'Default 8' } },
      required: ['query']
    }
  },
  primaryArg: 'query',
  readOnly: true,
  risk: () => 'low',
  summary: (a) => `search ${str(a, 'query')}`,
  async execute(args, ctx) {
    const query = str(args, 'query').trim()
    if (!query) return err('query is required')
    const max = Math.max(1, Math.min(20, Math.floor(num(args, 'max_results', 8))))
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Prism/0.2', Accept: 'text/html' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
      })
      const html = await res.text()
      const results: Array<{ title: string; url: string; snippet: string }> = []
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && results.length < max) {
        let url = decodeEntities(m[1] ?? '')
        const u = url.match(/[?&]uddg=([^&]+)/)
        if (u) url = decodeURIComponent(u[1]!)
        if (url.startsWith('//')) url = 'https:' + url
        const title = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim()
        const snippet = decodeEntities((m[3] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
        if (title && url && !/duckduckgo\.com\/y\.js/.test(url)) results.push({ title, url, snippet })
      }
      if (!results.length) return { content: `No results for "${query}".`, isError: false, meta: { results: 0 } }
      const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n')
      return { content: text, isError: false, meta: { results: results.length } }
    } catch (e) {
      return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export const todoTool: AgentTool = {
  spec: {
    name: 'todo_write',
    description:
      'The plan the user sees as a checklist at the top of the conversation. For any work with more than a couple of steps, lay out the whole plan in one call before starting, then call it again to tick items off as you go (one item active while you work on it, done when finished). Send the complete list every time.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'done'] }
            },
            required: ['text', 'status']
          }
        }
      },
      required: ['todos']
    }
  },
  primaryArg: null,
  readOnly: true,
  risk: () => null,
  summary: (a) => {
    const t = Array.isArray(a['todos']) ? (a['todos'] as unknown[]) : []
    return `update plan (${t.length} items)`
  },
  async execute(args, ctx) {
    const raw = Array.isArray(args['todos']) ? (args['todos'] as Array<Record<string, unknown>>) : []
    const todos: TodoItem[] = raw
      .map((t, i) => ({
        id: String(t['id'] ?? i + 1),
        text: str(t, 'text').trim(),
        status: (['pending', 'active', 'done'].includes(str(t, 'status')) ? str(t, 'status') : 'pending') as TodoItem['status']
      }))
      .filter((t) => t.text)
    ctx.setTodos(todos)
    const done = todos.filter((t) => t.status === 'done').length
    return { content: `Plan updated: ${done}/${todos.length} done.`, isError: false, meta: { todos } }
  }
}

export const askUserTool: AgentTool = {
  spec: {
    name: 'ask_user',
    description:
      'Ask the user a question when a decision is genuinely theirs to make and you cannot proceed sensibly without it. Offer concrete options when possible. Blocks until they answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] }
        },
        multi: { type: 'boolean', description: 'Allow several options' }
      },
      required: ['question']
    }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => null,
  summary: (a) => `ask: ${str(a, 'question').slice(0, 80)}`,
  async execute(args, ctx) {
    const question = str(args, 'question').trim()
    if (!question) return err('question is required')
    const options = (Array.isArray(args['options']) ? (args['options'] as Array<Record<string, unknown>>) : [])
      .map((o) => ({ label: str(o, 'label').trim(), description: str(o, 'description').trim() }))
      .filter((o) => o.label)
    const answer = await ctx.askUser({ question, options, multi: bool(args, 'multi') })
    return { content: answer ? `User answered: ${answer}` : 'User dismissed the question without answering.', isError: false, meta: { answer } }
  }
}

export const spawnAgentTool: AgentTool = {
  spec: {
    name: 'spawn_agent',
    description:
      'Delegate a self-contained task to a helper agent with its own context window. Good for broad searches, independent sub-tasks, or a second opinion. ' +
      'Give complete instructions: it cannot see this conversation. Returns its final report. ' +
      'background=true: it works while you carry on, and its report reaches you as a notice when it is done (start several this way to work in parallel). ' +
      'isolated=true: it works in its own copy of the project, so its edits cannot collide with yours or another helper\'s; bring its work in afterwards with merge_agent_work. ' +
      'Each helper keeps its name: message_agent talks to it while it works or carries it on after it has finished, stop_agent stops it.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions and what to report back' },
        name: { type: 'string', description: 'Short label, e.g. "explorer"' },
        model: { type: 'string', description: 'Optional model id from the roster' },
        read_only: { type: 'boolean', description: 'Restrict the helper to read/search tools' },
        background: { type: 'boolean', description: 'Return at once; its report comes later as a notice' },
        isolated: { type: 'boolean', description: 'Work in its own copy of the project (needs git)' }
      },
      required: ['task']
    }
  },
  primaryArg: null,
  readOnly: false,
  parallelSafe: true,
  risk: () => null,
  summary: (a) => `helper ${str(a, 'name', 'helper')}${bool(a, 'background') ? ' (background)' : ''}${bool(a, 'isolated') ? ' (own copy)' : ''}`,
  async execute(args, ctx) {
    const task = str(args, 'task').trim()
    if (!task) return err('task is required')
    const r = await ctx.spawnAgent(task, { name: str(args, 'name', 'helper'), model: str(args, 'model') || undefined, readOnly: bool(args, 'read_only'), background: bool(args, 'background'), isolated: bool(args, 'isolated') })
    return { content: r.summary || '(the helper returned nothing)', isError: !r.ok, meta: { subagent: str(args, 'name', 'helper') } }
  }
}
