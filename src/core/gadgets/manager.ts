import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Workspace } from '../fs/workspace'
import type { AgentTool, ToolResult } from '../agent/tools/types'
import { GadgetProcess } from './process'
import { GADGET_ID_RE, type GadgetFiles, type GadgetInfo, type GadgetManifest, type GadgetScope, type GadgetState, type GadgetToolSpec as ToolSpec } from './types'
import { EXAMPLE_GADGET, EXAMPLE_GADGET_ID } from './examples'
import { inlinePage } from './inline'

export interface GadgetManagerDeps {
  userData: string
  /** The gadgets that come with Prism (resources/gadgets, or build/gadgets in a checkout); null if there are none. */
  builtinDir?: string | null
  /** Prism's own Node runtime for backends (Electron run as Node). */
  nodeExe: string
  /** Contents of runtime.mjs, written next to the data files. */
  runtimeSource: string
  workspace(): Workspace | null
  send(channel: string, payload: unknown): void
  agentSend(text: string): Promise<void>
  /** A picture of the gadget's panel as the user sees it; null when it cannot be shown. */
  capture?(id: string): Promise<{ mime: string; base64: string } | null>
  /** The gadget's own measurement of its layout, at the current size and squeezed narrow. */
  inspect?(id: string): Promise<GadgetLayoutCheck | null>
  /** A gadget's backend failed. */
  failed?(id: string, error: string, log: string[]): void
  /** The agent noticed that a gadget would help: put the offer in the conversation. */
  suggest?(sessionId: string, idea: { kind: string; title: string; what: string; why: string }): 'offered' | 'silenced' | 'nowhere'
  /** Hand the user a file as a card in the conversation they are in, as attach_file does. */
  attach?(path: string, note: string, from: string): Promise<void>
  /** News for the user: a toast, a desktop notification when Prism is out of sight, and the phone's. */
  notify?(title: string, body: string): void
  /** A picture of a web page or HTML file at a given size, drawn off screen. */
  capturePage?(url: string, opts: { width: number; height: number; scale: number; waitMs: number }): Promise<{ mime: string; base64: string }>
  /** Kept encrypted with the user's other secrets, under a name of the gadget's own. */
  secrets?: { get(key: string): string | null; set(key: string, value: string | null): void }
}

export interface GadgetLayoutReport {
  width: number
  height: number
  issues: string[]
}

export interface GadgetLayoutCheck {
  current: GadgetLayoutReport
  narrow: GadgetLayoutReport | null
}

interface Rec {
  info: GadgetInfo
  proc: GadgetProcess | null
  log: string[]
  watcher: FSWatcher | null
  restartTimer: NodeJS.Timeout | null
  /** Fingerprints of the files on disk, so only real edits cause a reload. */
  backendSig: string
  uiSig: string
  /** False until the backend has reported its tools once (now or in an earlier run). */
  toolsKnown: boolean
  /** The project the running backend was started for: it is told only once, so a new one means a restart. */
  root: string
}

const SOURCE_EXT = /\.(json|html?|css|js|mjs|cjs|ts|svg)$/i
const SKIP_DIRS = new Set(['node_modules', 'data', '.git'])
const SKIP_FILES = new Set(['package.json', 'package-lock.json'])
const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PKG_RANGE_RE = /^[\w.^~<>=*|\- ]{1,40}$/

/** Backend code restarts the process; everything else only refreshes the panel. */
function isBackendFile(rel: string, backend: string | undefined): boolean {
  return rel === 'gadget.json' || rel === backend || /\.(mjs|cjs)$/i.test(rel) || /^(backend|server|lib)\//i.test(rel)
}

/** A first-open introduction, taken only if it is whole. */
function introOf(raw: unknown): GadgetManifest['intro'] {
  if (!raw || typeof raw !== 'object') return undefined
  const i = raw as Record<string, unknown>
  if (typeof i['tagline'] !== 'string' || typeof i['what'] !== 'string' || typeof i['example'] !== 'string') return undefined
  return { tagline: i['tagline'].slice(0, 160), what: i['what'].slice(0, 600), helps: Array.isArray(i['helps']) ? i['helps'].filter((x): x is string => typeof x === 'string').slice(0, 5).map((x) => x.slice(0, 200)) : [], example: i['example'].slice(0, 600), icon: typeof i['icon'] === 'string' ? i['icon'] : undefined, colour: typeof i['colour'] === 'string' ? i['colour'] : undefined }
}

