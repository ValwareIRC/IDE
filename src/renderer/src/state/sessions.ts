import { finishedNotice } from '@/lib/finished'
import { create } from 'zustand'
import type { AgentEvent, ApprovalRequest, Attachment, BackgroundState, Checkpoint, FileDiff, SessionWorktree, PlanDecision, PlanRequest, ModelRef, PermissionMode, QuestionRequest, ReviewDecision, ReviewRequest, Session, SlashCommand, TodoItem, ToolCall, TranscriptItem, Usage } from '@shared/types'
import { prism } from '@/lib/ipc'
import { con } from '@/lib/agentConsole'
import { changedRanges, flashLines } from '@/lib/editorBus'
import { previewKindFor } from '@/lib/languages'
import { useEditor } from './editor'
import { useLayout } from './layout'
import { toastError, useUi } from './ui'
import { useApp } from './app'

export interface SubagentLive {
  name: string
  task: string
  model: ModelRef
  status: 'running' | 'done' | 'failed'
  text: string
  reasoning: string
  tools: Array<{ call: ToolCall; done: boolean; isError?: boolean }>
  summary?: string
  durationMs?: number
}

/** A message typed while the agent was working, waiting its turn. Pictures ride along with it. */
export interface Queued {
  text: string
  attachments: Attachment[]
}

export interface ChangedFile {
  path: string
  additions: number
  deletions: number
  created: boolean
  deleted: boolean
  /** Checkpoint that holds this file's pre-change content. */
  checkpointId: string | null
}

export interface LiveRun {
  running: boolean
  step: number
  model: ModelRef | null
  text: string
  reasoning: string
  status: string | null
  pendingTools: Array<{ call: ToolCall; agent?: string; startedAt: number; output: string }>
  approvals: ApprovalRequest[]
  questions: QuestionRequest[]
  /** Change sets the agent proposed and is waiting on. */
  reviews: ReviewRequest[]
  /** Plans presented in plan mode, waiting for approval. */
  plans: PlanRequest[]
  todos: TodoItem[]
  usage: { input: number; output: number; cost: number }
  contextTokens: number
  contextWindow: number | null
  /** Output tokens per second over the latest model call. */
  tps: number | null
  subagents: Record<string, SubagentLive>
  changed: Record<string, ChangedFile>
  checkpointId: string | null
  startedAt: number | null
  endedAt: number | null
  lastReason: string | null
  lastError: string | null
  /** What the session waits on in the background: jobs, timers, helpers. */
  background: BackgroundState | null
}

export function emptyLive(): LiveRun {
  return {
    running: false,
    step: 0,
    model: null,
    text: '',
    reasoning: '',
    status: null,
    pendingTools: [],
    approvals: [],
    questions: [],
    reviews: [],
    plans: [],
    todos: [],
    usage: { input: 0, output: 0, cost: 0 },
    contextTokens: 0,
    contextWindow: null,
    tps: null,
    subagents: {},
    changed: {},
    checkpointId: null,
    startedAt: null,
    endedAt: null,
    lastReason: null,
    lastError: null,
    background: null
  }
}

interface SessionsState {
  sessions: Session[]
  active: string | null
  items: Record<string, TranscriptItem[]>
  live: Record<string, LiveRun>
  checkpoints: Record<string, Checkpoint[]>
  commands: SlashCommand[]
  showQueue: Array<{ path: string; note: string }>
  draft: Record<string, string>
  /** Picked in the message box before any session exists; given to the session the first message makes. undefined = not picked, model null = Auto. */
  pending: { model?: ModelRef | null; mode?: PermissionMode }
  /** Messages typed while the agent was busy; sent one by one when it finishes. */
  queue: Record<string, Queued[]>

