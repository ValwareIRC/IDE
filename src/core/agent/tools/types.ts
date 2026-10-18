import type { AgentEvent, FileDiff, PermissionMode, PlanDecision, PlanRequest, QuestionRequest, ReviewDecision, ReviewRequest, RiskLevel, TodoItem } from '@shared/types'
import type { Workspace } from '../../fs/workspace'
import type { ImagePart, ToolSpec } from '../../providers/types'

export interface ToolResult {
  content: string
  isError: boolean
  diff?: FileDiff
  meta?: Record<string, unknown>
  images?: ImagePart[]
}

export interface ToolContext {
  workspace: Workspace
  sessionId: string
  agent: string | undefined
  signal: AbortSignal
  emit(ev: AgentEvent): void
  /** Snapshot these workspace files before mutating them. */
  checkpoint(paths: string[]): Promise<void>
  /** Keep these earlier versions in the turn's checkpoint (a command already changed the files). */
  keepBefore?(files: Array<{ path: string; content: Buffer | null }>): void
  /** Of these changed files, the ones the user's rules protect. */
  protectedBy?(paths: string[]): Promise<{ rule: string; paths: string[] } | null>
  askUser(req: Omit<QuestionRequest, 'questionId'>): Promise<string>
  /** Show a change set and wait for the user to accept or reject its pieces. */
  review(req: Omit<ReviewRequest, 'reviewId'>): Promise<ReviewDecision>
  /** Plan mode: show the plan and wait for approve, feedback or discard. */
  presentPlan(req: Omit<PlanRequest, 'planId'>): Promise<PlanDecision>
  setTodos(todos: TodoItem[]): void
  /** background: return at once and report later as a notice. isolated: work in its own copy of the project. */
  spawnAgent(task: string, opts: { name?: string; model?: string; readOnly?: boolean; background?: boolean; isolated?: boolean }): Promise<{ ok: boolean; summary: string }>
  /** Notices, timers and other sessions (absent where background work is not possible). */
  background?: { host: import('../background').BackgroundHost; sessionId: string; rootSessionId: string }
  /** The lead agent's helpers (absent inside a helper). */
  helpers?: import('../background').HelperControl
  /** The checks that prove this turn's work (done_when); Prism runs them when the agent finishes. */
  setDoneWhen?(checks: Array<{ name: string; command: string }>): void
  /** Watch a background job's output for a pattern; matches arrive as notices. */
  watchJob?(id: string, pattern: RegExp, times: number): { ok: true } | { ok: false; error: string }
  /** The session's permission mode at this moment. */
  mode?(): PermissionMode
  /** Stream a chunk of live output for the current tool call (shell). */
  output(callId: string, chunk: string): void
  callId: string
}

export interface AgentTool {
  spec: ToolSpec
  /** Argument whose value permission patterns match against. */
  primaryArg: string | null
  /** null = read-only, never needs approval. */
  risk(args: Record<string, unknown>): RiskLevel | null
  /** One line shown in approval cards and activity rows. */
  summary(args: Record<string, unknown>): string
  /** Read-only tools may run in parallel with each other. */
  readOnly: boolean
  /** Mutating tools that are still safe to run concurrently (sub-agents). */
  parallelSafe?: boolean
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v)
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return /^(true|1|yes)$/i.test(v)
  return fallback
}

export function err(message: string): ToolResult {
  return { content: message, isError: true }
}

export function clipOutput(s: string, max = 60_000): string {
  if (s.length <= max) return s
  const head = s.slice(0, max * 0.7)
  const tail = s.slice(-max * 0.25)
  return `${head}\n\n… [${s.length - head.length - tail.length} characters omitted] …\n\n${tail}`
}
