// Delivers notices to sessions and keeps the timers agents set (see core/agent/background.ts).
// A notice for a session in the middle of a turn waits in its inbox until the engine's next step; for an
// idle session it starts a new turn, unless the user's limit of wake-ups in a row has been reached or the
// session belongs to a project that is not open, in which case it is written into the conversation to be
// seen later. Either way the user gets a desktop notification while Prism is in the background.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AgentEvent, BackgroundState, SessionWorktree, SystemItem, Wakeup } from '@shared/types'
import type { BackgroundHost, NoticeTarget, SessionBrief } from '@core/agent/background'
import { nextDue } from '@core/agent/background'
import { runningHelpers } from '@core/agent/helpers'
import { jobsOf } from '@core/agent/tools/shell'
import { git } from '@core/git/git'
import { createWorktree, removeWorktree } from '@core/git/worktree'
import type { Repo } from '@core/store/repo'
import type { Settings } from '@shared/types'
import { isRemote } from '@shared/place'

export interface BackgroundDeps {
  repo: Repo
  settings(): Settings
  userData: string
  /** The open project's folder, or null. */
  projectRoot(): string | null
  running(rootSessionId: string): boolean
  status(sessionId: string): 'idle' | 'running' | 'waiting'
  emit(rootSessionId: string, ev: AgentEvent): void
  /** Start a turn opened by these notices. */
  wake(rootSessionId: string, notices: SystemItem[]): Promise<void>
  /** A desktop notification, when Prism is not in front. */
  desktop(sessionId: string, title: string, body: string): void
}

const TICK_MS = 15_000

