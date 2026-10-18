import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  AssistantItem,
  Attachment,
  Endpoint,
  ModelInfo,
  ModelRef,
  PermissionMode,
  PermissionRule,
  PlanDecision,
  PlanRequest,
  QuestionRequest,
  ReviewDecision,
  ReviewRequest,
  RunEndReason,
  Settings,
  SystemItem,
  TodoItem,
  ToolCall,
  ToolItem,
  Usage,
  UserItem
} from '@shared/types'
import type { Workspace } from '../fs/workspace'
import type { McpClient } from '../mcp/client'
import type { GadgetManager } from '../gadgets/manager'
import type { BrowserHost } from './tools/browser'
import type { ThemeHost } from './tools/theme'
import type { ScratchHost } from './tools/scratch'
import { getAdapter, ProviderError, StallError, type ChatResult, type ImagePart, type Message, type ToolSpec } from '../providers'
import type { Repo } from '../store/repo'
import { compactionSplit, estimateMessages, messagesFromItems, transcriptAsText } from './context'
import { decide, suggestRule } from './permissions'
import { buildSystemPrompt, COMPACTION_PROMPT } from './prompt'
import { buildTools, primaryOf, type AgentTool, type ToolContext, type ToolResult } from './tools'
import type { BackgroundHost } from './background'
import { createHelpers } from './helpers'
import { watchJob } from './tools/shell'
import { MemoryStore, memoryIndex } from '../memory/memory'
import { StuckWatch, budgetLine, budgetState, runChecks, type DoneCheck } from './guards'
import { shellLabelFor } from './tools/shell'
import { readPins } from './contextReport'
import { deferOutsideTools } from './tools/deferred'
import type { ImpactHost } from './tools/impact'
import { pickSkills, skillNote, skillsPrompt, type Skill } from '../skills/skills'
import { callNote } from './calls'

export interface ResolvedModel {
  ep: Endpoint
  key: string | null
  info: ModelInfo
}

export interface EngineDeps {
  repo: Repo
  workspace: Workspace
  settings(): Settings
  resolveModel(ref: ModelRef): ResolvedModel | null
  findModel(id: string): ModelRef | null
  mcp(): Array<{ name: string; client: McpClient }>
  /** Gadget manager, for the gadget_* tools and gadget-provided tools. */
  gadgets(): GadgetManager | null
  /** Prism's in-app browser, for the browser_* tools. */
  browser?(): BrowserHost | null
  /** Prism's own appearance, for set_theme. */
  theme?(): ThemeHost | null
  /** Notices, timers, git copies for helpers, and other sessions (main/agent-host.ts). */
  background?: BackgroundHost
  /** Where memories for every project are kept. */
  memoryDir?: string
  /** Prism's own settings and panels. */
  prism?(): import('./tools/prismctl').PrismHost | null
  /** The scratchpad's runner, for run_snippet. */
  scratch?(): ScratchHost | null
  /** Every skill the project and the user have (core/skills). */
  skills?(): Promise<Skill[]>
  /** The user's own tools (core/customTools). */
  customTools?(): Promise<AgentTool[]>
  /** For check_impact: the files a session's latest request changed. */
  impact?: ImpactHost
  /** Of these changed files, the ones the user's rules protect. */
  protectedBy?(sessionId: string, paths: string[]): Promise<{ rule: string; paths: string[] } | null>
  /** A vision-capable model used when the lead model cannot see images. */
  visionModel(): ResolvedModel | null
  /** Model to continue with when the lead keeps failing (null = none). */
  fallbackModel(): ResolvedModel | null
  /** A stronger model to take over when the agent is going round in circles (null = none). */
  strongModel?(): ResolvedModel | null
  /** Persist an image a tool produced; returns the stored file name for prism://attach/. */
  storeImage(image: ImagePart): Promise<string>
  emit(sessionId: string, ev: AgentEvent): void
  /** 'unasked' means there was nobody to ask: the turn is over. Not a refusal. */
  requestApproval(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision | 'unasked'>
  /** A quick model's look at an action before the user is asked: ok lets it through, otherwise its concern goes on the card. */
  checkCall?(sessionId: string, call: ToolCall, summary: string): Promise<{ ok: boolean; reason: string } | null>
  /** The session's permission mode right now; it can change while a turn runs. */
  modeOf?(rootSessionId: string): PermissionMode | null
  requestAnswer(sessionId: string, req: QuestionRequest): Promise<string>
  requestReview(sessionId: string, req: ReviewRequest): Promise<ReviewDecision>
  requestPlan(sessionId: string, req: PlanRequest): Promise<PlanDecision>
  /** The project's hooks: a reason string from before() stops the tool; text from after() is added to its result. */
  hooks?: {
    before(sessionId: string, call: ToolCall): Promise<string | null>
    after(sessionId: string, call: ToolCall, isError: boolean): Promise<string | null>
  }
  addAllowRule(rule: PermissionRule): void
}

export interface RunInput {
  sessionId: string
  /** Events are published on the root session's channel. */
  rootSessionId: string
  model: ModelRef
  mode: PermissionMode
  text: string
  /** Prompt the model receives when a slash command expanded `text`. */
  expanded?: string
  attachments: Attachment[]
  agent?: string
  depth: number
  readOnly: boolean
  signal: AbortSignal
  sessionAllow: PermissionRule[]
  systemExtra?: string
  /** Root user item this turn belongs to (sub-agents inherit it). */
  turnItemId?: string
  /** A turn started by news rather than by the user: these notices open it instead of a user message. */
  notices?: SystemItem[]
}

export interface RunOutcome {
  reason: RunEndReason
  error?: string
  lastText: string
}

const RETRY_DELAYS = [1500, 4000, 9000]

export function costOf(info: ModelInfo, u: Usage): number {
  const inP = info.inputPrice ?? 0
  const outP = info.outputPrice ?? 0
  const cached = u.cacheReadTokens ?? 0
  const fresh = Math.max(0, u.inputTokens - cached)
  return (fresh * inP + cached * inP * 0.1 + (u.cacheWriteTokens ?? 0) * inP * 0.25 + u.outputTokens * outP) / 1_000_000
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && (e.message === 'aborted' || e.name === 'AbortError'))
}

