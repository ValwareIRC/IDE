import type { TranscriptItem } from '@shared/types'
import type { ToolItem, ToolCall, AgentEvent, ApprovalDecision, ApprovalRequest, PermissionMode, PermissionRule, PlanDecision, PlanRequest, QuestionRequest, ReviewDecision, ReviewRequest, SendOptions, Session, SlashCommand, ContextReport, GadgetIdea, GitOpResult, ReviewFile, AssistantItem, CompareEvent, ModelRef, SystemItem, UserItem } from '@shared/types'
import { CH } from '@shared/ipc'
import { compactSession, costOf, generateTitle, runTurn, type EngineDeps, type RunInput, type RunOutcome } from '@core/agent/engine'
import { createHelpers } from '@core/agent/helpers'
import { createFleetTools, type FleetHost, type HelperKit } from '@core/agent/tools/fleet'
import { BUILTIN_COMMANDS, customCommands, expandSlash } from '@core/agent/slash'
import { modeAllows } from '@core/agent/permissions'
import { compareMessages, opinionMessages, routeModel, streamAnswer } from '@core/agent/council'
import { randomUUID } from 'node:crypto'
import { contextReport, readPins } from '@core/agent/contextReport'
import { buildSystemPrompt } from '@core/agent/prompt'
import { buildTools } from '@core/agent/tools'
import { settingsThemeHost } from '@core/agent/tools/theme'
import { shellLabelFor } from '@core/agent/tools/shell'
import type { Services } from './services'
import { Workspace } from '@core/fs/workspace'
import { createWorktree, integrateWorktree, removeWorktree, worktreeChanges } from '@core/git/worktree'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { claudeJobs, closeClaude, runClaudeTurn, type ClaudeDeps } from '@core/claude/runner'
import { isClaudeRef } from '@core/claude/translate'
import { claudeOwnServers } from '@core/claude/locate'
import { isRemote, placeOf } from '@shared/place'
import { createGadgetTools } from '@core/agent/tools/gadgets'
import { checkProjectTool } from '@core/agent/tools/checks'
import { showTool } from '@core/agent/tools/fs'
import { attachFileTool } from '@core/agent/tools/attach'
import { todoTool } from '@core/agent/tools/misc'
import { gestureTool } from '@core/agent/tools/gesture'
import { createOpenProjectTool, createTabsLookTool } from '@core/agent/tools/window'
import { decisionRecordTool, decisionsLookTool, sessionOf, setDecisionTitles } from '@core/agent/tools/decisions'
import { record as recordDecision, type Decision } from '@core/decisions/ledger'
import { BITEBACK_NOTE, bitebackOn } from '@core/biteback/biteback'
import { createBitebackTools } from '@core/agent/tools/biteback'
import { callNote } from '@core/agent/calls'
import { findReferencesTool, renameSymbolTool } from '@core/agent/tools/refactor'
import { createBrowserTools } from '@core/agent/tools/browser'
import { createScratchTool } from '@core/agent/tools/scratch'
import { createUseSkillTool } from '@core/agent/tools/skills'
import { createImpactTool } from '@core/agent/tools/impact'
import { findBreakingCommitTool } from '@core/agent/tools/bisect'
import { createTourTool } from '@core/agent/tools/tour'
import { latestChanges } from './ipc'
import { SPEC_FILES } from '@core/spec/spec'
import { breaks, protectedAmong } from '@core/learning/rules'
import { pickSkills, skillNote, skillsPrompt, type Skill } from '@core/skills/skills'
import type { AgentTool } from '@core/agent/tools'
import { estimateTokens } from '@core/tokens'
import { HistoryRecorder } from '@core/history/recorder'
import { deferOutsideTools } from '@core/agent/tools/deferred'
import { basename, join } from 'node:path'
import { Background } from './background-host'
import { stopAllHelpers, stopHelper } from '@core/agent/helpers'
import { killJob } from '@core/agent/tools/shell'
import { checkCall, difficulty, reviewChanges } from './assist'
import { DEFAULT_SETTINGS } from '@core/store/settings'

/** Files whose change can change how a web page looks. */
const WEB_FILE = /\.(html?|css|scss|sass|less|styl|[cm]?[jt]sx?|vue|svelte|astro|mdx|svg)$/i

interface Run {
  controller: AbortController
  sessionAllow: PermissionRule[]
  approvals: Map<string, (d: ApprovalDecision) => void>
  /** Tool name behind each pending approval, so a mode switch can release the ones it now covers. */
  approvalTools: Map<string, string>
  /** The requests themselves, so a client that was not connected when they were made can still be shown them. */
  waiting: { approvals: Map<string, ApprovalRequest>; questions: Map<string, QuestionRequest>; reviews: Map<string, ReviewRequest>; plans: Map<string, PlanRequest> }
  mode: PermissionMode
  questions: Map<string, (a: string) => void>
  reviews: Map<string, (d: ReviewDecision) => void>
  plans: Map<string, { title: string; resolve: (d: PlanDecision) => void }>
  /** Set when a plan is approved: sent as the next turn once this one has ended. */
  followUp: { text: string; expanded: string; mode: PermissionMode } | null
  /** Files written during this turn, for turn-end hooks. */
  changed: Set<string>
  /** Set while Claude Code runs the turn: how to reach it mid-turn. */
  claude: { setMode(mode: PermissionMode): void; steer(text: string): boolean } | null
  /** The turn is Claude Code's: an approved plan carries on in the same turn instead of starting a new one. */
  external: boolean
}

/** The placeholder parent of quick questions: their sessions never show in the list. */
const QUICK_PARENT = 'quick-ask'
/** A session cut off longer ago than this is not picked up again by itself. */
const RESUME_WITHIN_MS = 12 * 3600_000
/** Automatic restarts in a row before Prism stops picking a session up by itself. */
const RESUME_LIMIT = 2

/**
 * Every conversation with a turn running, in any open copy of any project. Each
 * workbench only knows its own turns, and the cut-off check reads a mark kept in the
 * shared database: asked from a workbench that is not running a turn, it took a live
 * conversation for one Prism had gone down under, said so, and started it again.
 */
const RUNNING_ANYWHERE = new Set<string>()

/** An earlier conversation, shortened: what was asked, what was answered, which files changed. */
function conversationDigest(items: TranscriptItem[], files: string[], title: string): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.kind === 'user') parts.push(`User: ${it.text.slice(0, 1500)}`)
    else if (it.kind === 'assistant' && !it.toolCalls.length && it.text.trim() && !it.agent) parts.push(`Agent: ${it.text.slice(0, 2500)}`)
  }
  let body = parts.join('\n\n')
  if (body.length > 14_000) body = `…${body.slice(-14_000)}`
  const changed = [...new Set(files)]
  return `---\nThe user pointed at an earlier conversation, "${title}". What was said there:\n\n${body || '(nothing yet)'}${changed.length ? `\n\nFiles it changed: ${changed.slice(0, 40).join(', ')}` : ''}\n---`
}

export class AgentHost {
  private runs = new Map<string, Run>()
  /** Where approvals and questions from background helpers wait while their lead session is idle. */
  private idleRuns = new Map<string, Run>()
  readonly history: HistoryRecorder
  readonly background: Background

  constructor(private s: Services) {
    setDecisionTitles((id) => s.repo.getSession(id)?.title)
    this.history = new HistoryRecorder(s.repo, (id) => this.workspaceFor(id))
    this.background = new Background({
      repo: s.repo,
      settings: () => s.settings.get(),
      userData: s.userData,
      projectRoot: () => s.workspace?.root ?? null,
      running: (id) => this.runs.has(id),
      status: (id) => this.status(id),
      emit: (id, ev) => this.emit(id, ev),
      wake: async (id, notices) => {
        await this.send(id, notices.map((n) => n.text).join('\n\n'), {}, undefined, true, notices)
      },
      desktop: (id, title, body) => s.send(CH.Notice, { sessionId: id, title, body })
    })
  }

  private runOf(sessionId: string): Run | undefined {
    const run = this.runs.get(sessionId)
    if (run) return run
    let idle = this.idleRuns.get(sessionId)
    if (!idle) {
      const mode = this.s.repo.getSession(sessionId)?.mode ?? 'ask'
      idle = { controller: new AbortController(), sessionAllow: [], approvals: new Map(), approvalTools: new Map(), waiting: { approvals: new Map(), questions: new Map(), reviews: new Map(), plans: new Map() }, mode, questions: new Map(), reviews: new Map(), plans: new Map(), followUp: null, changed: new Set(), claude: null, external: false }
      this.idleRuns.set(sessionId, idle)
    }
    return idle
  }

  /**
   * A message the user typed while the agent works: it reaches the agent before its next step instead of waiting
   * for the turn to end. False when the turn cannot take one (Claude Code runs its own loop): queue it then.
   */
  steer(sessionId: string, text: string): boolean {
    const run = this.runs.get(sessionId)
    if (!run || !text.trim()) return false
    if (run.external) {
      // Claude Code runs its own loop, but its input stays open for the turn:
      // this goes in there and is taken up at its next step.
      if (!run.claude?.steer(text.trim())) return false
      const item: UserItem = { kind: 'user', id: randomUUID(), ts: Date.now(), text: text.trim(), attachments: [] }
      this.s.repo.appendItem(sessionId, item)
      this.emit(sessionId, { type: 'item', item })
      return true
    }
    this.background.notify({ sessionId, rootSessionId: sessionId }, text.trim(), { source: 'steer' }, true)
    return true
  }

  /**
   * A quick question from the overlay: answered by a read-only turn in a session of its own that never
   * shows in the sessions list (its parent is a placeholder). Returns that session's id to follow.
   */
  quickAsk(text: string): string {
    const ws = this.s.requireWorkspace()
    const ref = this.s.settings.get().roles.fast ?? this.s.defaultModel()
    if (!ref || isClaudeRef(ref)) throw new Error('Quick questions need a model Prism runs itself: pick one for the Fast role (Settings, Model roles).')
    const child = this.s.repo.createSession(ws.root, text.replace(/\s+/g, ' ').slice(0, 60), ref, 'ask', QUICK_PARENT)
    const controller = new AbortController()
    this.quick.set(child.id, controller)
    void runTurn(this.deps(child.id), {
      sessionId: child.id,
      rootSessionId: child.id,
      model: ref,
      mode: 'ask',
      text,
      attachments: [],
      depth: 0,
      readOnly: true,
      signal: controller.signal,
      sessionAllow: [],
      systemExtra: 'This is a quick question from an overlay, not a working session. Answer briefly and directly; point to files as path:line. Read what you need to be sure, but do not explore beyond the question. You can only read.'
    })
      .catch((e: unknown) => this.emit(child.id, { type: 'run-end', reason: 'error', error: e instanceof Error ? e.message : String(e), durationMs: 0 }))
      .finally(() => this.quick.delete(child.id))
    // keep only the latest few
    const old = this.s.repo.listChildren(QUICK_PARENT)
    for (const id of old.slice(0, Math.max(0, old.length - 30))) this.s.repo.deleteSession(id)
    return child.id
  }

