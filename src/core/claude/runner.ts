// A "Claude Agent" session.
//
// Prism's own engine (../agent/engine.ts) calls a model over HTTP and runs the
// tools itself. Here Claude Code does both: Prism starts the Claude Code
// program the user already installed and signed in to (through Anthropic's
// Agent SDK), hands it each message, and turns what comes back into the same
// events and transcript items the engine produces. So the agent panel, approval
// cards, plan panel, diffs, undo and hooks all work without knowing which of
// the two is running.
//
// One Claude Code serves a conversation for as long as it is in use, the way it
// does in a terminal. It used to be started for each turn and shut at the end of
// it, which took everything it was running in the background down too: builds and
// watchers died halfway, and the notice that would have said so was lost. Now a
// job keeps running after the turn that started it, and when it finishes Claude
// Code reports back by itself. Prism shows that as a turn Claude started.
//
// Claude Code keeps the real conversation in its own session file; the id of
// that session lives in the Prism session's extras, and a fresh Claude Code
// resumes it.
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { query, type HookCallback, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  AssistantItem,
  Attachment,
  Effort,
  ClaudeSessionState,
  FileDiff,
  ModelRef,
  PermissionMode,
  PlanDecision,
  PlanRequest,
  QuestionRequest,
  ReviewDecision,
  ReviewRequest,
  RunEndReason,
  SystemItem,
  ToolCall,
  ToolItem,
  TranscriptItem,
  Usage,
  UserItem
} from '@shared/types'
import type { Workspace } from '../fs/workspace'
import type { Repo } from '../store/repo'
import { transcriptAsText } from '../agent/context'
import { modeAllows, shellRisk } from '../agent/permissions'
import type { AgentTool, ToolContext } from '../agent/tools'
import { PRISM_PREFIX, prismBridge, type PrismBridge } from './bridge'
import { countDiff } from '../agent/tools/fs'
import { snapshotProject, type Snapshot } from '../history/snapshot'
import { claudeEnv } from './locate'
import { CLAUDE_ENDPOINT, EDITING, NOT_A_REFUSAL, claudeMode, explainError, planTitle, prismMode, readsAsRefusal, resultText, toPrismCall, todosFrom, TaskPlan } from './translate'

/**
 * Each conversation's plan, for as long as Prism runs. One Claude Code serves a whole
 * conversation and its list carries across turns, so the plan does too.
 */
const plans = new Map<string, TaskPlan>()
function planOf(sessionId: string): TaskPlan {
  let p = plans.get(sessionId)
  if (!p) plans.set(sessionId, (p = new TaskPlan()))
  return p
}

export interface ClaudeDeps {
  repo: Repo
  workspace: Workspace
  /** Absolute path of the Claude Code program. */
  exe: string
  emit(sessionId: string, ev: AgentEvent): void
  storeImage(image: { mime: string; base64: string }): Promise<string>
  /**
   * Resolves 'deny' by itself when the signal fires (Claude withdrew the request), and
   * 'unasked' when there was nobody to ask — the turn it belonged to is already over.
   * That is not a refusal and must never be reported as one.
   */
  requestApproval(sessionId: string, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | 'unasked'>
  requestAnswer(sessionId: string, req: QuestionRequest): Promise<string>
  requestPlan(sessionId: string, req: PlanRequest): Promise<PlanDecision>
  requestReview(sessionId: string, req: ReviewRequest): Promise<ReviewDecision>
  /**
   * Tool servers from Prism's own list, handed to Claude Code in memory rather than through a file. A running
   * Claude session rewrites ~/.claude.json from the copy it read at startup, so anything added to that file
   * meanwhile (by `claude mcp add`) is overwritten; passing them here cannot be clobbered. Names already in
   * Claude's own config are left alone so they do not appear twice.
   */
  mcpServers?: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }>
  hooks?: {
    before(sessionId: string, call: ToolCall): Promise<string | null>
    after(sessionId: string, call: ToolCall, isError: boolean): Promise<string | null>
  }
  /** Handles on the turn in progress: changing mode, and handing it something the user just typed. */
  controls(c: { setMode(mode: PermissionMode): void; steer(text: string): boolean } | null): void
  /** Claude (or an approved plan) changed the mode itself. */
  modeChanged(sessionId: string, mode: PermissionMode): void
  /** Prism's own tools to offer Claude (gadgets, project checks, show). */
  tools?: AgentTool[]
  /** Of these changed files, the ones the user's rules protect. */
  protectedBy?(sessionId: string, paths: string[]): Promise<{ rule: string; paths: string[] } | null>
  /**
   * Claude Code has started a turn by itself — a job it ran in the background finished and it is
   * reporting back. The host sets the turn up (so Stop, approvals and steering work) by calling
   * runClaudeTurn with `self`. False when it cannot: the conversation is gone, or already busy.
   */
  selfStart?(sessionId: string, model: ModelRef): boolean
  /** The Claude usage limit has been reached; it resets at this time (ms since 1970). */
  limitReached?(sessionId: string, resetsAt: number): void
}

export interface ClaudeInput {
  sessionId: string
  model: ModelRef
  mode: PermissionMode
  text: string
  expanded?: string
  attachments: Attachment[]
  signal: AbortSignal
  /** Added to Claude Code's own system prompt. Fixed for the session: a change would re-store the whole conversation. */
  append?: string
  /** What can change between turns (skills, rules, instructions, pinned files). It goes in the message, and only when it changed, so the cached conversation stays usable. */
  context?: string
  /** The model's context size, when known before the first turn has finished. */
  contextWindow?: number | null
  /** Lines to show in the conversation right after the user's message (skills that joined). */
  notes?: Array<{ text: string; meta: Record<string, unknown> | null }>
  /** How hard to think about this turn; left out, Claude decides. Models that do not take one ignore it. */
  effort?: Effort | null
  /** A turn Claude Code started by itself (see ClaudeDeps.selfStart): there is no message to send. */
  self?: boolean
}

export interface ClaudeOutcome {
  reason: RunEndReason
  error?: string
  lastText: string
}