function isRetryable(e: unknown): boolean {
  if (e instanceof StallError) return true
  if (e instanceof ProviderError) return e.retryable
  if (e instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i.test(e.message)) return true
  return false
}

export async function runTurn(deps: EngineDeps, input: RunInput): Promise<RunOutcome> {
  const { repo, workspace } = deps
  const emit = (ev: AgentEvent): void => deps.emit(input.rootSessionId, input.agent ? ({ ...ev, agent: input.agent } as AgentEvent) : ev)
  const settings = deps.settings()
  const resolved = deps.resolveModel(input.model)
  const t0 = Date.now()
  if (!resolved) {
    const err: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'error', text: 'The selected model is not available. Pick a model in the composer.', meta: null }
    repo.appendItem(input.sessionId, err)
    emit({ type: 'item', item: err })
    emit({ type: 'run-end', reason: 'error', error: err.text, durationMs: 0 })
    return { reason: 'error', error: err.text, lastText: '' }
  }
  let { ep, key, info } = resolved
  let adapter = getAdapter(ep.adapter)
  let modelRef: ModelRef = input.model
  let usedFallback = false

  // 1. persist the user turn (describing images through the vision role when the lead is text-only)
  let attachments = input.attachments
  if (!info.supportsVision && attachments.some((a) => a.mime.startsWith('image/') && !a.description)) {
    const vision = deps.visionModel()
    if (vision) {
      emit({ type: 'status', text: 'Looking at the images…' })
      attachments = await Promise.all(
        attachments.map(async (a) => {
          if (!a.mime.startsWith('image/') || a.description) return a
          try {
            const buf = await readFile(a.path)
            const description = await describeImage(vision, { mime: a.mime, base64: buf.toString('base64') }, input.text, input.signal)
            return { ...a, description }
          } catch {
            return a
          }
        })
      )
    }
  }
  const userItem: UserItem = {
    kind: 'user',
    id: randomUUID(),
    ts: Date.now(),
    text: input.text,
    ...(input.expanded ? { expanded: input.expanded } : {}),
    attachments
  }
  if (input.notices?.length) {
    for (const n of input.notices) {
      repo.appendItem(input.sessionId, n)
      emit({ type: 'item', item: n })
    }
  } else {
    repo.appendItem(input.sessionId, userItem)
    emit({ type: 'item', item: userItem })
  }
  if (!input.agent) emit({ type: 'run-start', runId: randomUUID(), model: input.model })
  if (!input.turnItemId) input.turnItemId = input.notices?.[0]?.id ?? userItem.id
  deps.background?.enter(input.sessionId, input.rootSessionId)

  // 2. tools + prompt
  const shellCfg = { shell: () => settings.terminal.shell, timeoutSec: () => settings.agent.shellTimeoutSec ?? 120 }
  const mcp = input.readOnly ? [] : deps.mcp()
  // plan mode: look, don't touch, until the user has approved a plan
  const planMode = !input.readOnly && input.depth === 0 && input.mode === 'plan'
  const readOnly = input.readOnly || planMode
  const gadgets = readOnly ? null : deps.gadgets()
  if (gadgets) await gadgets.warm()
  // skills: what the session already uses, plus what this message calls for; helper agents inherit the session's
  const allSkills = deps.skills ? await deps.skills().catch(() => []) : []
  const inUse = (): string[] => repo.getSessionExtras(input.rootSessionId).skills ?? []
  const picked = pickSkills(allSkills, inUse(), input.depth === 0 ? `${input.text}\n${input.expanded ?? ''}` : '')
  if (input.depth > 0) picked.loaded = picked.loaded.filter((s) => inUse().includes(s.name))
  else if (picked.fresh.length) {
    repo.setSessionExtras(input.rootSessionId, { skills: picked.loaded.map((s) => s.name) })
    const note: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: skillNote(picked.fresh), meta: { skills: picked.fresh.map((s) => s.name) } }
    repo.appendItem(input.sessionId, note)
    emit({ type: 'item', item: note })
  }
  const skillHost =
    input.depth === 0 && picked.others.length
      ? {
          all: () => allSkills,
          use: (s: Skill) => {
            if (!inUse().includes(s.name)) repo.setSessionExtras(input.rootSessionId, { skills: [...inUse(), s.name] })
          }
        }
      : null
  const custom = readOnly || !deps.customTools ? [] : await deps.customTools().catch(() => [])
  const lead = input.depth === 0
  const tools = buildTools({
    shell: shellCfg,
    readOnly,
    allowSpawn: lead,
    mcp,
    gadgets,
    browser: readOnly ? null : (deps.browser?.() ?? null),
    scratch: readOnly ? null : (deps.scratch?.() ?? null),
    custom,
    skills: skillHost,
    impact: readOnly ? null : (deps.impact ?? null),
    theme: readOnly ? null : (deps.theme?.() ?? null),
    plan: planMode,
    background: !!deps.background && lead && !readOnly,
    helpers: lead && !readOnly,
    memory: lead && deps.memoryDir ? { personalDir: deps.memoryDir } : null,
    prism: lead ? (deps.prism?.() ?? null) : null,
    changes: lead
      ? {
          versions: () => repo.listFileVersions(input.rootSessionId),
          requestOf: (turnItemId) => {
            const it = turnItemId ? repo.listItems(input.rootSessionId).find((x) => x.id === turnItemId) : null
            return it && it.kind === 'user' ? it.text : it && it.kind === 'system' ? it.text : '(unknown)'
          }
        }
      : null
  })
  if (!info.supportsTools) tools.clear()
  // many outside tools are offered by name until the model asks for a source
  const sources = (): string[] => repo.getSessionExtras(input.rootSessionId).toolSources ?? []
  deferOutsideTools(tools, sources(), (g) => {
    if (!sources().includes(g)) repo.setSessionExtras(input.rootSessionId, { toolSources: [...sources(), g] })
    specs = [...tools.values()].map((t) => t.spec)
  })
  let specs: ToolSpec[] = [...tools.values()].map((t) => t.spec)
  // what the user pinned or wrote for this session rides along on every turn
  const extras = input.depth === 0 ? repo.getSessionExtras(input.rootSessionId) : { pins: [], instructions: '' }
  const pinned = await readPins(workspace, extras.pins)
  const memories = lead && deps.memoryDir ? memoryIndex(await new MemoryStore(workspace, deps.memoryDir).list().catch(() => [])) : ''
  let system = await buildSystemPrompt({
    workspace,
    shellLabel: shellLabelFor(workspace.root, settings.terminal.shell),
    mode: input.mode,
    modelId: info.modelId,
    isSubagent: input.depth > 0,
    readOnly: input.readOnly,
    hasMcp: mcp.length > 0,
    hasGadgets: !!gadgets,
    builtinGadgets: gadgets?.builtinNote() ?? '',
    extra: [input.systemExtra, extras.instructions, budgetLine(lead ? repo.getSessionExtras(input.rootSessionId).budget : null), lead ? callNote(input.rootSessionId) : ''].filter((x) => x?.trim()).join('\n\n'),
    skills: skillsPrompt(picked.loaded, input.depth === 0 ? picked.others : []),
    pinned,
    memories,
    background: !!deps.background && lead && !readOnly,
    noRepeat: lead && settings.conversation?.noRepeat !== false
  })

  const liveImages = new Map<string, ImagePart[]>()
  let checkpointId: string | null = null
  let todos: TodoItem[] = []
  let lastText = ''
  let step = 0
  // guards: going round in circles, the request's budget, and the checks that prove the work
  const watch = new StuckWatch()
  let strikes = 0
  let spent = 0
  let budgetWarned = false
  let doneWhen: DoneCheck[] = []
  let checkRounds = 0
  const note = (subkind: 'info' | 'notice', text: string, meta: Record<string, unknown> | null = null): void => {
    const it: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind, text, meta }
    repo.appendItem(input.sessionId, it)
    emit({ type: 'item', item: it })
  }
  const maxSteps = Math.max(1, settings.agent.maxSteps)

  const keepBefore = (files: Array<{ path: string; content: Buffer | null }>): void => {
    if (!files.length) return
    if (!checkpointId) {
      const cp = repo.createCheckpoint(input.rootSessionId, input.text.replace(/\s+/g, ' ').slice(0, 60), files, input.turnItemId ?? null)
      checkpointId = cp.id
      emit({ type: 'checkpoint', id: cp.id, files: cp.files })
    } else {
      repo.addCheckpointFiles(checkpointId, files)
      const cp = repo.getCheckpoint(checkpointId)
      if (cp) emit({ type: 'checkpoint', id: cp.id, files: cp.files })
    }
  }

  const helpers = createHelpers(deps, input, runTurn, emit)
  const ctxBase = {
    workspace,
    sessionId: input.sessionId,
    agent: input.agent,
    signal: input.signal,
    emit,
    async checkpoint(paths: string[]): Promise<void> {
      const files: Array<{ path: string; content: Buffer | null }> = []
      for (const p of paths) {
        try {
          files.push({ path: p, content: await workspace.readRaw(p) })
        } catch {
          files.push({ path: p, content: null })
        }
      }
      keepBefore(files)
    },
    keepBefore,
    protectedBy: (paths: string[]) => (deps.protectedBy ? deps.protectedBy(input.rootSessionId, paths) : Promise.resolve(null)),
    async askUser(req: Omit<QuestionRequest, 'questionId'>): Promise<string> {
      const questionId = randomUUID()
      const full: QuestionRequest = { questionId, ...req }
      emit({ type: 'question', request: full })
      try {
        return await deps.requestAnswer(input.rootSessionId, full)
      } finally {
        emit({ type: 'question-resolved', questionId })
      }
    },
    async presentPlan(req: Omit<PlanRequest, 'planId'>): Promise<PlanDecision> {
      const full: PlanRequest = { planId: randomUUID(), ...req }
      emit({ type: 'plan', request: full })
      try {
        return await deps.requestPlan(input.rootSessionId, full)
      } finally {
        emit({ type: 'plan-resolved', planId: full.planId })
      }
    },
    async review(req: Omit<ReviewRequest, 'reviewId'>): Promise<ReviewDecision> {
      const full: ReviewRequest = { reviewId: randomUUID(), ...req, ...(input.agent ? { agent: input.agent } : {}) }
      emit({ type: 'review', request: full })
      try {
        return await deps.requestReview(input.rootSessionId, full)
      } finally {
        emit({ type: 'review-resolved', reviewId: full.reviewId })
      }
    },
    setDoneWhen(checks: DoneCheck[]): void {
      doneWhen = checks
    },
    setTodos(next: TodoItem[]): void {
      todos = next
      emit({ type: 'todos', todos })
    },
    async spawnAgent(task: string, opts: { name?: string; model?: string; readOnly?: boolean; background?: boolean; isolated?: boolean }): Promise<{ ok: boolean; summary: string }> {
      return helpers.spawn(task, opts)
    },
    ...(deps.background ? { background: { host: deps.background, sessionId: input.sessionId, rootSessionId: input.rootSessionId } } : {}),
    ...(lead ? { helpers: helpers.control } : {}),
    watchJob: (id: string, pattern: RegExp, times: number) =>
      deps.background ? watchJob(id, pattern, times, { host: deps.background, sessionId: input.sessionId, rootSessionId: input.rootSessionId }) : { ok: false as const, error: 'Not available here.' },
    output(callId: string, chunk: string): void {
      emit({ type: 'tool-output', callId, chunk })
    },
    mode: (): PermissionMode => deps.modeOf?.(input.rootSessionId) ?? input.mode
  }

  const finish = (reason: RunEndReason, error?: string): RunOutcome => {
    if (!input.agent) emit({ type: 'run-end', reason, error, durationMs: Date.now() - t0 })
    return { reason, error, lastText }
  }

  try {
    while (step < maxSteps) {
      if (input.signal.aborted) return finish('aborted')
      step += 1

      // news that arrived while the last step ran (a job finished, a message from the lead or another session)
      for (const n of deps.background?.drain(input.sessionId) ?? []) {
        repo.appendItem(input.sessionId, n)
        emit({ type: 'item', item: n })
      }

      // 3. assemble context, compacting when near the window
      let items = repo.listItems(input.sessionId)
      let messages = await messagesFromItems(system, items, liveImages, { vision: info.supportsVision })
      let contextTokens = estimateMessages(messages)
      const window = info.contextWindow
      if (window && contextTokens > window * settings.agent.compactAt) {
        emit({ type: 'status', text: 'Compacting context…' })
        const r = await compactSession(deps, input.sessionId, resolved, input.signal)
        if (r) {
          emit({ type: 'compaction', beforeTokens: contextTokens, afterTokens: r.afterTokens })
          items = repo.listItems(input.sessionId)
          messages = await messagesFromItems(system, items, liveImages, { vision: info.supportsVision })
          contextTokens = estimateMessages(messages)
        }
        emit({ type: 'status', text: null })
      }

      // 4. call the model with retries for stalls and transient failures, then the fallback model
      emit({ type: 'step-start', step, model: modelRef })
      let result: Awaited<ReturnType<typeof callModel>> | null = null
      let attempt = 0
      while (result === null) {
        try {
          result = await callModel(adapter, ep, key, info, messages, specs, settings, input.signal, emit)
        } catch (e) {
          if (isAbort(e, input.signal)) return finish('aborted')
          const msg = e instanceof Error ? e.message : String(e)
          repo.recordUsage({ endpointId: ep.id, modelId: info.modelId, sessionId: input.sessionId, ok: false, error: msg })
          const tries = Math.max(0, Math.min(10, settings.agent.retries ?? RETRY_DELAYS.length))
          if (isRetryable(e) && attempt < tries) {
            const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]!
            attempt += 1
            emit({ type: 'status', text: `${msg} Retrying (${attempt}/${tries})…` })
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay)
              input.signal.addEventListener('abort', () => {
                clearTimeout(t)
                resolve()
              }, { once: true })
            })
            if (input.signal.aborted) return finish('aborted')
            emit({ type: 'status', text: null })
            emit({ type: 'step-start', step, model: modelRef })
            continue
          }
          const fb = usedFallback ? null : deps.fallbackModel()
          if (fb && fb.info.modelId !== info.modelId && fb.info.supportsTools) {
            usedFallback = true
            ep = fb.ep
            key = fb.key
            info = fb.info
            adapter = getAdapter(ep.adapter)
            modelRef = { endpointId: ep.id, modelId: info.modelId }
            system = system.replace(/^- Model: .*$/m, `- Model: ${info.modelId}`)
            attempt = 0
            const note: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: `${msg} Switched to ${info.modelId} for the rest of this run.`, meta: { fallback: info.modelId } }
            repo.appendItem(input.sessionId, note)
            emit({ type: 'item', item: note })
            emit({ type: 'step-start', step, model: modelRef })
            continue
          }
          const errItem: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'error', text: msg, meta: null }
          repo.appendItem(input.sessionId, errItem)
          emit({ type: 'item', item: errItem })
          return finish('error', msg)
        }
      }

      // 5. persist the assistant turn + usage
      const usage: Usage = { ...result.usage, latencyMs: result.latencyMs, cost: costOf(info, result.usage) }
      repo.recordUsage({ endpointId: ep.id, modelId: info.modelId, sessionId: input.sessionId, ok: true, usage })
      repo.addSessionUsage(input.rootSessionId, usage)

      // The model declined. What it had written so far is not an answer and is not kept,
      // and nothing it asked to run is run; the user is told why, as far as it said.
      if (result.declined) {
        const why = result.declined.why ? `: ${result.declined.why}` : ''
        const said = result.declined.explanation ? ` It said: "${result.declined.explanation}"` : ''
        const msg = `${info.modelId} declined to continue${why}.${said}`
        // an empty reply clears what had been shown while it was writing
        emit({ type: 'item', item: { kind: 'assistant', id: randomUUID(), ts: Date.now(), text: '', reasoning: null, toolCalls: [], model: modelRef, usage, step, ...(input.agent ? { agent: input.agent } : {}) } })
        const declinedItem: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'error', text: msg, meta: { declined: true } }
        repo.appendItem(input.sessionId, declinedItem)
        emit({ type: 'item', item: declinedItem })
        return finish('error', msg)
      }
      // Another model took over after the one asked declined (Anthropic's fallbacks): say
      // so, and name the model that really answered.
      const answeredBy: ModelRef = result.servedBy ? { endpointId: ep.id, modelId: result.servedBy } : modelRef
      if (result.servedBy) note('info', `${info.modelId} declined this step, so ${result.servedBy} answered it instead.`, { fallback: result.servedBy })

      const assistant: AssistantItem = {
        kind: 'assistant',
        id: randomUUID(),
        ts: Date.now(),
        text: result.text,
        reasoning: result.reasoning,
        reasoningSignature: result.reasoningSignature,
        ...(result.blocks ? { blocks: result.blocks } : {}),
        toolCalls: result.toolCalls,
        model: answeredBy,
        usage,
        step,
        ...(input.agent ? { agent: input.agent } : {})
      }
      repo.appendItem(input.sessionId, assistant)
      emit({ type: 'item', item: assistant })
      emit({ type: 'usage', step, usage, contextTokens: result.usage.inputTokens || contextTokens, contextWindow: window })
      if (result.text.trim()) lastText = result.text

      // the user's budget for this request
      spent += usage.cost ?? 0
      if (!input.agent) {
        const b = budgetState(repo.getSessionExtras(input.rootSessionId).budget, spent, t0)
        if (b.over && result.toolCalls.length) {
          note('info', `Prism paused this request: ${b.over}. Send a message to let it carry on (Budget, in the session header).`, { budget: true })
          return finish('budget')
        }
        if (b.near && !budgetWarned) {
          budgetWarned = true
          note('notice', `Budget: ${b.near}. Wrap up soon: finish what matters most and say what is left.`, { source: 'budget' })
        }
      }

      // news came in while it was answering: let it see that before the turn ends
      if (result.toolCalls.length === 0 && deps.background?.pending(input.sessionId)) continue
      // it says it is done: run the checks it promised, and send it back if one fails
      if (result.toolCalls.length === 0 && doneWhen.length && !input.agent) {
        emit({ type: 'status', text: 'Running the checks it promised…' })
        const results = await runChecks(workspace.root, doneWhen, settings.terminal.shell, input.signal)
        emit({ type: 'status', text: null })
        if (input.signal.aborted) return finish('aborted')
        const failed = results.filter((r) => !r.ok)
        checkRounds += 1
        note('info', failed.length ? `${failed.length} of ${results.length} checks failed` : `All ${results.length} checks passed`, { verdict: results })
        const limit = Math.max(0, settings.agent.hookFixes ?? 2)
        if (failed.length && checkRounds <= limit) {
          note('notice', `You said this work is proven by these checks, and ${failed.length === 1 ? 'one of them fails' : `${failed.length} of them fail`}:\n\n${failed.map((r) => `$ ${r.command}  (exit ${r.code})\n${r.output.slice(-1500)}`).join('\n\n')}\n\nFix the cause (not the check), then finish again.`, { source: 'checks' })
          continue
        }
        return finish('completed')
      }
      if (result.toolCalls.length === 0) return finish('completed')

      // 6. run the tools
      const calls = result.toolCalls
      const canParallel =
        settings.agent.parallelTools &&
        calls.every((c) => {
          const t = tools.get(c.name)
          return t && (t.readOnly || t.parallelSafe)
        })
      const runOne = async (call: ToolCall): Promise<ToolItem> => {
        const st = Date.now()
        const ctx: ToolContext = { ...ctxBase, callId: call.id, emit: (ev) => emit(ev.type === 'file-touched' ? { ...ev, callId: call.id } : ev) }
        const r = await executeCall(deps, input, tools, call, ctx, emit)
        let storedImages: string[] = []
        if (r.images?.length) {
          try {
            storedImages = await Promise.all(r.images.slice(0, 6).map((im) => deps.storeImage(im)))
          } catch {
            storedImages = []
          }
          if (info.supportsVision) liveImages.set(call.id, r.images)
          else {
            const vision = deps.visionModel()
            if (!vision) {
              r.content +=
                '\n\n[You cannot see this image: your model is text-only and no vision-capable model is configured. The image is shown to the user in the transcript. Tell the user they can set a Vision model under Settings → Model roles if they want you to see images.]'
            } else {
              emit({ type: 'status', text: 'Looking at the image…' })
              const descs: string[] = []
              for (const im of r.images.slice(0, 4)) {
                try {
                  descs.push(await describeImage(vision, im, `The tool ${call.name} returned this picture for an agent that cannot see. Describe it so the agent can act on it: the layout from top to bottom, every piece of text exactly as written, the colours, and anything that looks wrong (text cut off or overlapping, things spilling out of their box, misaligned or empty areas, unreadable contrast, error messages).`, input.signal))
                } catch (e) {
                  descs.push(`(vision model failed: ${e instanceof Error ? e.message : String(e)})`)
                }
              }
              r.content += `\n\n[Image content, as seen by the vision model]\n${descs.join('\n\n')}`
            }
          }
        }
        return {
          kind: 'tool',
          id: randomUUID(),
          ts: Date.now(),
          callId: call.id,
          name: call.name,
          args: call.args,
          content: r.content,
          isError: r.isError,
          durationMs: Date.now() - st,
          diff: r.diff ?? null,
          meta: storedImages.length ? { ...(r.meta ?? {}), images: storedImages } : (r.meta ?? null),
          ...(input.agent ? { agent: input.agent } : {})
        }
      }
      let endTurn = false
      const stepItems: ToolItem[] = []
      if (canParallel) {
        const items2 = await Promise.all(calls.map(runOne))
        for (const it of items2) {
          repo.appendItem(input.sessionId, it)
          emit({ type: 'item', item: it })
          stepItems.push(it)
          if (it.meta?.['endTurn']) endTurn = true
        }
      } else {
        for (const call of calls) {
          if (input.signal.aborted) {
            const it: ToolItem = {
              kind: 'tool', id: randomUUID(), ts: Date.now(), callId: call.id, name: call.name, args: call.args,
              content: '(aborted before this tool ran)', isError: true, durationMs: 0, diff: null, meta: null,
              ...(input.agent ? { agent: input.agent } : {})
            }
            repo.appendItem(input.sessionId, it)
            emit({ type: 'item', item: it })
            continue
          }
          const it = await runOne(call)
          repo.appendItem(input.sessionId, it)
          emit({ type: 'item', item: it })
          stepItems.push(it)
          if (it.meta?.['endTurn']) endTurn = true
        }
      }
      if (input.signal.aborted) return finish('aborted')

      // going round in circles: first a nudge, then a stronger model if there is one, then stop
      const stuck = watch.observe(stepItems)
      if (stuck) {
        strikes += 1
        const strong = strikes >= 2 && deps.strongModel ? deps.strongModel() : null
        if (strikes === 1) {
          note('notice', `You seem to be going round in circles: ${stuck}. Stop repeating it. Work out why it is not working (read the error, check your assumptions, look at the code again) and try a different approach, or ask the user if you need something only they know.`, { source: 'stuck', reason: stuck })
          emit({ type: 'stuck', reason: stuck, action: 'nudged' })
        } else if (strong && strong.info.modelId !== info.modelId && strong.info.supportsTools) {
          ep = strong.ep
          key = strong.key
          info = strong.info
          adapter = getAdapter(ep.adapter)
          system = system.replace(/^- Model: .*$/m, `- Model: ${info.modelId}`)
          modelRef = { endpointId: ep.id, modelId: info.modelId }
          note('info', `The agent was still going round in circles (${stuck}), so ${info.modelId} took over for the rest of this request.`, { escalated: info.modelId })
          note('notice', `You are taking over from a model that got stuck: ${stuck}. Look at what was tried above, find the real cause and take a different approach.`, { source: 'stuck', reason: stuck })
          emit({ type: 'stuck', reason: stuck, action: 'escalated', model: info.modelId })
        } else if (strikes >= 3 || (strikes === 2 && !strong)) {
          note('info', `Prism stopped this request because the agent kept going round in circles: ${stuck}. Tell it what to try differently, or pick a stronger model.`, { stuck: stuck })
          emit({ type: 'stuck', reason: stuck, action: 'stopped' })
          return finish('stuck', `kept going round in circles: ${stuck}`)
        } else {
          note('notice', `Still going round in circles: ${stuck}. Change approach now.`, { source: 'stuck', reason: stuck })
        }
      }
      // a tool can close the turn (an approved or discarded plan): the model gets no further say
      if (endTurn) return finish('completed')
    }
    const limit: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: `Stopped after ${maxSteps} steps. Send a message to continue.`, meta: null }
    repo.appendItem(input.sessionId, limit)
    emit({ type: 'item', item: limit })
    return finish('max-steps')
  } catch (e) {
    if (isAbort(e, input.signal)) return finish('aborted')
    const msg = e instanceof Error ? e.message : String(e)
    const errItem: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'error', text: msg, meta: null }
    repo.appendItem(input.sessionId, errItem)
    emit({ type: 'item', item: errItem })
    return finish('error', msg)
  } finally {
    emit({ type: 'status', text: null })
    deps.background?.leave(input.sessionId)
  }
}