  /** fresh: after a gap in the connection, the open conversation is fetched again too. */
  refresh(fresh?: boolean): Promise<void>
  select(id: string | null): Promise<void>
  create(): Promise<Session | null>
  /** Sessions that work in their own copy of the project (a branch in a separate folder), by session id. */
  copies: Record<string, SessionWorktree>
  /** A new session working in its own copy. Needs a git repository with at least one commit. */
  createInCopy(): Promise<Session | null>
  /** Refresh what is known about a session's copy. */
  loadCopy(id: string): Promise<void>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  /** Load a session's transcript and subscribe to its events without making it active. */
  ensure(id: string): Promise<void>
  /** Follow a session's live events without loading its transcript (mission control). */
  watch(id: string): void
  send(text: string, opts?: { model?: ModelRef; mode?: PermissionMode; attachments?: Attachment[] }, sessionId?: string): Promise<void>
  enqueue(text: string, sessionId?: string, attachments?: Attachment[]): void
  dequeue(index: number, sessionId?: string): void
  /** Change a queued message, or move it earlier (-1) or later (1). */
  editQueue(index: number, text: string, sessionId?: string): void
  moveQueue(index: number, delta: -1 | 1, sessionId?: string): void
  abort(sessionId?: string): Promise<void>
  approve(approvalId: string, decision: 'once' | 'always' | 'deny', sessionId?: string): Promise<void>
  answer(questionId: string, answer: string, sessionId?: string): Promise<void>
  review(reviewId: string, decision: ReviewDecision, sessionId?: string): Promise<void>
  plan(planId: string, decision: PlanDecision, sessionId?: string): Promise<void>
  setMode(mode: PermissionMode, sessionId?: string): Promise<void>
  /** null = Auto: the routing rules choose a model for each message. */
  setModel(model: ModelRef | null, sessionId?: string): Promise<void>
  compact(sessionId?: string): Promise<void>
  loadCheckpoints(id: string): Promise<void>
  restore(checkpointId: string): Promise<void>
  restoreFile(checkpointId: string, path: string): Promise<void>
  rewind(itemId: string, sessionId?: string): Promise<void>
  loadCommands(): Promise<void>
  takeShow(): { path: string; note: string } | null
  setDraft(id: string, text: string): void
  /** Sessions the phone has only the latest part of. */
  partial: Record<string, boolean>
  /** Conversations being fetched right now, so the panel can say so instead of looking empty. */
  loading: Record<string, boolean>
  /** Fetch the rest of a conversation the phone only has the tail of. */
  loadAll(id: string): Promise<void>
  /** Things handed to a session's message box from elsewhere (the browser, the editor): text to add and pictures to attach. */
  inbox: Record<string, { text: string; attachments: Attachment[] }>
  hand(id: string, text: string, attachments?: Attachment[]): void
  takeInbox(id: string): void
}

/** How much of a conversation the phone pulls over the network to begin with. */
const PHONE_TAIL = 120


/**
 * What the session is in the middle of right now. The cards for a question or an
 * approval are built from events as they arrive, so a window — or a phone picked
 * up on a walk — that was not connected when the agent asked would see a session
 * that is busy, with nothing to answer and no way to get on with it.
 */
async function seedPending(id: string): Promise<void> {
  try {
    const p = await prism.agent.pending(id)
    useSessions.setState((s) => {
      const live = s.live[id] ?? emptyLive()
      // finished while this screen was not hearing about it: what it last showed in progress is over
      const over = !p.running && live.running ? { status: null, text: '', reasoning: '', pendingTools: [], endedAt: live.endedAt ?? Date.now() } : {}
      return { live: { ...s.live, [id]: { ...live, ...over, running: p.running, approvals: p.approvals, questions: p.questions, reviews: p.reviews, plans: p.plans } } }
    })
  } catch {
    /* an older computer without this answer: the cards appear when it next asks */
  }
}

