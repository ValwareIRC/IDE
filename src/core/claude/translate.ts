// Claude Code names its tools and arguments differently from Prism's own agent.
// Calls are renamed on the way into the transcript so the same rows, diff cards,
// approval cards and hooks work for both. The transcript copy is for display and
// for other models reading the conversation; Claude Code keeps its own record.
import { isAbsolute, relative } from 'node:path'
import type { PermissionMode, TodoItem, ToolCall } from '@shared/types'

export const CLAUDE_ENDPOINT = 'claude-agent'
export const CLAUDE_ENDPOINT_NAME = 'Claude Agent'

export function isClaudeRef(ref: { endpointId: string } | null | undefined): boolean {
  return ref?.endpointId === CLAUDE_ENDPOINT
}

export type ClaudeMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export function claudeMode(mode: PermissionMode): ClaudeMode {
  return mode === 'plan' ? 'plan' : mode === 'auto' ? 'bypassPermissions' : mode === 'auto-edit' ? 'acceptEdits' : 'default'
}

export function prismMode(mode: string): PermissionMode | null {
  return mode === 'plan' ? 'plan' : mode === 'bypassPermissions' ? 'auto' : mode === 'acceptEdits' ? 'auto-edit' : mode === 'default' ? 'ask' : null
}

/** Workspace-relative with forward slashes when the path is inside the workspace; otherwise unchanged. */
export function relPath(root: string, p: unknown): string {
  if (typeof p !== 'string' || !p) return ''
  if (!isAbsolute(p)) return p.split('\\').join('/')
  const rel = relative(root, p)
  if (!rel) return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return p
  return rel.split('\\').join('/')
}

const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

export function toPrismCall(id: string, name: string, input: Record<string, unknown>, root: string): ToolCall {
  const a = input ?? {}
  const path = relPath(root, a['file_path'] ?? a['notebook_path'] ?? a['path'])
  switch (name) {
    case 'Read':
      return { id, name: 'read_file', args: { path, ...pick(a, ['offset', 'limit', 'pages']) } }
    case 'Write':
      return { id, name: 'write_file', args: { path, content: a['content'] ?? '' } }
    case 'Edit':
      return { id, name: 'edit_file', args: { path, old_string: a['old_string'] ?? '', new_string: a['new_string'] ?? '', ...pick(a, ['replace_all']) } }
    case 'NotebookEdit':
      return { id, name: 'NotebookEdit', args: { ...a, path } }
    case 'Bash':
    case 'PowerShell':
      return { id, name: 'shell', args: { command: a['command'] ?? '', ...pick(a, ['description', 'timeout']), ...(a['run_in_background'] ? { background: true } : {}) } }
    case 'Glob':
      return { id, name: 'glob', args: { pattern: a['pattern'] ?? '', ...(a['path'] ? { path } : {}) } }
    case 'Grep':
      return { id, name: 'grep', args: { pattern: a['pattern'] ?? '', ...(a['glob'] ? { include: a['glob'] } : {}), ...(a['path'] ? { path } : {}), ...pick(a, ['output_mode', 'type']) } }
    case 'LS':
      return { id, name: 'list_dir', args: { path: path || '.' } }
    case 'WebFetch':
      return { id, name: 'web_fetch', args: pick(a, ['url', 'prompt']) }
    case 'WebSearch':
      return { id, name: 'web_search', args: pick(a, ['query']) }
    case 'TodoWrite':
      return { id, name: 'todo_write', args: a }
    case 'AskUserQuestion': {
      const qs = Array.isArray(a['questions']) ? (a['questions'] as Array<Record<string, unknown>>) : []
      return { id, name: 'ask_user', args: { question: qs.map((q) => String(q['question'] ?? '')).join(' · ') } }
    }
    case 'ExitPlanMode':
      return { id, name: 'present_plan', args: { title: planTitle(String(a['plan'] ?? '')), ...pick(a, ['plan']) } }
    case 'Agent':
    case 'Task':
      return { id, name: 'spawn_agent', args: { name: a['subagent_type'] ?? 'agent', task: a['description'] ?? a['prompt'] ?? '', ...pick(a, ['prompt']) } }
    default:
      return { id, name: name.startsWith('mcp__prism__') ? name.slice(12) : name, args: a }
  }
}

/** Tool names as Prism's hooks and "edit freely" mode know them. */
export const EDITING = new Set(['write_file', 'edit_file', 'NotebookEdit'])

export function planTitle(plan: string): string {
  const line = plan
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l)
  const t = (line ?? '').replace(/^#+\s*/, '').replace(/^plan:?\s*/i, '').trim()
  return t ? t.slice(0, 80) : 'Plan'
}

export function todosFrom(input: Record<string, unknown>): TodoItem[] {
  const list = Array.isArray(input['todos']) ? (input['todos'] as Array<Record<string, unknown>>) : []
  return list.map((t, i) => ({
    id: String(i + 1),
    text: String((t['status'] === 'in_progress' && t['activeForm']) || t['content'] || ''),
    status: t['status'] === 'completed' ? 'done' : t['status'] === 'in_progress' ? 'active' : 'pending'
  }))
}