async function callModel(
  adapter: ReturnType<typeof getAdapter>,
  ep: Endpoint,
  key: string | null,
  info: ModelInfo,
  messages: Message[],
  specs: ToolSpec[],
  settings: Settings,
  signal: AbortSignal,
  emit: (ev: AgentEvent) => void
): Promise<ChatResult & { latencyMs: number }> {
  const t0 = Date.now()
  const gen = adapter.chat(ep, key, {
    model: info.modelId,
    messages,
    tools: specs.length ? specs : undefined,
    temperature: settings.agent.temperature,
    maxTokens: info.maxOutput ? Math.min(info.maxOutput, 64_000) : null,
    reasoning: settings.agent.reasoning && info.reasoning,
    signal,
    cache: true
  })
  // a long tool call (a whole file) streams for minutes with no text; show it growing
  const started = new Map<string, { name: string; chars: number }>()
  let lastNote = 0
  let r = await gen.next()
  while (!r.done) {
    const ev = r.value
    if (ev.type === 'text') emit({ type: 'text-delta', text: ev.text })
    else if (ev.type === 'reasoning') emit({ type: 'reasoning-delta', text: ev.text })
    else if (ev.type === 'tool-call-start' && !started.has(ev.id)) {
      started.set(ev.id, { name: ev.name, chars: 0 })
      emit({ type: 'status', text: `Preparing ${ev.name}…` })
    } else if (ev.type === 'tool-call-delta') {
      const s = started.get(ev.id)
      if (s) {
        s.chars += ev.argsDelta.length
        if (s.chars > 1200 && Date.now() - lastNote > 600) {
          lastNote = Date.now()
          emit({ type: 'status', text: `Writing ${s.name} · ${(s.chars / 1024).toFixed(1)} KB` })
        }
      }
    }
    r = await gen.next()
  }
  const res = r.value
  return { ...res, usage: res.usage, latencyMs: Date.now() - t0 }
}

