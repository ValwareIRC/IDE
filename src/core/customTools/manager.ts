// The user's own tools for the agent: single TypeScript files in the project's
// .prism/tools/ (and in the app's data folder, tools/). Each file ends with
// `export default defineTool({ name, description, parameters, run })`.
//
// The files are turned into JavaScript here and run in a separate helper
// process (toolhost.mjs; its header explains how tool code is boxed in). What a
// tool does to the outside world it does by asking this manager: files only
// inside the workspace, shell commands and network requests only when the
// tool's `uses` says so.
//
// A file is offered to the agent only once the user has allowed it as it is now
// (tools-allowed.json holds a hash per file). Without that, the agent could
// write a tool that runs commands and never asks, or a cloned project could
// bring one along. Files made or saved from the settings page are allowed as
// part of saving; anything else waits there for a look.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { CustomToolInfo } from '@shared/types'
import type { AgentTool, ToolContext } from '../agent/tools/types'
import type { Workspace } from '../fs/workspace'
import { searchWorkspace } from '../fs/search'
import { runLine } from '../remote/command'

const PROJECT_DIR = '.prism/tools'
const SOURCE = /\.(ts|mts|js|mjs)$/i
// Electron-as-Node prints these on every start
const NOISE = /crashpad|registration_protocol_win|DevTools listening/i

type Scope = 'project' | 'personal'

interface Loaded {
  name: string
  description: string
  parameters: Record<string, unknown>
  uses: Array<'shell' | 'network'>
  risk: 'none' | 'low' | 'medium' | 'high'
  file: string
  scope: Scope
}

interface CallResult {
  ok: boolean
  value?: string
  error?: string
  logs: string[]
}

export interface CustomToolDeps {
  userData: string
  nodeExe: string
  runtimeSource: string
  workspace(): Workspace | null
  /** A tool's own code failed (not a stop or a refusal). */
  failed?(tool: { name: string; file: string; scope: Scope }, error: string): void
}

export class CustomToolManager {
  private child: ChildProcess | null = null
  private runtimePath: string
  private personalDir: string
  private allowedPath: string
  private allowed: Record<string, string> = {}
  private loaded: Loaded[] = []
  private errors: Array<{ file: string; scope: Scope; error: string }> = []
  /** Files the user has not allowed as they are now. */
  private waiting: Array<{ file: string; scope: Scope; changed: boolean }> = []
  private dirty = true
  private loading: Promise<void> | null = null
  private calls = new Map<number, (r: CallResult) => void>()
  /** The session behind each running call: its folder, and its undo history for files the tool writes. */
  private active = new Map<number, ToolContext>()
  private onLoaded: (() => void) | null = null
  private seq = 0
  /** Names and change times of the personal tool files, to notice edits made outside a project. */
  private personalStamp = ''

  constructor(private deps: CustomToolDeps) {
    this.runtimePath = join(deps.userData, 'toolhost.mjs')
    this.personalDir = join(deps.userData, 'tools')
    this.allowedPath = join(deps.userData, 'tools-allowed.json')
    writeFileSync(this.runtimePath, deps.runtimeSource, 'utf8')
    try {
      const v: unknown = JSON.parse(readFileSync(this.allowedPath, 'utf8'))
      if (v && typeof v === 'object') this.allowed = v as Record<string, string>
    } catch {
      /* nothing allowed yet */
    }
  }

  get personalFolder(): string {
    return this.personalDir
  }

  /** Read the tool files again the next time they are needed. */
  invalidate(): void {
    this.dirty = true
  }

  private keyOf(file: string, scope: Scope): string {
    return scope === 'project' ? `${this.deps.workspace()?.root ?? ''}|${file}` : file
  }

  private hash(source: string): string {
    return createHash('sha256').update(source).digest('hex')
  }

  /** The user lets the agent use this file as it is now. A later change to it has to be allowed again. */
  async allow(file: string, scope: Scope): Promise<void> {
    const ws = this.deps.workspace()
    const source = scope === 'project' ? (ws ? (await ws.read(file)).content : null) : readFileSync(file, 'utf8')
    if (source === null) throw new Error('No project is open.')
    this.allowed[this.keyOf(file, scope)] = this.hash(source)
    writeFileSync(this.allowedPath, JSON.stringify(this.allowed, null, 2), 'utf8')
    this.dirty = true
  }

