import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Minimal MCP stdio client: JSON-RPC 2.0 over newline-delimited stdio.
 * initialize → notifications/initialized → tools/list → tools/call.
 */

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: string
  isError: boolean
  images: Array<{ mime: string; base64: string }>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const CONNECT_TIMEOUT = 30_000
// npx and friends fetch the server the first time they run it, which on a slow line takes longer than talking
// to one that is already there
const FETCH_TIMEOUT = 150_000
const CALL_TIMEOUT = 180_000

export class McpClient {
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 1
  private closed = false
  private pending = new Map<number, Pending>()
  tools: McpToolDef[] = []
  serverName = ''
  log: string[] = []

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>
  ) {}

  get isConnected(): boolean {
    return !this.closed && this.proc !== null
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin || this.closed) throw new Error('MCP server is not running')
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  private handle(msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } }): void {
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'))
    else p.resolve(msg.result)
  }

  async connect(): Promise<void> {
    const isWin = process.platform === 'win32'
    const exe = this.command
    const viaCmd = isWin && (/\.(cmd|bat)$/i.test(exe) || /^(npx|pnpm|uvx|uv|npm|yarn|bunx)$/i.test(exe))
    this.proc = viaCmd
      ? spawn('cmd.exe', ['/c', exe, ...this.args], { windowsHide: true, env: { ...process.env, ...this.env } })
      : spawn(exe, this.args, { windowsHide: true, env: { ...process.env, ...this.env } })

    this.proc.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8')
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        try {
          this.handle(JSON.parse(line))
        } catch {
          /* noise */
        }
      }
    })
    this.proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim()
      if (line) this.log = [...this.log.slice(-99), line]
    })
    this.proc.on('exit', () => {
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('MCP server exited'))
      }
      this.pending.clear()
    })
    this.proc.on('error', (e) => {
      this.closed = true
      this.log.push(e.message)
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(e)
      }
      this.pending.clear()
    })
    this.proc.stdin?.on('error', () => {
      /* EPIPE on a dying server: exit handler cleans up */
    })

    const firstRun = viaCmd || /^(npx|pnpm|uvx|uv|npm|yarn|bunx)$/i.test(exe)
    const patience = firstRun ? FETCH_TIMEOUT : CONNECT_TIMEOUT
    const init = await this.request<{ serverInfo?: { name?: string } }>(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'prism', version: '0.2.0' }
      },
      patience
    )
    this.serverName = init.serverInfo?.name ?? 'unknown'
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    const list = await this.request<{ tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> }>(
      'tools/list',
      {},
      patience
    )
    this.tools = (list.tools ?? []).map((t) => ({
      name: t.name ?? 'unknown',
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' }
    }))
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = await this.request<{ content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
      CALL_TIMEOUT
    )
    const texts: string[] = []
    const images: McpCallResult['images'] = []
    for (const c of r.content ?? []) {
      if (c.type === 'text' && c.text) texts.push(c.text)
      else if (c.type === 'image' && c.data) images.push({ mime: c.mimeType ?? 'image/png', base64: c.data })
      else if (c.type === 'resource') texts.push(JSON.stringify(c))
    }
    return { content: texts.join('\n') || (images.length ? `(${images.length} image(s))` : JSON.stringify(r)), isError: r.isError === true, images }
  }

  close(): void {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP client closed'))
    }
    this.pending.clear()
    try {
      this.proc?.kill()
    } catch {
      /* already dead */
    }
    this.proc = null
  }
}
