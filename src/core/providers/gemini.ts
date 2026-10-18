import type { Endpoint, ToolCall, Usage } from '@shared/types'
import { errorBody, readSse } from './sse'
import { clip, ProviderError, type ChatResult, type Message, type ProviderAdapter, type StreamEvent } from './types'

function base(ep: Endpoint): string {
  let u = ep.baseUrl.trim().replace(/\/+$/, '')
  u = u.replace(/\/v1(beta)?$/, '')
  return u + '/v1beta'
}

function headers(ep: Endpoint, key: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...ep.extraHeaders }
  if (key && ep.auth.kind !== 'query') h[ep.auth.kind === 'header' && ep.auth.name ? ep.auth.name : 'x-goog-api-key'] = key
  return h
}

function url(ep: Endpoint, key: string | null, path: string): string {
  let u = base(ep) + path
  if (ep.auth.kind === 'query' && key) u += (u.includes('?') ? '&' : '?') + encodeURIComponent(ep.auth.name ?? 'key') + '=' + encodeURIComponent(key)
  return u
}

type Part = Record<string, unknown>

function wire(messages: Message[]): { system: string | undefined; contents: Array<{ role: 'user' | 'model'; parts: Part[] }> } {
  const sys: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = []
  const nameById = new Map<string, string>()
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        sys.push(m.content)
        break
      case 'user': {
        const parts: Part[] = []
        if (m.content) parts.push({ text: m.content })
        for (const im of m.images ?? []) parts.push({ inlineData: { mimeType: im.mime, data: im.base64 } })
        if (!parts.length) parts.push({ text: ' ' })
        push('user', parts)
        break
      }
      case 'assistant': {
        const parts: Part[] = []
        if (m.content) parts.push({ text: m.content })
        for (const c of m.toolCalls ?? []) {
          nameById.set(c.id, c.name)
          parts.push({ functionCall: { name: c.name, args: c.args ?? {} } })
        }
        if (!parts.length) parts.push({ text: ' ' })
        push('model', parts)
        break
      }
      case 'tool': {
        const parts: Part[] = [
          {
            functionResponse: {
              name: m.name || nameById.get(m.callId) || 'tool',
              response: m.isError ? { error: m.content } : { result: m.content }
            }
          }
        ]
        for (const im of m.images ?? []) parts.push({ inlineData: { mimeType: im.mime, data: im.base64 } })
        push('user', parts)
        break
      }
    }
  }
  return { system: sys.length ? sys.join('\n\n') : undefined, contents }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',

  async listModels(ep, key) {
    const res = await fetch(url(ep, key, '/models?pageSize=1000'), { headers: headers(ep, key), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${clip(await errorBody(res))}`, res.status)
    const j = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }
    return (j.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort()
  },

  async *chat(ep, key, req): AsyncGenerator<StreamEvent, ChatResult, void> {
    const { system, contents } = wire(req.messages)
    const body: Record<string, unknown> = { contents }
    if (system) body['systemInstruction'] = { parts: [{ text: system }] }
    if (req.tools?.length) {
      body['tools'] = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: stripSchema(t.parameters) })) }]
    }
    const gen: Record<string, unknown> = {}
    if (req.temperature !== undefined && req.temperature !== null) gen['temperature'] = req.temperature
    if (req.maxTokens) gen['maxOutputTokens'] = req.maxTokens
    if (req.reasoning) gen['thinkingConfig'] = { includeThoughts: true }
    if (Object.keys(gen).length) body['generationConfig'] = gen

    let res: Response
    try {
      res = await fetch(url(ep, key, `/models/${req.model}:streamGenerateContent?alt=sse`), {
        method: 'POST',
        headers: headers(ep, key),
        body: JSON.stringify(body),
        signal: req.signal
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError' || req.signal?.aborted) throw new Error('aborted')
      throw new ProviderError(`Connection failed: ${clip((e as Error).message ?? String(e))}`, undefined, true)
    }
    if (!res.ok) {
      const text = await errorBody(res)
      throw new ProviderError(`HTTP ${res.status}: ${clip(text)}`, res.status, retryable(res.status))
    }

    let text = ''
    let reasoning = ''
    let stop: string | null = null
    const usage: Partial<Usage> = {}
    const toolCalls: ToolCall[] = []
    let n = 0

    for await (const payload of readSse(res, { signal: req.signal })) {
      let j: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string } }> }; finishReason?: string }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number }
        error?: { message?: string }
      }
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      if (j.error?.message) throw new ProviderError(j.error.message, undefined, true)
      const cand = j.candidates?.[0]
      if (cand?.finishReason) stop = cand.finishReason
      for (const p of cand?.content?.parts ?? []) {
        if (p.functionCall?.name) {
          n += 1
          const id = p.functionCall.id ?? `fc_${n}_${Date.now().toString(36)}`
          toolCalls.push({ id, name: p.functionCall.name, args: p.functionCall.args ?? {} })
          yield { type: 'tool-call-start', id, name: p.functionCall.name }
          yield { type: 'tool-call-delta', id, argsDelta: JSON.stringify(p.functionCall.args ?? {}) }
        } else if (typeof p.text === 'string' && p.text) {
          if (p.thought) {
            reasoning += p.text
            yield { type: 'reasoning', text: p.text }
          } else {
            text += p.text
            yield { type: 'text', text: p.text }
          }
        }
      }
      if (j.usageMetadata) {
        usage.inputTokens = j.usageMetadata.promptTokenCount ?? usage.inputTokens
        usage.outputTokens = (j.usageMetadata.candidatesTokenCount ?? 0) + (j.usageMetadata.thoughtsTokenCount ?? 0)
        usage.cacheReadTokens = j.usageMetadata.cachedContentTokenCount
      }
    }
    yield { type: 'usage', usage }
    return {
      text,
      reasoning: reasoning || null,
      reasoningSignature: null,
      toolCalls,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cacheReadTokens: usage.cacheReadTokens },
      stopReason: stop
    }
  }
}

/** Gemini rejects some JSON-schema keywords; keep the subset it understands. */
function stripSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['type', 'properties', 'required', 'description', 'enum', 'items', 'nullable', 'format', 'minimum', 'maximum', 'anyOf'])
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v !== 'object' || v === null) return v
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'properties' && typeof val === 'object' && val) {
        const props: Record<string, unknown> = {}
        for (const [pk, pv] of Object.entries(val as Record<string, unknown>)) props[pk] = walk(pv)
        out[k] = props
      } else if (allowed.has(k)) {
        out[k] = walk(val)
      }
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}
