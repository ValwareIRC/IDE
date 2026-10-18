import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { GadgetToolSpec as ToolSpec } from './types'

// Electron-as-Node prints these on every start; they are not the gadget's output.
const NOISE = /crashpad|registration_protocol_win|DevTools listening/i

/** Host-side services a gadget backend may ask for over the stdio bridge. */
export interface GadgetHostServices {
  call(method: string, args: Record<string, unknown>): Promise<unknown>
  onEmit(event: string, data: unknown): void
  onLog(text: string): void
  onExit(code: number | null): void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export interface GadgetInitResult {
  tools: ToolSpec[]
  handlers: string[]
}

/** One running gadget backend: a Node child process speaking JSON lines. */
export class GadgetProcess {
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  tools: ToolSpec[] = []
  handlers: string[] = []

  constructor(
    private runtimePath: string,
    private backendPath: string,
    private nodeExe: string,
    private services: GadgetHostServices
  ) {}

  get alive(): boolean {
    return !this.closed && this.proc !== null
  }

  async start(init: { dir: string; workspace: string; permissions: unknown; stateFile: string; dataDir: string }): Promise<GadgetInitResult> {
    this.proc = spawn(this.nodeExe, [this.runtimePath, this.backendPath], {
      cwd: init.dir,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PRISM_GADGET: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (d: string) => this.feed(d))
    this.proc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        const t = line.trim()
        if (t && !NOISE.test(t)) this.services.onLog(t)
      }
    })
    this.proc.on('exit', (code) => {
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('Gadget backend exited'))
      }
      this.pending.clear()
      this.services.onExit(code)
    })
    this.proc.on('error', (e) => {
      this.closed = true
      this.services.onLog(`failed to start: ${e.message}`)
      this.services.onExit(-1)
    })
    this.proc.stdin?.on('error', () => {})
    const r = (await this.request('init', init, 30_000)) as GadgetInitResult
    this.tools = r.tools ?? []
    this.handlers = r.handlers ?? []
    return r
  }

  private feed(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        this.services.onLog(line)
        continue
      }
      if (msg.method) {
        void this.onIncoming(msg)
        continue
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'gadget error'))
        else p.resolve(msg.result)
      }
    }
  }

  private async onIncoming(msg: { id?: number; method?: string; params?: Record<string, unknown> }): Promise<void> {
    const params = msg.params ?? {}
    switch (msg.method) {
      case 'ui/emit':
        this.services.onEmit(String(params['event'] ?? ''), params['data'])
        return
      case 'log':
        this.services.onLog(String(params['text'] ?? ''))
        return
      case 'host/call': {
        try {
          const result = await this.services.call(String(params['method'] ?? ''), (params['args'] as Record<string, unknown>) ?? {})
          this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
        } catch (e) {
          this.write({ jsonrpc: '2.0', id: msg.id, error: { message: e instanceof Error ? e.message : String(e) } })
        }
        return
      }
      default:
        return
    }
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin || this.closed) throw new Error('Gadget backend is not running')
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  async stop(): Promise<void> {
    if (!this.alive) return
    try {
      await this.request('shutdown', {}, 8000)
    } catch {
      /* force below */
    }
    this.closed = true
    const pid = this.proc?.pid
    try {
      // whole tree: a backend may have started machines or servers of its own
      if (pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else this.proc?.kill()
    } catch {
      /* gone */
    }
    this.proc = null
  }

  /** Synchronous end, for app quit where nothing can be awaited. */
  killNow(): void {
    const pid = this.proc?.pid
    this.closed = true
    if (!pid) return
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 4000 })
      else this.proc?.kill()
    } catch {
      /* gone */
    }
    this.proc = null
  }
}