/** The widget part of a manifest, taken only as far as it makes sense: three buttons at most. */
function widgetOf(raw: unknown): GadgetManifest['widget'] {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as { title?: unknown; ratio?: unknown; actions?: unknown }
  const actions = Array.isArray(w.actions)
    ? w.actions
        .filter((a): a is { label: string; call: string; args?: Record<string, unknown> } => !!a && typeof a === 'object' && typeof (a as { label?: unknown }).label === 'string' && typeof (a as { call?: unknown }).call === 'string')
        .slice(0, 3)
        .map((a) => ({ label: a.label.slice(0, 18), call: a.call, ...(a.args && typeof a.args === 'object' ? { args: a.args } : {}) }))
    : []
  const ratio = typeof w.ratio === 'number' && w.ratio > 0.2 && w.ratio < 4 ? w.ratio : undefined
  return { ...(typeof w.title === 'string' ? { title: w.title.slice(0, 40) } : {}), ...(ratio ? { ratio } : {}), ...(actions.length ? { actions } : {}) }
}

function signatures(dir: string, backend: string | undefined): { backend: string; ui: string } {
  const b: string[] = []
  const u: string[] = []
  const walk = (abs: string, rel: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(abs).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const r = rel ? `${rel}/${name}` : name
      let st
      try {
        st = statSync(join(abs, name))
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 4 && !SKIP_DIRS.has(name)) walk(join(abs, name), r, depth + 1)
        continue
      }
      if (!SOURCE_EXT.test(name) || SKIP_FILES.has(name)) continue
      const line = `${r}:${st.size}:${Math.round(st.mtimeMs)}`
      if (isBackendFile(r, backend)) b.push(line)
      else u.push(line)
    }
  }
  walk(dir, '', 0)
  return { backend: b.join('|'), ui: u.join('|') }
}

/**
 * Owns every installed gadget: discovery in the project (.prism/gadgets), globally
 * (userData/gadgets) and among those that come with Prism (resources/gadgets),
 * backend lifecycle, the bridge between UI calls, agent tools and host services, and
 * hot reload on file changes.
 *
 * The ones that come with Prism are never written to: they are replaced at every
 * upgrade. Changing one makes a copy in the project (or globally) that takes its
 * place, and removing the copy brings the original back.
 *
 * Lifecycle operations on one gadget run one after another (see serial), so a
 * panel opening, a file change and an agent call can never start two backends.
 */
export class GadgetManager {
  private recs = new Map<string, Rec>()
  private chains = new Map<string, Promise<unknown>>()
  private runtimePath: string

  constructor(private deps: GadgetManagerDeps) {
    this.runtimePath = join(deps.userData, 'gadget-runtime.mjs')
    writeFileSync(this.runtimePath, deps.runtimeSource, 'utf8')
    mkdirSync(this.globalDir(), { recursive: true })
    mkdirSync(join(deps.userData, 'gadget-cache'), { recursive: true })
    this.installExample()
    this.rescan()
  }

  globalDir(): string {
    return join(this.deps.userData, 'gadgets')
  }

  projectDir(): string | null {
    const ws = this.deps.workspace()
    return ws ? join(ws.root, '.prism', 'gadgets') : null
  }