const DIGEST_CHARS = 60_000
/** Context window per model id, learned from finished turns. */
const windows = new Map<string, number>()
/** The usage warning is shown once per session for each limit period, not on every turn. */
const warnedFor = new Map<string, number>()
/** How long a conversation with nothing running in the background keeps its Claude Code. */
const IDLE_MS = 10 * 60_000
/** How long a turn Claude started by itself may take to be set up before what it says is let go. */
const SELF_START_MS = 15_000
/** What Claude Code sends that means a turn is under way. */
const TURN_MESSAGES = new Set(['assistant', 'stream_event', 'user', 'result'])
const NOBODY_TO_ASK = 'That turn is already over, so there was nobody to ask. Nobody refused anything. Ask again if it still needs doing.'

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function usageOf(u: RawUsage | null | undefined): Usage {
  const read = u?.cache_read_input_tokens ?? 0
  const write = u?.cache_creation_input_tokens ?? 0
  return { inputTokens: (u?.input_tokens ?? 0) + read + write, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: read, cacheWriteTokens: write }
}

type Block = Record<string, unknown>
type CanUseTool = NonNullable<Options['canUseTool']>
type TaskNotice = Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>
type Helper = { name: string; at: number; ended?: boolean }

const asUser = (c: string | Block[]): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: c }, parent_tool_use_id: null }) as unknown as SDKUserMessage

/** What one turn does with what Claude Code sends while the turn is the one in progress. */
interface Turn {
  handle(m: SDKMessage): Promise<void>
  canUseTool: CanUseTool
  pre: HookCallback
  post: HookCallback
  toolCtx(): ToolContext
  /** Claude Code went away under the turn. */
  exited(): void
}

/** The words for a job that finished in the background, from Claude Code's own summary. */
function jobNews(m: TaskNotice): string {
  const what = m.summary?.trim()
  if (what) return what
  return `A job running in the background ${m.status === 'completed' ? 'finished' : m.status === 'failed' ? 'failed' : 'was stopped'}.`
}

/** One Claude Code, kept running for a conversation. */
class LiveClaude {
  readonly q: Query
  claudeSession: string | null
  billed = false
  ref: ModelRef
  mode: PermissionMode
  turn: Turn | null = null
  /** What it is running in the background, watchers included: while there is any, it is kept. */
  bg: Array<{ id: string; description: string; ambient: boolean }> = []
  /** Helpers started in the background, so the turn they report back in can close them. */
  readonly bgHelpers = new Map<string, Helper>()
  /** Jobs that finished while no turn was in progress: said at the start of the turn they cause. */
  private news: string[] = []
  errTail = ''
  crash: string | null = null
  closed = false
  readonly tools: Map<string, AgentTool>
  readonly bridge: PrismBridge | null
  private input: Array<string | Block[]> = []
  private wake: (() => void) | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private selfWait: { promise: Promise<void>; resolve: () => void } | null = null

  constructor(
    readonly sid: string,
    /** What it was started with that cannot be changed while it runs. */
    readonly key: string,
    private readonly deps: ClaudeDeps,
    o: { ref: ModelRef; mode: PermissionMode; append?: string; effort?: Effort | null; st: ClaudeSessionState | null }
  ) {
    this.ref = o.ref
    this.mode = o.mode
    this.claudeSession = o.st?.sessionId ?? null
    this.tools = new Map((deps.tools ?? []).map((t) => [t.spec.name, t]))
    this.bridge = this.tools.size ? prismBridge([...this.tools.values()], () => this.turn?.toolCtx() ?? this.idleCtx()) : null

    // Claude Code holds on to these for its whole life; each hands over to the turn in progress
    const canUseTool: CanUseTool = async (name, input, opts) => {
      const t = await this.current()
      return t ? t.canUseTool(name, input, opts) : { behavior: 'deny', message: NOBODY_TO_ASK }
    }
    const hook =
      (pick: (t: Turn) => HookCallback): HookCallback =>
      async (h, id, x) => {
        const t = await this.current()
        return t ? pick(t)(h, id, x) : {}
      }
    const options: Options = {
      cwd: deps.workspace.root,
      // Planning is off by default since a Claude Code update, for sessions run the way
      // Prism runs them, and Prism passes on no CLAUDE_CODE_ settings of its own — so the
      // plan that ticks itself off at the top of the agent panel had quietly stopped.
      env: { ...claudeEnv(), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
      pathToClaudeCodeExecutable: deps.exe,
      permissionMode: claudeMode(o.mode),
      // lets "Full auto" be switched on while a turn is running; it changes nothing until that mode is chosen
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(o.append?.trim() ? { append: o.append.trim() } : {}) },
      canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [hook((t) => t.pre)] }],
        PostToolUse: [{ hooks: [hook((t) => t.post)] }],
        PostToolUseFailure: [{ hooks: [hook((t) => t.post)] }]
      },
      stderr: (d) => {
        this.errTail = (this.errTail + d).slice(-3000)
      },
      mcpServers: { ...(deps.mcpServers ?? {}), ...(this.bridge ? { [this.bridge.config.name]: this.bridge.config } : {}) },
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.ref.modelId !== 'default' ? { model: o.ref.modelId } : {}),
      ...(o.st?.sessionId ? { resume: o.st.sessionId, ...(o.st.resumeAt ? { resumeSessionAt: o.st.resumeAt } : {}) } : {})
    }
    this.q = query({ prompt: this.prompt(), options })
    void this.loop()
  }

  // The input stays open for the conversation's whole life: messages, approvals and mode
  // changes reach Claude Code at any time, and it never takes an empty input to mean "shut".
  private async *prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.input.length) yield asUser(this.input.shift()!)
      if (this.closed) return
      await new Promise<void>((r) => (this.wake = r))
    }
  }

  private nudge(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  /** Hands Claude Code a message. False once it has gone. */
  push(c: string | Block[]): boolean {
    if (this.closed) return false
    this.input.push(c)
    this.nudge()
    return true
  }

  private async loop(): Promise<void> {
    try {
      for await (const m of this.q) await this.dispatch(m)
    } catch (e) {
      this.crash = e instanceof Error ? e.message : String(e)
    } finally {
      this.close()
      this.turn?.exited()
    }
  }

  private async dispatch(m: SDKMessage): Promise<void> {
    if (m.type === 'system') this.track(m)
    // Claude has started talking with no turn in progress: something it ran in the background finished
    if (!this.turn && TURN_MESSAGES.has(m.type)) await this.selfTurn()
    if (this.turn) await this.turn.handle(m)
  }

  /** What belongs to the conversation rather than to a turn. */
  private track(m: Extract<SDKMessage, { type: 'system' }>): void {
    if (m.subtype === 'init') {
      this.claudeSession = m.session_id
      this.billed = !!m.apiKeySource && m.apiKeySource !== 'none'
    } else if (m.subtype === 'background_tasks_changed') {
      this.bg = m.tasks.map((t) => ({ id: t.task_id, description: t.description, ambient: t.ambient === true }))
      this.idleCheck()
    } else if (m.subtype === 'task_notification' && !this.turn && !m.skip_transcript && !m.ambient) {
      const helper = m.tool_use_id ? this.bgHelpers.get(m.tool_use_id) : undefined
      if (!helper) this.news.push(jobNews(m))
    }
  }

  /** The turn in progress, waiting for one Claude has just started to be set up. */
  async current(): Promise<Turn | null> {
    if (this.turn) return this.turn
    // a tool can be asked for before the message that shows the turn began has been read
    if (!this.closed) await this.selfTurn()
    return this.turn
  }

  private selfTurn(): Promise<void> {
    if (this.turn || this.closed) return Promise.resolve()
    if (this.selfWait) return this.selfWait.promise
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    this.selfWait = { promise, resolve }
    const timer = setTimeout(() => this.settleSelf(), SELF_START_MS)
    void promise.then(() => clearTimeout(timer))
    if (!(this.deps.selfStart?.(this.sid, this.ref) ?? false)) this.settleSelf()
    return promise
  }

  private settleSelf(): void {
    const w = this.selfWait
    this.selfWait = null
    w?.resolve()
  }

  /** What finished in the background while nobody was there, taken once. */
  takeNews(): string[] {
    const n = this.news
    this.news = []
    return n
  }

  attach(t: Turn): void {
    this.turn = t
    this.errTail = ''
    this.cancelIdle()
    this.settleSelf()
  }

  detach(t: Turn): void {
    if (this.turn === t) this.turn = null
    this.idleCheck()
  }

  /** The model and mode are changed in place: neither is worth restarting it for. */
  async follow(ref: ModelRef, mode: PermissionMode): Promise<void> {
    if (ref.modelId !== this.ref.modelId) await this.q.setModel(ref.modelId === 'default' ? undefined : ref.modelId).catch(() => {})
    this.ref = ref
    if (mode !== this.mode) await this.setMode(mode)
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
    await this.q.setPermissionMode(claudeMode(mode)).catch(() => {})
  }

  /** Let go of it once nothing is happening; kept while anything runs in the background. */
  private idleCheck(): void {
    if (this.closed) return
    if (this.turn || this.bg.length) return this.cancelIdle()
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.turn && !this.bg.length) this.close()
    }, IDLE_MS)
    this.idleTimer.unref?.()
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancelIdle()
    if (live.get(this.sid) === this) live.delete(this.sid)
    this.nudge()
    try {
      this.q.close()
    } catch {
      /* already gone */
    }
    this.settleSelf()
  }

  /** For one of Prism's own tools called between turns, which has no turn to belong to. */
  private idleCtx(): ToolContext {
    return {
      workspace: this.deps.workspace,
      sessionId: this.sid,
      agent: undefined,
      signal: new AbortController().signal,
      emit: (ev) => this.deps.emit(this.sid, ev),
      checkpoint: async () => {},
      askUser: async () => '',
      review: async () => ({ files: [] }),
      mode: () => this.mode,
      presentPlan: async () => ({ action: 'discard', plan: '' }),
      setTodos: () => {},
      spawnAgent: async () => ({ ok: false, summary: 'Not available in a Claude session.' }),
      output: () => {},
      callId: ''
    }
  }
}