const subs = new Map<string, () => void>()

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  active: null,
  items: {},
  live: {},
  checkpoints: {},
  commands: [],
  showQueue: [],
  draft: {},
  pending: {},
  queue: {},

  async refresh(fresh) {
    const sessions = await prism.sessions.list()
    set((s) => ({ sessions, active: s.active && sessions.some((x) => x.id === s.active) ? s.active : (sessions[0]?.id ?? null) }))
    const a = get().active
    // after a gap in the connection, what the open conversation shows is stale: it is fetched again
    if (a && (!get().items[a] || fresh)) await get().select(a)
  },

  copies: {},

  async createInCopy() {
    try {
      const session = await prism.sessions.createInCopy()
      set((s) => ({ sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)], items: { ...s.items, [session.id]: [] }, live: { ...s.live, [session.id]: emptyLive() } }))
      await get().select(session.id)
      return session
    } catch (e) {
      toastError(e, 'Could not make a copy for the session')
      return null
    }
  },

  async loadCopy(id) {
    try {
      const wt = (await prism.sessions.extras(id)).worktree ?? null
      set((s) => {
        const copies = { ...s.copies }
        if (wt) copies[id] = wt
        else delete copies[id]
        return { copies }
      })
    } catch {
      /* the session is gone */
    }
  },

  async select(id) {
    set({ active: id })
    if (!id) return
    void get().loadCopy(id)
    void prism.agent
      .background(id)
      .then((state) => set((s) => ({ live: { ...s.live, [id]: { ...(s.live[id] ?? emptyLive()), background: state } } })))
      .catch(() => {})
    set((s) => ({ loading: { ...s.loading, [id]: true } }))
    try {
      // same as `ensure`: the phone takes the latest part, not the whole transcript
      const tail = window.__prismMobile ? PHONE_TAIL : undefined
      const items = await prism.sessions.items(id, tail)
      set((s) => ({ items: { ...s.items, [id]: items }, partial: { ...s.partial, [id]: !!tail && items.length >= tail }, live: { ...s.live, [id]: s.live[id] ?? emptyLive() } }))
      subscribe(id)
      void seedPending(id)
    } catch (e) {
      toastError(e)
    } finally {
      set((s) => ({ loading: { ...s.loading, [id]: false } }))
    }
  },

  watch(id) {
    if (subs.has(id)) return
    subscribe(id)
    // a session in its own copy: its edits are not in the project folder, so follow mode must not open them
    void get().loadCopy(id)
    set((s) => (s.live[id] ? s : { live: { ...s.live, [id]: emptyLive() } }))
    void prism.agent
      .background(id)
      .then((state) => set((s) => ({ live: { ...s.live, [id]: { ...(s.live[id] ?? emptyLive()), background: state } } })))
      .catch(() => {})
  },

  async ensure(id) {
    if (get().items[id]) {
      subscribe(id)
      return
    }
    set((s) => ({ loading: { ...s.loading, [id]: true } }))
    try {
      // The phone fetches the latest few over the network rather than years of
      // transcript; the rest is fetched only if something needs it.
      const tail = window.__prismMobile ? PHONE_TAIL : undefined
      const items = await prism.sessions.items(id, tail)
      set((s) => ({ items: { ...s.items, [id]: items }, partial: { ...s.partial, [id]: !!tail && items.length >= tail }, live: { ...s.live, [id]: s.live[id] ?? emptyLive() } }))
      subscribe(id)
      void seedPending(id)
    } catch (e) {
      toastError(e)
    } finally {
      set((s) => ({ loading: { ...s.loading, [id]: false } }))
    }
  },

  async create() {
    try {
      let session = await prism.sessions.create()
      // what was picked while there was no session belongs to this one
      const { model, mode } = get().pending
      if (model !== undefined) {
        await prism.agent.setModel(session.id, model)
        session = { ...session, model }
      }
      if (mode !== undefined) {
        await prism.agent.setMode(session.id, mode)
        session = { ...session, mode }
      }
      const made = session
      set((s) => ({ sessions: [made, ...s.sessions.filter((x) => x.id !== made.id)], items: { ...s.items, [made.id]: [] }, live: { ...s.live, [made.id]: emptyLive() }, pending: {} }))
      await get().select(made.id)
      return made
    } catch (e) {
      toastError(e, 'Could not create a session')
      return null
    }
  },

  async remove(id) {
    await prism.sessions.delete(id)
    subs.get(id)?.()
    subs.delete(id)
    set((s) => {
      const items = { ...s.items }
      const live = { ...s.live }
      delete items[id]
      delete live[id]
      const sessions = s.sessions.filter((x) => x.id !== id)
      return { sessions, items, live, active: s.active === id ? (sessions[0]?.id ?? null) : s.active }
    })
    const a = get().active
    if (a && !get().items[a]) await get().select(a)
  },

  async rename(id, title) {
    await prism.sessions.rename(id, title)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }))
  },

  async send(text, opts, sessionId) {
    let id = sessionId ?? get().active
    if (!id) {
      const s = await get().create()
      if (!s) return
      id = s.id
    }
    const live = get().live[id] ?? emptyLive()
    set((s) => ({
      live: {
        ...s.live,
        [id]: { ...live, running: true, text: '', reasoning: '', status: 'Thinking…', startedAt: Date.now(), endedAt: null, lastReason: null, lastError: null, pendingTools: [], subagents: {}, changed: {}, checkpointId: null, tps: null }
      },
      draft: { ...s.draft, [id]: '' }
    }))
    useEditor.getState().clearTouched()
    try {
      await prism.agent.send(id, text, opts)
    } catch (e) {
      set((s) => ({ live: { ...s.live, [id]: { ...(s.live[id] ?? emptyLive()), running: false, status: null } } }))
      toastError(e, 'Could not send')
    }
  },

  enqueue(text, sessionId, attachments) {
    const id = sessionId ?? get().active
    if (!id || !text.trim()) return
    set((s) => ({ queue: { ...s.queue, [id]: [...(s.queue[id] ?? []), { text: text.trim(), attachments: attachments ?? [] }] } }))
  },

  dequeue(index, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    set((s) => ({ queue: { ...s.queue, [id]: (s.queue[id] ?? []).filter((_, i) => i !== index) } }))
  },

  editQueue(index, text, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    if (!text.trim()) return get().dequeue(index, id)
    set((s) => ({ queue: { ...s.queue, [id]: (s.queue[id] ?? []).map((q, i) => (i === index ? { ...q, text: text.trim() } : q)) } }))
  },

  moveQueue(index, delta, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    set((s) => {
      const q = [...(s.queue[id] ?? [])]
      const to = index + delta
      if (to < 0 || to >= q.length) return s
      ;[q[index], q[to]] = [q[to]!, q[index]!]
      return { queue: { ...s.queue, [id]: q } }
    })
  },

  async abort(sessionId) {
    const id = sessionId ?? get().active
    if (id) await prism.agent.abort(id)
  },

  async approve(approvalId, decision, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    await prism.agent.approve(id, approvalId, decision)
  },

  async answer(questionId, answer, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    await prism.agent.answer(id, questionId, answer)
  },

  async plan(planId, decision, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    await prism.agent.plan(id, planId, decision).catch(toastError)
    // an approved plan continues in the mode chosen for it
    if (decision.action === 'approve' && decision.mode) set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, mode: decision.mode! } : x)) }))
  },

  async review(reviewId, decision, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    await prism.agent.review(id, reviewId, decision).catch(toastError)
  },

  async setMode(mode, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return set((s) => ({ pending: { ...s.pending, mode } }))
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, mode } : x)) }))
    await prism.agent.setMode(id, mode).catch((e) => toastError(e, 'Could not change the permission mode'))
  },

  async setModel(model, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return set((s) => ({ pending: { ...s.pending, model } }))
    // shown at once; saved so the next refresh of the session list does not put the old one back
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, model } : x)) }))
    await prism.agent.setModel(id, model).catch((e) => toastError(e, 'Could not change the model'))
  },

  async compact(sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    try {
      await prism.agent.compact(id)
      useUi.getState().toast('success', 'Context compacted')
    } catch (e) {
      toastError(e, 'Compaction failed')
    }
  },

  async loadCheckpoints(id) {
    const cps = await prism.agent.checkpoints(id)
    set((s) => ({ checkpoints: { ...s.checkpoints, [id]: cps } }))
  },

  async restore(checkpointId) {
    try {
      const files = await prism.agent.restore(checkpointId)
      useUi.getState().toast('success', `Restored ${files.length} file${files.length === 1 ? '' : 's'}`)
      for (const f of files) void useEditor.getState().reload(f)
    } catch (e) {
      toastError(e, 'Restore failed')
    }
  },

  async restoreFile(checkpointId, path) {
    try {
      const ok = await prism.agent.restoreFile(checkpointId, path)
      if (ok) {
        useUi.getState().toast('success', `Reverted ${path}`)
        void useEditor.getState().reload(path)
      } else useUi.getState().toast('error', 'Nothing to revert for that file')
    } catch (e) {
      toastError(e, 'Revert failed')
    }
  },

  async rewind(itemId, sessionId) {
    const id = sessionId ?? get().active
    if (!id) return
    try {
      const r = await prism.agent.rewind(id, itemId)
      const items = await prism.sessions.items(id)
      set((s) => ({
        items: { ...s.items, [id]: items },
        draft: { ...s.draft, [id]: r.text },
        live: { ...s.live, [id]: { ...emptyLive() } }
      }))
      for (const f of r.files) void useEditor.getState().reload(f)
      await get().loadCheckpoints(id)
      useUi.getState().toast('success', 'Rewound', r.files.length ? `${r.files.length} file${r.files.length === 1 ? '' : 's'} restored. Your message is back in the composer.` : 'Your message is back in the composer.')
    } catch (e) {
      toastError(e, 'Rewind failed')
    }
  },

  async loadCommands() {
    try {
      set({ commands: await prism.agent.slashCommands() })
    } catch {
      /* no workspace yet */
    }
  },

  takeShow() {
    const q = get().showQueue
    if (!q.length) return null
    set({ showQueue: q.slice(1) })
    return q[0]!
  },

  partial: {},
  loading: {},
  async loadAll(id) {
    if (!get().partial[id]) return
    set((s) => ({ loading: { ...s.loading, [id]: true } }))
    try {
      const items = await prism.sessions.items(id)
      set((s) => ({ items: { ...s.items, [id]: items }, partial: { ...s.partial, [id]: false } }))
    } catch (e) {
      toastError(e)
    } finally {
      set((s) => ({ loading: { ...s.loading, [id]: false } }))
    }
  },
  setDraft: (id, text) => set((s) => ({ draft: { ...s.draft, [id]: text } })),
  inbox: {},
  hand: (id, text, attachments = []) =>
    set((s) => {
      const cur = s.inbox[id] ?? { text: '', attachments: [] }
      return { inbox: { ...s.inbox, [id]: { text: cur.text + text, attachments: [...cur.attachments, ...attachments] } } }
    }),
  takeInbox: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.inbox
      return { inbox: rest }
    })
}))