/**
 * Claude Code's newer plan: a list built one item at a time.
 *
 * It used to send the whole plan with each change (TodoWrite, above). Since an update
 * it adds items with TaskCreate, which only says the new item's number in its reply,
 * and changes them by number with TaskUpdate — so the list has to be kept here, for the
 * whole conversation, and rebuilt into Prism's checklist after each change.
 */
export class TaskPlan {
  private items = new Map<string, { subject: string; active: string; status: TodoItem['status'] }>()
  /** A create that has been asked for, waiting on the reply that says its number. */
  private asked = new Map<string, { subject: string; active: string }>()

  /** A TaskCreate has been decided on; it joins the list once its number is known. */
  creating(callId: string, input: Record<string, unknown>): void {
    this.asked.set(callId, { subject: String(input['subject'] ?? input['content'] ?? ''), active: String(input['activeForm'] ?? '') })
  }

  /** The reply to a TaskCreate, which says what number it was given. Returns whether the list changed. */
  created(callId: string, reply: string): boolean {
    const a = this.asked.get(callId)
    this.asked.delete(callId)
    if (!a) return false
    const id = (/#\s*(\d+)/.exec(reply) ?? /\b(\d+)\b/.exec(reply) ?? [])[1]
    if (!id) return false
    this.items.set(id, { subject: a.subject, active: a.active, status: 'pending' })
    return true
  }

  /** A TaskUpdate: started, finished, renamed or removed. Returns whether the list changed. */
  update(input: Record<string, unknown>): boolean {
    const id = String(input['taskId'] ?? input['id'] ?? '')
    const t = this.items.get(id)
    if (!t) return false
    const status = input['status']
    if (status === 'deleted') {
      this.items.delete(id)
      return true
    }
    if (status === 'completed') t.status = 'done'
    else if (status === 'in_progress') t.status = 'active'
    else if (status === 'pending') t.status = 'pending'
    if (typeof input['subject'] === 'string') t.subject = input['subject']
    if (typeof input['activeForm'] === 'string') t.active = input['activeForm']
    return true
  }

  /** The list as Prism's checklist: what is being done is named the way it is being done. */
  todos(): TodoItem[] {
    return [...this.items.entries()].map(([id, t]) => ({ id, text: t.status === 'active' && t.active ? t.active : t.subject, status: t.status }))
  }
}

/** A tool result's content blocks as plain text, plus any pictures in it. */
export function resultText(content: unknown): { text: string; images: Array<{ mime: string; base64: string }> } {
  if (typeof content === 'string') return { text: content, images: [] }
  const images: Array<{ mime: string; base64: string }> = []
  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
      else if (b?.['type'] === 'image') {
        const src = b['source'] as Record<string, unknown> | undefined
        if (src?.['type'] === 'base64' && typeof src['data'] === 'string') images.push({ mime: String(src['media_type'] ?? 'image/png'), base64: src['data'] })
      } else if (b?.['type'] === 'tool_reference' && typeof b['tool_name'] === 'string') parts.push(`(loaded tool ${b['tool_name']})`)
    }
  }
  return { text: parts.join('\n'), images }
}

/**
 * Claude Code's wording for a call it cancelled because the session was parked: the
 * abort it uses carries the reason "background", and this is the text the agent is
 * given for it. It reads as the user refusing, and it tells the agent to stop and
 * wait — so a cancellation nobody performed gets blamed on the user, and the work
 * halts waiting for an answer to a question nobody was asked.
 */
const READS_AS_REFUSAL = "The user doesn't want to take this action right now."

/**
 * A short error result carrying that sentence. Short, because a long result merely
 * quoting it (a search through Claude Code's own files) is not one of these.
 */
export function readsAsRefusal(text: string): boolean {
  const t = text.trim()
  return t.length < 400 && t.includes(READS_AS_REFUSAL)
}

/** Prism's answer to one, so the agent does not stop and does not blame the user. */
export const NOT_A_REFUSAL =
  '[Prism] The tool result just above is not a refusal. Nobody was asked and nobody said no:' +
  ' the call was cancelled because Claude Code parked the session, and it words that cancellation' +
  ' as the user refusing. Do not stop, and do not wait for an answer. Run the call again if it is' +
  ' still needed, and carry on.'

/** What went wrong, in words a person can act on. */
export function explainError(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'Claude Code is not signed in. Open a terminal, run "claude", sign in with /login, then try again.'
    case 'oauth_org_not_allowed':
      return 'This Claude account is not allowed to use Claude Code here.'
    case 'account_on_hold':
    case 'verification_required':
      return 'Your Claude account needs attention before it can be used. Open claude.ai to see what it asks for.'
    case 'billing_error':
      return 'Claude reported a billing problem with this account.'
    case 'rate_limit':
      return 'You have reached your Claude usage limit for now. It will work again when the limit resets.'
    case 'overloaded':
      return 'Claude is overloaded right now. Try again in a moment.'
    case 'model_not_found':
      return 'This Claude model is not available to your account. Pick another one in the model list.'
    case 'max_output_tokens':
      return 'The answer was cut off because it reached the length limit. Send "continue" to carry on.'
    default:
      return 'Claude could not answer (server error). Try again in a moment.'
  }
}
