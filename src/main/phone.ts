import type { Host } from './host'
// Control from your phone: when switched on, a small page is served on the home network. A phone pairs once with
// the six-digit code Prism shows, then sees every session, approves or denies, answers questions, sends
// messages (steering a session that is working) and stops runs. Nothing works without the pairing.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ApprovalRequest, QuestionRequest, TranscriptItem } from '@shared/types'
import { PHONE_APP } from './phoneApp'

interface Waiting {
  approvals: Map<string, ApprovalRequest>
  questions: Map<string, QuestionRequest>
  status: string | null
}

export interface PhoneInfo {
  on: boolean
  urls: string[]
  code: string
  paired: number
  error: string | null
}

export class PhoneRemote {
  private server: Server | null = null
  private port = 0
  private code = ''
  private tokens = new Set<string>()
  private fails = 0
  private lockedUntil = 0
  private waiting = new Map<string, Waiting>()
  private clients = new Set<ServerResponse>()
  private error: string | null = null
  private file: string

  constructor(
    userData: string,
    private host: Host
  ) {
    this.file = join(userData, 'phone-pairings.json')
    try {
      if (existsSync(this.file)) for (const t of JSON.parse(readFileSync(this.file, 'utf8')) as string[]) this.tokens.add(t)
    } catch {
      /* start unpaired */
    }
  }

  /** Every agent event passes here: what waits on the user is kept, and the phones are told something changed. */
  event(sessionId: string, ev: AgentEvent): void {
    const w = this.waiting.get(sessionId) ?? { approvals: new Map(), questions: new Map(), status: null }
    if (ev.type === 'approval') w.approvals.set(ev.request.approvalId, ev.request)
    else if (ev.type === 'approval-resolved') w.approvals.delete(ev.approvalId)
    else if (ev.type === 'question') w.questions.set(ev.request.questionId, ev.request)
    else if (ev.type === 'question-resolved') w.questions.delete(ev.questionId)
    else if (ev.type === 'status') w.status = ev.text
    else if (ev.type === 'run-end') {
      w.approvals.clear()
      w.questions.clear()
      w.status = null
    }
    this.waiting.set(sessionId, w)
    if (!this.clients.size) return
    if (['approval', 'approval-resolved', 'question', 'question-resolved', 'run-start', 'run-end', 'item', 'status'].includes(ev.type)) {
      for (const c of this.clients) c.write(`data: ${JSON.stringify({ sessionId, type: ev.type })}\n\n`)
    }
  }

  info(): PhoneInfo {
    const urls: string[] = []
    if (this.server) {
      for (const list of Object.values(networkInterfaces())) {
        for (const n of list ?? []) if (n.family === 'IPv4' && (!n.internal || process.env['PRISM_PHONE_HOST'])) urls.push(`http://${n.address}:${this.port}/`)
      }
    }
    return { on: !!this.server, urls, code: this.code, paired: this.tokens.size, error: this.error }
  }

  async apply(on: boolean, port: number): Promise<void> {
    if (!on) return this.stop()
    if (this.server && (port === 0 || port === this.port)) return
    this.stop()
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.error = null
    const server = createServer((req, res) => void this.handle(req, res).catch((e: unknown) => this.reply(res, 500, { error: e instanceof Error ? e.message : String(e) })))
    await new Promise<void>((resolve) => {
      server.once('error', (e) => {
        this.error = e.message
        resolve()
      })
      // PRISM_PHONE_HOST=127.0.0.1 keeps it on this computer (tests)
      server.listen(port || 0, process.env['PRISM_PHONE_HOST'] || '0.0.0.0', () => resolve())
    })
    if (this.error) return
    const a = server.address()
    this.port = typeof a === 'object' && a ? a.port : port
    this.server = server
  }

  stop(): void {
    for (const c of this.clients) c.end()
    this.clients.clear()
    this.server?.close()
    this.server = null
    this.code = ''
  }