async function executeCall(
  deps: EngineDeps,
  input: RunInput,
  tools: Map<string, AgentTool>,
  call: ToolCall,
  ctx: ToolContext,
  emit: (ev: AgentEvent) => void
): Promise<ToolResult> {
  const tool = tools.get(call.name)
  if (!tool) {
    return { content: `Unknown tool '${call.name}'. Available: ${[...tools.keys()].join(', ')}`, isError: true }
  }
  const settings = deps.settings()
  const primary = primaryOf(tool, call.args)
  const risk = tool.risk(call.args)
  const decision = decide(
    { mode: deps.modeOf?.(input.rootSessionId) ?? input.mode, allow: settings.permissions.allow, deny: settings.permissions.deny, sessionAllow: input.sessionAllow },
    call.name,
    primary,
    risk
  )
  if (decision === 'deny') return { content: 'This action is blocked by a permission rule.', isError: true }
  emit({ type: 'tool-start', call })
  let checked: string | null = null
  // the quick checker: never for high-risk actions, and it can only let things through, never refuse them
  const check = decision === 'ask' && risk !== 'high' && settings.permissions.checker && deps.checkCall ? await deps.checkCall(input.rootSessionId, call, tool.summary(call.args)).catch(() => null) : null
  if (check?.ok) checked = check.reason
  if (decision === 'ask' && !checked) {
    const approvalId = randomUUID()
    const rule = suggestRule(call.name, primary)
    const req: ApprovalRequest = { approvalId, call, risk: risk ?? 'low', summary: tool.summary(call.args), rule, ...(input.agent ? { agent: input.agent } : {}), ...(check && !check.ok ? { concern: check.reason } : {}) }
    emit({ type: 'approval', request: req })
    let verdict: ApprovalDecision | 'unasked'
    try {
      verdict = await deps.requestApproval(input.rootSessionId, req)
    } finally {
      /* resolved event is emitted by the host */
    }
    if (verdict === 'unasked') {
      return { content: 'That turn is already over, so there was nobody to ask and this card was never shown. Nobody refused anything.', isError: true }
    }
    if (verdict === 'deny') {
      return { content: 'The user declined this action. Do not retry it; ask how they would like to proceed or take a different approach.', isError: false }
    }
    if (verdict === 'always') {
      input.sessionAllow.push(rule)
      deps.addAllowRule(rule)
    }
  }
  emit({ type: 'status', text: tool.summary(call.args) })
  try {
    const stop = tool.risk(call.args) === null ? null : await deps.hooks?.before(input.rootSessionId, call).catch(() => null)
    if (stop) return { content: stop, isError: true }
    const done = await tool.execute(call.args, ctx)
    const r = checked ? { ...done, meta: { ...(done.meta ?? {}), checkedBy: checked } } : done
    const note = tool.risk(call.args) === null ? null : await deps.hooks?.after(input.rootSessionId, call, r.isError).catch(() => null)
    return note ? { ...r, content: `${r.content}\n\n${note}` } : r
  } catch (e) {
    return { content: `Tool crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  } finally {
    emit({ type: 'status', text: null })
  }
}

/** Ask the vision model what an image shows, in the context of the user's request. */
async function describeImage(model: ResolvedModel, image: ImagePart, context: string, signal: AbortSignal): Promise<string> {
  const adapter = getAdapter(model.ep.adapter)
  const gen = adapter.chat(model.ep, model.key, {
    model: model.info.modelId,
    messages: [
      {
        role: 'system',
        content:
          'You are the eyes for a coding agent that cannot see images. Describe the image precisely and completely: layout, every piece of visible text verbatim, UI elements, colours, errors, diagrams, code. Mention what seems relevant to the request. No preamble.'
      },
      { role: 'user', content: `Request context: ${context.slice(0, 1500)}`, images: [image] }
    ],
    maxTokens: 1500,
    reasoning: false,
    signal,
    cache: false
  })
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value.text.trim() || '(the vision model returned nothing)'
}

/** Summarise everything before the latest user turn into one compaction item. */
export async function compactSession(deps: EngineDeps, sessionId: string, model: ResolvedModel, signal: AbortSignal): Promise<{ afterTokens: number } | null> {
  const items = deps.repo.listItems(sessionId)
  const { toSummarise } = compactionSplit(items)
  if (toSummarise.length < 2) return null
  const text = transcriptAsText(toSummarise)
  const adapter = getAdapter(model.ep.adapter)
  const gen = adapter.chat(model.ep, model.key, {
    model: model.info.modelId,
    messages: [
      { role: 'system', content: COMPACTION_PROMPT },
      { role: 'user', content: text.slice(-600_000) }
    ],
    maxTokens: 4000,
    reasoning: false,
    signal,
    cache: false
  })
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  const summary = r.value.text.trim()
  if (!summary) return null
  const item: SystemItem = {
    kind: 'system',
    id: randomUUID(),
    ts: Date.now(),
    subkind: 'compaction',
    text: summary,
    meta: { items: toSummarise.length }
  }
  deps.repo.compactItems(sessionId, toSummarise[toSummarise.length - 1]!.id, item)
  deps.repo.recordUsage({ endpointId: model.ep.id, modelId: model.info.modelId, sessionId, ok: true, usage: { ...r.value.usage, cost: costOf(model.info, r.value.usage) } })
  return { afterTokens: estimateMessages(await messagesFromItems('', deps.repo.listItems(sessionId), new Map(), { vision: false })) }
}

/** Short session title from the first message. */
export async function generateTitle(model: ResolvedModel, text: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const adapter = getAdapter(model.ep.adapter)
    const gen = adapter.chat(model.ep, model.key, {
      model: model.info.modelId,
      messages: [
        { role: 'system', content: 'Write a 3-6 word title for a coding session that starts with the following request. Reply with the title only, no quotes, no punctuation at the end.' },
        { role: 'user', content: text.slice(0, 2000) }
      ],
      maxTokens: 24,
      reasoning: false,
      signal,
      cache: false
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    const t = r.value.text.trim().replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0] ?? ''
    return t && t.length <= 80 ? t : null
  } catch {
    return null
  }
}
