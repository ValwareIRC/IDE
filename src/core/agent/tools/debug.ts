// Debug mode: instead of guessing at a bug, the agent adds temporary logging marked "prism-debug", has the
// problem happen (the user reproduces it, or a command does), reads what was logged, fixes the cause, then
// removes every marked line. Logs go to .prism/debug/<id>.log in the project; code running in a browser
// posts them to a small server on this computer that appends them there.
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Workspace } from '../../fs/workspace'
import { searchWorkspace } from '../../fs/search'
import { placeOf, remotePath } from '@shared/place'
import { err, str, type AgentTool } from './types'

const MARK = 'prism-debug'
const MAX_LOG = 2_000_000

interface Run {
  id: string
  sessionId: string
  ws: Workspace
  problem: string
  guesses: string[]
  log: string
}

const runs = new Map<string, Run>()
let server: Server | null = null
let port = 0

async function append(run: Run, text: string): Promise<void> {
  const cur = (await run.ws.exists(run.log)) ? (await run.ws.read(run.log)).content : ''
  const next = (cur + text.replace(/\r?\n?$/, '\n')).slice(-MAX_LOG)
  await run.ws.write(run.log, next)
}

async function ensureServer(): Promise<number> {
  if (server) return port
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') return void res.end()
    const run = [...runs.values()].find((r) => req.url === `/${r.id}`)
    if (!run || req.method !== 'POST') {
      res.statusCode = 404
      return void res.end()
    }
    let body = ''
    req.on('data', (d: Buffer) => {
      if (body.length < 200_000) body += d.toString('utf8')
    })
    req.on('end', () => {
      void append(run, body).finally(() => res.end('ok'))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const a = server.address()
  port = typeof a === 'object' && a ? a.port : 0
  server.unref()
  return port
}

const runOf = (sessionId: string): Run | undefined => [...runs.values()].reverse().find((r) => r.sessionId === sessionId)

async function readLog(run: Run, tail: number): Promise<{ lines: string[]; total: number }> {
  if (!(await run.ws.exists(run.log))) return { lines: [], total: 0 }
  const all = (await run.ws.read(run.log)).content.split('\n').filter((l) => l.trim())
  return { lines: all.slice(-tail), total: all.length }
}

export const debugStartTool: AgentTool = {
  spec: {
    name: 'debug_start',
    description:
      'Start a debug run for a bug whose cause is not obvious from reading the code. Say what goes wrong and your guesses at the cause; you get a log file and an address to log to. ' +
      'Then add temporary logging that would tell your guesses apart, marking every added line with a "prism-debug" comment, have the problem happen (debug_reproduce asks the user; or run it yourself), read the log with debug_read, fix the real cause, and finish with debug_cleanup.',
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'What goes wrong, in one or two sentences' },
        guesses: { type: 'array', items: { type: 'string' }, description: 'Your guesses at the cause, most likely first' }
      },
      required: ['problem', 'guesses']
    }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => 'low',
  summary: (a) => `debug: ${str(a, 'problem').slice(0, 90)}`,
  async execute(args, ctx) {
    const problem = str(args, 'problem').trim()
    const guesses = (Array.isArray(args['guesses']) ? (args['guesses'] as unknown[]) : []).map((g) => String(g).trim()).filter(Boolean).slice(0, 8)
    if (!problem) return err('Say what goes wrong.')
    const id = randomUUID().slice(0, 6)
    const log = `.prism/debug/${id}.log`
    const run: Run = { id, sessionId: ctx.sessionId, ws: ctx.workspace, problem, guesses, log }
    runs.set(id, run)
    await ctx.workspace.write(log, '')
    const p = await ensureServer()
    const abs = remotePath(ctx.workspace.abs(log))
    const remote = placeOf(ctx.workspace.root).kind !== 'local'
    return {
      content: [
        `Debug run ${id} started.`,
        `Log file: ${log} (full path: ${abs}). Append one line per event, plain text or JSON, with what tells your guesses apart: values, which branch ran, timings, sizes.`,
        `From code in a browser: fetch('http://127.0.0.1:${p}/${id}', { method: 'POST', body: JSON.stringify({...}) }).catch(() => {})${remote ? ' (this server is on the user\'s computer; code on the remote machine should write the file instead)' : ''}`,
        `Mark every line you add with a "${MARK}" comment on that same line. For a block of several lines, put a "${MARK}-start" comment line before it and a "${MARK}-end" comment line after it. debug_cleanup removes exactly those lines, so do not mark anything else.`,
        'Next: add the logging, then have the problem happen (debug_reproduce asks the user to do it; or run a test or command yourself), then debug_read.'
      ].join('\n'),
      isError: false,
      meta: { debug: { id, problem, guesses } }
    }
  }
}