  /** The file is gone: forget that it was allowed. */
  forget(file: string, scope: Scope): void {
    delete this.allowed[this.keyOf(file, scope)]
    writeFileSync(this.allowedPath, JSON.stringify(this.allowed, null, 2), 'utf8')
    this.dirty = true
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    // --permission: no file access beyond its own script, no child processes, no native add-ons
    const child = spawn(this.deps.nodeExe, ['--permission', `--allow-fs-read=${this.runtimePath}`, this.runtimePath], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8').trim()
      if (s && !NOISE.test(s)) console.error('[tools]', s)
    })
    child.on('message', (m: { type?: string; id?: number; call?: number; tool?: string; method?: string; args?: unknown[]; tools?: Loaded[]; errors?: CustomToolManager['errors']; ok?: boolean; value?: string; error?: string; logs?: string[] }) => {
      if (m.type === 'loaded') {
        this.loaded = m.tools ?? []
        this.errors = [...this.errors, ...(m.errors ?? [])]
        this.onLoaded?.()
      } else if (m.type === 'result' && typeof m.id === 'number') {
        const done = this.calls.get(m.id)
        this.calls.delete(m.id)
        done?.({ ok: m.ok === true, value: m.value, error: m.error, logs: m.logs ?? [] })
      } else if (m.type === 'api' && typeof m.id === 'number') {
        const reply = (r: { ok: boolean; value?: unknown; error?: string }): void => {
          if (child.connected) child.send({ type: 'api-result', id: m.id, call: m.call, ...r })
        }
        void this.serve(m.call ?? -1, m.tool ?? '', m.method ?? '', m.args ?? []).then(
          (value) => reply({ ok: true, value }),
          (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) })
        )
      }
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
      this.dirty = true
      for (const [, done] of [...this.calls]) done({ ok: false, error: 'The tools helper stopped.', logs: [] })
      this.calls.clear()
      this.onLoaded?.()
    })
    this.child = child
    return child
  }

  /** What a tool asked for through its `prism` object. */
  private async serve(call: number, toolName: string, method: string, args: unknown[]): Promise<unknown> {
    const ctx = this.active.get(call)
    if (!ctx) throw new Error('This tool call has already ended.')
    const ws = ctx.workspace
    const uses = this.loaded.find((t) => t.name === toolName)?.uses ?? []
    const s = (i: number): string => String(args[i] ?? '')
    switch (method) {
      case 'fs.read': {
        const f = await ws.read(s(0))
        if (f.binary) throw new Error(`${s(0)} is not a text file.`)
        return f.content
      }
      case 'fs.write':
        // snapshot first, so rewinding the conversation also undoes what a tool wrote
        await ctx.checkpoint([s(0)])
        await ws.write(s(0), s(1))
        ctx.emit({ type: 'file-touched', path: s(0), op: 'write' })
        return null
      case 'fs.list':
        return (await ws.list(s(0) || '.')).map((e) => ({ name: e.name, path: e.path, kind: e.kind, size: e.size }))
      case 'fs.exists':
        return ws.exists(s(0))
      case 'fs.search': {
        const o = (args[1] ?? {}) as { regex?: boolean; caseSensitive?: boolean; include?: string }
        const r = await searchWorkspace(ws.root, { query: s(0), regex: o.regex === true, caseSensitive: o.caseSensitive !== false, wholeWord: false, ...(o.include ? { include: String(o.include) } : {}), maxResults: 300 })
        return r.matches.map((m) => ({ path: m.path, line: m.line, text: m.text }))
      }
      case 'shell.run': {
        if (!uses.includes('shell')) throw new Error('This tool has not listed "shell" in its uses.')
        const o = (args[1] ?? {}) as { timeoutMs?: number }
        const r = await runLine(ws.root, s(0), { timeoutMs: Math.max(1000, Math.min(120_000, Number(o.timeoutMs) || 60_000)) })
        return { code: r.code, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.slice(-60_000) }
      }
      case 'net.fetch': {
        if (!uses.includes('network')) throw new Error('This tool has not listed "network" in its uses.')
        if (!/^https?:\/\//i.test(s(0))) throw new Error('Only http and https addresses can be fetched.')
        const o = (args[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string }
        const res = await fetch(s(0), { method: o.method ?? 'GET', headers: o.headers, body: o.body, signal: AbortSignal.timeout(60_000) })
        return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 1_000_000) }
      }
      default:
        throw new Error(`Unknown request: ${method}`)
    }
  }

  /** Gather the allowed tool files, as JavaScript; the rest are noted as waiting. */
  private async sources(): Promise<Array<{ file: string; scope: Scope; code: string }>> {
    const out: Array<{ file: string; scope: Scope; code: string }> = []
    const add = (file: string, scope: Scope, source: string): void => {
      const was = this.allowed[this.keyOf(file, scope)]
      if (was !== this.hash(source)) {
        this.waiting.push({ file, scope, changed: !!was })
        return
      }
      try {
        out.push({ file, scope, code: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText })
      } catch (e) {
        this.errors.push({ file, scope, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const ws = this.deps.workspace()
    if (ws) {
      try {
        for (const e of await ws.list(PROJECT_DIR)) {
          if (e.kind === 'file' && SOURCE.test(e.name) && !/\.d\.ts$/i.test(e.name)) add(e.path, 'project', (await ws.read(e.path)).content)
        }
      } catch {
        /* the project has no tools folder */
      }
    }
    if (existsSync(this.personalDir)) {
      for (const f of readdirSync(this.personalDir)) {
        if (SOURCE.test(f) && !/\.d\.ts$/i.test(f)) add(join(this.personalDir, f), 'personal', readFileSync(join(this.personalDir, f), 'utf8'))
      }
    }
    return out
  }

  private stampPersonal(): string {
    if (!existsSync(this.personalDir)) return ''
    try {
      return readdirSync(this.personalDir)
        .filter((f) => SOURCE.test(f))
        .map((f) => `${f}:${statSync(join(this.personalDir, f)).mtimeMs}`)
        .join('|')
    } catch {
      return ''
    }
  }

  /** Make sure the helper has the current files. Cheap when nothing changed. */
  ready(): Promise<void> {
    const stamp = this.stampPersonal()
    if (stamp !== this.personalStamp) {
      this.personalStamp = stamp
      this.dirty = true
    }
    // a load already under way: wait for it, and go again if the files changed meanwhile
    if (this.loading) return this.dirty ? this.loading.then(() => this.ready()) : this.loading
    if (!this.dirty) return Promise.resolve()
    this.loading = (async () => {
      try {
        this.dirty = false
        this.errors = []
        this.waiting = []
        const files = await this.sources()
        if (!files.length) {
          this.loaded = []
          this.child?.kill()
          this.child = null
          return
        }
        const child = this.start()
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 8000)
          this.onLoaded = () => {
            clearTimeout(t)
            this.onLoaded = null
            resolve()
          }
          child.send({ type: 'load', files })
        })
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  /** For the settings page: every tool file and where it stands. */
  async list(reserved: Set<string>): Promise<CustomToolInfo[]> {
    await this.ready()
    const blank = { name: '', description: '', uses: [], risk: 'low' as const }
    return [
      ...this.waiting.map((w) => ({ ...blank, file: w.file, scope: w.scope, error: null, waiting: w.changed ? ('changed' as const) : ('new' as const) })),
      ...this.loaded.map((t) => ({ name: t.name, description: t.description, file: t.file, scope: t.scope, uses: t.uses, risk: t.risk, error: reserved.has(t.name) ? 'Prism already has a tool with this name, so this one is not offered. Give it another name.' : null })),
      ...this.errors.map((e) => ({ ...blank, file: e.file, scope: e.scope, error: e.error }))
    ]
  }

  /** The loaded tools, in the form the agent uses. */
  async tools(): Promise<AgentTool[]> {
    await this.ready()
    return this.loaded.map((t) => this.agentTool(t))
  }

  private agentTool(t: Loaded): AgentTool {
    return {
      spec: { name: t.name, description: `${t.description} (a tool written for this ${t.scope === 'project' ? 'project' : 'user'})`, parameters: t.parameters },
      primaryArg: null,
      readOnly: false,
      risk: () => (t.risk === 'none' ? null : t.risk),
      summary: (a) => `${t.name}${Object.keys(a).length ? ` ${JSON.stringify(a).slice(0, 80)}` : ''}`,
      execute: async (args, ctx) => {
        // the helper may have been restarted since the tools were listed
        await this.ready()
        const child = this.start()
        const id = ++this.seq
        this.active.set(id, ctx)
        const r = await new Promise<CallResult>((resolve) => {
          const finish = (res: CallResult): void => {
            clearTimeout(timer)
            ctx.signal.removeEventListener('abort', stop)
            resolve(res)
          }
          // a tool stuck in a loop cannot be interrupted from inside: the helper is restarted instead
          const end = (error: string): void => {
            if (!this.calls.delete(id)) return
            finish({ ok: false, error, logs: [] })
            if (this.calls.size === 0) child.kill()
          }
          const timer = setTimeout(() => end('The tool took longer than two minutes and was stopped.'), 125_000)
          const stop = (): void => end('Stopped.')
          ctx.signal.addEventListener('abort', stop, { once: true })
          this.calls.set(id, finish)
          child.send({ type: 'call', id, name: t.name, args })
        })
        this.active.delete(id)
        const logs = r.logs.length ? `\n\n[log]\n${r.logs.join('\n')}` : ''
        // a stop, or a request the rules or uses refused, is not the tool's code going wrong
        if (!r.ok && r.error && !/^Stopped\.$|has not listed|Blocked by the user's rule|outside the workspace/i.test(r.error)) this.deps.failed?.({ name: t.name, file: t.file, scope: t.scope }, `${r.error}${logs}`)
        return r.ok ? { content: `${r.value || '(done, nothing returned)'}${logs}`.slice(0, 60_000), isError: false, meta: { customTool: t.name } } : { content: `${t.name} failed: ${r.error}${logs}`, isError: true }
      }
    }
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
  }
}