function subscribe(id: string): void {
  if (subs.has(id)) return
  const off = prism.agent.onEvent(id, (ev) => applyEvent(id, ev))
  subs.set(id, off)
}

function applyEvent(id: string, ev: AgentEvent): void {
  const st = useSessions.getState()
  const cur = st.live[id] ?? emptyLive()
  const patch = (p: Partial<LiveRun>): void => useSessions.setState((s) => ({ live: { ...s.live, [id]: { ...(s.live[id] ?? emptyLive()), ...p } } }))
  const agent = 'agent' in ev ? ev.agent : undefined
  const isActive = st.active === id

  switch (ev.type) {
    case 'run-start': {
      const session = st.sessions.find((x) => x.id === id)
      // helpers still working in the background stay on show
      const still = Object.fromEntries(Object.entries(cur.subagents).filter(([, s]) => s.status === 'running'))
      patch({ running: true, model: ev.model, startedAt: Date.now(), endedAt: null, lastReason: null, lastError: null, text: '', reasoning: '', subagents: still, changed: {}, checkpointId: null, tps: null })
      con.banner(session?.title ?? 'session', ev.model.modelId)
      break
    }
    case 'step-start':
      if (agent) updateSub(id, agent, (sa) => ({ ...sa, text: '', reasoning: '' }))
      else patch({ step: ev.step, text: '', reasoning: '', status: 'Thinking…' })
      break
    case 'text-delta':
      if (agent) updateSub(id, agent, (sa) => ({ ...sa, text: sa.text + ev.text }))
      else patch({ text: cur.text + ev.text, status: null })
      break
    case 'reasoning-delta':
      if (agent) updateSub(id, agent, (sa) => ({ ...sa, reasoning: sa.reasoning + ev.text }))
      else patch({ reasoning: cur.reasoning + ev.text, status: cur.text ? null : 'Thinking…' })
      break
    case 'tool-start':
      if (agent) updateSub(id, agent, (sa) => ({ ...sa, tools: [...sa.tools, { call: ev.call, done: false }] }))
      patch({ pendingTools: [...cur.pendingTools, { call: ev.call, agent, startedAt: Date.now(), output: '' }] })
      if (ev.call.name === 'shell' && isActive) con.command(String(ev.call.args['command'] ?? ''), agent)
      break
    case 'tool-output':
      patch({ pendingTools: cur.pendingTools.map((t) => (t.call.id === ev.callId ? { ...t, output: (t.output + ev.chunk).slice(-20_000) } : t)) })
      if (isActive && cur.pendingTools.some((t) => t.call.id === ev.callId && t.call.name === 'shell')) con.output(ev.chunk)
      break
    case 'item': {
      const item = ev.item
      if (item.kind === 'tool') {
        patch({ pendingTools: cur.pendingTools.filter((t) => t.call.id !== item.callId) })
        if (item.agent) updateSub(id, item.agent, (sa) => ({ ...sa, tools: sa.tools.map((t) => (t.call.id === item.callId ? { ...t, done: true, isError: item.isError } : t)) }))
        if (item.name === 'shell' && isActive) {
          const code = item.meta && typeof item.meta['exitCode'] === 'number' ? (item.meta['exitCode'] as number) : item.isError ? 1 : 0
          if (!(item.meta && item.meta['background'])) con.exit(code, item.durationMs)
          else con.note(item.content.split('\n')[0] ?? '')
        }
        const show = item.meta?.['show']
        if (typeof show === 'string') useSessions.setState((s) => ({ showQueue: [...s.showQueue, { path: show, note: String(item.meta?.['note'] ?? '') }] }))
        const openGadget = item.meta?.['openGadget']
        if (typeof openGadget === 'string') setTimeout(() => useLayout.getState().openGadget(openGadget), 50)
        // what the agent's own check found also fills the Problems panel
        const checked = item.name === 'check_project' ? item.meta?.['results'] : undefined
        if (Array.isArray(checked)) void import('./problems').then((m) => m.useProblems.getState().ingest(checked as Parameters<ReturnType<typeof m.useProblems.getState>['ingest']>[0]))
        if (item.diff) onAgentEdit(id, item.diff.path, item.diff.before, item.diff.after, item.diff.additions, item.diff.deletions)
        // an accepted proposal writes several files in one tool call; the first is item.diff
        const more = item.meta?.['diffs']
        if (Array.isArray(more)) for (const d of (more as FileDiff[]).slice(1)) onAgentEdit(id, d.path, d.before, d.after, d.additions, d.deletions)
        if (item.name === 'delete_path' && !item.isError && typeof item.args['path'] === 'string') {
          const p = item.args['path'] as string
          useSessions.setState((s) => {
            const l = s.live[id] ?? emptyLive()
            return { live: { ...s.live, [id]: { ...l, changed: { ...l.changed, [p]: { path: p, additions: 0, deletions: 0, created: false, deleted: true, checkpointId: l.checkpointId } } } } }
          })
        }
      }
      if (item.kind === 'assistant' && !item.agent) patch({ text: '', reasoning: '' })
      if (item.kind === 'assistant' && item.agent) updateSub(id, item.agent, (sa) => ({ ...sa, text: '', reasoning: '' }))
      if (!('agent' in item) || !item.agent) {
        useSessions.setState((s) => ({ items: { ...s.items, [id]: [...(s.items[id] ?? []), item] } }))
      }
      break
    }
    case 'approval':
      patch({ approvals: [...cur.approvals, ev.request], status: 'Waiting for your approval' })
      if (away()) notify('Prism needs your approval', ev.request.summary)
      break
    case 'approval-resolved':
      patch({ approvals: cur.approvals.filter((a) => a.approvalId !== ev.approvalId), status: null })
      break
    case 'question':
      patch({ questions: [...cur.questions, ev.request], status: 'Waiting for your answer' })
      if (away()) notify('Prism has a question', ev.request.question)
      break
    case 'plan':
      patch({ plans: [...cur.plans, ev.request], status: 'Waiting for you to read the plan' })
      useLayout.getState().openPlan(id, ev.request.planId, ev.request.title)
      if (away()) notify('Prism has a plan for you', ev.request.title)
      break
    case 'plan-resolved':
      patch({ plans: cur.plans.filter((p) => p.planId !== ev.planId), status: null })
      setTimeout(() => useLayout.getState().closePanel(`plan:${ev.planId}`), 1200)
      break
    case 'review':
      patch({ reviews: [...cur.reviews, ev.request], status: 'Waiting for your review' })
      useLayout.getState().openReview(id, ev.request.reviewId, ev.request.title)
      if (away()) notify('Prism proposes a change', ev.request.title)
      break
    case 'review-resolved':
      patch({ reviews: cur.reviews.filter((r) => r.reviewId !== ev.reviewId), status: null })
      setTimeout(() => useLayout.getState().closePanel(`review:${ev.reviewId}`), 900)
      break
    case 'question-resolved':
      patch({ questions: cur.questions.filter((q) => q.questionId !== ev.questionId), status: null })
      break
    case 'todos':
      patch({ todos: ev.todos })
      break
    case 'status':
      if (!agent) patch({ status: ev.text })
      break
    case 'usage': {
      const u: Usage = ev.usage
      const tps = u.latencyMs && u.latencyMs > 0 && u.outputTokens > 0 ? Math.round(u.outputTokens / (u.latencyMs / 1000)) : cur.tps
      patch({
        usage: { input: cur.usage.input + u.inputTokens, output: cur.usage.output + u.outputTokens, cost: cur.usage.cost + (u.cost ?? 0) },
        contextTokens: ev.contextTokens,
        contextWindow: ev.contextWindow,
        tps
      })
      useSessions.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, inputTokens: x.inputTokens + u.inputTokens, outputTokens: x.outputTokens + u.outputTokens, cost: x.cost + (u.cost ?? 0) } : x
        )
      }))
      break
    }
    case 'background':
      patch({ background: ev.state })
      break
    case 'stuck':
      if (ev.action !== 'nudged') useUi.getState().toast(ev.action === 'stopped' ? 'error' : 'info', ev.action === 'stopped' ? 'Stopped: it was going round in circles' : `${ev.model ?? 'A stronger model'} took over`, ev.reason)
      break
    case 'subagent-start':
      patch({ subagents: { ...cur.subagents, [ev.agent]: { name: ev.agent, task: ev.task, model: ev.model, status: 'running', text: '', reasoning: '', tools: [] } } })
      break
    case 'subagent-end':
      updateSub(id, ev.agent, (sa) => ({ ...sa, status: ev.ok ? 'done' : 'failed', summary: ev.summary, durationMs: ev.durationMs }))
      break
    case 'compaction':
      void prism.sessions.items(id).then((items) => useSessions.setState((s) => ({ items: { ...s.items, [id]: items } })))
      if (ev.beforeTokens) useUi.getState().toast('info', 'Context compacted', `${Math.round(ev.beforeTokens / 1000)}k → ${Math.round(ev.afterTokens / 1000)}k tokens`)
      break
    case 'checkpoint':
      patch({ checkpointId: ev.id })
      void st.loadCheckpoints(id)
      break
    case 'file-touched':
      useEditor.getState().touch(ev.path, ev.op)
      break
    case 'run-end': {
      // a background helper's question to the user outlives the lead's turn
      patch({ running: false, status: null, endedAt: Date.now(), lastReason: ev.reason, lastError: ev.error ?? null, pendingTools: [], approvals: cur.approvals.filter((a) => !!a.agent), questions: [], reviews: [], plans: [] })
      if (isActive) con.end(ev.reason, ev.durationMs)
      if (ev.reason === 'error' && ev.error) useUi.getState().toast('error', 'Agent stopped', ev.error)
      if (away()) {
        const session = st.sessions.find((x) => x.id === id)
        if (ev.reason === 'completed') {
          // what it said, or the question it ended on, rather than only that it finished
          const last = [...(st.items[id] ?? [])].reverse().find((i) => i.kind === 'assistant' && !i.agent && i.text.trim())
          const n = finishedNotice(session?.title ?? '', last && last.kind === 'assistant' ? last.text : null)
          // the last picture it made rides along on the computer's notification
          const pic = [...(st.items[id] ?? [])].reverse().find((i) => i.kind === 'tool' && !i.agent && Array.isArray(i.meta?.['images']) && (i.meta!['images'] as string[]).length)
          if (pic && pic.kind === 'tool') {
            const names = pic.meta!['images'] as string[]
            const name = names[names.length - 1]
            if (name) void pictureFor(name).then((icon) => notify(n.title, n.body, icon))
            else notify(n.title, n.body)
          } else notify(n.title, n.body)
        } else notify(`Prism stopped (${ev.reason})`, session?.title ?? '')
      }
      // Everything that was waiting goes as one message: they were written to the
      // same agent about the same work, and sending them one turn at a time would
      // have it answer the first before it had read the rest.
      const q = useSessions.getState().queue[id] ?? []
      if (q.length && ev.reason !== 'aborted') {
        useSessions.setState((s) => ({ queue: { ...s.queue, [id]: [] } }))
        const text = q.map((m) => m.text).join('\n\n')
        const attachments = q.flatMap((m) => m.attachments).slice(0, 8)
        setTimeout(() => void useSessions.getState().send(text, { attachments }, id), 300)
      }
      break
    }
  }
}