  forget(): void {
    this.tokens.clear()
    this.save()
    for (const c of this.clients) c.end()
    this.clients.clear()
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify([...this.tokens]))
    } catch {
      /* pairings last until restart */
    }
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let text = ''
      req.on('data', (d: Buffer) => {
        if (text.length < 100_000) text += d.toString('utf8')
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(text || '{}') as Record<string, unknown>)
        } catch {
          resolve({})
        }
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://phone')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return void res.end(PHONE_APP)
    }
    if (req.method === 'POST' && url.pathname === '/pair') {
      if (Date.now() < this.lockedUntil) return this.reply(res, 429, { error: 'Too many wrong codes. Wait a minute; Prism shows a new code.' })
      const b = await this.body(req)
      if (String(b['code'] ?? '').trim() !== this.code || !this.code) {
        if (++this.fails >= 5) {
          this.fails = 0
          this.lockedUntil = Date.now() + 60_000
          this.code = String(randomInt(0, 1_000_000)).padStart(6, '0')
        }
        return this.reply(res, 403, { error: 'That is not the code Prism shows.' })
      }
      this.fails = 0
      const token = randomBytes(24).toString('hex')
      this.tokens.add(token)
      this.save()
      return this.reply(res, 200, { token })
    }
    const token = String(req.headers['x-prism-token'] ?? url.searchParams.get('token') ?? '')
    if (!this.tokens.has(token)) return this.reply(res, 401, { error: 'Not paired' })

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write('data: {"type":"hello"}\n\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // every project open in Prism, newest conversations first
      const benches = this.host.workbenches().filter((b) => b.workspace)
      const project = benches.map((b) => b.workspace!.name).join(', ') || null
      const sessions = benches
        .flatMap((b) => b.agent.listSessions().map((x) => ({ x, project: b.workspace!.name })))
        .sort((a, b) => b.x.updatedAt - a.x.updatedAt)
        .slice(0, 40)
        .map(({ x, project: p }) => {
          const w = this.waiting.get(x.id)
          return { id: x.id, title: benches.length > 1 ? `${p} · ${x.title}` : x.title, status: x.status, updatedAt: x.updatedAt, waiting: (w?.approvals.size ?? 0) + (w?.questions.size ?? 0) }
        })
      return this.reply(res, 200, { project, sessions })
    }
    const m = /^\/api\/session\/([\w-]+)(?:\/(send|stop|approve|answer))?$/.exec(url.pathname)
    if (!m) return this.reply(res, 404, { error: 'Not found' })
    const id = m[1]!
    const wb = this.host.bySession(id)
    const session = wb?.agent.listSessions().find((x) => x.id === id)
    if (!wb || !session) return this.reply(res, 404, { error: 'No such session' })
    const agent = wb.agent
    if (req.method === 'GET' && !m[2]) {
      const w = this.waiting.get(id)
      return this.reply(res, 200, { id, title: session.title, status: session.status, activity: w?.status ?? null, approvals: [...(w?.approvals.values() ?? [])], questions: [...(w?.questions.values() ?? [])], items: phoneItems(wb.repo.listItems(id)) })
    }
    const b = await this.body(req)
    if (m[2] === 'send') {
      const text = String(b['text'] ?? '').trim()
      if (!text) return this.reply(res, 400, { error: 'Nothing to send' })
      if (session.status === 'running' && agent.steer(id, text)) return this.reply(res, 200, { steered: true })
      void agent.send(id, text).catch(() => {})
      return this.reply(res, 200, { sent: true })
    }
    if (m[2] === 'stop') {
      agent.abort(id)
      return this.reply(res, 200, { ok: true })
    }
    if (m[2] === 'approve') {
      const d = String(b['decision'])
      agent.approve(id, String(b['approvalId']), d === 'deny' ? 'deny' : d === 'always' ? 'always' : 'once')
      return this.reply(res, 200, { ok: true })
    }
    if (m[2] === 'answer') {
      agent.answer(id, String(b['questionId']), String(b['answer'] ?? ''))
      return this.reply(res, 200, { ok: true })
    }
    return this.reply(res, 404, { error: 'Not found' })
  }
}

/** The conversation, shortened for a phone: messages in full, steps as one line each. */
function phoneItems(items: TranscriptItem[]): Array<{ id: string; kind: string; text: string; ts: number; bad?: boolean }> {
  const out: Array<{ id: string; kind: string; text: string; ts: number; bad?: boolean }> = []
  for (const it of items.slice(-120)) {
    if (it.kind === 'user') out.push({ id: it.id, kind: 'you', text: it.text, ts: it.ts })
    else if (it.kind === 'assistant' && it.text.trim() && !it.agent) out.push({ id: it.id, kind: it.toolCalls.length ? 'said' : 'answer', text: it.text, ts: it.ts })
    else if (it.kind === 'tool') {
      const a = it.args
      const arg = ['path', 'command', 'pattern', 'query', 'url'].map((k) => a[k]).find((v) => typeof v === 'string') as string | undefined
      out.push({ id: it.id, kind: 'step', text: `${it.name.replace(/_/g, ' ')}${arg ? ` ${arg.split('\n')[0]!.slice(0, 80)}` : ''}${it.diff ? ` (+${it.diff.additions} −${it.diff.deletions})` : ''}`, ts: it.ts, bad: it.isError })
    } else if (it.kind === 'system' && (it.subkind === 'notice' || it.subkind === 'error' || Array.isArray(it.meta?.['verdict']))) out.push({ id: it.id, kind: 'note', text: it.text.slice(0, 400), ts: it.ts, bad: it.subkind === 'error' })
  }
  return out.slice(-60)
}
