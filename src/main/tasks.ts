// The task board: a list of jobs for the agent that runs by itself, one after another or a few at a
// time, each in its own session (and, if asked, its own copy of the project), for example overnight.
// A task is finished when its session's turn has ended and nothing it started is still running in the
// background. The board is kept per project in Prism's data folder, so it never shows up in the project.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardTask, ModelRef, PermissionMode } from '@shared/types'
import { CH } from '@shared/ipc'
import type { Services } from './services'

const UNATTENDED = `

(This task runs from the task board while the user is away: nobody will answer questions until they are back. Make sensible choices and note real guesses with assume; prove your work with done_when; do not stop to ask. Finish with a short report: what you did, how you checked it, and anything left for the user.)`

export class TaskBoard {
  private queue: string[] = []
  private parallel = 1
  private stopped = false

  constructor(private s: Services) {
    s.agent.onTurnEnd((sessionId, reason) => void this.turnEnded(sessionId, reason))
  }

  private file(): string | null {
    const root = this.s.workspace?.root
    if (!root) return null
    const dir = join(this.s.userData, 'tasks')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, `${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)}.json`)
  }

  list(): BoardTask[] {
    const f = this.file()
    if (!f || !existsSync(f)) return []
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as BoardTask[]) : []
    } catch {
      return []
    }
  }

  private write(tasks: BoardTask[]): BoardTask[] {
    const f = this.file()
    if (!f) throw new Error('Open a project first.')
    writeFileSync(f, JSON.stringify(tasks, null, 2), 'utf8')
    this.s.send(CH.TasksChanged, tasks)
    return tasks
  }

  private patch(id: string, p: Partial<BoardTask>): void {
    this.write(this.list().map((t) => (t.id === id ? { ...t, ...p } : t)))
  }

  /** The user's edits (titles, prompts, order, options); what a running task is doing is kept. */
  save(next: Array<Partial<BoardTask> & { title: string; prompt: string }>): BoardTask[] {
    const cur = new Map(this.list().map((t) => [t.id, t]))
    const out: BoardTask[] = next.map((n) => {
      const old = n.id ? cur.get(n.id) : undefined
      const base: BoardTask = old ?? { id: randomUUID().slice(0, 8), title: '', prompt: '', ownCopy: false, mode: 'auto', model: null, status: 'todo', sessionId: null, summary: '', verdict: null, changed: 0, startedAt: null, endedAt: null, error: null }
      const keepRun = base.status === 'running' || base.status === 'queued'
      return {
        ...base,
        title: String(n.title).slice(0, 200),
        prompt: String(n.prompt).slice(0, 20_000),
        ownCopy: n.ownCopy ?? base.ownCopy,
        mode: (['ask', 'auto-edit', 'auto'] as PermissionMode[]).includes(n.mode as PermissionMode) ? (n.mode as PermissionMode) : base.mode,
        model: n.model === undefined ? base.model : (n.model as ModelRef | null),
        ...(keepRun ? {} : n.status === 'todo' ? { status: 'todo', sessionId: null, summary: '', verdict: null, changed: 0, startedAt: null, endedAt: null, error: null } : {})
      }
    })
    return this.write(out)
  }

  /** Start the given tasks (or every one still to do), `parallel` at a time. */
  run(ids: string[] | null, parallel: number): BoardTask[] {
    if (!this.s.workspace) throw new Error('Open a project first.')
    this.stopped = false
    this.parallel = Math.max(1, Math.min(6, Math.floor(parallel) || 1))
    const tasks = this.list()
    const pick = tasks.filter((t) => (ids ? ids.includes(t.id) : t.status === 'todo') && t.status !== 'running')
    for (const t of pick) if (!this.queue.includes(t.id)) this.queue.push(t.id)
    this.write(tasks.map((t) => (pick.some((p) => p.id === t.id) ? { ...t, status: 'queued', error: null } : t)))
    void this.pump()
    return this.list()
  }

  /** Stop starting new tasks and stop the ones running. */
  stop(): BoardTask[] {
    this.stopped = true
    const tasks = this.list()
    for (const t of tasks) if (t.status === 'running' && t.sessionId) this.s.agent.abort(t.sessionId)
    this.queue = []
    return this.write(tasks.map((t) => (t.status === 'queued' ? { ...t, status: 'todo' } : t)))
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.queue.length && this.list().filter((t) => t.status === 'running').length < this.parallel) {
      const id = this.queue.shift()!
      const task = this.list().find((t) => t.id === id)
      if (!task) continue
      await this.start(task).catch((e: unknown) => this.patch(task.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), endedAt: Date.now() }))
    }
  }

  private async start(task: BoardTask): Promise<void> {
    const ws = this.s.requireWorkspace()
    const session = task.ownCopy ? await this.s.agent.createInCopy(`Task: ${task.title}`) : this.s.repo.createSession(ws.root, `Task: ${task.title}`, task.model ?? this.s.defaultModel(), task.mode)
    this.patch(task.id, { status: 'running', sessionId: session.id, startedAt: Date.now(), endedAt: null, summary: '', verdict: null, changed: 0, error: null })
    this.s.send(CH.SessionChanged, this.s.agent.listSessions())
    await this.s.agent.send(session.id, `${task.prompt}${UNATTENDED}`, { mode: task.mode, ...(task.model ? { model: task.model } : {}) })
  }

  private async turnEnded(sessionId: string, reason: string): Promise<void> {
    const task = this.list().find((t) => t.sessionId === sessionId && t.status === 'running')
    if (!task) return
    // something it started is still going: its news will wake the session and end another turn
    await new Promise((r) => setTimeout(r, 1500))
    const bg = this.s.agent.backgroundState(sessionId)
    if (reason !== 'aborted' && (bg.jobs.length || bg.timers.length || bg.helpers.some((h) => h.running))) return
    const items = this.s.repo.listItems(sessionId)
    let summary = ''
    let verdict: BoardTask['verdict'] = null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (!summary && it.kind === 'assistant' && it.text.trim()) summary = it.text.trim().slice(0, 1500)
      if (verdict === null && it.kind === 'system' && Array.isArray(it.meta?.['verdict'])) verdict = (it.meta!['verdict'] as Array<{ ok: boolean }>).every((c) => c.ok) ? 'proven' : 'not-proven'
      if (summary && verdict !== null) break
    }
    const changed = new Set(this.s.repo.listFileVersions(sessionId).map((v) => v.path)).size
    const status: BoardTask['status'] = reason === 'completed' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
    const why = reason === 'budget' ? 'Paused: its budget ran out' : reason === 'stuck' ? 'Stopped: it went round in circles' : reason === 'max-steps' ? 'Stopped at the step limit' : reason === 'error' ? 'Ended with an error' : null
    this.patch(task.id, { status, summary, verdict, changed, endedAt: Date.now(), error: why })
    void this.pump()
  }
}

