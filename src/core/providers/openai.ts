import type { Endpoint, ToolCall, Usage } from '@shared/types'
import { errorBody, readSse } from './sse'
import { clip, parseArgs, ProviderError, type ChatRequest, type ChatResult, type Message, type ProviderAdapter, type StreamEvent, type ToolSpec } from './types'

/**
 * OpenAI-compatible chat completions: OpenAI, OpenRouter, Z.ai/BigModel (GLM),
 * DeepSeek, Groq, Together, Mistral, xAI, Ollama, LM Studio, vLLM, llama.cpp…
 */

export function normalizeBase(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(u)
    if (parsed.pathname === '' || parsed.pathname === '/') u += '/v1'
  } catch {
    /* fetch reports bad URLs */
  }
  return u
}

function url(ep: Endpoint, path: string, key: string | null): string {
  let u = normalizeBase(ep.baseUrl) + path
  if (ep.auth.kind === 'query' && key && ep.auth.name) {
    u += (u.includes('?') ? '&' : '?') + encodeURIComponent(ep.auth.name) + '=' + encodeURIComponent(key)
  }
  return u
}

function headers(ep: Endpoint, key: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...ep.extraHeaders }
  if (key) {
    if (ep.auth.kind === 'bearer') h['Authorization'] = `Bearer ${key}`
    else if (ep.auth.kind === 'header' && ep.auth.name) h[ep.auth.name] = key
  }
  return h
}

function isZhipu(ep: Endpoint): boolean {
  return /z\.ai|bigmodel\.cn|zhipu/i.test(ep.baseUrl)
}

function wireMessages(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content })
        break
      case 'user':
        if (m.images?.length) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: m.content || ' ' },
              ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } }))
            ]
          })
        } else {
          out.push({ role: 'user', content: m.content })
        }
        break
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null }
        if (m.toolCalls?.length) {
          msg['tool_calls'] = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
          }))
        }
        if (m.reasoning && m.reasoning.trim()) msg['reasoning_content'] = m.reasoning
        out.push(msg)
        break
      }
      case 'tool': {
        let content = m.content
        if (m.images?.length) content += `\n[${m.images.length} image(s) attached to this result]`
        out.push({ role: 'tool', tool_call_id: m.callId, content })
        // Vision via tool results is not standard; surface images as a follow-up user message.
        if (m.images?.length) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: `Images returned by tool ${m.name}:` },
              ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } }))
            ]
          })
        }
        break
      }
    }
  }
  return out
}

function wireTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

function usageFrom(u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined): Partial<Usage> {
  if (!u) return {}
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens
  }
}

interface ToolAcc {
  id: string
  name: string
  args: string
}

function finish(text: string, reasoning: string, acc: Map<number, ToolAcc>, usage: Partial<Usage>, stop: string | null): ChatResult {
  const toolCalls: ToolCall[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, t]) => t.name)
    .map(([, t]) => ({ id: t.id, name: t.name, args: parseArgs(t.args) }))
  return {
    text,
    reasoning: reasoning || null,
    reasoningSignature: null,
    toolCalls,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cacheReadTokens: usage.cacheReadTokens },
    stopReason: stop
  }
}

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai-compat',

  async listModels(ep, key) {
    const res = await fetch(url(ep, '/models', key), { headers: headers(ep, key), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${clip(await errorBody(res))}`, res.status)
    const j = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; id?: string }> }
    const ids = (j.data ?? j.models ?? []).map((m) => (typeof m?.id === 'string' ? m.id : typeof (m as { name?: string })?.name === 'string' ? (m as { name: string }).name : '')).filter(Boolean)
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  },

  async *chat(ep, key, req): AsyncGenerator<StreamEvent, ChatResult, void> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (req.tools?.length) body['tools'] = wireTools(req.tools)
    if (req.temperature !== undefined && req.temperature !== null) body['temperature'] = req.temperature
    if (req.maxTokens) body['max_tokens'] = req.maxTokens
    if (isZhipu(ep)) body['thinking'] = { type: req.reasoning === false ? 'disabled' : 'enabled' }

    const doFetch = async (b: Record<string, unknown>): Promise<Response> => {
      try {
        return await fetch(url(ep, '/chat/completions', key), {
          method: 'POST',
          headers: headers(ep, key),
          body: JSON.stringify(b),
          signal: req.signal
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError' || req.signal?.aborted) throw new Error('aborted')
        throw new ProviderError(`Connection failed: ${clip((e as Error).message ?? String(e))}`, undefined, true)
      }
    }

    let res = await doFetch(body)
    if (!res.ok) {
      const text = await errorBody(res)
      if (res.status === 400 && /stream_options|thinking/i.test(text)) {
        const { stream_options: _so, thinking: _th, ...rest } = body
        void _so
        void _th
        res = await doFetch(rest)
      }
      if (!res.ok) {
        const t2 = res.bodyUsed ? text : await errorBody(res)
        throw new ProviderError(`HTTP ${res.status}: ${clip(t2 || text)}`, res.status, retryable(res.status))
      }
    }

    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('text/event-stream')) {
      // Server ignored stream:true and sent one JSON completion.
      const j = (await res.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>
        usage?: Record<string, unknown>
      }
      const m = j.choices?.[0]?.message
      const acc = new Map<number, ToolAcc>()
      ;(m?.tool_calls ?? []).forEach((c, i) => acc.set(i, { id: c.id ?? `call_${i}`, name: c.function?.name ?? '', args: c.function?.arguments ?? '{}' }))
      const text = m?.content ?? ''
      const reasoning = m?.reasoning_content ?? m?.reasoning ?? ''
      if (reasoning) yield { type: 'reasoning', text: reasoning }
      if (text) yield { type: 'text', text }
      return finish(text, reasoning, acc, usageFrom(j.usage as Parameters<typeof usageFrom>[0]), j.choices?.[0]?.finish_reason ?? null)
    }

    let text = ''
    let reasoning = ''
    let stop: string | null = null
    let usage: Partial<Usage> = {}
    const acc = new Map<number, ToolAcc>()
    const started = new Set<number>()

    for await (const payload of readSse(res, { signal: req.signal })) {
      if (payload === '[DONE]') break
      let j: {
        choices?: Array<{
          finish_reason?: string | null
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            reasoning?: string | null
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
        }>
        usage?: Record<string, unknown>
        error?: { message?: string }
      }
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      if (j.error?.message) throw new ProviderError(j.error.message, undefined, false)
      const choice = j.choices?.[0]
      const delta = choice?.delta
      if (choice?.finish_reason) stop = choice.finish_reason
      const think = delta?.reasoning_content ?? delta?.reasoning
      if (typeof think === 'string' && think) {
        reasoning += think
        yield { type: 'reasoning', text: think }
      }
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        yield { type: 'text', text: delta.content }
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0
        let a = acc.get(idx)
        if (!a) {
          a = { id: tc.id ?? `call_${idx}_${Date.now().toString(36)}`, name: '', args: '' }
          acc.set(idx, a)
        }
        if (tc.id) a.id = tc.id
        if (tc.function?.name) a.name += tc.function.name
        if (tc.function?.arguments) a.args += tc.function.arguments
        if (a.name && !started.has(idx)) {
          started.add(idx)
          yield { type: 'tool-call-start', id: a.id, name: a.name }
        }
        if (tc.function?.arguments) yield { type: 'tool-call-delta', id: a.id, argsDelta: tc.function.arguments }
      }
      if (j.usage) {
        usage = usageFrom(j.usage as Parameters<typeof usageFrom>[0])
        yield { type: 'usage', usage }
      }
    }
    return finish(text, reasoning, acc, usage, stop)
  }
}