export class Background implements BackgroundHost {
  /** Sessions the engine is running a loop for, and their lead session. */
  private active = new Map<string, string>()
  private inbox = new Map<string, SystemItem[]>()
  /** Automatic wake-ups in a row, per session, since the user last wrote. */
  private wakes = new Map<string, number>()
  /** Sessions already told they hit the limit, so the note is not repeated. */
  private toldLimit = new Set<string>()
  /** Who wants to hear the reply when a session finishes its turn. */
  private replyTo = new Map<string, string[]>()
  /** Notices gathered for a moment so news that arrives together wakes the agent once. */
  private gathering = new Map<string, { items: SystemItem[]; wake: boolean; timer: ReturnType<typeof setTimeout> }>()
  private changedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(private d: BackgroundDeps) {
    if (d.repo.sessionsWithWakeups().length) this.startTicker()
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker)
    for (const g of this.gathering.values()) clearTimeout(g.timer)
  }

  // ------------------------------------------------------------ notices

  notify(target: NoticeTarget, text: string, meta: Record<string, unknown>, wake: boolean): void {
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'notice', text, meta: { ...meta, wake } }
    // a helper still at work hears it before its next step
    if (target.sessionId !== target.rootSessionId && this.active.has(target.sessionId)) return this.toInbox(target.sessionId, item)
    const root = target.rootSessionId
    if (this.active.has(root) || this.d.running(root)) return this.toInbox(root, item)
    const g = this.gathering.get(root)
    if (g) {
      g.items.push(item)
      g.wake ||= wake
      return
    }
    this.gathering.set(root, { items: [item], wake, timer: setTimeout(() => void this.deliver(root), 400) })
  }

  private toInbox(sessionId: string, item: SystemItem): void {
    const q = this.inbox.get(sessionId) ?? []
    q.push(item)
    this.inbox.set(sessionId, q)
    this.changed(this.active.get(sessionId) ?? sessionId)
  }

  private async deliver(root: string): Promise<void> {
    const g = this.gathering.get(root)
    this.gathering.delete(root)
    if (!g) return
    await this.handIn(root, g.items, g.wake)
  }

  /** Notices for an idle session: start a turn with them, or write them down to be read later. */
  private async handIn(root: string, items: SystemItem[], wake: boolean): Promise<void> {
    const s = this.d.repo.getSession(root)
    if (!s) return
    // it started working in the meantime: they go in before its next step
    if (this.d.running(root)) {
      for (const i of items) this.toInbox(root, i)
      return
    }
    // a message the user sent while the agent worked counts as the user writing
    if (items.some((i) => i.meta?.['source'] === 'steer')) this.userSpoke(root)
    const first = items[0]!.text.split('\n')[0]!.slice(0, 140)
    this.d.desktop(root, s.title, items.length > 1 ? `${first} (+${items.length - 1} more)` : first)
    const limit = Math.max(0, this.d.settings().agent.wakeLimit ?? 10)
    const n = this.wakes.get(root) ?? 0
    const here = this.d.projectRoot() === s.workspace
    if (wake && here && n < limit) {
      this.wakes.set(root, n + 1)
      try {
        await this.d.wake(root, items)
        return
      } catch {
        /* could not start: written down below */
      }
    }
    const why = !wake ? null : !here ? 'This project was not open, so the agent was not woken. Open it and send a message to carry on.' : n >= limit && !this.toldLimit.has(root) ? `The agent has been woken ${n === 1 ? 'once' : `${n} times in a row`} without you, so it is waiting for you now. Send a message to let it carry on (the limit is in Settings, Agent).` : null
    if (why) {
      this.toldLimit.add(root)
      items.push({ kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: why, meta: { wakePaused: true } })
    }
    for (const i of items) {
      this.d.repo.appendItem(root, i)
      this.d.emit(root, { type: 'item', item: i })
    }
  }

  /** The user wrote: the agent may be woken again. */
  userSpoke(root: string): void {
    this.wakes.delete(root)
    this.toldLimit.delete(root)
  }

  /** A turn ended. News that came too late for it starts the next one; a session that was asked for a reply sends it. */
  turnEnded(root: string, lastText: string, aborted: boolean): void {
    const waiting = this.inbox.get(root)
    this.inbox.delete(root)
    if (waiting?.length && !aborted) void this.handIn(root, waiting, waiting.some((i) => i.meta?.['wake'] === true))
    else if (waiting?.length) for (const i of waiting) {
      this.d.repo.appendItem(root, i)
      this.d.emit(root, { type: 'item', item: i })
    }
    const askers = this.replyTo.get(root)
    if (askers?.length && !aborted) {
      this.replyTo.delete(root)
      const title = this.d.repo.getSession(root)?.title ?? 'another session'
      for (const a of askers) this.notify({ sessionId: a, rootSessionId: a }, `Session "${title}" (${root.slice(0, 8)}) replied:\n\n${lastText.trim() || '(it said nothing)'}`, { source: 'session-reply', from: root }, true)
    }
    this.changed(root)
  }

  pending(sessionId: string): boolean {
    return (this.inbox.get(sessionId)?.length ?? 0) > 0
  }

  drain(sessionId: string): SystemItem[] {
    const q = this.inbox.get(sessionId) ?? []
    this.inbox.delete(sessionId)
    return q
  }

  enter(sessionId: string, rootSessionId: string): void {
    this.active.set(sessionId, rootSessionId)
  }

  leave(sessionId: string): void {
    const root = this.active.get(sessionId)
    this.active.delete(sessionId)
    // a helper that has finished passes on what it did not get to read
    if (root && root !== sessionId) {
      const left = this.drain(sessionId)
      for (const i of left) this.notify({ sessionId: root, rootSessionId: root }, i.text, { ...(i.meta ?? {}), forHelper: true }, i.meta?.['wake'] === true)
    }
  }

  changed(root: string): void {
    const t = this.changedTimers.get(root)
    if (t) clearTimeout(t)
    this.changedTimers.set(
      root,
      setTimeout(() => {
        this.changedTimers.delete(root)
        this.d.emit(root, { type: 'background', state: this.state(root) })
      }, 120)
    )
  }

  state(root: string): BackgroundState {
    const running = runningHelpers(root)
    const helpers = (this.d.repo.getSessionExtras(root).helpers ?? [])
      .filter((h) => running.includes(h.name) || h.copy)
      .map((h) => ({ name: h.name, task: h.task, running: running.includes(h.name), startedAt: h.startedAt, isolated: !!h.copy }))
    return { jobs: jobsOf(root), timers: this.timers.list(root), helpers, wakes: this.wakes.get(root) ?? 0, wakeLimit: this.d.settings().agent.wakeLimit ?? 10 }
  }

  // ------------------------------------------------------------ timers

  private startTicker(): void {
    this.ticker ??= setInterval(() => this.tick(), TICK_MS)
  }

  private tick(): void {
    // only this project's sessions: another open project has its own
    const root = this.d.projectRoot()
    const ids = this.d.repo.sessionsWithWakeups().filter((id) => !!root && this.d.repo.getSession(id)?.workspace === root)
    if (!ids.length && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
      return
    }
    const now = Date.now()
    for (const id of ids) {
      const list = this.d.repo.getSessionExtras(id).wakeups ?? []
      const due = list.filter((w) => w.dueAt <= now)
      if (!due.length) continue
      const keep = list
        .map((w) => {
          if (w.dueAt > now) return w
          const next = w.every ? nextDue(w.every, Math.max(now, w.dueAt)) : null
          return next ? { ...w, dueAt: next } : null
        })
        .filter((w): w is Wakeup => !!w)
      this.d.repo.setSessionExtras(id, { wakeups: keep })
      for (const w of due) {
        const late = now - w.dueAt > 5 * 60_000 ? ` (it was due at ${new Date(w.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; Prism was closed or asleep then)` : ''
        this.notify({ sessionId: id, rootSessionId: id }, `Your timer ${w.id}${w.every ? ` (every ${w.every})` : ''} went off${late}. Your note:\n${w.note}`, { source: 'timer', wakeup: w.id }, true)
      }
      this.changed(id)
    }
  }

  timers = {
    add: (root: string, t: { dueAt: number; every?: string; note: string }): Wakeup => {
      const w: Wakeup = { id: randomUUID().slice(0, 6), dueAt: t.dueAt, ...(t.every ? { every: t.every } : {}), note: t.note.slice(0, 2000), createdAt: Date.now() }
      const list = this.d.repo.getSessionExtras(root).wakeups ?? []
      this.d.repo.setSessionExtras(root, { wakeups: [...list, w].slice(-50) })
      this.startTicker()
      this.changed(root)
      return w
    },
    list: (root: string): Wakeup[] => [...(this.d.repo.getSessionExtras(root).wakeups ?? [])].sort((a, b) => a.dueAt - b.dueAt),
    cancel: (root: string, id: string): boolean => {
      const list = this.d.repo.getSessionExtras(root).wakeups ?? []
      if (!list.some((w) => w.id === id)) return false
      this.d.repo.setSessionExtras(root, { wakeups: list.filter((w) => w.id !== id) })
      this.changed(root)
      return true
    }
  }

  // ------------------------------------------------------------ other sessions

  sessions = {
    list: (root: string): SessionBrief[] => {
      const me = this.d.repo.getSession(root)
      if (!me) return []
      return this.d.repo
        .listSessions(me.workspace)
        .filter((s) => s.id !== root)
        .slice(0, 40)
        .map((s) => {
          const items = this.d.repo.listItems(s.id)
          let lastWords = ''
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]!
            if (it.kind === 'assistant' && it.text.trim()) {
              lastWords = it.text.trim()
              break
            }
          }
          return { id: s.id, title: s.title, status: this.d.status(s.id), updatedAt: s.updatedAt, lastWords: lastWords.slice(0, 400) }
        })
    },
    message: async (from: string, to: string, text: string, wantReply: boolean): Promise<string> => {
      const a = this.d.repo.getSession(from)
      const b = this.d.repo.getSession(to)
      if (!a || !b) throw new Error('That session no longer exists.')
      if (a.workspace !== b.workspace) throw new Error('That session belongs to another project.')
      if (wantReply) this.replyTo.set(to, [...new Set([...(this.replyTo.get(to) ?? []), from])])
      this.notify(
        { sessionId: to, rootSessionId: to },
        `Message from another session, "${a.title}" (${from.slice(0, 8)}):\n\n${text}${wantReply ? '\n\n(Your answer at the end of this turn is passed back to it.)' : ''}`,
        { source: 'session', from },
        true
      )
      return `Delivered to "${b.title}". ${wantReply ? 'Its answer will come back to you as a notice when it finishes.' : ''}`.trim()
    }
  }

  // ------------------------------------------------------------ helpers' own copies

  copies = {
    make: async (root: string, name: string): Promise<{ path: string; branch: string; base: string }> => {
      const s = this.d.repo.getSession(root)
      const project = s?.workspace ?? this.d.projectRoot()
      if (!project) throw new Error('No project is open.')
      if (isRemote(project)) throw new Error('A helper with its own copy is not available yet for a folder in WSL or on another computer.')
      const tag = `${name}-${randomUUID().slice(0, 6)}`
      const wt = await createWorktree(project, join(this.d.userData, 'worktrees', `${basename(project)}-helper-${tag}`), `prism/helper-${tag}`)
      // start from the project as it is now, not only as it was last committed
      const patch = join(tmpdir(), `prism-start-${tag}.patch`)
      const diff = await git(project, ['diff', 'HEAD', '--binary', `--output=${patch}`])
      if (diff.ok) await git(wt.path, ['apply', '--whitespace=nowarn', patch], 120_000)
      await rm(patch, { force: true })
      const untracked = await git(project, ['ls-files', '--others', '--exclude-standard', '-z'])
      for (const f of untracked.stdout.split('\0').filter(Boolean).slice(0, 5000)) {
        try {
          await mkdir(dirname(join(wt.path, f)), { recursive: true })
          await copyFile(join(project, f), join(wt.path, f))
        } catch {
          /* vanished or unreadable */
        }
      }
      await git(wt.path, ['add', '-A'])
      await git(wt.path, ['-c', 'user.name=Prism', '-c', 'user.email=prism@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'Prism: where the helper started'], 120_000)
      const head = await git(wt.path, ['rev-parse', 'HEAD'])
      return { path: wt.path, branch: wt.branch, base: head.ok ? head.stdout.trim() : wt.base }
    },
    changes: async (copy: { path: string; base: string }): Promise<string[]> => {
      await git(copy.path, ['add', '-A'])
      const r = await git(copy.path, ['diff', '--cached', '--name-only', copy.base])
      return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    },
    apply: async (root: string, copy: { path: string; base: string }): Promise<{ ok: boolean; files: string[]; output: string }> => {
      const project = this.d.repo.getSession(root)?.workspace ?? this.d.projectRoot()
      if (!project) return { ok: false, files: [], output: 'No project is open.' }
      const files = await this.copies.changes(copy)
      if (!files.length) return { ok: true, files: [], output: '' }
      const patch = join(tmpdir(), `prism-merge-${randomUUID().slice(0, 8)}.patch`)
      try {
        const d = await git(copy.path, ['diff', '--cached', '--binary', copy.base, `--output=${patch}`])
        if (!d.ok) return { ok: false, files: [], output: d.stderr }
        const plain = await git(project, ['apply', '--whitespace=nowarn', patch], 120_000)
        if (plain.ok) return { ok: true, files, output: '' }
        // the project changed since: let git merge line by line, then leave the user's staging area as it was
        const three = await git(project, ['apply', '--3way', '--whitespace=nowarn', patch], 120_000)
        await git(project, ['reset', '-q', '--', ...files])
        return { ok: three.ok, files, output: (three.stdout + '\n' + three.stderr).trim() || plain.stderr }
      } finally {
        await rm(patch, { force: true })
      }
    },
    discard: async (root: string, copy: { path: string; branch: string }): Promise<void> => {
      const project = this.d.repo.getSession(root)?.workspace ?? this.d.projectRoot()
      if (!project) return
      await removeWorktree(project, { path: copy.path, branch: copy.branch, base: '' } as SessionWorktree)
      const ex = this.d.repo.getSessionExtras(root)
      this.d.repo.setSessionExtras(root, { helpers: (ex.helpers ?? []).map((h) => (h.copy?.path === copy.path ? { ...h, copy: null } : h)) })
      this.changed(root)
    }
  }
}