  stopQuick(id: string): void {
    this.quick.get(id)?.abort()
  }

  private quick = new Map<string, AbortController>()

  /** What a session waits on in the background, for its header. */
  backgroundState(sessionId: string): import('@shared/types').BackgroundState {
    return this.background.state(sessionId)
  }

  /** The user cancelled something from the list in the session header. */
  cancelBackground(sessionId: string, kind: 'job' | 'timer' | 'helper', id: string): boolean {
    const ok = kind === 'job' ? killJob(id) : kind === 'timer' ? this.background.timers.cancel(sessionId, id) : stopHelper(sessionId, id)
    this.background.changed(sessionId)
    return ok
  }

  /** A deleted session takes its helpers and timers with it. */
  forget(sessionId: string): void {
    stopAllHelpers(sessionId)
    this.idleRuns.delete(sessionId)
    closeClaude(sessionId)
  }

  /** How each session's latest turn ended, for listeners. */
  private lastEnd = new Map<string, string>()
  private turnEndListeners = new Set<(sessionId: string, reason: string) => void>()

  /** Called after every turn of a lead session ends (the task board waits on this). */
  onTurnEnd(cb: (sessionId: string, reason: string) => void): () => void {
    this.turnEndListeners.add(cb)
    return () => this.turnEndListeners.delete(cb)
  }

  private emit(sessionId: string, ev: AgentEvent): void {
    if (ev.type === 'run-end' && !('agent' in ev && ev.agent)) this.lastEnd.set(sessionId, ev.reason)
    if (ev.type === 'file-touched' && ev.op !== 'read') {
      this.runs.get(sessionId)?.changed.add(ev.path)
      this.history.changed(sessionId, ev.path, ev.callId ?? null)
    }
    // a helper agent's own messages are not turns of the session
    if (ev.type === 'item' && ev.item.kind === 'user' && !('agent' in ev && ev.agent)) this.history.turnStarted(sessionId, ev.item.id)
    this.s.send(CH.AgentEventPrefix + sessionId, ev)
    for (const l of this.eventListeners) l(sessionId, ev)
  }

  private eventListeners = new Set<(sessionId: string, ev: AgentEvent) => void>()
  /** Background work that keeps this project going with no window on it: jobs, running helpers, timers. */
  backgroundBusy(): boolean {
    for (const s of this.listSessions()) {
      const b = this.background.state(s.id)
      if (b.jobs.length || b.timers.length || b.helpers.some((h) => h.running)) return true
      // what Claude Code runs in the background counts too: closing the window must not kill a build
      if (claudeJobs(s.id).length) return true
      // a session waiting to carry on after Prism went down: its project stays open until it has
      if (this.s.repo.getSessionExtras(s.id).working) return true
    }
    return false
  }

  /** Set once Prism is going down: a turn cut off by that is not finished, and keeps its mark. */
  private quitting = false

  /** Noted as a session starts working, so a Prism that goes down under it can pick it up again. */
  private markWorking(sessionId: string): void {
    const prev = this.s.repo.getSessionExtras(sessionId).working
    this.s.repo.setSessionExtras(sessionId, { working: { since: Date.now(), turn: true, jobs: [], resumes: prev?.resumes ?? 0 } })
  }

  /**
   * Prism is going down. What each session is in the middle of — a turn, or jobs running in the
   * background — is noted on it first, so it carries on once Prism is back (resumeCutOff); then
   * everything is stopped.
   */
  shutdown(): void {
    this.quitting = true
    for (const s of this.listSessions()) {
      const jobs = [...claudeJobs(s.id), ...this.background.state(s.id).jobs.map((j) => j.command)]
      const turn = this.runs.has(s.id)
      if (!turn && !jobs.length) continue
      const prev = this.s.repo.getSessionExtras(s.id).working
      this.s.repo.setSessionExtras(s.id, { working: { since: prev?.since ?? Date.now(), turn, jobs, resumes: prev?.resumes ?? 0 } })
    }
    this.abortAll()
  }