function onAgentEdit(id: string, path: string, before: string | null, after: string | null, additions: number, deletions: number): void {
  useSessions.setState((s) => {
    const l = s.live[id] ?? emptyLive()
    const prev = l.changed[path]
    return {
      live: {
        ...s.live,
        [id]: {
          ...l,
          changed: {
            ...l.changed,
            [path]: {
              path,
              additions: (prev?.additions ?? 0) + additions,
              deletions: (prev?.deletions ?? 0) + deletions,
              created: prev?.created ?? before === null,
              deleted: after === null,
              checkpointId: prev?.checkpointId ?? l.checkpointId
            }
          }
        }
      }
    }
  })
  if (useSessions.getState().copies[id]) return
  const ui = useUi.getState()
  const kind = previewKindFor(path)
  if (before === null && (kind === 'image' || kind === 'model3d' || kind === 'html')) {
    useLayout.getState().openPreview(path, undefined, { quiet: true })
    return
  }
  const ranges = changedRanges(before, after)
  void useEditor
    .getState()
    .reload(path)
    .then(() => {
      if (ui.follow && after !== null) useLayout.getState().openEditor(path, { line: ranges[0]?.start ?? 1, quiet: true })
      flashLines(path, ranges)
    })
}

/** Whether the person has looked away: another window on the computer, another app on the phone. */
function away(): boolean {
  return window.__prismMobile ? document.visibilityState === 'hidden' : !document.hasFocus()
}

