import type { AdapterId, Endpoint, ToolCall, Usage } from '@shared/types'

/** JSON-schema tool definition handed to a provider. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ImagePart {
  mime: string
  base64: string
}

/** Provider-neutral conversation message. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImagePart[] }
  | {
      role: 'assistant'
      content: string
      reasoning?: string | null
      reasoningSignature?: string | null
      toolCalls?: ToolCall[]
      /** The reply exactly as the provider sent it, for providers that need it back unchanged (Anthropic). */
      blocks?: Array<Record<string, unknown>> | null
    }
  | { role: 'tool'; callId: string; name: string; content: string; isError: boolean; images?: ImagePart[] }

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  temperature?: number | null
  maxTokens?: number | null
  /** Ask for reasoning/thinking when the model supports it. */
  reasoning?: boolean
  signal?: AbortSignal
  /** Prompt-caching hint for providers that need explicit markers. */
  cache?: boolean
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argsDelta: string }
  | { type: 'usage'; usage: Partial<Usage> }

export interface ChatResult {
  text: string
  reasoning: string | null
  reasoningSignature: string | null
  toolCalls: ToolCall[]
  usage: Usage
  stopReason: string | null
  /** The reply exactly as it came, to be sent back unchanged while the turn runs (Anthropic). */
  blocks?: Array<Record<string, unknown>> | null
  /** The model declined: nothing it wrote counts and none of its tool calls run. */
  declined?: { why: string | null; explanation: string | null } | null
  /** Another model answered instead, after the one asked declined (Anthropic's fallbacks). */
  servedBy?: string | null
}

export interface ProviderAdapter {
  id: AdapterId
  listModels(ep: Endpoint, key: string | null): Promise<string[]>
  /** Streams events, then returns the assembled result. */
  chat(ep: Endpoint, key: string | null, req: ChatRequest): AsyncGenerator<StreamEvent, ChatResult, void>
}

export class ProviderError extends Error {
  status: number | undefined
  retryable: boolean
  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.retryable = retryable
  }
}

export function clip(s: string, n = 600): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    // Some models emit trailing garbage or concatenated objects; salvage the first balanced object.
    const start = raw.indexOf('{')
    if (start < 0) return {}
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < raw.length; i++) {
      const c = raw[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>
          } catch {
            return {}
          }
        }
      }
    }
    return {}
  }
}