  /**
   * A project has opened: each session Prism went down under carries on where it was, told what was
   * cut off. Not marks from long ago, and not for ever: work that keeps bringing Prism down stops
   * being restarted after two goes, and says so.
   */
  resumeCutOff(): void {
    for (const s of this.listSessions()) {
      const w = this.s.repo.getSessionExtras(s.id).working
      if (!w || this.runs.has(s.id) || RUNNING_ANYWHERE.has(s.id)) continue
      if (Date.now() - w.since > RESUME_WITHIN_MS) {
        this.s.repo.setSessionExtras(s.id, { working: null })
        continue
      }
      if (w.resumes >= RESUME_LIMIT) {
        this.s.repo.setSessionExtras(s.id, { working: null })
        const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: 'Prism went down twice in a row while this was working, so it has not carried on by itself again. Send a message to pick it up.', meta: null }
        this.s.repo.appendItem(s.id, item)
        this.emit(s.id, { type: 'item', item })
        continue
      }
      // counted before it starts, so a resumed turn that brings Prism down again still counts
      this.s.repo.setSessionExtras(s.id, { working: { ...w, resumes: w.resumes + 1 } })
      const at = new Date(w.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const parts = [w.turn ? `Prism restarted while you were working on this, cutting off the turn that started at ${at}. Carry on from where you left off; check what was already done before doing it again.` : 'Prism restarted, which stopped what you were running in the background.']
      if (w.jobs.length) parts.push(`These were running in the background and were stopped: ${w.jobs.join('; ')}. Start them again if they are still needed${w.turn ? '' : ', and carry on'}.`)
      const text = parts.join(' ')
      const notice: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'notice', text, meta: { resumed: true } }
      void this.send(s.id, text, {}, undefined, true, [notice]).catch((e: unknown) => {
        // it could not start (no model, say): the mark goes, so nothing waits on it for ever, and the reason is shown
        this.s.repo.setSessionExtras(s.id, { working: null })
        const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: `Prism restarted while this was working, but could not carry on by itself: ${e instanceof Error ? e.message : String(e)}`, meta: null }
        this.s.repo.appendItem(s.id, item)
        this.emit(s.id, { type: 'item', item })
      })
    }
  }

  dispose(): void {
    this.background.dispose()
    // the Claude Code serving a conversation is a program of its own, and would outlive Prism
    for (const id of this.claudeUsed) closeClaude(id)
  }

  /** Conversations that have had a Claude Code started for them, so quitting can shut each one. */
  private claudeUsed = new Set<string>()

  /** Every event of every session (the phone remote listens). */
  onEvent(cb: (sessionId: string, ev: AgentEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private copies = new Map<string, Workspace>()

  /** Where a session's tools read and write: its own copy when it has one, else the project folder. */
  workspaceFor(sessionId: string): Workspace {
    const wt = this.s.repo.getSessionExtras(sessionId).worktree
    if (!wt) return this.s.requireWorkspace()
    if (!existsSync(wt.path)) throw new Error('This session\'s copy of the project is gone. Start a new session.')
    let ws = this.copies.get(sessionId)
    if (!ws || ws.root !== wt.path) {
      ws = new Workspace(wt.path)
      this.copies.set(sessionId, ws)
    }
    return ws
  }

  /** A new session that works on its own branch in its own folder, leaving the project's files alone. */
  async createInCopy(title?: string): Promise<Session> {
    const ws = this.s.requireWorkspace()
    if (isRemote(ws.root)) throw new Error('A session in its own copy is not available yet for a folder in WSL or on another computer.')
    const session = this.s.repo.createSession(ws.root, title ?? 'New session', this.s.defaultModel(), this.s.settings.get().permissions.mode)
    const short = session.id.slice(0, 8)
    try {
      const wt = await createWorktree(ws.root, join(this.s.userData, 'worktrees', `${basename(ws.root)}-${short}`), `prism/${short}`)
      this.s.repo.setSessionExtras(session.id, { worktree: wt })
    } catch (e) {
      this.s.repo.deleteSession(session.id)
      throw e
    }
    this.broadcastSessions()
    return session
  }

  copyChanges(sessionId: string): Promise<ReviewFile[]> {
    const wt = this.s.repo.getSessionExtras(sessionId).worktree
    return wt ? worktreeChanges(wt) : Promise.resolve([])
  }

  /** Merge the copy's branch into the project's current branch. The copy stays until it is discarded. */
  async integrateCopy(sessionId: string): Promise<GitOpResult> {
    if (this.runs.has(sessionId)) throw new Error('Wait for the current turn to finish first.')
    const wt = this.s.repo.getSessionExtras(sessionId).worktree
    if (!wt) throw new Error('This session works directly in the project.')
    const session = this.s.repo.getSession(sessionId)
    return integrateWorktree(this.s.requireWorkspace().root, wt, session?.title && session.title !== 'New session' ? session.title : 'Work from a Prism session')
  }

  /** Delete the copy and its branch; the session goes back to working in the project folder. */
  async discardCopy(sessionId: string): Promise<GitOpResult> {
    if (this.runs.has(sessionId)) throw new Error('Wait for the current turn to finish first.')
    const wt = this.s.repo.getSessionExtras(sessionId).worktree
    if (!wt) return { ok: true, output: '' }
    this.copies.get(sessionId)?.close()
    this.copies.delete(sessionId)
    const r = await removeWorktree(this.s.requireWorkspace().root, wt)
    this.s.repo.setSessionExtras(sessionId, { worktree: null })
    this.broadcastSessions()
    return r
  }

  private deps(sessionId: string): EngineDeps {
    return {
      repo: this.s.repo,
      workspace: this.workspaceFor(sessionId),
      settings: () => this.s.settings.get(),
      resolveModel: (ref) => this.s.resolveModel(ref),
      findModel: (id) => this.s.findModel(id),
      mcp: () => this.s.liveMcp(),
      gadgets: () => this.s.gadgets,
      browser: () => this.s.preview,
      theme: () => settingsThemeHost(this.s.settings),
      background: this.background,
      memoryDir: join(this.s.userData, 'memory'),
      prism: () => ({
        settings: () => this.s.settings.get(),
        defaults: () => DEFAULT_SETTINGS,
        update: (patch) => void this.s.settings.update(patch),
        open: (panel, section) => this.s.send('gadget:ui', { kind: 'openPanel', panel, section }),
        tabs: () => this.s.tabs()
      }),
      scratch: () => this.s.scratch,
      skills: () => this.s.skills(),
      customTools: () => this.s.customTools.tools(),
      impact: { latest: (sid) => this.history.settled(sid).then(() => latestChanges(this.s, sid)) },
      protectedBy: (sid, paths) => this.protectedBy(sid, paths),
      visionModel: () => this.s.visionModel(),
      // these take over Prism's own agent mid-request, with its tools: a Claude Agent model cannot
      fallbackModel: () => {
        const ref = this.s.settings.get().roles.fallback
        return ref && !isClaudeRef(ref) ? this.s.resolveModel(ref) : null
      },
      strongModel: () => {
        const ref = this.s.settings.get().roles.strong
        return ref && !isClaudeRef(ref) ? this.s.resolveModel(ref) : null
      },
      storeImage: (im) => this.s.storeImage(im),
      emit: (sid, ev) => this.emit(sid, ev),
      requestApproval: (sid, req) => this.requestApproval(sid, req),
      checkCall: (sid, call, summary) => checkCall(this.s, sid, call, summary),
      modeOf: (sid) => this.runs.get(sid)?.mode ?? null,
      requestAnswer: (sid, req) => this.requestAnswer(sid, req),
      requestReview: (sid, req) => this.requestReview(sid, req),
      requestPlan: (sid, req) => this.requestPlan(sid, req),
      hooks: {
        before: (sid, call) => this.beforeTool(sid, call),
        after: (sid, call, isError) => this.s.automations.afterTool(sid, call, isError)
      },
      addAllowRule: (rule) => {
        const cur = this.s.settings.get().permissions
        if (!cur.allow.some((r) => r.tool === rule.tool && r.pattern === rule.pattern)) {
          this.s.settings.update({ permissions: { ...cur, allow: [...cur.allow, rule] } })
        }
      }
    }
  }

  /**
   * What a session is in the middle of, for a client that has just connected. The
   * cards for an unanswered question or approval are built from events as they
   * happen, so a phone that was not here when they were asked would show a session
   * that is working, with nothing to answer and no way to get on with it.
   */
  pending(sessionId: string): {
    running: boolean
    approvals: ApprovalRequest[]
    questions: QuestionRequest[]
    reviews: ReviewRequest[]
    plans: PlanRequest[]
  } {
    const run = this.runs.get(sessionId) ?? this.idleRuns.get(sessionId)
    return {
      running: this.runs.has(sessionId),
      approvals: run ? [...run.waiting.approvals.values()] : [],
      questions: run ? [...run.waiting.questions.values()] : [],
      reviews: run ? [...run.waiting.reviews.values()] : [],
      plans: run ? [...run.waiting.plans.values()] : []
    }
  }

  status(sessionId: string): Session['status'] {
    const idle = this.idleRuns.get(sessionId)
    const run = this.runs.get(sessionId) ?? (idle && (idle.approvals.size || idle.questions.size || idle.reviews.size || idle.plans.size) ? idle : undefined)
    if (!run) return 'idle'
    return run.approvals.size || run.questions.size || run.reviews.size || run.plans.size ? 'waiting' : 'running'
  }

  listSessions(): Session[] {
    const ws = this.s.workspace
    if (!ws) return []
    return this.s.repo.listSessions(ws.root).map((x) => ({ ...x, status: this.status(x.id) }))
  }

  private broadcastSessions(): void {
    this.s.send(CH.SessionChanged, this.listSessions())
  }

  async commands(): Promise<SlashCommand[]> {
    const ws = this.s.workspace
    const custom = ws ? await customCommands(ws) : []
    const own = [...BUILTIN_COMMANDS, ...custom]
    // Claude Code's commands are offered in Claude Agent sessions; Prism's win a name clash
    const taken = new Set(own.map((c) => c.name))
    return [...own, ...this.s.claude.commands().filter((c) => !taken.has(c.name))]
  }

  async send(sessionId: string, text: string, opts: SendOptions = {}, prepared?: string, automatic = false, notices?: SystemItem[]): Promise<{ runId: string }> {
    // JSON has no "undefined": a client that left the options out sends null, which a
    // default parameter does not stand in for
    opts = opts ?? {}
    // a message from the user starts a fresh allowance of automatic fix-up turns and wake-ups
    if (!automatic) {
      this.autoFixes.delete(sessionId)
      this.background.userSpoke(sessionId)
    }
    const session = this.s.repo.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if (this.runs.has(sessionId)) throw new Error('The agent is still working on this session. Stop it first or wait.')
    const ws = this.s.requireWorkspace()
    if (session.workspace !== ws.root) throw new Error('This session belongs to a different workspace.')
    // Biteback: the agent ended this conversation, with a handover; a new one can start at once
    const ended = this.s.repo.getSessionExtras(sessionId).ended
    if (ended) throw new Error(`The agent ended this conversation: ${ended.reason} Its handover is the last thing it said. Start a new conversation to carry on.`)

    const mode: PermissionMode = opts.mode ?? session.mode
    // "Auto" sessions keep no model of their own: the routing rules choose one for each message
    const auto = opts.auto === true || (!opts.model && !session.model)
    const routed = auto ? routeModel(this.s.settings.get(), { text, hasImages: (opts.attachments ?? []).some((a) => a.mime.startsWith('image/')), mode }) : null
    let routedOk = routed && this.s.usable(routed.model) ? routed.model : null
    // no rule matched: by how hard it looks (when switched on)
    if (auto && !routedOk && this.s.settings.get().routing?.byDifficulty) {
      const level = await difficulty(this.s, text)
      const roles = this.s.settings.get().roles
      const pick = level === 'easy' ? roles.fast : level === 'hard' ? roles.strong : null
      if (pick && this.s.usable(pick)) routedOk = pick
      this.emit(sessionId, { type: 'status', text: `Auto: this looks ${level}, so ${(routedOk ?? this.s.defaultModel())?.modelId ?? 'the default model'} takes it` })
    }
    const model = (auto ? routedOk : null) ?? opts.model ?? (auto ? null : session.model) ?? this.s.defaultModel()
    if (!model) throw new Error('No model configured. Add an endpoint in Settings and pick a model.')
    const viaClaude = isClaudeRef(model)
    const claudeExe = viaClaude ? this.s.claude.exe() : null
    if (viaClaude && isRemote(ws.root)) throw new Error('Claude Agent runs Claude Code on this computer, so it cannot work in a folder inside WSL or on another computer. Pick another model for this project, or run Claude Code on that side in a terminal.')
    if (viaClaude && !claudeExe) throw new Error('Claude Code was not found on this computer. Install it and sign in, or set where it is under Settings, Claude Agent.')
    this.s.repo.updateSession(sessionId, { model: auto ? null : model, mode })

    // Slash commands. Claude Code has its own (/compact, /context, …): those go to it as typed.
    let expanded: string | undefined = prepared
    const slash = notices?.length ? null : expandSlash(text, viaClaude ? (await this.commands()).filter((c) => c.source === 'custom' || (c.source === 'builtin' && !!c.prompt)) : await this.commands())
    if (slash) {
      if (slash.command.name === 'compact') {
        const t0 = Date.now()
        try {
          await this.compact(sessionId)
        } finally {
          // the message box shows the session busy until it hears the turn ended
          this.emit(sessionId, { type: 'run-end', reason: 'completed', durationMs: Date.now() - t0 })
        }
        return { runId: 'compact' }
      }
      if (slash.command.name === 'clear') throw new Error('Use the New session button to start fresh.')
      expanded = slash.prompt
    }

    // @[title](conversation:id): what was said in an earlier conversation comes with the message
    const refs = [...text.matchAll(/@\[([^\]]+)\]\(conversation:([\w-]+)\)/g)]
    if (refs.length) {
      const digests = refs.slice(0, 4).map(([, title, id]) => conversationDigest(this.s.repo.listItems(id!), this.s.repo.listFileVersions(id!).map((v) => v.path), title!))
      expanded = `${expanded ?? text}\n\n${digests.join('\n\n')}`
    }

    // the page being worked on, as it looks before this turn (only when one is open in the Browser panel)
    const pageUrl = this.s.preview.pageUrl()
    const pageBefore = pageUrl && this.s.settings.get().assist?.pagePictures !== false ? this.s.preview.render(pageUrl).catch(() => null) : null
    if (!automatic && !prepared) void this.learn(sessionId, text).catch(() => {})
    const rulesNote = await this.rulesText(sessionId)
    const run: Run = { controller: new AbortController(), sessionAllow: [], approvals: new Map(), approvalTools: new Map(), waiting: { approvals: new Map(), questions: new Map(), reviews: new Map(), plans: new Map() }, mode, questions: new Map(), reviews: new Map(), plans: new Map(), followUp: null, changed: new Set(), claude: null, external: viaClaude }
    this.runs.set(sessionId, run)
    RUNNING_ANYWHERE.add(sessionId)
    this.markWorking(sessionId)
    this.broadcastSessions()
    const copy = this.s.repo.getSessionExtras(sessionId).worktree
    const runId = `${sessionId}:${Date.now()}`
    const isFirst = session.itemCount === 0

    void (async () => {
      try {
        if (viaClaude && claudeExe) {
          // skills join a Claude session the same way: by the words in the message, and they stay
          const allSkills = await this.s.skills().catch(() => [])
          const inUse = (): string[] => this.s.repo.getSessionExtras(sessionId).skills ?? []
          const picked = pickSkills(allSkills, inUse(), `${text}\n${expanded ?? ''}`)
          if (picked.fresh.length) this.s.repo.setSessionExtras(sessionId, { skills: picked.loaded.map((x) => x.name) })
          const more: AgentTool[] = await this.s.customTools.tools().catch(() => [])
          if (picked.others.length) {
            more.push(
              createUseSkillTool({
                all: () => allSkills,
                use: (x: Skill) => {
                  if (!inUse().includes(x.name)) this.s.repo.setSessionExtras(sessionId, { skills: [...inUse(), x.name] })
                }
              })
            )
          }
          await runClaudeTurn(this.claudeDeps(sessionId, run, claudeExe, more), {
            sessionId,
            model,
            mode,
            text: notices?.length ? `[Notice from Prism, not written by the user]\n${text}` : text,
            expanded,
            attachments: opts.attachments ?? [],
            signal: run.controller.signal,
            append: this.claudeFixed(sessionId),
            context: await this.claudeContext(sessionId, allSkills),
            effort: this.s.repo.getSessionExtras(sessionId).effort ?? null,
            notes: picked.fresh.length ? [{ text: skillNote(picked.fresh), meta: { skills: picked.fresh.map((x) => x.name) } }] : [],
            contextWindow: this.s.claude.models().find((m) => m.modelId === model.modelId)?.contextWindow ?? null
          })
        } else await runTurn(this.deps(sessionId), {
          sessionId,
          rootSessionId: sessionId,
          model,
          mode,
          text,
          expanded,
          attachments: opts.attachments ?? [],
          depth: 0,
          readOnly: false,
          signal: run.controller.signal,
          sessionAllow: run.sessionAllow,
          ...(notices?.length ? { notices } : {}),
          ...(copy || rulesNote ? { systemExtra: [rulesNote, copy ? `You are working in a separate copy of the project (a git worktree at ${copy.path}, on branch ${copy.branch}). The user's own project folder is untouched until they bring your work in, so work freely here. Dependencies may not be installed in this copy: install them first if a build or test needs them. Do not switch branches and do not merge; the user does that from Prism.` : ''].filter(Boolean).join('\n\n') } : {})
        })
      } catch (e) {
        this.emit(sessionId, { type: 'run-end', reason: 'error', error: e instanceof Error ? e.message : String(e), durationMs: 0 })
      } finally {
        const { aborted, followUp } = await this.turnFinished(sessionId, run)
        if (!aborted && run.changed.size && this.s.settings.get().assist?.autoReview) void this.reviewTurn(sessionId, text).catch(() => {})
        if (!aborted && pageUrl && pageBefore && [...run.changed].some((p) => WEB_FILE.test(p))) void this.pageAfter(sessionId, pageUrl, pageBefore)
        // an approved plan becomes the next turn, in the mode the user chose for it
        if (followUp) setTimeout(() => void this.send(sessionId, followUp.text, { mode: followUp.mode }, followUp.expanded).catch(() => {}), 150)
        if (isFirst && session.title === 'New session' && this.s.settings.get().agent.autoTitle !== false) {
          const titler = this.s.roleModel('fast') ?? this.s.resolveModel(model)
          // with only Claude Code set up there is no quick model to ask: the start of the message names the session
          const title = titler ? await generateTitle(titler, text) : text.split(/\s+/).join(' ').trim().slice(0, 48)
          if (title) {
            this.s.repo.updateSession(sessionId, { title })
            this.broadcastSessions()
          }
        }
      }
    })()
    return { runId }
  }

  /** What happens after every turn of a session ends, whoever started it. */
  private async turnFinished(sessionId: string, run: Run): Promise<{ aborted: boolean; followUp: Run['followUp'] }> {
    const followUp = run.followUp
    const aborted = run.controller.signal.aborted
    this.runs.delete(sessionId)
    RUNNING_ANYWHERE.delete(sessionId)
    // the turn is over, whether finished or stopped; one cut off by Prism going down keeps its mark
    if (!this.quitting) this.s.repo.setSessionExtras(sessionId, { working: null })
    // a background helper may still be waiting on the user: its request outlives the lead's turn
    if (run.approvals.size || run.questions.size || run.reviews.size) {
      const idle = this.runOf(sessionId)!
      for (const [k, v] of run.approvals) idle.approvals.set(k, v)
      for (const [k, v] of run.approvalTools) idle.approvalTools.set(k, v)
      for (const [k, v] of run.waiting.approvals) idle.waiting.approvals.set(k, v)
      for (const [k, v] of run.waiting.questions) idle.waiting.questions.set(k, v)
      for (const [k, v] of run.waiting.reviews) idle.waiting.reviews.set(k, v)
      for (const [k, v] of run.questions) idle.questions.set(k, v)
      for (const [k, v] of run.reviews) idle.reviews.set(k, v)
    }
    this.broadcastSessions()
    // news that came in too late for this turn, and a reply another session is waiting for
    const said = this.s.repo.listItems(sessionId).reverse().find((it) => it.kind === 'assistant' && it.text.trim())
    this.background.turnEnded(sessionId, said && said.kind === 'assistant' ? said.text : '', aborted)
    const reason = aborted ? 'aborted' : (this.lastEnd.get(sessionId) ?? 'completed')
    for (const l of this.turnEndListeners) {
      try {
        l(sessionId, reason)
      } catch {
        /* a listener's problem */
      }
    }
    // turn-end hooks; a failing one may send the agent back to fix it, a bounded number of times
    if (!aborted && !followUp) {
      const fix = await this.s.automations.turnEnd(sessionId, [...run.changed]).catch(() => null)
      const n = this.autoFixes.get(sessionId) ?? 0
      if (fix && n < (this.s.settings.get().agent.hookFixes ?? 2) && !this.runs.has(sessionId)) {
        this.autoFixes.set(sessionId, n + 1)
        setTimeout(() => void this.send(sessionId, fix, {}, undefined, true).catch(() => {}), 150)
      }
    }
    if (this.specSync.has(sessionId)) {
      // a plan turn changes nothing; the approved plan's own turn (followUp) carries the flag on
      if (aborted || (!followUp && !run.changed.size)) this.specSync.delete(sessionId)
      else if (!followUp) {
        this.specSync.delete(sessionId)
        await this.s.spec.markSynced(this.workspaceFor(sessionId)).catch(() => {})
        this.s.send(CH.SpecChanged, null)
      }
    } else if (!aborted && run.changed.size) void this.checkSpec(sessionId, [...run.changed]).catch(() => {})
    if (!aborted && !followUp) void this.considerGadget(sessionId).catch(() => {})
    return { aborted, followUp }
  }

  /**
   * Claude Code started a turn by itself: something it was running in the background finished and
   * it is reporting back. That is a turn like any other — shown as running, able to be stopped,
   * steered and to ask for approval — and it ends the way any other turn does.
   */
  /**
   * Out of Claude until the limit resets: a timer a minute after the reset wakes the
   * conversation to carry on where it stopped, so a run cut off by the limit finishes by
   * itself. One per reset time; the user sees it with the other timers and can cancel it.
   */
  private carryOnAfterLimit(sessionId: string, resetsAt: number): void {
    const note = 'Your Claude usage limit has reset. Carry on from where you stopped when it ran out.'
    const dueAt = resetsAt + 60_000
    if (this.background.timers.list(sessionId).some((w) => w.note === note && Math.abs(w.dueAt - dueAt) < 120_000)) return
    this.background.timers.add(sessionId, { dueAt, note })
    const at = new Date(dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: `The Claude usage limit has been reached. This conversation will carry on by itself at ${at}, once it resets.`, meta: { limit: true } }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  private claudeSelfTurn(sessionId: string, model: ModelRef): boolean {
    if (this.runs.has(sessionId)) return false
    const session = this.s.repo.getSession(sessionId)
    const exe = this.s.claude.exe()
    if (!session || !exe) return false
    const mode = session.mode
    const run: Run = { controller: new AbortController(), sessionAllow: [], approvals: new Map(), approvalTools: new Map(), waiting: { approvals: new Map(), questions: new Map(), reviews: new Map(), plans: new Map() }, mode, questions: new Map(), reviews: new Map(), plans: new Map(), followUp: null, changed: new Set(), claude: null, external: true }
    this.runs.set(sessionId, run)
    RUNNING_ANYWHERE.add(sessionId)
    this.markWorking(sessionId)
    this.broadcastSessions()
    void (async () => {
      try {
        await runClaudeTurn(this.claudeDeps(sessionId, run, exe), { sessionId, model, mode, text: '', attachments: [], signal: run.controller.signal, self: true })
      } catch (e) {
        this.emit(sessionId, { type: 'run-end', reason: 'error', error: e instanceof Error ? e.message : String(e), durationMs: 0 })
      } finally {
        const { followUp } = await this.turnFinished(sessionId, run)
        if (followUp) setTimeout(() => void this.send(sessionId, followUp.text, { mode: followUp.mode }, followUp.expanded).catch(() => {}), 150)
      }
    })()
    return true
  }

  /** Automatic review: a second model reads what this turn changed and says what is wrong, if anything. */
  private async reviewTurn(sessionId: string, request: string): Promise<void> {
    await this.history.settled(sessionId)
    const files = await latestChanges(this.s, sessionId)
    // what the agent wrote down as guesses this turn, so the review does not take them for oversights
    const items = this.s.repo.listItems(sessionId)
    let from = items.length - 1
    while (from > 0 && items[from]!.kind !== 'user') from--
    const guesses = items.slice(from).flatMap((it) => (it.kind === 'tool' && it.name === 'assume' ? [String(it.args['assumption'] ?? '')] : []))
    const r = await reviewChanges(this.s, files, guesses.length ? `${request}\n\n(The agent noted these assumptions for the user to confirm: ${guesses.join('; ')})` : request)
    if (!r) return
    const ok = /^looks right\.?$/i.test(r.text)
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'opinion', text: r.text, meta: { model: r.model, review: true, ok, files: files.length } }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  /** After a turn that changed web files: the page again, next to how it looked before, in the conversation. */
  private async pageAfter(sessionId: string, url: string, before: Promise<Buffer | null>): Promise<void> {
    const was = await before
    // a dev server rebuilds after the files change
    await new Promise((r) => setTimeout(r, 1500))
    const now = await this.s.preview.render(url).catch(() => null)
    if (!was || !now) return
    if (was.equals(now)) return
    const [b, a] = await Promise.all([this.s.storeImage({ mime: 'image/png', base64: was.toString('base64') }), this.s.storeImage({ mime: 'image/png', base64: now.toString('base64') })])
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'visual', text: `How ${url} looks now`, meta: { url, before: b, after: a } }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  /**
   * A file a gadget hands over (a build from the release desk, a picture from the phone):
   * a card in the conversation most recently used, exactly as if attach_file had been
   * called there, so the phone can download it the same way.
   */
  async attachToCurrent(path: string, note: string, from: string): Promise<void> {
    const ws = this.s.requireWorkspace()
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) throw new Error(`${basename(path)} is not there.`)
    const target = this.s.repo.listSessions(ws.root)[0] ?? this.s.repo.createSession(ws.root, 'New session', this.s.defaultModel(), this.s.settings.get().permissions.mode)
    const item: ToolItem = {
      kind: 'tool',
      id: randomUUID(),
      ts: Date.now(),
      callId: randomUUID(),
      name: 'attach_file',
      args: { path, note },
      content: `${from} handed over ${basename(path)} (${st.size} bytes).`,
      isError: false,
      durationMs: 0,
      diff: null,
      meta: { attach: { path, name: basename(path), size: st.size, note: note || `From ${from}` } }
    }
    this.s.repo.appendItem(target.id, item)
    this.emit(target.id, { type: 'item', item })
    this.s.send('gadget:ui', { kind: 'focusSession', id: target.id })
  }

  /** A message from outside the composer (a gadget): goes to the newest idle session, or a new one. */
  async sendToCurrent(text: string): Promise<void> {
    const ws = this.s.requireWorkspace()
    let target = this.s.repo.listSessions(ws.root).find((x) => !this.runs.has(x.id))
    if (!target) target = this.s.repo.createSession(ws.root, 'New session', this.s.defaultModel(), this.s.settings.get().permissions.mode)
    this.s.send('gadget:ui', { kind: 'focusSession', id: target.id })
    await new Promise((r) => setTimeout(r, 150))
    await this.send(target.id, text)
  }

  abort(sessionId: string): void {
    const run = this.runs.get(sessionId)
    if (!run) return
    run.controller.abort()
    for (const [id, resolve] of run.approvals) {
      resolve('deny')
      this.emit(sessionId, { type: 'approval-resolved', approvalId: id, decision: 'deny' })
    }
    run.approvals.clear()
    run.approvalTools.clear()
    run.waiting.approvals.clear()
    run.waiting.questions.clear()
    run.waiting.reviews.clear()
    run.waiting.plans.clear()
    for (const [id, resolve] of run.questions) {
      resolve('')
      this.emit(sessionId, { type: 'question-resolved', questionId: id })
    }
    run.questions.clear()
    // a stopped run writes nothing that was waiting for review
    for (const [, resolve] of run.reviews) resolve({ files: [] })
    run.reviews.clear()
    for (const [, p] of run.plans) p.resolve({ action: 'discard', plan: '' })
    run.plans.clear()
    run.followUp = null
  }

  abortAll(): void {
    for (const id of [...this.runs.keys()]) this.abort(id)
  }

  approve(sessionId: string, approvalId: string, decision: ApprovalDecision): void {
    const run = this.runOf(sessionId)
    const resolve = run?.approvals.get(approvalId)
    if (!run || !resolve) return
    run.approvals.delete(approvalId)
    run.approvalTools.delete(approvalId)
    run.waiting.approvals.delete(approvalId)
    resolve(decision)
    this.emit(sessionId, { type: 'approval-resolved', approvalId, decision })
    this.broadcastSessions()
  }

  answer(sessionId: string, questionId: string, answer: string): void {
    const run = this.runOf(sessionId)
    const resolve = run?.questions.get(questionId)
    if (!run || !resolve) return
    run.questions.delete(questionId)
    run.waiting.questions.delete(questionId)
    resolve(answer)
    this.broadcastSessions()
  }

  /** Kept for the session's next message; a turn already running carries on with the model it started with. */
  setModel(sessionId: string, model: ModelRef | null): void {
    if (!this.s.repo.getSession(sessionId)) throw new Error('That session no longer exists.')
    this.s.repo.updateSession(sessionId, { model })
    this.broadcastSessions()
  }

  /** Applies at once: a running turn follows the new mode, and anything it was waiting on that the mode now covers goes ahead. */
  setMode(sessionId: string, mode: PermissionMode): void {
    this.s.repo.updateSession(sessionId, { mode })
    const run = this.runs.get(sessionId)
    if (run) {
      run.mode = mode
      run.claude?.setMode(mode)
      for (const [id, tool] of [...run.approvalTools]) if (modeAllows(mode, tool)) this.approve(sessionId, id, 'once')
    }
    this.broadcastSessions()
  }

  async compact(sessionId: string): Promise<void> {
    const session = this.s.repo.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const ref = session.model ?? this.s.defaultModel()
    // Claude Code summarises its own conversation
    if (isClaudeRef(ref) && this.s.repo.getSessionExtras(sessionId).claude) {
      await this.send(sessionId, '/compact')
      return
    }
    const model = ref ? this.s.resolveModel(ref) : null
    if (!model) throw new Error('No model available to compact with.')
    const ctl = new AbortController()
    this.emit(sessionId, { type: 'status', text: 'Compacting context…' })
    try {
      const r = await compactSession(this.deps(sessionId), sessionId, model, ctl.signal)
      this.emit(sessionId, { type: 'compaction', beforeTokens: 0, afterTokens: r?.afterTokens ?? 0 })
    } finally {
      this.emit(sessionId, { type: 'status', text: null })
    }
  }

  private requestApproval(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision | 'unasked'> {
    const run = this.runOf(sessionId)
    // No run means the turn is over and the card has nowhere to appear. Answering
    // "deny" here was read as the user refusing, so the agent stopped and said they
    // had said no to something they were never shown — which is how a tool call made
    // just after a long job came back refused by a person who had not touched it.
    if (!run) return Promise.resolve('unasked')
    return new Promise<ApprovalDecision>((resolve) => {
      run.approvals.set(req.approvalId, resolve)
      run.approvalTools.set(req.approvalId, req.call.name)
      run.waiting.approvals.set(req.approvalId, req)
      this.broadcastSessions()
    })
  }

  /** Prism's own tool servers, ready to hand to Claude Code (see ClaudeDeps.mcpServers). */
  private mcpForClaude(): Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> {
    const theirs = claudeOwnServers()
    const out: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> = {}
    for (const cfg of this.s.settings.get().mcp ?? []) {
      if (!cfg.enabled) continue
      const key = cfg.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || cfg.id.slice(0, 8)
      // Claude already has one by this name: leave theirs alone
      if (theirs.has(key) || out[key]) continue
      const secrets = Object.fromEntries((cfg.secrets ?? []).map((n) => [n, this.s.vault.get(`mcp:${cfg.id}:${n}`) ?? '']))
      out[key] = { type: 'stdio', command: cfg.command, args: cfg.args, env: { ...cfg.env, ...secrets } }
    }
    return out
  }
  private claudeDeps(sessionId: string, run: Run, exe: string, more: AgentTool[] = []): ClaudeDeps {
    this.claudeUsed.add(sessionId)
    return {
      repo: this.s.repo,
      workspace: this.workspaceFor(sessionId),
      exe,
      mcpServers: this.mcpForClaude(),
      emit: (sid, ev) => this.emit(sid, ev),
      storeImage: (im) => this.s.storeImage(im),
      requestApproval: (sid, req, signal) => {
        // Claude Code can take a request back (the turn moved on). Taking the card
        // away is right; recording it as a refusal is not, so the runner is told
        // the difference and nobody is told the user said no.
        if (signal.aborted) return Promise.resolve('deny')
        const cancel = (): void => this.approve(sid, req.approvalId, 'deny')
        signal.addEventListener('abort', cancel, { once: true })
        return this.requestApproval(sid, req).finally(() => signal.removeEventListener('abort', cancel))
      },
      requestAnswer: (sid, req) => this.requestAnswer(sid, req),
      requestPlan: (sid, req) => this.requestPlan(sid, req),
      requestReview: (sid, req) => this.requestReview(sid, req),
      hooks: {
        before: (sid, call) => this.beforeTool(sid, call),
        after: (sid, call, isError) => this.s.automations.afterTool(sid, call, isError)
      },
      controls: (c) => {
        run.claude = c
      },
      protectedBy: (sid, paths) => this.protectedBy(sid, paths),
      tools: [...createGadgetTools(this.s.gadgets), checkProjectTool, showTool, attachFileTool, todoTool, gestureTool, createOpenProjectTool((root) => this.s.host.newWindow?.(root)), createTabsLookTool(() => this.s.tabs()), decisionRecordTool, decisionsLookTool, ...this.bitebackTools(sessionId), ...(this.s.settings.get().claude.helpers ? createFleetTools(this.fleetHost()) : []), findReferencesTool, renameSymbolTool, ...createBrowserTools(this.s.preview), createScratchTool(this.s.scratch), createImpactTool({ latest: (sid) => this.history.settled(sid).then(() => latestChanges(this.s, sid)) }), findBreakingCommitTool, createTourTool, ...more],
      modeChanged: (sid, mode) => {
        run.mode = mode
        this.s.repo.updateSession(sid, { mode })
        this.broadcastSessions()
      },
      selfStart: (sid, model) => this.claudeSelfTurn(sid, model),
      limitReached: (sid, resetsAt) => this.carryOnAfterLimit(sid, resetsAt)
    }
  }

  /** Everything Prism gives Claude about a session (the context panel shows it whole). */
  private async claudeAppend(sessionId: string, skills?: Skill[]): Promise<string> {
    return [this.claudeFixed(sessionId), await this.claudeContext(sessionId, skills)].filter(Boolean).join('\n\n')
  }

  /** What Prism adds to Claude Code's own instructions: the same on every turn, so the cached conversation behind it stays usable. */
  private claudeFixed(sessionId: string): string {
    const extras = this.s.repo.getSessionExtras(sessionId)
    const parts = [
      "You are running inside Prism, a desktop IDE, started from its agent panel. The user reads your replies there, rendered as Markdown. Files you change show up as diffs they can review and undo, and commands you run are shown with their output. Questions you ask and plans you present appear in Prism's own panels."
    ]
    parts.push(
      'Prism adds a few tools of its own, named mcp__prism__<tool>. The gadget_* tools build and drive gadgets: mini-apps inside Prism, each a sandboxed UI plus an optional Node backend that can run processes and offer tools to you. When the user wants a dashboard, a control panel, a viewer, a monitor, or a fleet of anything with buttons, read gadget_sdk first, then use gadget_write and gadget_open, and gadget_call to run a gadget\'s own tools; gadget_look shows you the gadget as the user sees it. When you notice that work in front of you has an ongoing or repeatable shape the two of you would both get at more easily through a panel — a build or a test run worth watching, a process, numbers that move, anything you keep reading out of scrollback — offer one with suggest_gadget and carry on; the user decides, and a kind they turn down is never raised again. find_references lists every use of a name across the project by meaning, and rename_symbol renames it everywhere in one step: prefer these to grep and hand edits for JavaScript and TypeScript. run_snippet runs a short JavaScript, TypeScript or Python snippet against the project in a notebook-like session that remembers what earlier snippets defined. browser_open, browser_look and browser_eval drive Prism\'s built-in browser: open the page you are working on, look at a picture of it, and click or read things in it, so you can check web work with your own eyes; check_accessibility shows what would shut people out of a page (faint or tiny text, things a screen reader cannot name, controls too small to tap, zoom turned off, sound with no words on screen), so run it on anything you build that people look at. check_project runs the project\'s checkers (types, lint, tests) and fills Prism\'s Problems panel. show opens a file in the user\'s view (images, 3D models, HTML pages, PDFs, code): use it after producing something worth looking at. attach_file hands the user a file as a card under your answer, which they can open on the computer or download straight to their phone through Prism\'s own connection: use it for anything they should keep or install (an APK, an installer, a video) instead of uploading it somewhere. todo_write is the plan the user watches at the top of the conversation: for any work with more than a couple of steps, send the whole plan in one call before you start, and call it again to tick each item off as you finish it. Prefer it to TaskCreate, which builds the plan one item at a time. gesture moves your face while the user is on a voice call with you (Prism tells you when): wave, nod, shake your head, smile or laugh, whenever you want to.'
    )
    parts.push(
      "tabs_look shows the user's tab groups in Prism: where each sits, the files, gadgets and pages open in each, and what is showing. Look before talking about 'the open file' or opening things for them; files you show join the group already holding their files, never one they keep for a gadget."
    )
    // without this Claude reaches for its own Agent tool, which only runs Claude models, and says GLM cannot be done
    if (this.s.settings.get().claude.helpers) {
      parts.push(
        "The user has let you use Prism's other models. mcp__prism__prism_helper hands a self-contained task to a helper on any model Prism has, from any provider (GLM, other Claude models and the rest; its description lists them), and returns the helper's report. mcp__prism__fleet_list and mcp__prism__fleet_run run the teams of helpers the user saved in Settings. Use these, not your own Agent tool, whenever a helper should be on a model that is not Claude, or the user names a model or a fleet. The user's own rules about asking before starting helpers still apply."
      )
    }
    const own = this.s.gadgets.builtinNote()
    if (own) parts.push(own)
    if (extras.worktree) parts.push(`You are working in a separate copy of the project (a git worktree at ${extras.worktree.path}, on branch ${extras.worktree.branch}). The user's own project folder is untouched until they bring your work in, so work freely here. Dependencies may not be installed in this copy: install them first if a build or test needs them. Do not switch branches and do not merge; the user does that from Prism.`)
    return parts.join('\n\n')
  }

  /** What can change between turns. It travels in the message when it changes (runner.ts), never in the instructions: a change there re-stores the whole conversation. */
  private async claudeContext(sessionId: string, skills?: Skill[]): Promise<string> {
    const extras = this.s.repo.getSessionExtras(sessionId)
    const all = skills ?? (await this.s.skills().catch(() => []))
    const sk = pickSkills(all, extras.skills ?? [], '')
    const fence = '```'
    const parts: string[] = []
    const skillText = skillsPrompt(sk.loaded, sk.others, 'mcp__prism__use_skill')
    if (skillText) parts.push(skillText)
    if (extras.instructions.trim()) parts.push(`# Instructions for this session\n${extras.instructions.trim()}`)
    const call = callNote(sessionId)
    if (call) parts.push(call)
    const rulesNote = await this.rulesText(sessionId)
    if (rulesNote) parts.push(rulesNote)
    const pinned = await readPins(this.workspaceFor(sessionId), extras.pins)
    if (pinned.length) {
      parts.push(
        `# Pinned files\nThe user pinned these files for this session. Their current content is below; you do not need to read them again unless you change them.\n\n${pinned.map((f) => `## ${f.path}${f.truncated ? ' (beginning only)' : ''}\n${fence}\n${f.content}\n${fence}`).join('\n\n')}`
      )
    }
    return parts.join('\n\n')
  }

  /** The transcript was cut back: Claude Code's copy of the conversation is cut back to match on the next turn. */
  rewound(sessionId: string): void {
    // the running Claude Code remembers the turns that were cut: it is started afresh from the cut
    closeClaude(sessionId)
    const st = this.s.repo.getSessionExtras(sessionId).claude
    if (!st) return
    const left = this.s.repo.listItems(sessionId)
    const ids = new Set(left.map((i) => i.id))
    const cut = st.turns.findIndex((t) => !ids.has(t.item))
    const synced = left[left.length - 1]?.id ?? null
    if (cut < 0) {
      this.s.repo.setSessionExtras(sessionId, { claude: { ...st, synced: st.synced && ids.has(st.synced) ? st.synced : synced } })
      return
    }
    const before = st.turns[cut]!.before
    // rewound past Claude's first turn here: it starts a new conversation
    // the context may have been given in a turn that is now gone: it is given again
    this.s.repo.setSessionExtras(sessionId, { claude: before ? { ...st, resumeAt: before, lastUuid: before, turns: st.turns.slice(0, cut), synced, given: null } : null })
  }

  /** Sessions whose current turn brings code and spec back in line: when it finishes, the spec counts as matched. */
  private specSync = new Set<string>()

  /** Failures already being repaired (or repaired) in this run of Prism, so one problem is fixed once. */
  private repairing = new Set<string>()

  /**
   * One of the user's own tools or gadgets failed: the agent fixes it in a session called Repairs. A fixed tool file
   * waits for the user's OK like any changed tool; a gadget fix is made in Ask first, so writing it waits for approval.
   * `force`: asked for by the user (a Fix it button), whatever the setting.
   */
  async repair(target: { kind: 'tool'; name: string; file: string; scope: 'project' | 'personal' } | { kind: 'gadget'; name: string }, error: string, force = false): Promise<string | null> {
    if (!force && !this.s.settings.get().agent.selfRepair) return null
    if (!this.s.workspace) return null
    const key = `${target.kind}:${target.name}:${error.split('\n')[0]}`
    if (!force && this.repairing.has(key)) return null
    this.repairing.add(key)
    const ws = this.s.requireWorkspace()
    let id = this.s.repo.listSessions(ws.root).find((x) => x.title === 'Repairs')?.id
    if (!id) id = this.s.repo.createSession(ws.root, 'Repairs', this.s.defaultModel(), 'auto-edit').id
    if (this.runs.has(id)) {
      // busy with another repair: try this one when asked again
      this.repairing.delete(key)
      return null
    }
    const prompt =
      target.kind === 'tool'
        ? `My tool "${target.name}" (${target.scope === 'project' ? target.file : `the file ${target.file}`}) failed:\n\n${error.slice(0, 4000)}\n\nRead the tool file, find the cause and fix it there. Keep its name, parameters and uses as they are unless the fix needs a change; a tool file can only use what is on the prism object (read .prism/tools/prism-tools.d.ts or use_skill extending-prism if unsure). Do not change anything else. Say in two sentences what was wrong and what you changed.`
        : `My gadget "${target.name}" failed:\n\n${error.slice(0, 4000)}\n\nRead it with gadget_read, find the cause, and fix it with gadget_write. Then check it with gadget_look. Do not change anything else. Say in two sentences what was wrong and what you changed.`
    this.s.send('gadget:ui', { kind: 'toast', title: `Prism is fixing your ${target.kind} "${target.name}"`, detail: target.kind === 'tool' ? 'The fixed version will wait for your OK.' : 'It will ask before writing the fix (session Repairs).' })
    this.broadcastSessions()
    await this.send(id, prompt, { mode: target.kind === 'tool' ? 'auto-edit' : 'ask' }, undefined, true)
    return id
  }

  /** The user's rules come first: a call that breaks one never runs. Then the project's own hooks. */
  private async beforeTool(sessionId: string, call: ToolCall): Promise<string | null> {
    const rule = breaks(await this.s.rules.list(this.workspaceFor(sessionId)).catch(() => []), call)
    if (rule) return `Blocked by the user's rule: "${rule.text}". Do not look for a way around it. If the task cannot be done without it, stop and tell the user.`
    return this.s.automations.beforeTool(sessionId, call)
  }

  private async protectedBy(sessionId: string, paths: string[]): Promise<{ rule: string; paths: string[] } | null> {
    const hit = protectedAmong(await this.s.rules.list(this.workspaceFor(sessionId)).catch(() => []), paths)
    return hit ? { rule: hit.rule.text, paths: hit.paths } : null
  }

  /** The rules, for the agent's instructions, so it does not try in the first place. */
  private async rulesText(sessionId: string): Promise<string> {
    const rules = (await this.s.rules.list(this.workspaceFor(sessionId)).catch(() => [])).filter((r) => r.enabled)
    const ruleText = rules.length ? `The user's rules. Prism blocks anything that breaks them, so plan around them:\n${rules.map((r) => `- ${r.text}`).join('\n')}` : ''
    // Vibecoding Safety Biteback travels with the rules: both say how this project wants the agent to behave
    const bite = bitebackOn(this.s.userData, this.s.repo.getSession(sessionId)?.workspace) ? BITEBACK_NOTE : ''
    return [ruleText, bite].filter(Boolean).join('\n\n')
  }

  /**
   * After a turn: would a gadget serve this work better than more scrollback? Asked of
   * the quick model, never the one doing the work, and only about what the turn
   * actually did (see core/gadgets/scout.ts). Nearly always nothing.
   */
  private async considerGadget(sessionId: string): Promise<void> {
    if (this.s.settings.get().assist?.gadgetIdeas === false) return
    // With no quick model there is nobody cheap to ask — but the agent has the
    // suggest_gadget tool and notices for itself, so nothing is lost by staying quiet here.
    const model = this.s.roleModel('fast') ?? this.s.roleModel('strong')
    if (!model) return
    const ws = this.workspaceFor(sessionId)
    const items = this.s.repo.listItems(sessionId)
    // only what this turn did: back as far as the user's last message
    const from = items.map((it) => it.kind).lastIndexOf('user')
    const turn = from >= 0 ? items.slice(from) : items.slice(-40)
    const tools = turn.filter((it) => it.kind === 'tool')
    if (!tools.length) return
    // a turn that only read and searched has no ongoing shape to show, whatever else is
    // in it: not worth a model call to find that out
    const names = tools.map((t) => (t.kind === 'tool' ? t.name : ''))
    const didSomething = names.some((n) => /^(shell|terminal|check_project|run_snippet|browser_|gadget_|task|job)/.test(n))
    if (!didSomething && names.length < 6) return
    const said = [...turn].reverse().find((it) => it.kind === 'assistant' && it.text.trim())
    const idea = await this.s.gadgetScout.consider(ws.root, model, {
      tools: names.filter(Boolean),
      commands: tools.flatMap((t) => (t.kind === 'tool' && t.name === 'shell' ? [String(t.args?.['command'] ?? '').slice(0, 200)] : [])).filter(Boolean),
      said: said && said.kind === 'assistant' ? said.text : '',
      existing: this.s.gadgets.list().map((g) => ({ id: g.id, description: g.description }))
    })
    if (!idea) return
    this.raiseGadgetIdea(sessionId, idea)
  }

  /**
   * The agent itself noticed (the suggest_gadget tool). It knows what the work is for,
   * which a model shown only the turn's shape cannot, so this is the better of the two
   * ways in — and the only one when there is no quick model to ask.
   */
  suggestGadget(sessionId: string, raw: { kind: string; title: string; what: string; why: string }): 'offered' | 'silenced' | 'nowhere' {
    if (!this.s.repo.getSession(sessionId)) return 'nowhere'
    const root = this.workspaceFor(sessionId).root
    if (this.s.gadgetScout.silenced(root).includes(raw.kind)) return 'silenced'
    this.s.gadgetScout.raised(raw.kind)
    this.raiseGadgetIdea(sessionId, { id: randomUUID().slice(0, 8), ...raw })
    return 'offered'
  }

  private raiseGadgetIdea(sessionId: string, idea: GadgetIdea): void {
    const item: SystemItem = {
      kind: 'system',
      id: randomUUID(),
      ts: Date.now(),
      subkind: 'info',
      text: `This might be worth a gadget: ${idea.title}`,
      meta: { gadgetIdea: idea }
    }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  /** After a message that may correct the agent: is there a habit to keep, or a rule to make? */
  private async learn(sessionId: string, text: string): Promise<void> {
    if (this.s.settings.get().assist?.learn === false) return
    const items = this.s.repo.listItems(sessionId)
    const lastAnswer = [...items].reverse().find((i) => i.kind === 'assistant' && i.text.trim())
    if (!lastAnswer || lastAnswer.kind !== 'assistant') return
    const model = this.s.roleModel('fast')
    if (!model) return
    const ws = this.workspaceFor(sessionId)
    const rules = await this.s.rules.list(ws).catch(() => [])
    const offer = await this.s.learner.consider(ws.root, model, lastAnswer.text, text, rules.map((r) => r.text)).catch(() => null)
    if (!offer) return
    const item: SystemItem = {
      kind: 'system',
      id: randomUUID(),
      ts: Date.now(),
      subkind: 'info',
      text: offer.kind === 'skill' ? `You have said this before: ${offer.instruction}` : `That sounds like a rule: ${offer.sentence}`,
      meta: { offer }
    }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  /** A request about the spec, in the given session or in one called "Spec". Returns the session. */
  async specTurn(text: string, mode: PermissionMode, sessionId: string | null, opts: { sync: boolean }): Promise<string> {
    const ws = this.s.requireWorkspace()
    let id = sessionId && this.s.repo.getSession(sessionId) ? sessionId : null
    if (!id) id = this.s.repo.listSessions(ws.root).find((x) => x.title === 'Spec')?.id ?? this.s.repo.createSession(ws.root, 'Spec', this.s.defaultModel(), mode).id
    if (this.runs.has(id)) throw new Error('That session is busy. Wait for it to finish.')
    if (opts.sync) this.specSync.add(id)
    this.broadcastSessions()
    await this.send(id, text, { mode })
    return id
  }

  /** After the agent changed code: does it still agree with the spec? Drift is noted in the conversation. */
  private async checkSpec(sessionId: string, changed: string[]): Promise<void> {
    if (this.s.settings.get().assist?.specChecks === false) return
    const ws = this.workspaceFor(sessionId)
    const spec = await this.s.spec.find(ws)
    if (!spec) return
    const code = changed.filter((p) => !SPEC_FILES.includes(p))
    if (!code.length) return
    const model = this.s.roleModel('fast')
    if (!model) return
    await this.history.settled(sessionId)
    const files = (await latestChanges(this.s, sessionId)).filter((f) => code.includes(f.path))
    const drift = await this.s.spec.check(ws, model, files, sessionId).catch(() => [])
    this.s.send(CH.SpecChanged, null)
    if (!drift.length) return
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'info', text: `This may no longer match the spec (${spec.path}): ${drift.map((d) => `"${d.title}": ${d.note}`).join(' ')}`, meta: { specDrift: drift } }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
  }

  private compares = new Map<string, AbortController>()
  private autoFixes = new Map<string, number>()
  private automationSessions = new Map<string, string>()

  anyRunning(): boolean {
    return this.runs.size > 0
  }

  /** A watcher or schedule fires: its prompt goes to a session of its own. Returns null when that session is still busy. */
  async runAutomation(automationId: string, name: string, prompt: string, mode: PermissionMode): Promise<string | null> {
    const ws = this.s.requireWorkspace()
    let sessionId = this.automationSessions.get(automationId)
    if (!sessionId || !this.s.repo.getSession(sessionId)) {
      const title = `Automation: ${name}`
      sessionId = this.s.repo.listSessions(ws.root).find((x) => x.title === title)?.id ?? this.s.repo.createSession(ws.root, title, this.s.defaultModel(), mode).id
      this.automationSessions.set(automationId, sessionId)
    }
    if (this.runs.has(sessionId)) return null
    await this.send(sessionId, prompt, { mode }, undefined, true)
    return sessionId
  }

  /** Another model reviews the conversation up to one of the agent's answers. Stored in the transcript, never shown to the lead model. */
  async opinion(sessionId: string, itemId: string, ref: ModelRef): Promise<SystemItem> {
    const model = this.s.resolveModel(ref)
    if (!model) throw new Error('That model is not available.')
    const all = this.s.repo.listItems(sessionId)
    const at = all.findIndex((i) => i.id === itemId)
    if (at < 0) throw new Error('That answer is no longer in the conversation.')
    const r = await streamAnswer(model, opinionMessages(all.slice(0, at + 1)), () => {}, undefined, 2500)
    const usage = { ...r.usage, latencyMs: r.ms, cost: costOf(model.info, r.usage) }
    this.s.repo.recordUsage({ endpointId: model.ep.id, modelId: model.info.modelId, sessionId, ok: true, usage })
    this.s.repo.addSessionUsage(sessionId, usage)
    const item: SystemItem = { kind: 'system', id: randomUUID(), ts: Date.now(), subkind: 'opinion', text: r.text.trim() || '(the model returned nothing)', meta: { model: model.info.modelId, forItem: itemId } }
    this.s.repo.appendItem(sessionId, item)
    this.emit(sessionId, { type: 'item', item })
    this.broadcastSessions()
    return item
  }

  /** The same question to several models at once; progress streams on compare:event:<runId>. */
  compare(runId: string, sessionId: string | null, question: string, refs: ModelRef[]): void {
    const ctl = new AbortController()
    this.compares.set(runId, ctl)
    const items = sessionId ? this.s.repo.listItems(sessionId) : []
    const messages = compareMessages(items, question)
    const send = (ev: CompareEvent): void => this.s.send(`compare:event:${runId}`, ev)
    void Promise.all(
      refs.slice(0, 6).map(async (ref) => {
        const key = `${ref.endpointId}::${ref.modelId}`
        const model = this.s.resolveModel(ref)
        if (!model) return send({ type: 'error', key, message: 'This model is not available.' })
        try {
          const r = await streamAnswer(model, messages, (text) => send({ type: 'delta', key, text }), ctl.signal)
          const cost = costOf(model.info, r.usage)
          this.s.repo.recordUsage({ endpointId: model.ep.id, modelId: model.info.modelId, sessionId, ok: true, usage: { ...r.usage, latencyMs: r.ms, cost } })
          send({ type: 'done', key, text: r.text, ms: r.ms, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cost })
        } catch (e) {
          send({ type: 'error', key, message: ctl.signal.aborted ? 'Stopped.' : e instanceof Error ? e.message : String(e) })
        }
      })
    ).finally(() => this.compares.delete(runId))
  }

  compareStop(runId: string): void {
    this.compares.get(runId)?.abort()
  }

  /** Carry on a session with one of the compared answers: the question and that answer join the transcript, and the session switches to that model. */
  adopt(sessionId: string, question: string, answer: string, ref: ModelRef): void {
    if (this.runs.has(sessionId)) throw new Error('Wait for the current turn to finish first.')
    const user: UserItem = { kind: 'user', id: randomUUID(), ts: Date.now(), text: question, attachments: [] }
    const assistant: AssistantItem = { kind: 'assistant', id: randomUUID(), ts: Date.now() + 1, text: answer, reasoning: '', toolCalls: [], model: ref, usage: { inputTokens: 0, outputTokens: 0 }, step: 1 }
    this.s.repo.appendItem(sessionId, user)
    this.s.repo.appendItem(sessionId, assistant)
    this.s.repo.updateSession(sessionId, { model: ref })
    this.emit(sessionId, { type: 'item', item: user })
    this.emit(sessionId, { type: 'item', item: assistant })
    this.broadcastSessions()
  }

  /** What this session would send to the model right now, part by part. */
  async context(sessionId: string): Promise<ContextReport> {
    const session = this.s.repo.getSession(sessionId)
    if (!session) throw new Error('That session no longer exists.')
    const ws = this.workspaceFor(sessionId)
    const settings = this.s.settings.get()
    const ref = session.model ?? this.s.defaultModel()
    const model = ref ? this.s.resolveModel(ref) : null
    const extras = this.s.repo.getSessionExtras(sessionId)
    const allSkills = await this.s.skills().catch(() => [])
    const sk = pickSkills(allSkills, extras.skills ?? [], '')
    const skillRows = (tool: string): { text: string; list: ContextReport['skills'] } => ({
      text: skillsPrompt(sk.loaded, sk.others, tool),
      list: allSkills.map((x) => ({ name: x.name, description: x.description, tokens: estimateTokens(x.body), loaded: sk.loaded.includes(x), always: x.always }))
    })
    if (isClaudeRef(ref)) {
      // Claude Code adds its own instructions and tools, which Prism cannot measure: only what Prism sends is counted
      const window = this.s.claude.models().find((m) => m.modelId === ref?.modelId)?.contextWindow ?? null
      return contextReport({ workspace: ws, items: this.s.repo.listItems(sessionId), extras, system: await this.claudeAppend(sessionId, allSkills), toolSpecs: [], window, skills: skillRows('mcp__prism__use_skill') })
    }
    const mcp = this.s.liveMcp()
    const system = await buildSystemPrompt({
      workspace: ws,
      shellLabel: shellLabelFor(ws.root, settings.terminal.shell),
      mode: session.mode,
      modelId: model?.info.modelId ?? 'unknown',
      isSubagent: false,
      readOnly: false,
      hasMcp: mcp.length > 0,
      hasGadgets: true,
      builtinGadgets: this.s.gadgets.builtinNote(),
      extra: extras.instructions,
      skills: skillsPrompt(sk.loaded, sk.others),
      pinned: await readPins(ws, extras.pins)
    })
    const tools = buildTools({ shell: { shell: () => settings.terminal.shell }, readOnly: session.mode === 'plan', allowSpawn: true, mcp, gadgets: this.s.gadgets, browser: this.s.preview, scratch: this.s.scratch, theme: settingsThemeHost(this.s.settings), custom: [...(await this.s.customTools.tools().catch(() => [])), ...this.bitebackTools(sessionId), ...createFleetTools(this.fleetHost()).filter((t) => t.spec.name !== 'prism_helper')], skills: sk.others.length ? { all: () => allSkills, use: () => {} } : null, plan: session.mode === 'plan' })
    deferOutsideTools(tools, extras.toolSources ?? [], () => {})
    return contextReport({ workspace: ws, items: this.s.repo.listItems(sessionId), extras, system, toolSpecs: [...tools.values()].map((t) => t.spec), window: model?.info.contextWindow ?? null, skills: skillRows('use_skill') })
  }

  /** Take one bulky tool result out of what the model is sent; the transcript keeps a one-line marker. */
  pruneItem(sessionId: string, itemId: string): boolean {
    if (this.runs.has(sessionId)) throw new Error('Wait for the current turn to finish first.')
    if (isClaudeRef(this.s.repo.getSession(sessionId)?.model)) throw new Error('Claude Code keeps its own copy of this conversation, so a result cannot be taken out here. Type /compact to make room instead.')
    const item = this.s.repo.getItem(sessionId, itemId)
    if (!item || item.kind !== 'tool') return false
    const size = item.content.length
    this.s.repo.replaceItem(sessionId, { ...item, content: `[The user removed this result (${size} characters) from the conversation to save room. Run the tool again if you need it.]`, diff: null, meta: { ...(item.meta ?? {}), pruned: true } })
    return true
  }

  plan(sessionId: string, planId: string, decision: PlanDecision): void {
    const run = this.runOf(sessionId)
    const pending = run?.plans.get(planId)
    if (!run || !pending) return
    const { resolve, title } = pending
    run.plans.delete(planId)
    run.waiting.plans.delete(planId)
    if (decision.action === 'approve' && !run.external) {
      const mode: PermissionMode = decision.mode && decision.mode !== 'plan' ? decision.mode : 'ask'
      // the transcript shows one line; the model gets the whole approved plan
      run.followUp = {
        text: `Carry out the approved plan: ${title}`,
        expanded: `Carry out this plan, which I approved. Follow it step by step, keep a todo list of its steps, and verify the result as it says.\n\n# ${title}\n\n${decision.plan.trim()}`,
        mode
      }
    }
    resolve(decision)
    this.broadcastSessions()
  }

  private requestPlan(sessionId: string, req: PlanRequest): Promise<PlanDecision> {
    const run = this.runOf(sessionId)
    if (!run) return Promise.resolve({ action: 'discard', plan: '' })
    return new Promise<PlanDecision>((resolve) => {
      run.plans.set(req.planId, { title: req.title, resolve })
      run.waiting.plans.set(req.planId, req)
      this.broadcastSessions()
    })
  }

  review(sessionId: string, reviewId: string, decision: ReviewDecision): void {
    const run = this.runOf(sessionId)
    const resolve = run?.reviews.get(reviewId)
    if (!run || !resolve) return
    run.reviews.delete(reviewId)
    run.waiting.reviews.delete(reviewId)
    resolve(decision)
    this.broadcastSessions()
  }

  private requestReview(sessionId: string, req: ReviewRequest): Promise<ReviewDecision> {
    const run = this.runOf(sessionId)
    if (!run) return Promise.resolve({ files: [] })
    return new Promise<ReviewDecision>((resolve) => {
      run.reviews.set(req.reviewId, resolve)
      run.waiting.reviews.set(req.reviewId, req)
      this.broadcastSessions()
    })
  }

  private requestAnswer(sessionId: string, req: QuestionRequest): Promise<string> {
    const run = this.runOf(sessionId)
    if (!run) return Promise.resolve('')
    return new Promise<string>((resolve) => {
      // whatever the answer, it goes into the project's decisions ledger as well
      const root = this.s.repo.getSession(sessionId)?.workspace
      run.questions.set(req.questionId, (answer: string) => {
        if (root) this.keepDecision(root, { kind: 'choice', question: req.question, options: req.options.map((o) => o.label), answer, session: sessionOf(sessionId) })
        resolve(answer)
      })
      run.waiting.questions.set(req.questionId, req)
      this.broadcastSessions()
    })
  }

  /** Where fleets and helpers come from, for either kind of lead. */
  private fleetHost(): FleetHost {
    return {
      fleets: () => this.s.settings.get().fleets ?? [],
      roster: () => this.helperModels().slice(0, 60).map((m) => `- ${m.key}: ${m.label}`).join('\n') || '(no models set up)',
      kit: (sid: string) => this.helperKit(sid)
    }
  }

  /** Every model a helper can be given, from every provider, Claude included. */
  private helperModels(): Array<{ key: string; ref: ModelRef; label: string }> {
    const out = this.s.repo.listModels().map((m) => ({ key: m.key, ref: { endpointId: m.endpointId, modelId: m.modelId }, label: `${m.modelId} (${m.endpointName})` }))
    for (const c of this.s.claude.models()) out.push({ key: `${c.endpointId}::${c.modelId}`, ref: { endpointId: c.endpointId, modelId: c.modelId }, label: `${c.label ?? c.modelId} (Claude)` })
    return out
  }

  /** The model a helper given none runs on: the strong or lead role, else the first there is. */
  private helperModel(): ModelRef | null {
    const r = this.s.settings.get().roles
    for (const m of [r.strong, r.lead, r.fast, r.fallback]) if (m && this.s.usable(m)) return m
    return this.helperModels()[0]?.ref ?? null
  }

  /**
   * Helpers and fleets for either kind of lead, on any model. Each helper is a conversation of
   * its own under the lead's, and its report comes back to the lead; stopping the lead's turn
   * stops them.
   */
  private helperKit(sessionId: string): HelperKit | null {
    const run = this.runOf(sessionId)
    const fallback = this.helperModel()
    if (!run || !fallback) return null
    const input: RunInput = { sessionId, rootSessionId: sessionId, model: fallback, mode: run.mode, text: '', attachments: [], depth: 0, readOnly: false, signal: run.controller.signal, sessionAllow: run.sessionAllow }
    // a helper's model may be Claude's, which Prism's ordinary model lookup does not know
    const find = (id: string): ModelRef | null => this.helperModels().find((m) => m.key === id)?.ref ?? this.s.findModel(id)
    const { spawn, control } = createHelpers({ ...this.deps(sessionId), findModel: find }, input, (deps, i) => this.helperTurn(deps, i), (ev) => this.emit(sessionId, ev))
    const unknown = (key?: string): string | null => (key && !find(key) ? `There is no model "${key}" in Prism.` : null)
    return {
      spawn: async (task, o) => {
        const bad = unknown(o.model)
        return bad ? { ok: false, summary: bad } : spawn(task, o)
      },
      team: async (spec, background) => {
        for (const st of spec.stages) for (const a of st.agents) {
          const bad = unknown(a.model)
          if (bad) return { ok: false, summary: `${a.name}: ${bad}` }
        }
        return control.team(spec, background)
      }
    }
  }

  /**
   * One helper turn: Prism's own agent, or Claude Code when the helper is on a Claude model.
   * A Claude helper gets a run of its own, so its permission requests show in its own
   * conversation and it never takes over the lead's (typing to steer the lead stays the lead's).
   */
  private async helperTurn(deps: EngineDeps, input: RunInput): Promise<RunOutcome> {
    if (!isClaudeRef(input.model)) return runTurn(deps, input)
    const exe = this.s.claude.exe()
    if (!exe) return { reason: 'error', error: 'Claude Code was not found on this computer.', lastText: '' }
    const sid = input.sessionId
    if (this.runs.has(sid)) return { reason: 'error', error: 'That helper is already working.', lastText: '' }
    // a read-only helper asks before any change, and is told not to make one
    const mode: PermissionMode = input.readOnly ? 'ask' : input.mode
    const run: Run = { controller: new AbortController(), sessionAllow: [], approvals: new Map(), approvalTools: new Map(), waiting: { approvals: new Map(), questions: new Map(), reviews: new Map(), plans: new Map() }, mode, questions: new Map(), reviews: new Map(), plans: new Map(), followUp: null, changed: new Set(), claude: null, external: true }
    const stop = (): void => run.controller.abort()
    input.signal.addEventListener('abort', stop, { once: true })
    this.runs.set(sid, run)
    RUNNING_ANYWHERE.add(sid)
    this.broadcastSessions()
    try {
      return await runClaudeTurn(this.claudeDeps(sid, run, exe), {
        sessionId: sid,
        model: input.model,
        mode,
        text: input.readOnly ? `${input.text}\n\nFor this task only read and search: do not change files or run anything that changes them.` : input.text,
        attachments: [],
        signal: run.controller.signal,
        append: [this.claudeFixed(sid), input.systemExtra].filter(Boolean).join('\n\n'),
        context: await this.claudeContext(sid)
      })
    } finally {
      input.signal.removeEventListener('abort', stop)
      this.runs.delete(sid)
      RUNNING_ANYWHERE.delete(sid)
      this.broadcastSessions()
    }
  }

  /** Vibecoding Safety Biteback's tools, in a conversation whose project has it on. */
  private bitebackTools(sessionId: string): AgentTool[] {
    const root = this.s.repo.getSession(sessionId)?.workspace
    if (!bitebackOn(this.s.userData, root)) return []
    return createBitebackTools({
      root: (sid) => this.s.repo.getSession(sid)?.workspace ?? null,
      title: (sid) => this.s.repo.getSession(sid)?.title ?? '',
      refusedAt: (sid) => this.s.repo.getSessionExtras(sid).refused?.at ?? null,
      markRefused: (sid, reason) => {
        this.s.repo.setSessionExtras(sid, { refused: { at: Date.now(), reason } })
      },
      end: (sid, reason, handover) => {
        this.s.repo.setSessionExtras(sid, { ended: { at: Date.now(), reason, handover } })
        this.broadcastSessions()
      }
    })
  }

  /** A decision into the project's ledger; a project the ledger cannot be written in is not a reason to fail the turn. */
  private keepDecision(root: string, d: Omit<Decision, 'id' | 'at'>): void {
    if (placeOf(root).kind === 'ssh') return
    try {
      recordDecision(root, d)
    } catch {
      /* a read-only folder */
    }
  }
}
