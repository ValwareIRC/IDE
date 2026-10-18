// Anthropic's Messages API, for Prism's own agent. Claude Code sessions do not come
// through here: Claude Code is Anthropic's own harness and keeps its own rules.
//
// What each Claude model accepts changed a lot between Opus 4.6 and Opus 5.5, and the
// rules below follow Anthropic's documentation (checked 2026-10-08):
//
// - Thinking is asked for as "adaptive" from the 4.6 models on, and as a token budget
//   before them; a budget is refused outright by 4.7 and later. Opus 5.5 and Fable always
//   think, so "off" means not asking to see it; Sonnet 5.5 turns it off with
//   "between_tools"; Opus 5 and Sonnet 5 with "disabled".
// - What comes back is a summary written for display, never the raw reasoning, and only
//   when asked for ("summarized"); from Opus 4.7 the default is to send it empty.
// - Temperature is refused by Opus 4.7 and later, Sonnet 5 and later, and Fable.
// - Every block of a reply - thinking (even empty), text, tool calls - goes back exactly
//   as it came, in order, while the turn is still running. A thinking block is only valid
//   while everything before it is unchanged, so thinking from earlier turns is left out,
//   oldest first, which Anthropic allows; Prism rebuilds its instructions every turn and
//   could not promise the rest.
// - A model can decline (stop reason "refusal"). What it had written is thrown away, its
//   tool calls are not run, and the user is told. On the Claude API the newest models
//   are asked to let a recommended model take over instead (fallbacks: "default").
//
// A model that is not Claude, behind an Anthropic-style endpoint, keeps exactly the
// request it always had.
import type { Endpoint, ToolCall, Usage } from '@shared/types'
import { errorBody, readSse } from './sse'
import { clip, parseArgs, ProviderError, type ChatRequest, type ChatResult, type Message, type ProviderAdapter, type StreamEvent } from './types'

const VERSION = '2023-06-01'

/** Beta features used on Anthropic's own API (never sent to other endpoints, which may not know them). */
const BINDING_BETA = 'thinking-binding-controls-2026-08-01'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