  private installExample(): void {
    const dir = join(this.globalDir(), EXAMPLE_GADGET_ID)
    if (existsSync(dir)) return
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(EXAMPLE_GADGET)) writeFileSync(join(dir, name), content, 'utf8')
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(
      id,
      next.catch(() => undefined)
    )
    return next
  }

  // ---------------------------------------------------------------- discovery

  rescan(): GadgetInfo[] {
    const found = new Map<string, { scope: GadgetScope; dir: string; manifest: GadgetManifest }>()
    const scan = (root: string | null, scope: GadgetScope): void => {
      if (!root || !existsSync(root)) return
      let entries: string[] = []
      try {
        entries = readdirSync(root)
      } catch {
        return
      }
      for (const name of entries) {
        const dir = join(root, name)
        const manifestFile = join(dir, 'gadget.json')
        if (!existsSync(manifestFile)) continue
        try {
          const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<GadgetManifest>
          const id = typeof raw.id === 'string' && GADGET_ID_RE.test(raw.id) ? raw.id : name
          if (!GADGET_ID_RE.test(id)) continue
          const deps: Record<string, string> = {}
          if (raw.dependencies && typeof raw.dependencies === 'object') {
            for (const [k, v] of Object.entries(raw.dependencies)) if (typeof v === 'string') deps[k] = v
          }
          found.set(id, {
            scope,
            dir,
            manifest: {
              id,
              name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : id,
              description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : '',
              icon: typeof raw.icon === 'string' ? raw.icon : undefined,
              version: typeof raw.version === 'string' ? raw.version : undefined,
              ui: typeof raw.ui === 'string' ? raw.ui : 'index.html',
              backend: typeof raw.backend === 'string' ? raw.backend : undefined,
              dependencies: Object.keys(deps).length ? deps : undefined,
              agent: typeof raw.agent === 'string' ? raw.agent.slice(0, 300) : undefined,
              intro: introOf(raw.intro),
              widget: widgetOf(raw.widget),
              permissions: raw.permissions ?? {}
            }
          })
        } catch {
          /* malformed manifest: skip */
        }
      }
    }
    // project gadgets win over global ones with the same id, and both over Prism's own
    scan(this.deps.builtinDir ?? null, 'builtin')
    const builtin = new Set(found.keys())
    scan(this.globalDir(), 'global')
    scan(this.projectDir(), 'project')
    const root = this.deps.workspace()?.root ?? ''

    // drop gadgets that vanished
    for (const [id, rec] of this.recs) {
      if (!found.has(id)) {
        void rec.proc?.stop()
        rec.watcher?.close()
        this.recs.delete(id)
      }
    }
    for (const [id, f] of found) {
      const existing = this.recs.get(id)
      const overrides = f.scope !== 'builtin' && builtin.has(id)
      if (existing && existing.info.dir === f.dir) {
        existing.info = { ...existing.info, ...f.manifest, scope: f.scope, overrides, hasBackend: !!f.manifest.backend }
        // a backend started before the project was opened would go on working without it
        if (existing.proc?.alive && existing.root !== root) void this.reload(id)
        continue
      }
      if (existing) {
        void existing.proc?.stop()
        existing.watcher?.close()
      }
      const sig = signatures(f.dir, f.manifest.backend)
      const cached = this.readCache(id, sig.backend)
      const rec: Rec = {
        info: {
          ...f.manifest,
          scope: f.scope,
          overrides,
          dir: f.dir,
          hasBackend: !!f.manifest.backend,
          state: 'stopped',
          error: null,
          tools: cached?.tools ?? [],
          handlers: cached?.handlers ?? []
        },
        proc: null,
        log: [],
        watcher: null,
        restartTimer: null,
        backendSig: sig.backend,
        uiSig: sig.ui,
        toolsKnown: !!cached,
        root: ''
      }
      this.recs.set(id, rec)
      this.watchDir(rec)
    }
    this.broadcast()
    return this.list()
  }

  private watchDir(rec: Rec): void {
    try {
      rec.watcher = watch(rec.info.dir, { recursive: true, persistent: false }, (_ev, file) => {
        if (file && /node_modules/.test(String(file))) return
        if (rec.restartTimer) clearTimeout(rec.restartTimer)
        rec.restartTimer = setTimeout(() => void this.reconcile(rec.info.id), 300)
      })
      rec.watcher.on('error', () => {
        rec.watcher = null
      })
    } catch {
      rec.watcher = null
    }
  }

  /** After files changed on disk: restart the backend, refresh the panel, or do nothing. */
  private async reconcile(id: string): Promise<void> {
    const rec = this.recs.get(id)
    if (!rec) return
    if (!existsSync(join(rec.info.dir, 'gadget.json'))) {
      this.rescan()
      return
    }
    const sig = signatures(rec.info.dir, rec.info.backend)
    if (sig.backend !== rec.backendSig) {
      await this.reload(id)
    } else if (sig.ui !== rec.uiSig) {
      rec.uiSig = sig.ui
      this.deps.send(`gadget:event:${id}`, { event: '__reload', data: null })
    }
  }

  list(): GadgetInfo[] {
    const on = this.turnedOn()
    return [...this.recs.values()].map((r) => ({ ...r.info, on: r.info.scope !== 'builtin' || on.has(r.info.id) })).sort((a, b) => a.name.localeCompare(b.name))
  }

  // ---------------------------------------------------------------- turned on, per project

  private onFile(): string {
    return join(this.deps.userData, 'gadgets-on.json')
  }

  /** The gadgets that come with Prism which the user has turned on in this project. */
  private turnedOn(): Set<string> {
    try {
      const all = JSON.parse(readFileSync(this.onFile(), 'utf8')) as Record<string, string[]>
      return new Set(all[this.deps.workspace()?.root ?? ''] ?? [])
    } catch {
      return new Set()
    }
  }

  /** The user said yes on its introduction: from now on it opens straight away here. */
  turnOn(id: string, on = true): GadgetInfo[] {
    let all: Record<string, string[]> = {}
    try {
      all = JSON.parse(readFileSync(this.onFile(), 'utf8')) as Record<string, string[]>
    } catch {
      /* first one */
    }
    const key = this.deps.workspace()?.root ?? ''
    const set = new Set(all[key] ?? [])
    if (on) set.add(id)
    else set.delete(id)
    all[key] = [...set]
    writeFileSync(this.onFile(), JSON.stringify(all, null, 2))
    this.broadcast()
    return this.list()
  }

  /** For the agent's instructions: the gadgets that come with Prism, what each is for, and how to reach them. */
  /** A gadget that comes with Prism which the user has not turned on in this project. */
  isOff(id: string): boolean {
    return this.recs.get(id)?.info.scope === 'builtin' && !this.turnedOn().has(id)
  }

  builtinNote(): string {
    const own = this.list().filter((g) => g.scope === 'builtin' || g.overrides)
    if (!own.length) return ''
    // A gadget the user has not turned on in this project gives no instructions: its note says
    // how to behave once it is on (Practice's "ask before diagnosing"), and acting on that
    // before the user chose it is the agent doing something nobody asked for.
    const on = own.filter((g) => g.on !== false)
    const off = own.filter((g) => g.on === false)
    // {state:key|fallback} in a note is filled from the gadget's own saved state, so a switch in its panel reaches the agent
    const fill = (g: GadgetInfo, text: string): string => text.replace(/\{state:([\w-]+)(?:\|([^}]*))?\}/g, (_m, k: string, d?: string) => String(this.readState(g.id)[k] ?? d ?? ''))
    const parts: string[] = []
    if (on.length) parts.push(`Gadgets that come with Prism, turned on in this project (gadget_list with an id shows what one can do; gadget_call runs its tools):\n${on.map((g) => `- ${g.name} (${g.id}): ${fill(g, g.agent ?? g.description)}`).join('\n')}`)
    if (off.length) parts.push(`Also built in but not turned on in this project, so do not use them or follow what they would ask; the user turns one on by opening it from the Gadgets list: ${off.map((g) => `${g.name} (${g.id})`).join(', ')}.`)
    return parts.join('\n\n')
  }

  get(id: string): GadgetInfo | null {
    return this.recs.get(id)?.info ?? null
  }

  dirOf(id: string): string | null {
    return this.recs.get(id)?.info.dir ?? null
  }

  logOf(id: string): string[] {
    return this.recs.get(id)?.log ?? []
  }

  private broadcast(): void {
    this.deps.send('gadget:changed', this.list())
  }

  private setState(rec: Rec, state: GadgetState, error: string | null = null): void {
    rec.info = { ...rec.info, state, error }
    this.broadcast()
    if (state === 'error' && error) this.deps.failed?.(rec.info.id, error, rec.log.slice(-20))
  }

  private pushLog(rec: Rec, text: string): void {
    const line = `${new Date().toLocaleTimeString()}  ${text}`
    rec.log = [...rec.log.slice(-299), line]
    this.deps.send(`gadget:log:${rec.info.id}`, line)
  }

  // ---------------------------------------------------------------- tool cache

  private cacheFile(id: string): string {
    return join(this.deps.userData, 'gadget-cache', `${id}.json`)
  }

  /** Tools a backend reported last time, valid while its code is unchanged. Lets the agent see them without starting it. */
  private readCache(id: string, sig: string): { tools: ToolSpec[]; handlers: string[] } | null {
    try {
      const c = JSON.parse(readFileSync(this.cacheFile(id), 'utf8')) as { sig: string; tools: ToolSpec[]; handlers: string[] }
      return c.sig === sig ? { tools: c.tools ?? [], handlers: c.handlers ?? [] } : null
    } catch {
      return null
    }
  }

  private writeCache(rec: Rec): void {
    try {
      writeFileSync(this.cacheFile(rec.info.id), JSON.stringify({ sig: rec.backendSig, tools: rec.info.tools, handlers: rec.info.handlers }))
    } catch {
      /* cache only */
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start(id: string): Promise<GadgetInfo> {
    return this.serial(id, () => this.startNow(id))
  }

  stop(id: string): Promise<GadgetInfo> {
    return this.serial(id, () => this.stopNow(id))
  }

  /** Full restart: manifest re-read, backend restarted, panel refreshed. */
  reload(id: string): Promise<GadgetInfo> {
    return this.serial(id, async () => {
      await this.stopNow(id)
      this.rescan()
      const fresh = this.recs.get(id)
      if (!fresh) throw new Error(`Gadget ${id} disappeared`)
      const sig = signatures(fresh.info.dir, fresh.info.backend)
      if (sig.backend !== fresh.backendSig) fresh.toolsKnown = false
      fresh.backendSig = sig.backend
      fresh.uiSig = sig.ui
      this.deps.send(`gadget:event:${id}`, { event: '__reload', data: null })
      if (fresh.info.backend) await this.startNow(id)
      return fresh.info
    })
  }

  private async startNow(id: string): Promise<GadgetInfo> {
    const rec = this.recs.get(id)
    if (!rec) throw new Error(`No gadget named ${id}`)
    if (!rec.info.backend) return rec.info
    if (rec.proc?.alive) return rec.info
    const backendPath = join(rec.info.dir, rec.info.backend)
    if (!existsSync(backendPath)) {
      this.setState(rec, 'error', `${rec.info.backend} is missing`)
      return rec.info
    }
    try {
      await this.ensurePackages(rec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.pushLog(rec, msg)
      this.setState(rec, 'error', msg)
      return rec.info
    }
    this.setState(rec, 'starting')
    const proc = new GadgetProcess(this.runtimePath, backendPath, this.deps.nodeExe, {
      call: (method, args) => this.hostCall(rec, method, args),
      onEmit: (event, data) => this.deps.send(`gadget:event:${id}`, { event, data }),
      onLog: (text) => this.pushLog(rec, text),
      onExit: (code) => {
        if (rec.proc === proc) {
          rec.proc = null
          if (rec.info.state !== 'error') this.setState(rec, 'stopped', code && code !== 0 ? `stopped unexpectedly (code ${code})` : null)
        }
      }
    })
    rec.proc = proc
    rec.root = this.deps.workspace()?.root ?? ''
    try {
      const r = await proc.start({
        dir: rec.info.dir,
        workspace: rec.root,
        permissions: rec.info.permissions ?? {},
        stateFile: join(this.deps.userData, 'gadget-state', `${id}.json`),
        dataDir: join(this.deps.userData, 'gadget-data', id)
      })
      rec.info = { ...rec.info, tools: r.tools, handlers: r.handlers }
      rec.toolsKnown = true
      this.writeCache(rec)
      this.setState(rec, 'running')
      this.pushLog(rec, `started · ${r.tools.length} tool(s), ${r.handlers.length} handler(s)`)
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 6).join('\n')
      this.pushLog(rec, `start failed: ${msg}`)
      await proc.stop()
      rec.proc = null
      this.setState(rec, 'error', msg.split('\n')[0] ?? msg)
    }
    return rec.info
  }

  private async stopNow(id: string): Promise<GadgetInfo> {
    const rec = this.recs.get(id)
    if (!rec) throw new Error(`No gadget named ${id}`)
    const proc = rec.proc
    rec.proc = null
    await proc?.stop()
    this.setState(rec, 'stopped')
    return rec.info
  }

  /** Install the npm packages a gadget lists in gadget.json, once per change of that list. */
  private async ensurePackages(rec: Rec): Promise<void> {
    const deps = rec.info.dependencies
    if (!deps || !Object.keys(deps).length) return
    if (rec.info.scope === 'builtin') throw new Error('A gadget that comes with Prism cannot install packages into Prism\'s own folder.')
    const want = JSON.stringify(deps)
    const marker = join(rec.info.dir, 'node_modules', '.prism-packages.json')
    try {
      if (readFileSync(marker, 'utf8') === want) return
    } catch {
      /* not installed yet */
    }
    const specs: string[] = []
    for (const [name, range] of Object.entries(deps)) {
      if (!PKG_NAME_RE.test(name) || (range && !PKG_RANGE_RE.test(range))) throw new Error(`"${name}": "${range}" is not a valid package in gadget.json`)
      specs.push(range && range !== '*' && range !== 'latest' ? `${name}@${range}` : name)
    }
    this.setState(rec, 'installing')
    this.pushLog(rec, `installing ${specs.join(', ')}`)
    // a package.json of its own, or npm would install into the project around it
    const pkgFile = join(rec.info.dir, 'package.json')
    if (!existsSync(pkgFile)) writeFileSync(pkgFile, JSON.stringify({ name: `gadget-${rec.info.id}`, private: true, type: 'module' }, null, 2))
    await new Promise<void>((res, rej) => {
      exec(`npm install --no-audit --no-fund --loglevel=error ${specs.map((s) => `"${s}"`).join(' ')}`, { cwd: rec.info.dir, windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (!err) return res()
        const tail = String(stderr).trim().split('\n').slice(-4).join(' ')
        rej(new Error(/not recognized|not found|ENOENT/i.test(tail + err.message) && !/npm error/i.test(tail) ? 'npm was not found. Install Node.js so gadgets can use packages.' : `Package install failed: ${tail || err.message}`))
      })
    })
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, want)
    this.pushLog(rec, 'packages installed')
  }

  async stopAll(): Promise<void> {
    for (const rec of this.recs.values()) {
      await rec.proc?.stop()
      rec.watcher?.close()
    }
  }

  /** App quit: nothing can be awaited, and no machine may be left running. */
  disposeNow(): void {
    for (const rec of this.recs.values()) {
      rec.watcher?.close()
      if (rec.restartTimer) clearTimeout(rec.restartTimer)
      rec.proc?.killNow()
      rec.proc = null
    }
  }

  // ---------------------------------------------------------------- calls

  /** UI → backend handler (or host service when method is "__host"). */
  async call(id: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const rec = this.recs.get(id)
    if (!rec) throw new Error(`No gadget named ${id}`)
    if (method === '__host') return this.hostCall(rec, String(args['method'] ?? ''), (args['args'] as Record<string, unknown>) ?? {})
    if (!rec.proc?.alive) await this.start(id)
    if (!rec.proc?.alive) throw new Error(rec.info.error ?? 'this gadget is not running')
    return rec.proc.request('ui/call', { method, args })
  }

  capture(id: string): Promise<{ mime: string; base64: string } | null> {
    return this.deps.capture ? this.deps.capture(id) : Promise.resolve(null)
  }

  inspect(id: string): Promise<GadgetLayoutCheck | null> {
    return this.deps.inspect ? this.deps.inspect(id) : Promise.resolve(null)
  }

  private async hostCall(rec: Rec, method: string, args: Record<string, unknown>): Promise<unknown> {
    const perms = rec.info.permissions ?? {}
    const ws = this.deps.workspace()
    const needWs = (): Workspace => {
      if (!ws) throw new Error('No workspace is open')
      if (!perms.workspace || perms.workspace === 'none') throw new Error(`${rec.info.name} did not declare workspace access in gadget.json`)
      return ws
    }
    switch (method) {
      case 'agent.send':
        await this.deps.agentSend(`[from gadget ${rec.info.name}] ${String(args['text'] ?? '')}`)
        return true
      case 'ui.toast':
        this.deps.send('gadget:ui', { kind: 'toast', title: String(args['title'] ?? rec.info.name), detail: args['detail'] ? String(args['detail']) : undefined })
        return true
      case 'ui.openFile':
        this.deps.send('gadget:ui', { kind: 'openFile', path: String(args['path'] ?? '') })
        return true
      case 'ui.openPreview':
        this.deps.send('gadget:ui', { kind: 'openPreview', path: String(args['path'] ?? '') })
        return true
      case 'ui.show':
        this.deps.send('gadget:ui', { kind: 'openGadget', id: rec.info.id, title: rec.info.name })
        return true
      case 'ui.attach': {
        if (!this.deps.attach) throw new Error('Files cannot be handed over here.')
        const path = String(args['path'] ?? '')
        if (!path) throw new Error('Say which file.')
        await this.deps.attach(resolve(ws?.root ?? rec.info.dir, path), String(args['note'] ?? ''), rec.info.name)
        return true
      }
      case 'ui.notify':
        this.deps.notify?.(String(args['title'] ?? rec.info.name), String(args['body'] ?? ''))
        return true
      case 'page.capture': {
        if (!this.deps.capturePage) throw new Error('Pages cannot be drawn here.')
        const n = (k: string, d: number, lo: number, hi: number): number => (typeof args[k] === 'number' ? Math.min(hi, Math.max(lo, args[k] as number)) : d)
        let url = String(args['url'] ?? '')
        // a file in the project, or anywhere on this computer
        if (url && !/^(https?|file|data):/i.test(url)) url = pathToFileURL(resolve(ws?.root ?? rec.info.dir, url)).toString()
        if (!url) throw new Error('Say which page.')
        return this.deps.capturePage(url, { width: n('width', 1280, 200, 4000), height: n('height', 800, 200, 4000), scale: n('scale', 1, 0.5, 3), waitMs: n('waitMs', 600, 0, 15000) })
      }
      case 'secret.get':
        return this.deps.secrets?.get(`gadget:${rec.info.id}:${String(args['key'] ?? '')}`) ?? null
      case 'secret.set':
        if (!this.deps.secrets) throw new Error('Secrets cannot be kept here.')
        this.deps.secrets.set(`gadget:${rec.info.id}:${String(args['key'] ?? '')}`, args['value'] == null ? null : String(args['value']))
        return true
      case 'workspace.read':
        return (await needWs().read(String(args['path'] ?? ''))).content
      case 'workspace.list':
        return needWs().list(String(args['path'] ?? '.'))
      case 'workspace.write': {
        const w = needWs()
        if (perms.workspace !== 'write') throw new Error(`${rec.info.name} only has read access to the workspace`)
        await w.write(String(args['path'] ?? ''), String(args['content'] ?? ''))
        return true
      }
      case 'state.get': {
        const all = this.readState(rec.info.id)
        const key = String(args['key'] ?? '')
        return key in all ? all[key] : (args['fallback'] ?? null)
      }
      case 'state.set': {
        const all = this.readState(rec.info.id)
        all[String(args['key'] ?? '')] = args['value']
        const file = join(this.deps.userData, 'gadget-state', `${rec.info.id}.json`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(all, null, 2))
        return true
      }
      case 'shell': {
        if (!perms.shell) throw new Error(`${rec.info.name} did not declare shell access in gadget.json`)
        const command = String(args['command'] ?? '')
        const cwd = typeof args['cwd'] === 'string' ? resolve(ws?.root ?? rec.info.dir, args['cwd']) : (ws?.root ?? rec.info.dir)
        const timeout = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 60_000
        return new Promise((resolveP) => {
          exec(command, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolveP({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
          })
        })
      }
      default:
        throw new Error(`Unknown host method ${method}`)
    }
  }

  private readState(id: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(join(this.deps.userData, 'gadget-state', `${id}.json`), 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  // ---------------------------------------------------------------- agent tools

  /** Backend tools of every gadget, bridged for the agent. Backends start when a tool is first used. */
  agentTools(): AgentTool[] {
    const out: AgentTool[] = []
    for (const rec of this.recs.values()) {
      // Prism's own are many and seldom needed in a given conversation, so they are not
      // offered one by one on every turn: gadget_list describes them and gadget_call runs them
      if (!rec.info.backend || rec.info.scope === 'builtin') continue
      for (const t of rec.info.tools) out.push(this.bridge(rec.info.id, rec.info.name, t))
    }
    return out
  }

  /** Run one of a gadget's tools by name, starting its backend if needed. */
  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // look the record up each time: a reload replaces the process
      let rec = this.recs.get(id)
      if (!rec) return { content: `Gadget ${id} is no longer installed.`, isError: true }
      if (!rec.proc?.alive) await this.start(id)
      rec = this.recs.get(id)
      if (!rec?.proc?.alive) return { content: `Gadget ${id} could not start: ${rec?.info.error ?? 'unknown error'}`, isError: true }
      // a tool may build, profile or deploy something, which takes minutes rather than seconds
      const r = (await rec.proc.request('tools/call', { name, args }, 30 * 60_000)) as { content?: string; isError?: boolean; images?: Array<{ mime: string; base64: string }> }
      return { content: String(r?.content ?? ''), isError: r?.isError === true, images: Array.isArray(r?.images) ? r.images : undefined, meta: { gadget: id, tool: name } }
    } catch (e) {
      return { content: `Gadget tool failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }

  private bridge(id: string, gadgetName: string, t: ToolSpec): AgentTool {
    return {
      spec: { name: `gadget__${id.replace(/-/g, '_')}__${t.name}`, description: `[gadget ${gadgetName}] ${t.description}`, parameters: t.parameters },
      primaryArg: null,
      readOnly: false,
      risk: () => 'medium',
      summary: (a) => {
        const first = Object.values(a).find((v) => typeof v === 'string') as string | undefined
        return `${gadgetName}: ${t.name}${first ? ` · ${first.slice(0, 60)}` : ''}`
      },
      execute: (args): Promise<ToolResult> => this.callTool(id, t.name, args)
    }
  }

  /** Start only the backends whose tools are still unknown, so the agent's tool list is complete. */
  async warm(): Promise<void> {
    for (const rec of this.recs.values()) {
      if (rec.info.backend && !rec.toolsKnown && rec.info.state !== 'error' && rec.info.scope !== 'builtin') {
        try {
          await this.start(rec.info.id)
        } catch {
          /* state carries the error */
        }
      }
    }
  }

  // ---------------------------------------------------------------- authoring

  async write(id: string, files: GadgetFiles, scope: GadgetScope): Promise<GadgetInfo> {
    if (!GADGET_ID_RE.test(id)) throw new Error('Gadget id must be lowercase letters, digits and dashes (2-40 chars).')
    const existing = this.recs.get(id)
    const builtin = existing?.info.scope === 'builtin' ? existing.info.dir : null
    const root = existing && !builtin ? dirname(existing.info.dir) : scope === 'project' ? this.projectDir() : this.globalDir()
    if (!root) throw new Error('Open a folder first to create a project gadget, or use scope "global".')
    const dir = join(root, id)
    // Prism's own copy is replaced at every upgrade: changes go into a copy that takes its place
    if (builtin && !existsSync(dir)) await cp(builtin, dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) })
    await mkdir(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolve(dir, rel)
      if (abs !== dir && !abs.startsWith(dir + sep)) throw new Error(`File path escapes the gadget folder: ${rel}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }
    if (!existsSync(join(dir, 'gadget.json'))) {
      await writeFile(join(dir, 'gadget.json'), JSON.stringify({ id, name: id, description: '' }, null, 2), 'utf8')
    }
    this.rescan()
    const rec = this.recs.get(id)
    if (!rec) throw new Error('Gadget was written but could not be loaded. Check gadget.json.')
    if (rec.restartTimer) clearTimeout(rec.restartTimer)
    const sig = signatures(rec.info.dir, rec.info.backend)
    // UI-only edits leave a running backend (and whatever it has started) alone
    if (rec.info.backend && (sig.backend !== rec.backendSig || !rec.proc?.alive)) return this.reload(id)
    rec.uiSig = sig.ui
    rec.backendSig = sig.backend
    this.deps.send(`gadget:event:${id}`, { event: '__reload', data: null })
    return rec.info
  }

  /** See GadgetManagerDeps.suggest. */
  suggest(sessionId: string, idea: { kind: string; title: string; what: string; why: string }): 'offered' | 'silenced' | 'nowhere' {
    return this.deps.suggest ? this.deps.suggest(sessionId, idea) : 'nowhere'
  }

  async readFiles(id: string): Promise<GadgetFiles> {
    const dir = this.dirOf(id)
    if (!dir) throw new Error(`No gadget named ${id}`)
    const out: GadgetFiles = {}
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      for (const name of await readdir(abs)) {
        if (SKIP_DIRS.has(name) || name.startsWith('.') || name === 'package-lock.json') continue
        const p = join(abs, name)
        const r = rel ? `${rel}/${name}` : name
        try {
          if (statSync(p).isDirectory()) {
            if (depth < 3) await walk(p, r, depth + 1)
            continue
          }
          if (!SOURCE_EXT.test(name) && !/\.(md|txt)$/i.test(name)) continue
          const content = await readFile(p, 'utf8')
          if (content.length < 400_000) out[r] = content
        } catch {
          /* unreadable */
        }
      }
    }
    await walk(dir, '', 0)
    return out
  }

  /**
   * The gadget's page with everything it loads folded into it: stylesheets, scripts
   * and pictures become part of the one file. A window serves those over
   * prism-gadget://, but the phone app is a page of its own with no such address to
   * reach, so it is handed the whole thing at once and shows it in a sandboxed frame.
   */
  async page(id: string): Promise<string> {
    const dir = this.dirOf(id)
    if (!dir) throw new Error(`No gadget named ${id}`)
    const file = this.resolveFile(id, this.recs.get(id)?.info.ui ?? 'index.html')
    if (!file) throw new Error(`${id} has no page to show`)
    return inlinePage(await readFile(file, 'utf8'), (rel) => this.resolveFile(id, rel))
  }

  remove(id: string): Promise<void> {
    return this.serial(id, async () => {
      const rec = this.recs.get(id)
      if (!rec) return
      if (rec.info.scope === 'builtin') throw new Error(`${rec.info.name} comes with Prism and cannot be removed.`)
      rec.watcher?.close()
      if (rec.restartTimer) clearTimeout(rec.restartTimer)
      await rec.proc?.stop()
      try {
        await rm(rec.info.dir, { recursive: true, force: true })
      } catch {
        // another window watching the folder keeps it from going; without its files it is no longer a gadget
        for (const name of await readdir(rec.info.dir).catch(() => [] as string[])) await rm(join(rec.info.dir, name), { recursive: true, force: true }).catch(() => {})
      }
      await rm(this.cacheFile(id), { force: true })
      this.recs.delete(id)
      if (rec.info.overrides) this.rescan()
      else this.broadcast()
    })
  }

  /** Absolute file inside a gadget folder, for the prism-gadget:// protocol. */
  resolveFile(id: string, rel: string): string | null {
    const dir = this.dirOf(id)
    if (!dir) return null
    const abs = resolve(dir, rel || 'index.html')
    if (abs !== dir && !abs.startsWith(dir + sep)) return null
    return existsSync(abs) ? abs : null
  }

  static nameOf(dir: string): string {
    return basename(dir)
  }
}