export const debugReproduceTool: AgentTool = {
  spec: {
    name: 'debug_reproduce',
    description: 'Ask the user to make the problem happen now, with your logging in place, and wait. Returns what was logged meanwhile. Say exactly what to do (which page, which button, what to type).',
    parameters: { type: 'object', properties: { steps: { type: 'string', description: 'What the user should do to make it happen' } }, required: ['steps'] }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => null,
  summary: (a) => `reproduce: ${str(a, 'steps').slice(0, 90)}`,
  async execute(args, ctx) {
    const run = runOf(ctx.sessionId)
    if (!run) return err('Start a debug run first with debug_start.')
    const before = (await readLog(run, 1)).total
    const answer = await ctx.askUser({
      question: `Make the problem happen now, so the logging can catch it:\n\n${str(args, 'steps').trim()}\n\nThen pick one.`,
      options: [
        { label: 'Done, it happened', description: 'I did it and saw the problem' },
        { label: "It didn't happen", description: 'I did it but the problem did not show this time' },
        { label: 'Stop debugging', description: 'Leave it here' }
      ],
      multi: false
    })
    const { lines, total } = await readLog(run, 400)
    const fresh = total - before
    return {
      content: `User: ${answer || 'dismissed it'}\n${fresh} new log line${fresh === 1 ? '' : 's'} (${total} in all). Latest:\n${lines.slice(-Math.max(fresh, 1)).slice(-400).join('\n') || '(nothing logged: the logging may not run where you think, or the steps did not reach it)'}`,
      isError: false,
      meta: { debugReproduce: { answer, fresh, total } }
    }
  }
}

export const debugReadTool: AgentTool = {
  spec: {
    name: 'debug_read',
    description: 'Read the debug run\'s log (the last lines; tail sets how many).',
    parameters: { type: 'object', properties: { tail: { type: 'number' } } }
  },
  primaryArg: null,
  readOnly: true,
  risk: () => null,
  summary: () => 'read the debug log',
  async execute(args, ctx) {
    const run = runOf(ctx.sessionId)
    if (!run) return err('No debug run in this session.')
    const tail = Math.max(1, Math.min(2000, Math.floor(Number(args['tail']) || 300)))
    const { lines, total } = await readLog(run, tail)
    return { content: total ? `${total} line${total === 1 ? '' : 's'} logged${total > lines.length ? `, last ${lines.length}` : ''}:\n${lines.join('\n')}` : 'Nothing logged yet.', isError: false, meta: { lines: total } }
  }
}

/** Every file in the project holding the marker. */
async function markedFiles(ws: Workspace): Promise<string[]> {
  if (placeOf(ws.root).kind !== 'ssh') {
    const r = await searchWorkspace(ws.root, { query: MARK, regex: false, caseSensitive: true, wholeWord: false, maxResults: 5000 })
    return [...new Set(r.matches.map((m) => m.path))].filter((p) => !p.startsWith('.prism/debug/'))
  }
  const out: string[] = []
  for (const f of await ws.walk(20_000)) {
    if (f.startsWith('.prism/debug/')) continue
    const c = await ws.read(f).catch(() => null)
    if (c && !c.binary && c.content.includes(MARK)) out.push(f)
  }
  return out
}

/** The file without the marked lines and blocks. */
export function stripMarked(text: string): { text: string; removed: number } {
  const keep: string[] = []
  let inBlock = false
  let removed = 0
  // true from a removed line until the next kept line with text on it
  let gap = false
  for (const l of text.split('\n')) {
    const marked = inBlock || l.includes(MARK)
    if (l.includes(`${MARK}-start`)) inBlock = true
    if (l.includes(`${MARK}-end`)) inBlock = false
    if (marked) {
      removed++
      gap = true
      continue
    }
    // a removed block between two blank lines would leave them doubled
    if (!l.trim() && gap && keep.length && !keep[keep.length - 1]!.trim()) continue
    if (l.trim()) gap = false
    keep.push(l)
  }
  return { text: keep.join('\n'), removed }
}

export const debugCleanupTool: AgentTool = {
  spec: {
    name: 'debug_cleanup',
    description: 'End the debug run: remove every line marked "prism-debug" (and every prism-debug-start … prism-debug-end block) from the project, and delete the log. Call it before you finish, once the fix is in.',
    parameters: { type: 'object', properties: {} }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => 'low',
  summary: () => 'remove the temporary logging',
  async execute(_args, ctx) {
    const files = await markedFiles(ctx.workspace)
    await ctx.checkpoint(files)
    const done: Array<{ path: string; removed: number }> = []
    for (const f of files) {
      const c = await ctx.workspace.read(f)
      const s = stripMarked(c.content)
      if (s.removed) {
        await ctx.workspace.write(f, s.text)
        done.push({ path: f, removed: s.removed })
      }
    }
    for (const r of [...runs.values()].filter((x) => x.sessionId === ctx.sessionId)) {
      await r.ws.delete(r.log).catch(() => {})
      runs.delete(r.id)
    }
    const left = await markedFiles(ctx.workspace)
    const total = done.reduce((a, d) => a + d.removed, 0)
    return {
      content:
        (done.length ? `Removed ${total} line${total === 1 ? '' : 's'} of temporary logging:\n${done.map((d) => `- ${d.path}: ${d.removed}`).join('\n')}` : 'There was no marked logging left to remove.') +
        (left.length ? `\nStill marked (check these by hand): ${left.join(', ')}` : '\nNothing marked is left in the project.'),
      isError: left.length > 0,
      meta: { debugCleanup: { files: done, left } }
    }
  }
}

export const DEBUG_TOOLS = [debugStartTool, debugReproduceTool, debugReadTool, debugCleanupTool]