function base(ep: Endpoint): string {
  return ep.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Anthropic's own API, as opposed to a cloud platform or a compatible endpoint run by someone else. */
function isClaudeApi(ep: Endpoint): boolean {
  try {
    return new URL(base(ep)).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

function headers(ep: Endpoint, key: string | null, betas: string[]): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': VERSION,
    ...ep.extraHeaders
  }
  if (betas.length) h['anthropic-beta'] = [...new Set([...(h['anthropic-beta'] ?? '').split(',').map((b) => b.trim()), ...betas])].filter(Boolean).join(',')
  if (key) {
    if (ep.auth.kind === 'bearer') h['Authorization'] = `Bearer ${key}`
    else h[ep.auth.kind === 'header' && ep.auth.name ? ep.auth.name : 'x-api-key'] = key
  }
  return h
}

/** What a model accepts. */
export interface Shape {
  claude: boolean
  /** adaptive: {type: "adaptive"}. budget: {type: "enabled", budget_tokens}. */
  thinking: 'adaptive' | 'budget'
  /** How to ask for no thinking: leave the field out, {type: "disabled"}, or Sonnet 5.5's {type: "between_tools"}. */
  off: 'omit' | 'disabled' | 'between_tools'
  /** Thinks whatever is asked, so its (possibly empty) thinking blocks come back every turn. */
  alwaysThinks: boolean
  /** The summary has to be asked for: from Opus 4.7 the default is "omitted". */
  askSummary: boolean
  /** temperature is accepted. */
  sampling: boolean
  /** Server-side fallbacks ("default" form) are offered for this model on the Claude API. */
  fallbacks: boolean
}

/** Not Claude: the request it always had (thinking as a budget, temperature allowed). */
const PLAIN: Shape = { claude: false, thinking: 'budget', off: 'omit', alwaysThinks: false, askSummary: false, sampling: true, fallbacks: false }

/**
 * What a model accepts, from its name. Names carry a platform prefix on some clouds
 * ("anthropic.claude-opus-5-5"), and a date on older ones ("claude-opus-4-5-20251101").
 * A Claude model newer than any named here is assumed to take the newest shape.
 */
export function shapeOf(model: string): Shape {
  const m = model.toLowerCase()
  const at = m.indexOf('claude-')
  if (at < 0) return PLAIN
  const name = m.slice(at)
  // the older naming, claude-3-7-sonnet and the like: thinking by budget, if at all
  if (/^claude-\d/.test(name)) return { ...PLAIN, claude: true }
  const v = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/.exec(name)
  if (!v) return { claude: true, thinking: 'adaptive', off: 'omit', alwaysThinks: false, askSummary: true, sampling: false, fallbacks: false }
  const family = v[1]!
  const version = Number(v[2]) + Number(v[3] ?? 0) / 10
  const modern = { claude: true, thinking: 'adaptive' as const, askSummary: true, sampling: false }
  if (family === 'fable' || family === 'mythos') return { ...modern, off: 'omit', alwaysThinks: true, fallbacks: family === 'fable' && version === 5.1 }
  if (family === 'opus') {
    if (version >= 5.5) return { ...modern, off: 'omit', alwaysThinks: true, fallbacks: version === 5.5 }
    if (version >= 5) return { ...modern, off: 'disabled', alwaysThinks: false, fallbacks: true }
    if (version >= 4.7) return { ...modern, off: 'omit', alwaysThinks: false, fallbacks: false }
    if (version >= 4.6) return { claude: true, thinking: 'adaptive', off: 'omit', alwaysThinks: false, askSummary: false, sampling: true, fallbacks: false }
    return { ...PLAIN, claude: true }
  }
  if (family === 'sonnet') {
    if (version >= 5.5) return { ...modern, off: 'between_tools', alwaysThinks: false, fallbacks: version === 5.5 }
    if (version >= 5) return { ...modern, off: 'disabled', alwaysThinks: false, fallbacks: false }
    if (version >= 4.6) return { claude: true, thinking: 'adaptive', off: 'omit', alwaysThinks: false, askSummary: false, sampling: true, fallbacks: false }
    return { ...PLAIN, claude: true }
  }
  // haiku
  if (version >= 5) return { ...modern, off: 'omit', alwaysThinks: false, fallbacks: false }
  return { ...PLAIN, claude: true }
}

type Block = Record<string, unknown>

/** Why a reply stopped, when it was declined. */
type StopDetails = { category?: string | null; explanation?: string | null }

/**
 * The conversation in Anthropic's form. For Claude: the turn in progress (everything
 * after the user's last message) goes back exactly as each reply came, thinking and all;
 * earlier turns go back as their text and tool calls only. `strip` leaves out every
 * thinking block, for the one retry Anthropic suggests when a block is refused.
 */
function wire(messages: Message[], cache: boolean, claude: boolean, strip = false): { system: Block[] | undefined; messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> } {
  const systemParts: Block[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  let turnStarts = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      turnStarts = i
      break
    }
  }
  for (const [i, m] of messages.entries()) {
    switch (m.role) {
      case 'system':
        systemParts.push({ type: 'text', text: m.content })
        break
      case 'user': {
        const blocks: Block[] = []
        for (const im of m.images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })
        blocks.push({ type: 'text', text: m.content || ' ' })
        push('user', blocks)
        break
      }
      case 'assistant': {
        const current = i > turnStarts
        if (claude && current && !strip && Array.isArray(m.blocks) && m.blocks.length) {
          // exactly as it came: the API refuses a thinking block that has been changed
          push('assistant', m.blocks.map((b) => ({ ...(b as Block) })))
          break
        }
        const blocks: Block[] = []
        const keepThinking = !strip && (!claude || current)
        if (keepThinking && m.reasoning && m.reasoningSignature) blocks.push({ type: 'thinking', thinking: m.reasoning, signature: m.reasoningSignature })
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })
        if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' })
        push('assistant', blocks)
        break
      }
      case 'tool': {
        const content: Block[] = [{ type: 'text', text: m.content || '(empty)' }]
        for (const im of m.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })
        push('user', [{ type: 'tool_result', tool_use_id: m.callId, content, ...(m.isError ? { is_error: true } : {}) }])
        break
      }
    }
  }
  if (cache) {
    const lastSys = systemParts[systemParts.length - 1]
    if (lastSys) lastSys['cache_control'] = { type: 'ephemeral' }
    // Cache the conversation prefix up to the last user turn.
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]!
      if (m.role === 'user') {
        const lastBlock = m.content[m.content.length - 1]
        if (lastBlock) lastBlock['cache_control'] = { type: 'ephemeral' }
        break
      }
    }
  }
  return { system: systemParts.length ? systemParts : undefined, messages: out }
}