// Android 13 and later only show notifications once asked, and asking needs the app on
// screen — so it is asked as the app starts, not at the moment a run finishes, when the
// app is by definition somewhere else.
if (window.__prismMobile) void import('@capacitor/local-notifications').then((m) => m.LocalNotifications.requestPermissions()).catch(() => {})

let notified = 0

/** The pictures already shrunk for a notification, so the same one is not re-drawn every time. */
const pictureCache = new Map<string, Promise<string>>()

/** A picture the agent made, shrunk to what a notification can show as its icon. Empty string: it could not be read. */
function pictureFor(name: string): Promise<string> {
  let p = pictureCache.get(name)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, 512 / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * scale))
        c.height = Math.max(1, Math.round(img.height * scale))
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = () => resolve('')
      img.src = `prism://attach/${name}`
    })
    p.catch(() => {})
    pictureCache.set(name, p)
  }
  return p
}

function notify(title: string, body: string, icon?: string): void {
  if (useApp.getState().settings?.assist?.notifications === false) return
  // The phone's web view has no Notification at all. This used to try it anyway, fail
  // inside the try, and say nothing — so on the phone no notification ever arrived.
  if (window.__prismMobile) {
    // the background watcher says it instead, app open or not; both saying it is twice
    if ((window as unknown as { __prismWatching?: boolean }).__prismWatching) return
    void import('@capacitor/local-notifications')
      .then((m) => m.LocalNotifications.schedule({ notifications: [{ id: (Date.now() % 2_000_000_000) + (notified++ % 1000), title, body: body.slice(0, 300) }] }))
      .catch(() => {})
    return
  }
  // with a sound: a notification that arrives in silence while you are in another
  // window is one you find an hour later
  try {
    if (Notification.permission === 'granted' || Notification.permission === 'default')
      new Notification(title, { body: body.slice(0, 300), silent: false, ...(icon ? { icon } : {}) })
  } catch {
    /* notifications unavailable */
  }
}

function updateSub(id: string, agent: string, fn: (sa: SubagentLive) => SubagentLive): void {
  useSessions.setState((s) => {
    const live = s.live[id] ?? emptyLive()
    const sa = live.subagents[agent] ?? { name: agent, task: '', model: { endpointId: '', modelId: '' }, status: 'running' as const, text: '', reasoning: '', tools: [] }
    return { live: { ...s.live, [id]: { ...live, subagents: { ...live.subagents, [agent]: fn(sa) } } } }
  })
}

// news for a session: a desktop notification when Prism is in the background, a toast when another session is in front
prism.agent.onNotice((n) => {
  if (away()) notify(`Prism: ${n.title}`, n.body)
  else if (useSessions.getState().active !== n.sessionId) useUi.getState().toast('info', `News in "${n.title}"`, n.body)
})

// a pick made before the first session belongs to the project it was made in
prism.workspace.onChanged(() => useSessions.setState({ pending: {} }))

prism.sessions.onChanged((sessions) => {
  useSessions.setState((s) => {
    const active = s.active && sessions.some((x) => x.id === s.active) ? s.active : (sessions[0]?.id ?? null)
    return { sessions, active }
  })
})
