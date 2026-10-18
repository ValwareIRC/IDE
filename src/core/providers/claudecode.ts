// Claude for Prism's one-off requests (the Fast, Vision and Review roles, second opinions):
// through the Claude Code signed in on this computer, because a Claude Agent model has no API
// key for Prism to call with. Each request is a single answer with no tools: Claude Code's
// own tools are switched off, no CLAUDE.md, settings or MCP servers are read, and nothing is
// kept in Claude Code's history. It is the user's own login, for their own use on their own
// computer, like Claude Agent sessions (docs/ai/anthropic-conformance.md).
//
// The endpoint is made up by Services.resolveModel: its baseUrl is where Claude Code is.
import { tmpdir } from 'node:os'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeEnv } from '../claude/locate'
import { ProviderError, type ChatRequest, type ChatResult, type Message, type ProviderAdapter, type StreamEvent } from './types'

/** The longest one answer may take before it is given up on. */
const LIMIT_MS = 5 * 60_000

function asText(m: Message): string {
  if (m.role === 'tool') return `[${m.name} result]\n${m.content}`
  return m.content
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',

  async listModels() {
    // Claude Code's models come from its own catalogue (core/claude/catalog.ts)
    return []
  },

  async *chat(ep, _key, req: ChatRequest): AsyncGenerator<StreamEvent, ChatResult, void> {
    if (req.tools?.length) throw new ProviderError('A Claude Agent model can answer questions for Prism, but cannot drive Prism\'s own agent. Pick another model for this role.')
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages.filter((m) => m.role !== 'system')
    // one question and one answer: the conversation so far becomes a single message
    const text =
      rest.length === 1
        ? asText(rest[0]!)
        : rest.map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User'}:\n${asText(m)}`).join('\n\n')
    const images = rest.flatMap((m) => (m.role === 'user' || m.role === 'tool' ? (m.images ?? []) : []))
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          ...images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mime as 'image/png', data: im.base64 } })),
          { type: 'text' as const, text: text || '(empty)' }
        ]
      }
    }
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield message
    }

    const abort = new AbortController()
    const stop = (): void => abort.abort()
    req.signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, LIMIT_MS)
    const t0 = Date.now()
    let errTail = ''
    try {
      const q = query({
        prompt: prompt(),
        options: {
          cwd: tmpdir(),
          env: claudeEnv(),
          pathToClaudeCodeExecutable: ep.baseUrl,
          model: req.model,
          ...(system ? { systemPrompt: system } : {}),
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: 1,
          abortController: abort,
          stderr: (d: string) => (errTail = (errTail + d).slice(-2000))
        }
      })
      for await (const msg of q) {
        if (msg.type !== 'result') continue
        if (msg.subtype !== 'success' || msg.is_error) throw new ProviderError(`Claude Code could not answer: ${'result' in msg ? String(msg.result) : msg.subtype}`)
        const answer = msg.result ?? ''
        yield { type: 'text', text: answer }
        const usage = { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0, cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0, latencyMs: Date.now() - t0 }
        return { text: answer, reasoning: null, reasoningSignature: null, toolCalls: [], usage, stopReason: 'end_turn' }
      }
      throw new ProviderError(`Claude Code stopped without answering.${errTail ? ` ${errTail.trim().split('\n').pop()}` : ''}`, undefined, true)
    } catch (e) {
      if (abort.signal.aborted && !req.signal?.aborted) throw new ProviderError('Claude Code took too long to answer.', undefined, true)
      throw e
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', stop)
    }
  }
}