/** The request body, and the betas it needs. */
export function requestFor(ep: Endpoint, req: ChatRequest, strip = false): { body: Record<string, unknown>; betas: string[] } {
  const shape = shapeOf(req.model)
  const own = isClaudeApi(ep) && shape.claude
  const { system, messages } = wire(req.messages, req.cache !== false, shape.claude, strip)
  const maxTokens = req.maxTokens ?? 16_000
  const body: Record<string, unknown> = { model: req.model, max_tokens: maxTokens, messages, stream: true }
  const betas: string[] = []
  if (system) body['system'] = system
  if (req.tools?.length) {
    body['tools'] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(req.cache !== false && i === req.tools!.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
    }))
  }

  let thinking: Block | null = null
  if (req.reasoning) {
    if (shape.thinking === 'adaptive') thinking = { type: 'adaptive', ...(shape.askSummary ? { display: 'summarized' } : {}) }
    else thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.min(32_000, Math.floor(maxTokens * 0.6))) }
  } else if (shape.claude) {
    if (shape.off === 'disabled') thinking = { type: 'disabled' }
    else if (shape.off === 'between_tools') thinking = { type: 'between_tools' }
    // a model that always thinks is asked plainly, so its thinking can be bound below
    else if (shape.alwaysThinks) thinking = { type: 'adaptive' }
  }
  // On Anthropic's own API, a thinking block whose history no longer matches is dropped
  // rather than failing the request: Prism replays only the turn in progress, so this
  // is a safety net, not a habit. (between_tools takes no other field, and disabled has
  // no blocks to bind.)
  if (own && thinking && (thinking['type'] === 'adaptive' || thinking['type'] === 'enabled')) {
    thinking['block_binding'] = { prefix_mismatch_behavior: 'drop_block' }
    betas.push(BINDING_BETA)
  }
  if (thinking) body['thinking'] = thinking
  if (req.temperature !== undefined && req.temperature !== null && shape.sampling && !(thinking && thinking['type'] !== 'disabled')) body['temperature'] = req.temperature
  // (not alongside between_tools: whether the model taking over accepts it is not documented)
  if (own && shape.fallbacks && thinking?.['type'] !== 'between_tools') {
    body['fallbacks'] = 'default'
    betas.push(FALLBACK_BETA)
  }
  return { body, betas }
}

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500
}

/** A thinking block the API would not take back (edited, or tied to a different history). */
function thinkingRefused(status: number, text: string): boolean {
  return status === 400 && /thinking/i.test(text) && /signature|different conversation|block_binding/i.test(text)
}