/** The Claude Code serving each conversation, by Prism session id. */
const live = new Map<string, LiveClaude>()

/** What the Claude Code serving a conversation is running in the background: real work, not watchers. */
export function claudeJobs(sessionId: string): string[] {
  const p = live.get(sessionId)
  return p && !p.closed ? p.bg.filter((t) => !t.ambient).map((t) => t.description.trim() || 'a job') : []
}

/** Shuts the Claude Code serving a conversation, and with it anything it runs in the background. */
export function closeClaude(sessionId: string): void {
  live.get(sessionId)?.close()
}

export async function runClaudeTurn(deps: ClaudeDeps, input: ClaudeInput): Promise<ClaudeOutcome> {
  const { repo, workspace } = deps
  const root = workspace.root
  const sid = input.sessionId
  const plan = planOf(sid)
  const ref = input.model
  const t0 = Date.now()
  const emit = (ev: AgentEvent): void => deps.emit(sid, ev)
  const tagged = (ev: AgentEvent, agent?: string): void => deps.emit(sid, agent ? ({ ...ev, agent } as AgentEvent) : ev)

  const earlier = repo.listItems(sid)
  // a turn Claude started has no message of its own: it belongs with the one before it
  const userItem: UserItem | null = input.self ? null : { kind: 'user', id: randomUUID(), ts: Date.now(), text: input.text, ...(input.expanded ? { expanded: input.expanded } : {}), attachments: input.attachments }
  const turnItemId = userItem?.id ?? [...earlier].reverse().find((i) => i.kind === 'user')?.id ?? null
  if (userItem) {
    repo.appendItem(sid, userItem)
    emit({ type: 'item', item: userItem })
  }
  emit({ type: 'run-start', runId: randomUUID(), model: ref })

  const note = (subkind: SystemItem['subkind'], text: string, meta: Record<string, unknown> | null = null): void => {
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind, text, meta }
    repo.appendItem(sid, item)
    emit({ type: 'item', item })
  }
  for (const n of input.notes ?? []) note('info', n.text, n.meta)

  let state: ClaudeSessionState | null = repo.getSessionExtras(sid).claude ?? null
  let lastText = ''
  let outcome: ClaudeOutcome | null = null

  // a session file that has gone missing gets one fresh start, with the transcript as a written summary
  for (let attempt = 0; attempt < 2 && !outcome; attempt += 1) {
    const r = await once(state)
    if (r === 'retry-fresh') {
      state = null
      repo.setSessionExtras(sid, { claude: null })
      continue
    }
    outcome = r
  }
  outcome ??= { reason: 'error', error: 'Claude Code could not continue this conversation.', lastText }
  emit({ type: 'status', text: null })
  emit({ type: 'run-end', reason: outcome.reason, error: outcome.error, durationMs: Date.now() - t0 })
  return outcome

  async function once(st: ClaudeSessionState | null): Promise<ClaudeOutcome | 'retry-fresh'> {
    // ---- what Claude is sent
    const unseen = st ? after(earlier, st.synced) : earlier
    let digest = ''
    if (unseen.some((i) => i.kind === 'user' || i.kind === 'assistant')) {
      const body = transcriptAsText(unseen)
      digest =
        (st ? 'Since your last turn in this conversation, it continued with another model. What happened in between:' : 'This conversation started before you joined it. What happened so far:') +
        `\n\n${body.length > DIGEST_CHARS ? '…' + body.slice(-DIGEST_CHARS) : body}\n\n---\nThe user now says:`
    }
    const files = input.attachments.filter((a) => !a.mime.startsWith('image/')).map((a) => `[Attached file: ${a.path}]`)
    const ctx = input.context?.trim() ?? ''
    const ctxHash = ctx ? createHash('sha1').update(ctx).digest('hex') : null
    // a slash command must come first to count as one: the context waits for the next ordinary message
    const command = (input.expanded ?? input.text).trimStart().startsWith('/')
    const changed = !input.self && !command && (st?.given ?? null) !== ctxHash && (!!ctx || !!st?.given)
    const ctxNote = !changed
      ? ''
      : ctx
        ? `[Notice from Prism, not written by the user]\nThe session's context as of now (it replaces any earlier one Prism gave you):\n\n${ctx}`
        : '[Notice from Prism, not written by the user]\nThe session context Prism gave you earlier (skills, rules, instructions, pinned files) no longer applies.'
    const text = [ctxNote, digest, input.expanded ?? input.text, ...files].filter((x) => x.trim()).join('\n\n')
    const images: Block[] = []
    for (const a of input.attachments) {
      if (!a.mime.startsWith('image/')) continue
      try {
        images.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: (await readFile(a.path)).toString('base64') } })
      } catch {
        /* a picture that has gone missing is skipped */
      }
    }
    // plain text keeps Claude Code's own slash commands working
    const content: string | Block[] = images.length ? [...images, { type: 'text', text }] : text

    // ---- turn state
    let proc: LiveClaude | undefined
    let mode = input.mode
    let step = 0
    let stepStart = Date.now()
    let streamUsage: Usage | null = null
    let cur: { id: string; text: string; reasoning: string; calls: ToolCall[]; usage: Usage } | null = null
    const flushed = new Set<string>()
    const started = new Map<string, { call: ToolCall; at: number; agent?: string }>()
    /** When a cancellation that reads as a refusal was last answered, so one batch of them draws one answer. */
    let lastNotARefusal = 0
    const agents = new Map<string, Helper>()
    const snapshots = new Map<string, { path: string; before: string | null }>()
    /** Commands in flight, with the project's state noted before each. */
    const commandSnaps = new Map<string, Promise<Snapshot | null>>()
    let checkpointId: string | null = null
    const turnBefore = st ? (st.resumeAt ?? st.lastUuid) : null
    let lastUuid = turnBefore
    let sawOutput = false
    let reported: string | null = null
    let result: Extract<SDKMessage, { type: 'result' }> | null = null
    let argChars = 0
    let argNote = 0
    let argTool = ''
    let summarised = false
    let turnOver = false
    let finish!: () => void
    const over = new Promise<void>((r) => {
      finish = () => {
        turnOver = true
        r()
      }
    })

    const save = (): void => {
      const claudeSession = proc?.claudeSession
      if (!claudeSession) return
      const items = repo.listItems(sid)
      const turns = userItem ? [...(st?.turns ?? []).filter((t) => t.item !== userItem.id), { item: userItem.id, before: turnBefore }].slice(-300) : (st?.turns ?? [])
      repo.setSessionExtras(sid, { claude: { sessionId: claudeSession, lastUuid, resumeAt: null, turns, synced: items[items.length - 1]?.id ?? null, given: summarised ? null : changed ? ctxHash : (st?.given ?? null) } })
    }

    const flush = (): void => {
      if (!cur) return
      const c = cur
      cur = null
      flushed.add(c.id)
      if (!c.text.trim() && !c.reasoning && !c.calls.length) return
      const usage: Usage = { ...(streamUsage ?? c.usage), latencyMs: Date.now() - stepStart, cost: 0 }
      streamUsage = null
      repo.recordUsage({ endpointId: CLAUDE_ENDPOINT, modelId: ref.modelId, sessionId: sid, ok: true, usage })
      repo.addSessionUsage(sid, usage)
      const item: AssistantItem = { kind: 'assistant', id: randomUUID(), ts: Date.now(), text: c.text, reasoning: c.reasoning || null, toolCalls: c.calls, model: ref, usage, step: Math.max(1, step) }
      repo.appendItem(sid, item)
      emit({ type: 'item', item })
      emit({ type: 'usage', step: Math.max(1, step), usage, contextTokens: usage.inputTokens, contextWindow: windows.get(ref.modelId) ?? input.contextWindow ?? null })
      if (c.text.trim()) lastText = c.text
    }

    const agentOf = (parent: string | null): string | undefined | null => (parent ? (agents.get(parent)?.name ?? proc?.bgHelpers.get(parent)?.name ?? null) : undefined)

    /** A tool call Claude has decided on: show it as running. */
    const begin = (id: string, name: string, args: Record<string, unknown>, agent?: string): ToolCall => {
      const call = toPrismCall(id, name, args, root)
      if (started.has(id)) return call
      started.set(id, { call, at: Date.now(), ...(agent ? { agent } : {}) })
      tagged({ type: 'tool-start', call }, agent)
      if (name === 'TodoWrite' && !agent) emit({ type: 'todos', todos: todosFrom(args) })
      if (name === 'TaskCreate' && !agent) plan.creating(id, args)
      if (name === 'TaskUpdate' && !agent && plan.update(args)) emit({ type: 'todos', todos: plan.todos() })
      if (name === 'Agent' || name === 'Task') {
        let label = String(args['subagent_type'] ?? 'agent').replace(/[^\w-]+/g, '-').slice(0, 24) || 'agent'
        const taken = new Set([...agents.values(), ...(proc?.bgHelpers.values() ?? [])].map((a) => a.name))
        for (let n = 2; taken.has(label); n += 1) label = `${label.replace(/-\d+$/, '')}-${n}`
        agents.set(id, { name: label, at: Date.now() })
        emit({ type: 'subagent-start', agent: label, task: String(args['description'] ?? args['prompt'] ?? ''), model: ref })
      }
      return call
    }

    const finishTool = async (block: Block, agent?: string): Promise<void> => {
      const id = String(block['tool_use_id'] ?? '')
      const s = started.get(id)
      if (!s) return
      started.delete(id)
      if (!agent) flush()
      const isError = block['is_error'] === true
      const r = resultText(block['content'])
      if (!agent && !isError && plan.created(id, r.text)) emit({ type: 'todos', todos: plan.todos() })
      // A call cancelled by a parked session comes back worded as the user refusing it, with
      // an instruction to stop and wait. Left alone it stops the turn and tells the user they
      // said no to something they were never shown, so it is answered instead.
      if (!agent && isError && readsAsRefusal(r.text) && Date.now() - lastNotARefusal > 5000) {
        lastNotARefusal = Date.now()
        proc?.push(NOT_A_REFUSAL)
      }
      let stored: string[] = []
      if (r.images.length) stored = await Promise.all(r.images.slice(0, 6).map((im) => deps.storeImage(im))).catch(() => [])
      let diff: FileDiff | null = null
      const snap = snapshots.get(id)
      snapshots.delete(id)
      const path = typeof s.call.args['path'] === 'string' ? (s.call.args['path'] as string) : ''
      // files outside the project (Claude's own plan and memory files) are listed, but are not part of the project's changes
      if (snap && !isError && !isAbsolute(snap.path)) {
        const now = await readText(snap.path)
        if (now !== snap.before) diff = { path: snap.path, before: snap.before, after: now, ...countDiff(snap.before, now) }
        emit({ type: 'file-touched', path: snap.path, op: s.call.name === 'write_file' ? 'write' : 'edit', callId: id })
      } else if (s.call.name === 'read_file' && path && !isError) emit({ type: 'file-touched', path, op: 'read' })
      const meta: Record<string, unknown> = {}
      // one of Prism's own tools: its full result carries what the panels react to
      const own = proc?.bridge?.take(s.call.name, s.call.args)
      if (own) {
        Object.assign(meta, own.meta ?? {})
        if (own.diff) diff = own.diff
      }
      if (s.call.name === 'shell') meta['exitCode'] = isError ? 1 : 0
      const cmdSnap = commandSnaps.get(id)
      commandSnaps.delete(id)
      if (cmdSnap) {
        const r = await (await cmdSnap)?.changes().catch(() => null)
        // a command cannot get round a rule: what it changed in protected files is put back at once
        const guard = r?.files.length && deps.protectedBy ? await deps.protectedBy(sid, r.files.map((f) => f.path)).catch(() => null) : null
        if (r && guard) {
          for (const f of r.files.filter((x) => guard.paths.includes(x.path))) {
            if (f.before === null) await workspace.delete(f.path).catch(() => {})
            else await workspace.writeRaw(f.path, f.before).catch(() => {})
          }
          r.files = r.files.filter((x) => !guard.paths.includes(x.path))
          meta['blocked'] = `Blocked by the user's rule: "${guard.rule}". Prism put back ${guard.paths.join(', ')}.`
          note('info', `A command changed ${guard.paths.join(', ')}, which your rule "${guard.rule}" protects; Prism put ${guard.paths.length === 1 ? 'it' : 'them'} back.`)
        }
        if (r?.files.length) {
          await keepGiven(r.files.map((f) => ({ path: f.path, content: f.before })))
          for (const f of r.files) emit({ type: 'file-touched', path: f.path, op: 'write', callId: id })
          meta['changed'] = r.files.map((f) => f.path)
        }
      }
      if (stored.length) meta['images'] = stored
      const item: ToolItem = {
        kind: 'tool',
        id: randomUUID(),
        ts: Date.now(),
        callId: id,
        name: s.call.name,
        args: s.call.args,
        // a stopped turn makes Claude Code report its tools as "rejected by the user", which is not what happened
        content: isError && input.signal.aborted ? '(stopped before this finished)' : r.text || (isError ? '(failed with no message)' : '(done)'),
        isError,
        durationMs: Date.now() - s.at,
        diff,
        meta: Object.keys(meta).length ? meta : null,
        ...(agent ? { agent } : {})
      }
      // what a helper agent does stays out of the stored transcript, as with Prism's own helpers
      if (!agent) repo.appendItem(sid, item)
      emit({ type: 'item', item })
      // a helper started in the background reports straight away and finishes later (see task_notification),
      // perhaps in a turn of its own: the conversation keeps it until then
      const sub = agents.get(id)
      if (sub && /^async agent launched/i.test(r.text.trim()) && !isError) {
        agents.delete(id)
        proc?.bgHelpers.set(id, sub)
      } else if (sub) endAgent(sub, !isError, r.text)
    }

    const endAgent = (sub: Helper, ok: boolean, summary: string): void => {
      if (sub.ended) return
      sub.ended = true
      emit({ type: 'subagent-end', agent: sub.name, ok, summary: summary.slice(0, 2000), durationMs: Date.now() - sub.at })
    }

    const readText = async (p: string): Promise<string | null> => {
      try {
        return isAbsolute(p) ? await readFile(p, 'utf8') : (await workspace.readRaw(p)).toString('utf8')
      } catch {
        return null
      }
    }

    /** Keep the file as it was, so the change can be shown as a diff and undone. */
    const snapshot = async (id: string, p: string): Promise<void> => {
      if (!p || snapshots.has(id)) return
      snapshots.set(id, { path: p, before: await readText(p) })
      if (isAbsolute(p)) return // outside the project: shown, but not part of undo
      await keep([p])
    }

    const keep = async (paths: string[]): Promise<void> => {
      const files: Array<{ path: string; content: Buffer | null }> = []
      for (const p of paths) files.push({ path: p, content: await workspace.readRaw(p).catch(() => null) })
      await keepGiven(files)
    }

    const keepGiven = async (files: Array<{ path: string; content: Buffer | null }>): Promise<void> => {
      if (!files.length) return
      if (!checkpointId) {
        const label = input.self ? 'After a background job' : input.text.replace(/\s+/g, ' ').slice(0, 60)
        const cp = repo.createCheckpoint(sid, label, files, turnItemId)
        checkpointId = cp.id
        emit({ type: 'checkpoint', id: cp.id, files: cp.files })
      } else {
        repo.addCheckpointFiles(checkpointId, files)
        const cp = repo.getCheckpoint(checkpointId)
        if (cp) emit({ type: 'checkpoint', id: cp.id, files: cp.files })
      }
    }

    // ---- Prism's own tools, run in this process
    const toolCtx = (): ToolContext => ({
      workspace,
      sessionId: sid,
      agent: undefined,
      signal: input.signal,
      emit,
      checkpoint: keep,
      askUser: async (req) => {
        const full: QuestionRequest = { questionId: randomUUID(), ...req }
        emit({ type: 'question', request: full })
        try {
          return await deps.requestAnswer(sid, full)
        } finally {
          emit({ type: 'question-resolved', questionId: full.questionId })
        }
      },
      review: async (req) => {
        const full: ReviewRequest = { reviewId: randomUUID(), ...req }
        emit({ type: 'review', request: full })
        try {
          return await deps.requestReview(sid, full)
        } finally {
          emit({ type: 'review-resolved', reviewId: full.reviewId })
        }
      },
      mode: () => mode,
      presentPlan: async () => ({ action: 'discard', plan: '' }),
      setTodos: (todos) => emit({ type: 'todos', todos }),
      spawnAgent: async () => ({ ok: false, summary: 'Not available in a Claude session.' }),
      output: () => {},
      callId: ''
    })

    // ---- hooks: Prism's automations, and the snapshot before each edit
    const pre: HookCallback = async (h) => {
      if (h.hook_event_name !== 'PreToolUse') return {}
      const call = toPrismCall(h.tool_use_id, h.tool_name, (h.tool_input ?? {}) as Record<string, unknown>, root)
      const reason = deps.hooks ? await deps.hooks.before(sid, call).catch(() => null) : null
      if (reason) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
      if (EDITING.has(call.name)) await snapshot(h.tool_use_id, String(call.args['path'] ?? '')).catch(() => {})
      if (call.name === 'shell' && call.args['background'] !== true) commandSnaps.set(h.tool_use_id, snapshotProject(workspace).catch(() => null))
      return {}
    }
    const post: HookCallback = async (h) => {
      if (h.hook_event_name !== 'PostToolUse' && h.hook_event_name !== 'PostToolUseFailure') return {}
      if (!deps.hooks) return {}
      const call = toPrismCall(h.tool_use_id, h.tool_name, (h.tool_input ?? {}) as Record<string, unknown>, root)
      const extra = await deps.hooks.after(sid, call, h.hook_event_name === 'PostToolUseFailure').catch(() => null)
      return extra ? { hookSpecificOutput: { hookEventName: h.hook_event_name, additionalContext: extra } } : {}
    }

    // ---- questions, plans and approvals
    const askUser = async (toolInput: Record<string, unknown>): Promise<PermissionResult> => {
      const qs = Array.isArray(toolInput['questions']) ? (toolInput['questions'] as Array<Record<string, unknown>>) : []
      const answers: Record<string, string> = {}
      for (const q of qs) {
        const req: QuestionRequest = {
          questionId: randomUUID(),
          question: String(q['question'] ?? ''),
          options: (Array.isArray(q['options']) ? (q['options'] as Array<Record<string, unknown>>) : []).map((o) => ({ label: String(o['label'] ?? ''), description: String(o['description'] ?? '') })),
          multi: q['multiSelect'] === true
        }
        emit({ type: 'question', request: req })
        let answer = ''
        try {
          answer = await deps.requestAnswer(sid, req)
        } finally {
          emit({ type: 'question-resolved', questionId: req.questionId })
        }
        if (input.signal.aborted) return { behavior: 'deny', message: 'The user stopped the turn.', interrupt: true }
        answers[req.question] = answer
      }
      return { behavior: 'allow', updatedInput: { ...toolInput, answers } }
    }

    const presentPlan = async (toolInput: Record<string, unknown>): Promise<PermissionResult | null> => {
      let plan = typeof toolInput['plan'] === 'string' ? toolInput['plan'] : ''
      if (!plan && typeof toolInput['planFilePath'] === 'string') plan = await readFile(toolInput['planFilePath'], 'utf8').catch(() => '')
      if (!plan.trim()) return null
      const req: PlanRequest = { planId: randomUUID(), title: planTitle(plan), plan }
      emit({ type: 'plan', request: req })
      let d: PlanDecision
      try {
        d = await deps.requestPlan(sid, req)
      } finally {
        emit({ type: 'plan-resolved', planId: req.planId })
      }
      if (d.action === 'approve') {
        const next: PermissionMode = d.mode && d.mode !== 'plan' ? d.mode : 'ask'
        mode = next
        if (proc) proc.mode = next
        deps.modeChanged(sid, next)
        const edited = d.plan.trim() && d.plan.trim() !== plan.trim()
        return { behavior: 'allow', updatedInput: edited ? { ...toolInput, plan: d.plan } : toolInput, updatedPermissions: [{ type: 'setMode', mode: claudeMode(next), destination: 'session' }] }
      }
      if (d.action === 'revise') {
        const edited = d.plan.trim() && d.plan.trim() !== plan.trim()
        return {
          behavior: 'deny',
          message: `The user read the plan and wants it changed before any work starts.${d.feedback?.trim() ? `\n\nTheir feedback:\n${d.feedback.trim()}` : ''}${edited ? `\n\nThey also edited the plan. Their version:\n${d.plan.trim()}` : ''}\n\nRevise the plan and present it again.`
        }
      }
      return { behavior: 'deny', message: 'The user discarded the plan. Stop here and wait for them.', interrupt: true }
    }

    const canUseTool: CanUseTool = async (toolName, toolInput, o) => {
      if (toolName === 'AskUserQuestion') return askUser(toolInput)
      if (toolName === 'ExitPlanMode') {
        const r = await presentPlan(toolInput)
        if (r) return r
      }
      const id = (o as { toolUseID?: string }).toolUseID ?? randomUUID()
      const agent = started.get(id)?.agent
      const call = toPrismCall(id, toolName, toolInput, root)
      // Prism's own tools follow Prism's rules: harmless ones never ask, the rest follow the mode
      const mine = toolName.startsWith(PRISM_PREFIX) ? proc?.tools.get(call.name) : undefined
      const ownRisk = mine ? mine.risk(toolInput) : undefined
      if (mine && (ownRisk === null || modeAllows(mode, call.name))) return { behavior: 'allow', updatedInput: toolInput }
      const suggestions: PermissionUpdate[] = o.suggestions ?? []
      const first = suggestions.find((s) => s.type === 'addRules')
      const rule = first && 'rules' in first ? first.rules[0] : undefined
      const req: ApprovalRequest = {
        approvalId: randomUUID(),
        call,
        risk: ownRisk ?? (call.name === 'shell' ? shellRisk(String(call.args['command'] ?? '')) : 'medium'),
        summary: o.title ?? o.decisionReason ?? `Claude wants to use ${toolName}`,
        rule: { tool: rule?.toolName ?? toolName, ...(rule?.ruleContent ? { pattern: rule.ruleContent } : {}) },
        ...(agent ? { agent } : {})
      }
      emit({ type: 'approval', request: req })
      const d = await deps.requestApproval(sid, req, o.signal)
      if (d === 'unasked') {
        // The turn this belonged to is already finished, so the card had nowhere to go
        // and nobody ever saw it. Reporting that as a refusal blames the user for
        // something they were never shown.
        return { behavior: 'deny', message: NOBODY_TO_ASK }
      }
      if (d === 'deny') {
        // Three different things end up here and only one of them is a refusal.
        // Claude Code withdraws a request when the turn moves on; saying "the user
        // said no" then puts words in their mouth and stops the agent dead waiting
        // for an answer to a question nobody was asked.
        if (input.signal.aborted) return { behavior: 'deny', message: 'The user stopped the turn.' }
        if (o.signal.aborted) return { behavior: 'deny', message: 'This request was taken back before anyone was asked. Nobody refused anything: carry on.' }
        return { behavior: 'deny', message: 'The user said no to this. Ask them what they would like instead, or carry on another way.' }
      }
      if (d === 'always') return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: suggestions.length ? suggestions : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }] }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    // ---- what this turn does with each message from Claude Code
    const handle = async (m: SDKMessage): Promise<void> => {
      switch (m.type) {
        case 'system': {
          if (m.subtype === 'init') save()
          else if (m.subtype === 'status') {
            emit({ type: 'status', text: m.status === 'compacting' ? 'Making room in the conversation…' : null })
            const pm = m.permissionMode ? prismMode(m.permissionMode) : null
            if (pm && pm !== mode) {
              mode = pm
              if (proc) proc.mode = pm
              deps.modeChanged(sid, pm)
            }
          } else if (m.subtype === 'compact_boundary') {
            // the summary may not carry the context along: it is given again next turn
            summarised = true
            save()
            note('info', 'Claude summarised the earlier part of this conversation to make room.')
          } else if (m.subtype === 'local_command_output') {
            if (m.content.trim()) note('info', m.content.trim())
            sawOutput = true
          } else if (m.subtype === 'task_notification') {
            const id = m.tool_use_id
            const sub = id ? (agents.get(id) ?? proc?.bgHelpers.get(id)) : undefined
            if (sub) {
              endAgent(sub, m.status === 'completed', m.summary)
              if (id) proc?.bgHelpers.delete(id)
            } else if (!m.skip_transcript && !m.ambient) note('info', jobNews(m))
          } else if (m.subtype === 'api_retry') {
            emit({ type: 'status', text: `Claude did not answer. Trying again (${m.attempt}/${m.max_retries})…` })
          }
          break
        }
        case 'rate_limit_event': {
          const info = m.rate_limit_info
          // out of Claude for now: the host carries on by itself once the limit resets
          if (info.status === 'rejected' && info.resetsAt) deps.limitReached?.(sid, info.resetsAt * 1000)
          if (info.status === 'allowed_warning' && warnedFor.get(sid) !== (info.resetsAt ?? 0)) {
            warnedFor.set(sid, info.resetsAt ?? 0)
            const which = info.rateLimitType === 'five_hour' ? '5-hour' : info.rateLimitType?.startsWith('seven_day') ? 'weekly' : ''
            const pct = typeof info.utilization === 'number' ? `${Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization)}% of` : 'most of'
            const reset = info.resetsAt ? ` It resets at ${new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''
            note('info', `You have used ${pct} your ${which} Claude limit.${reset}`.replace(/\s+/g, ' '))
          }
          break
        }
        case 'stream_event': {
          const agent = agentOf(m.parent_tool_use_id)
          if (agent === null) break
          const ev = m.event as unknown as { type: string; message?: { usage?: RawUsage }; content_block?: Block; delta?: Block; usage?: RawUsage }
          if (ev.type === 'message_start') {
            if (agent) tagged({ type: 'step-start', step: 1, model: ref }, agent)
            else {
              flush()
              step += 1
              stepStart = Date.now()
              streamUsage = usageOf(ev.message?.usage)
              emit({ type: 'step-start', step, model: ref })
            }
          } else if (ev.type === 'content_block_start') {
            if (ev.content_block?.['type'] === 'tool_use' && !agent) {
              argChars = 0
              argTool = String(ev.content_block['name'] ?? 'tool')
              emit({ type: 'status', text: `Preparing ${argTool}…` })
            }
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta ?? {}
            if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
              sawOutput = true
              tagged({ type: 'text-delta', text: d['text'] }, agent)
            } else if (d['type'] === 'thinking_delta' && typeof d['thinking'] === 'string') tagged({ type: 'reasoning-delta', text: d['thinking'] }, agent)
            else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string' && !agent) {
              argChars += d['partial_json'].length
              if (argChars > 1200 && Date.now() - argNote > 600) {
                argNote = Date.now()
                emit({ type: 'status', text: `Writing ${argTool} · ${(argChars / 1024).toFixed(1)} KB` })
              }
            }
          } else if (ev.type === 'message_delta') {
            if (!agent && streamUsage && ev.usage) {
              const u = usageOf({ ...ev.usage, input_tokens: ev.usage.input_tokens ?? 0 })
              streamUsage = { ...streamUsage, outputTokens: u.outputTokens || streamUsage.outputTokens }
            }
          } else if (ev.type === 'message_stop') {
            if (!agent) flush()
          }
          break
        }
        case 'assistant': {
          const agent = agentOf(m.parent_tool_use_id)
          if (agent === null) break
          sawOutput = true
          const msg = m.message as unknown as { id: string; content: Block[]; usage?: RawUsage }
          const blocks = Array.isArray(msg.content) ? msg.content : []
          if (m.error && !reported) {
            reported = explainError(m.error)
            note('error', reported)
          }
          if (agent) {
            let text = ''
            const calls: ToolCall[] = []
            for (const b of blocks) {
              if (b['type'] === 'text') text += String(b['text'] ?? '')
              else if (b['type'] === 'tool_use') calls.push(begin(String(b['id']), String(b['name']), (b['input'] ?? {}) as Record<string, unknown>, agent))
            }
            if (text.trim() || calls.length) emit({ type: 'item', item: { kind: 'assistant', id: randomUUID(), ts: Date.now(), text, reasoning: null, toolCalls: calls, model: ref, usage: null, step: 1, agent } })
            break
          }
          lastUuid = m.uuid
          if (cur && cur.id !== msg.id) flush()
          const late = flushed.has(msg.id)
          cur ??= { id: msg.id, text: '', reasoning: '', calls: [], usage: usageOf(msg.usage) }
          for (const b of blocks) {
            // an error message from Claude Code itself arrives as text; the plain-words version is already shown
            if (b['type'] === 'text' && !m.error) cur.text += String(b['text'] ?? '')
            else if (b['type'] === 'thinking') cur.reasoning += String(b['thinking'] ?? '')
            else if (b['type'] === 'tool_use') cur.calls.push(begin(String(b['id']), String(b['name']), (b['input'] ?? {}) as Record<string, unknown>))
          }
          cur.usage = usageOf(msg.usage)
          if (late) flush()
          break
        }
        case 'user': {
          const agent = agentOf(m.parent_tool_use_id)
          if (agent === null) break
          const c = (m.message as unknown as { content: unknown }).content
          if (!Array.isArray(c)) break
          for (const b of c as Block[]) if (b?.['type'] === 'tool_result') await finishTool(b, agent)
          break
        }
        case 'result': {
          flush()
          result = m
          for (const [name, u] of Object.entries(m.modelUsage ?? {})) {
            if (u.contextWindow) {
              windows.set(name, u.contextWindow)
              windows.set(ref.modelId, u.contextWindow)
            }
          }
          if (proc?.billed && m.total_cost_usd > 0) {
            const usage: Usage = { inputTokens: 0, outputTokens: 0, cost: m.total_cost_usd }
            repo.addSessionUsage(sid, usage)
            emit({ type: 'usage', step: Math.max(1, step), usage, contextTokens: 0, contextWindow: windows.get(ref.modelId) ?? null })
          }
          // the turn is over; Claude Code is not, and what it runs in the background carries on
          finish()
          break
        }
        default:
          break
      }
    }

    // ---- the Claude Code for this conversation: the one already running, or a fresh one
    const key = createHash('sha1')
      .update(JSON.stringify([deps.exe, root, input.append?.trim() ?? '', input.effort ?? null, deps.mcpServers ?? {}, (deps.tools ?? []).map((t) => t.spec.name).sort()]))
      .digest('hex')
    proc = live.get(sid)
    if (proc && !input.self) {
      // its conversation was rewritten (rewound, restarted or switched): it cannot carry on from what it remembers
      const rewritten = proc.closed || !st?.sessionId || proc.claudeSession !== st.sessionId || !!st.resumeAt
      // a change it cannot take while running waits until nothing would be lost by restarting it
      if (rewritten || (proc.key !== key && !proc.bg.length)) {
        proc.close()
        proc = undefined
      }
    }
    if (input.self && (!proc || proc.closed)) return { reason: 'completed', lastText }
    if (!proc) {
      try {
        proc = new LiveClaude(sid, key, deps, { ref, mode: input.mode, append: input.append, effort: input.effort, st })
      } catch (e) {
        const msg = `Claude Code could not be started: ${e instanceof Error ? e.message : String(e)}`
        note('error', msg)
        return { reason: 'error', error: msg, lastText }
      }
      live.set(sid, proc)
    }
    const p = proc

    // what finished in the background while nobody was there comes first: it is why Claude is talking
    for (const n of p.takeNews()) note('info', n)
    const turn: Turn = { handle, canUseTool, pre, post, toolCtx, exited: () => finish() }
    p.attach(turn)
    await p.follow(ref, input.mode)
    if (!input.self) p.push(content)

    deps.controls({
      setMode(next) {
        mode = next
        void p.setMode(next)
      },
      steer(text) {
        if (turnOver || !text.trim()) return false
        return p.push(text)
      }
    })
    let hardStop: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      void p.q.interrupt().catch(() => {})
      // Claude Code normally winds the turn up by itself; this is for when it does not.
      // Shutting it while calls are still running makes it report every unfinished call as
      // the user refusing it, so that waits for them to finish, and only stops waiting
      // after a long one has had its chance.
      const giveUpAt = Date.now() + 60_000
      const closeWhenIdle = (): void => {
        if (turnOver) return
        if (started.size && Date.now() < giveUpAt) {
          hardStop = setTimeout(closeWhenIdle, 500)
          return
        }
        p.close()
      }
      hardStop = setTimeout(closeWhenIdle, 2500)
    }
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })

    try {
      await over
    } finally {
      if (hardStop) clearTimeout(hardStop)
      input.signal.removeEventListener('abort', onAbort)
      deps.controls(null)
      flush()
      p.detach(turn)
    }

    // tools that never reported back (the turn was stopped under them)
    for (const [id, s] of started) {
      const item: ToolItem = { kind: 'tool', id: randomUUID(), ts: Date.now(), callId: id, name: s.call.name, args: s.call.args, content: '(stopped before this finished)', isError: true, durationMs: Date.now() - s.at, diff: null, meta: null, ...(s.agent ? { agent: s.agent } : {}) }
      if (!s.agent) repo.appendItem(sid, item)
      emit({ type: 'item', item })
    }
    started.clear()
    for (const sub of agents.values()) endAgent(sub, !input.signal.aborted, '')
    save()

    if (input.signal.aborted) return { reason: 'aborted', lastText }
    const done = result as Extract<SDKMessage, { type: 'result' }> | null
    const crash = done ? null : p.crash
    const failed = crash !== null || !done || done.is_error || done.subtype !== 'success'
    if (!failed) return { reason: 'completed', lastText }

    const errTail = p.errTail
    const detail = crash ?? (done && 'errors' in done && done.errors.length ? done.errors.join('\n') : done && 'result' in done ? done.result : '') ?? ''
    // the stored Claude conversation is gone (cleaned up, or made on another computer), or the point a
    // rewind cut it back to is not in it (Claude Code had summarised it since): start it again, with
    // the conversation as you see it given as a written summary
    if (st?.sessionId && !sawOutput && /no conversation found|no message found with message.uuid|session.*(not found|does not exist)|could not (find|resume)/i.test(`${detail}\n${errTail}`)) {
      p.close()
      return 'retry-fresh'
    }
    if (done?.subtype === 'error_max_turns') {
      note('info', 'Claude stopped after its limit of steps. Send a message to continue.')
      return { reason: 'max-steps', lastText }
    }
    if (reported) return { reason: 'error', error: reported, lastText }
    const lastLine = errTail.trim().split('\n').pop() ?? ''
    const msg = detail.trim() || (lastLine ? `Claude Code stopped unexpectedly: ${lastLine}` : 'Claude Code stopped unexpectedly.')
    note('error', msg)
    return { reason: 'error', error: msg, lastText }
  }
}

/** The items that come after `id`. An id that is gone means there is nothing new to tell. */
function after(items: TranscriptItem[], id: string | null): TranscriptItem[] {
  if (!id) return items
  const i = items.findIndex((x) => x.id === id)
  return i < 0 ? [] : items.slice(i + 1)
}
