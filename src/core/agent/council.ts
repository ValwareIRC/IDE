import type { RoutingRule, Settings, TranscriptItem, ModelRef, PermissionMode, Usage } from '@shared/types'
import { getAdapter } from '../providers'
import type { Message } from '../providers/types'
import type { ResolvedModel } from './engine'

/**
 * More than one model on the same question: a second opinion on an answer,
 * several models answering side by side, and rules that pick a model per
 * message. None of these use tools; they read the conversation as text.
 */

const DIGEST_CHARS = 60_000

/** The conversation as plain text, newest part kept when it is long, so any model can read it whatever its tool-calling dialect. */
export function digest(items: TranscriptItem[]): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.kind === 'user') parts.push(`USER:\n${it.expanded ?? it.text}`)
    else if (it.kind === 'assistant') {
      if (it.text.trim()) parts.push(`AGENT:\n${it.text.trim()}`)
    } else if (it.kind === 'tool') {
      const args = JSON.stringify(it.args ?? {})
      parts.push(`TOOL ${it.name}(${args.length > 300 ? args.slice(0, 300) + '…' : args})${it.isError ? ' [failed]' : ''}:\n${it.content.length > 1500 ? it.content.slice(0, 1500) + '\n…' : it.content}`)
    } else if (it.subkind === 'compaction') parts.push(`SUMMARY OF EARLIER TURNS:\n${it.text}`)
  }
  let text = parts.join('\n\n')
  if (text.length > DIGEST_CHARS) text = `…(earlier part left out)\n\n${text.slice(-DIGEST_CHARS)}`
  return text
}

export interface StreamedAnswer {
  text: string
  usage: Usage
  ms: number
}

/** One model answering in plain text, streamed. */
export async function streamAnswer(model: ResolvedModel, messages: Message[], onText: (delta: string) => void, signal?: AbortSignal, maxTokens = 4000): Promise<StreamedAnswer> {
  const t0 = Date.now()
  const adapter = getAdapter(model.ep.adapter)
  const gen = adapter.chat(model.ep, model.key, { model: model.info.modelId, messages, maxTokens: model.info.maxOutput ? Math.min(model.info.maxOutput, maxTokens) : maxTokens, reasoning: false, signal, cache: false })
  let r = await gen.next()
  while (!r.done) {
    if (r.value.type === 'text') onText(r.value.text)
    r = await gen.next()
  }
  return { text: r.value.text, usage: r.value.usage, ms: Date.now() - t0 }
}

export function opinionMessages(items: TranscriptItem[]): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a senior engineer giving a second opinion on the work of an AI coding agent. You see the conversation between a user and the agent, including what its tools returned. Judge the agent\'s LAST answer: say plainly whether it is right, name concrete mistakes, risks or things it missed, and say what you would do differently. Be specific (files, lines, commands) and brief. If it is fine, say so in one or two sentences; do not invent problems. Markdown.'
    },
    { role: 'user', content: `${digest(items)}\n\n---\nGive your second opinion on the agent's last answer.` }
  ]
}

export function compareMessages(items: TranscriptItem[], question: string): Message[] {
  const ctx = items.length ? `The conversation so far, for context:\n\n${digest(items)}\n\n---\n` : ''
  return [
    { role: 'system', content: 'You are an expert software engineer answering inside Prism, an agentic IDE. You cannot run tools in this reply: answer directly and concretely from what you are given. Markdown; code in fenced blocks.' },
    { role: 'user', content: `${ctx}${question}` }
  ]
}

function matches(rule: RoutingRule, m: { text: string; hasImages: boolean; mode: PermissionMode }): boolean {
  switch (rule.when) {
    case 'image':
      return m.hasImages
    case 'plan':
      return m.mode === 'plan'
    case 'short':
      return m.text.trim().length <= (Number(rule.value) || 200)
    case 'long':
      return m.text.trim().length >= (Number(rule.value) || 2000)
    case 'keyword': {
      const words = (rule.value ?? '')
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
      const t = m.text.toLowerCase()
      return words.some((w) => t.includes(w))
    }
    default:
      return false
  }
}

/** The first routing rule that fits this message, when routing is on. */
export function routeModel(settings: Settings, m: { text: string; hasImages: boolean; mode: PermissionMode }): { model: ModelRef; rule: RoutingRule } | null {
  if (!settings.routing?.enabled) return null
  for (const rule of settings.routing.rules) if (rule.model && matches(rule, m)) return { model: rule.model, rule }
  return null
}