/** Why a model declined, in words for the person reading. */
const DECLINED: Record<string, string> = {
  cyber: 'it looked like security work this model will not do',
  bio: 'it looked like biology research this model will not do',
  reasoning_extraction: 'it asked the model to write out its hidden reasoning',
  frontier_llm: 'it looked like work on building other AI models',
  general_harms: 'it looked like it could cause harm'
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  async listModels(ep, key) {
    const res = await fetch(`${base(ep)}/v1/models?limit=1000`, { headers: headers(ep, key, []), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${clip(await errorBody(res))}`, res.status)
    const j = (await res.json()) as { data?: Array<{ id?: string }> }
    return (j.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort()
  },

  async *chat(ep, key, req): AsyncGenerator<StreamEvent, ChatResult, void> {
    const shape = shapeOf(req.model)
    let res: Response | null = null
    let handOver = false
    for (const strip of [false, true]) {
      const { body, betas } = requestFor(ep, req, strip)
      handOver = body['fallbacks'] !== undefined
      try {
        res = await fetch(`${base(ep)}/v1/messages`, { method: 'POST', headers: headers(ep, key, betas), body: JSON.stringify(body), signal: req.signal })
      } catch (e) {
        if ((e as Error).name === 'AbortError' || req.signal?.aborted) throw new Error('aborted')
        throw new ProviderError(`Connection failed: ${clip((e as Error).message ?? String(e))}`, undefined, true)
      }
      if (res.ok) break
      const text = await errorBody(res)
      // Anthropic's own advice when a thinking block is refused: send the history again without any, once
      if (!strip && shape.claude && thinkingRefused(res.status, text)) continue
      throw new ProviderError(`HTTP ${res.status}: ${clip(text)}`, res.status, retryable(res.status))
    }
    if (!res) throw new ProviderError('No response', undefined, true)

    let stop: string | null = null
    let stopDetails = null as StopDetails | null
    let servedBy: string | null = null
    const usage: Partial<Usage> = {}
    /** Every block as it came, by its position in the reply. */
    const blocks = new Map<number, Block & { args?: string }>()

    for await (const payload of readSse(res, { signal: req.signal })) {
      let j: {
        type?: string
        index?: number
        content_block?: Block
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string; stop_reason?: string; stop_details?: StopDetails | null }
        message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
        usage?: { output_tokens?: number; input_tokens?: number }
        stop_details?: StopDetails | null
        error?: { message?: string }
      }
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      switch (j.type) {
        case 'error':
          throw new ProviderError(j.error?.message ?? 'stream error', undefined, true)
        case 'message_start': {
          const u = j.message?.usage
          if (u) {
            usage.inputTokens = u.input_tokens ?? 0
            usage.cacheReadTokens = u.cache_read_input_tokens
            usage.cacheWriteTokens = u.cache_creation_input_tokens
          }
          // another model answering is only ever a handover Prism asked for
          if (handOver && j.message?.model && j.message.model !== req.model) servedBy = j.message.model
          break
        }
        case 'content_block_start': {
          const idx = j.index ?? 0
          const cb = j.content_block ?? {}
          const t = String(cb['type'] ?? 'text')
          if (t === 'tool_use') {
            const id = String(cb['id'] ?? `tu_${idx}`)
            const name = String(cb['name'] ?? 'unknown')
            blocks.set(idx, { type: 'tool_use', id, name, input: {}, args: '' })
            yield { type: 'tool-call-start', id, name }
          } else if (t === 'thinking') {
            blocks.set(idx, { type: 'thinking', thinking: String(cb['thinking'] ?? ''), signature: String(cb['signature'] ?? '') })
          } else if (t === 'text') {
            blocks.set(idx, { type: 'text', text: String(cb['text'] ?? '') })
          } else {
            // redacted_thinking, fallback markers, and anything newer: kept whole
            blocks.set(idx, { ...cb })
            if (t === 'fallback' && handOver) {
              const to = (cb['to'] as { model?: string } | undefined)?.model
              if (to) servedBy = to
            }
          }
          break
        }
        case 'content_block_delta': {
          const d = j.delta
          const b = blocks.get(j.index ?? 0)
          if (!d || !b) break
          if (d.type === 'text_delta' && d.text) {
            b['text'] = String(b['text'] ?? '') + d.text
            yield { type: 'text', text: d.text }
          } else if (d.type === 'thinking_delta' && d.thinking) {
            b['thinking'] = String(b['thinking'] ?? '') + d.thinking
            yield { type: 'reasoning', text: d.thinking }
          } else if (d.type === 'signature_delta' && d.signature) {
            b['signature'] = String(b['signature'] ?? '') + d.signature
          } else if (d.type === 'input_json_delta' && d.partial_json && b['type'] === 'tool_use') {
            b.args = (b.args ?? '') + d.partial_json
            yield { type: 'tool-call-delta', id: String(b['id']), argsDelta: d.partial_json }
          }
          break
        }
        case 'content_block_stop': {
          const b = blocks.get(j.index ?? 0)
          if (b && b['type'] === 'tool_use') b['input'] = parseArgs(b.args || '{}')
          break
        }
        case 'message_delta': {
          if (j.usage?.output_tokens !== undefined) usage.outputTokens = j.usage.output_tokens
          if (j.delta?.stop_reason) stop = j.delta.stop_reason
          stopDetails = j.delta?.stop_details ?? j.stop_details ?? stopDetails
          break
        }
        case 'message_stop':
          break
      }
    }
    yield { type: 'usage', usage }
    const finalUsage: Usage = { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens }

    // Declined: what was written is not an answer, and its tool calls are not run.
    if (stop === 'refusal') {
      const why = stopDetails?.category ? DECLINED[stopDetails.category] : undefined
      return {
        text: '',
        reasoning: null,
        reasoningSignature: null,
        toolCalls: [],
        usage: finalUsage,
        stopReason: stop,
        blocks: null,
        declined: { why: why ?? null, explanation: stopDetails?.explanation ?? null },
        servedBy
      }
    }

    let ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
    // After a model hands over partway through, only the text written before the handover
    // goes back; its thinking and tool calls belonged to the model that declined.
    const handover = ordered.map((b) => b['type']).lastIndexOf('fallback')
    if (handover >= 0) ordered = [...ordered.slice(0, handover).filter((b) => b['type'] === 'text'), ...ordered.slice(handover + 1)]
    const clean = ordered.map((b) => {
      const { args: _args, ...rest } = b
      return rest
    })
    const toolCalls: ToolCall[] = clean.filter((b) => b['type'] === 'tool_use').map((b) => ({ id: String(b['id']), name: String(b['name']), args: (b['input'] as Record<string, unknown>) ?? {} }))
    const text = clean.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('')
    const thinkingBlocks = clean.filter((b) => b['type'] === 'thinking')
    // Claude: each summary on its own. Not Claude: joined exactly as it always was, with
    // its one signature, the form it is sent back in.
    const thought = shape.claude
      ? thinkingBlocks
          .map((b) => String(b['thinking'] ?? ''))
          .filter((t) => t.trim())
          .join('\n\n')
      : thinkingBlocks.map((b) => String(b['thinking'] ?? '')).join('')
    const signature = thinkingBlocks.map((b) => String(b['signature'] ?? '')).join('')
    return {
      text,
      reasoning: thought || null,
      reasoningSignature: shape.claude ? null : signature || null,
      toolCalls,
      usage: finalUsage,
      stopReason: stop,
      blocks: shape.claude ? clean : null,
      declined: null,
      servedBy
    }
  }
}
