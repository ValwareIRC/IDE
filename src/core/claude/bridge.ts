// Prism's own tools, offered to Claude Code as an in-process MCP server named
// "prism" (Claude sees them as mcp__prism__<tool>). The Agent SDK only needs an
// object with connect(transport); the few MCP messages involved are answered
// here directly, so tool schemas stay the plain JSON Schema Prism already has.
import type { AgentTool, ToolContext, ToolResult } from '../agent/tools'

export const PRISM_SERVER = 'prism'
export const PRISM_PREFIX = `mcp__${PRISM_SERVER}__`

interface Rpc {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

interface Transport {
  onmessage?: (msg: Rpc) => void
  send(msg: unknown): Promise<void>
  start?(): Promise<void>
}

export interface PrismBridge {
  /** What the Agent SDK's mcpServers option takes. */
  config: { type: 'sdk'; name: string; instance: never }
  /** The full result of a finished call (its diff, pictures and panel hints), matched by tool and arguments. */
  take(name: string, args: Record<string, unknown>): ToolResult | null
}

/** How long a tool call may take before Claude is told it did not finish. */
const CALL_LIMIT_MIN = 40

export function prismBridge(tools: AgentTool[], ctx: () => ToolContext): PrismBridge {
  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  const results: Array<{ name: string; key: string; result: ToolResult }> = []

  const call = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const name = String(params['name'] ?? '')
    const args = (params['arguments'] ?? {}) as Record<string, unknown>
    const tool = byName.get(name)
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true }
    let r: ToolResult
    // A tool that never answers would hold Claude's turn for ever: each one sets its own
    // limits, and this is the net under all of them (a build or a deploy may take half an hour)
    let timer: NodeJS.Timeout | undefined
    const giveUp = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => resolve({ content: `${name} had not finished after ${CALL_LIMIT_MIN} minutes, so Prism stopped waiting for it. Whatever it started may still be running.`, isError: true }), CALL_LIMIT_MIN * 60_000)
    })
    try {
      r = await Promise.race([tool.execute(args, ctx()), giveUp])
    } catch (e) {
      r = { content: e instanceof Error ? e.message : String(e), isError: true }
    } finally {
      clearTimeout(timer)
    }
    results.push({ name, key: JSON.stringify(args), result: r })
    if (results.length > 40) results.shift()
    return {
      content: [{ type: 'text', text: r.content || '(done)' }, ...(r.images ?? []).slice(0, 6).map((im) => ({ type: 'image', data: im.base64, mimeType: im.mime }))],
      isError: r.isError
    }
  }

  const instance = {
    async connect(transport: Transport): Promise<void> {
      const reply = (id: Rpc['id'], result: unknown): void => void transport.send({ jsonrpc: '2.0', id, result }).catch(() => {})
      transport.onmessage = (msg) => {
        if (msg.id === undefined || !msg.method) return // notifications need no answer
        switch (msg.method) {
          case 'initialize':
            reply(msg.id, { protocolVersion: msg.params?.['protocolVersion'] ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: PRISM_SERVER, version: '1' } })
            break
          case 'tools/list':
            reply(msg.id, {
              tools: tools.map((t) => ({ name: t.spec.name, description: t.spec.description, inputSchema: t.spec.parameters, annotations: { readOnlyHint: t.readOnly } }))
            })
            break
          case 'tools/call':
            void call(msg.params ?? {}).then((r) => reply(msg.id, r))
            break
          case 'ping':
            reply(msg.id, {})
            break
          default:
            void transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }).catch(() => {})
        }
      }
      await transport.start?.()
    }
  }

  return {
    config: { type: 'sdk', name: PRISM_SERVER, instance: instance as never },
    take(name, args) {
      const key = JSON.stringify(args)
      const i = results.findIndex((r) => r.name === name && r.key === key)
      return i < 0 ? null : results.splice(i, 1)[0]!.result
    }
  }
}
