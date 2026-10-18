// The host: what every window shares (settings, the vault, the database, models, MCP servers, the phone page
// and trigger addresses) and the workbenches, one per open project, each with its own agent, terminals,
// automations and previews. A client (a window, or a remote app) is attached to one workbench; two clients on
// the same project share it and see the same things. Every request runs "as" its client, so the code that
// handles it (ipc.ts) can keep saying s.workspace, s.agent, s.send.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync } from 'node:fs'
import { placeOf } from '@shared/place'
import { join } from 'node:path'
import { app, safeStorage, type BrowserWindow } from 'electron'
import type { McpStatus } from '@shared/types'
import { CH } from '@shared/ipc'
import { McpClient } from '@core/mcp/client'
import { openDb, type Db } from '@core/store/db'
import { Repo } from '@core/store/repo'
import { SettingsStore } from '@core/store/settings'
import { Vault } from '@core/store/vault'
import { importLegacy, importLegacyMcp } from '@core/store/legacy'
import { ClaudeCatalog } from '@core/claude/catalog'
import { SpecKeeper } from '@core/spec/spec'
import { RuleBook } from '@core/learning/rules'
import { Learner } from '@core/learning/learn'
import { GadgetScout } from '@core/gadgets/scout'
import { killAllJobs } from '@core/agent/tools/shell'
import { IGNORED_DIRS, setHiddenDirs } from '@core/fs/paths'
import { PhoneRemote } from './phone'
import { Webhooks } from './webhooks'
import { RemoteHost } from './remote'
import type { Settings } from '@shared/types'
import { Services } from './services'
import { bootLog } from './bootlog'
import type { Floats } from './float'

export interface Client {
  id: string
  kind: 'window' | 'remote'
  send(channel: string, payload: unknown): void
  /** The window, for a window client. */
  window(): BrowserWindow | null
  /** Bring it to the front (a window), if it can be. */
  focus(): void
}

/** What every workbench shares. */
export class Shared {
  readonly userData: string
  readonly settings: SettingsStore
  readonly vault: Vault
  readonly db: Db
  readonly repo: Repo
  readonly claude: ClaudeCatalog
  readonly spec: SpecKeeper
  readonly rules: RuleBook
  readonly learner: Learner
  readonly gadgetScout: GadgetScout
  readonly phone: PhoneRemote
  readonly webhooks: Webhooks
  readonly remote: RemoteHost
  private mcpClients = new Map<string, { client: McpClient; error: string | null; state: 'connecting' | 'connected' | 'error' }>()

  constructor(readonly host: Host) {
    this.userData = app.getPath('userData')
    mkdirSync(join(this.userData, 'attachments'), { recursive: true })
    this.settings = new SettingsStore(join(this.userData, 'settings.json'))
    bootLog('settings read; asking whether passwords can be kept encrypted')
    const encrypted = safeStorage.isEncryptionAvailable()
    bootLog(`passwords: ${encrypted ? 'encrypted' : 'plain (no keyring)'}`)
    this.vault = new Vault(join(this.userData, 'vault.json'), {
      available: encrypted,
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b)
    })
    // prism.sqlite, not prism.db: the previous Prism's database shares this folder.
    this.db = openDb(join(this.userData, 'prism.sqlite'))
    bootLog('database open')
    this.repo = new Repo(this.db, (id) => this.vault.has(id))
    if (this.repo.listEndpoints().length === 0) {
      const n = importLegacy(this.userData, this.repo, (id, key) => this.vault.setRaw(id, key), (id) => this.vault.has(id))
      if (n) console.log(`[prism] imported ${n} endpoint(s) from the previous Prism`)
    }
    if (this.settings.get().mcp.length === 0 && !this.settings.get().onboarded) {
      const mcp = importLegacyMcp(this.userData)
      if (mcp.length) {
        this.settings.update({ mcp, onboarded: true })
        console.log(`[prism] imported ${mcp.length} MCP server(s) from the previous Prism`)
      }
    }
    this.claude = new ClaudeCatalog(join(this.userData, 'claude-agent.json'), () => this.settings.get().claude, (st) => host.broadcast(CH.ClaudeChanged, st))
    this.spec = new SpecKeeper(join(this.userData, 'spec'))
    this.rules = new RuleBook(join(this.userData, 'rules.json'))
    this.learner = new Learner(join(this.userData, 'learning'))
    this.gadgetScout = new GadgetScout(join(this.userData, 'gadget-ideas'))
    this.phone = new PhoneRemote(this.userData, host)
    this.webhooks = new Webhooks(this.userData, (root, id, body) => host.byRoot(root)?.automations.webhook(id, body) ?? false)
    this.remote = new RemoteHost(host, this.userData, this.vault)
    // settings saved before the phone app existed have no remote part
    const remote = (): Settings['remote'] => {
      const r = this.settings.get().remote as Partial<Settings['remote']> | undefined
      return { enabled: r?.enabled ?? false, port: r?.port ?? 8793, relay: r?.relay ?? '', upnp: r?.upnp ?? false }
    }
    bootLog('phone and remote connections being set up')
    void this.remote.apply(remote())
    setHiddenDirs(this.settings.get().files?.hidden ?? [...IGNORED_DIRS])
    this.settings.onChange((s) => {
      void this.remote.apply(remote())
      setHiddenDirs(s.files?.hidden ?? [...IGNORED_DIRS])
      host.broadcast(CH.SettingsChanged, s)
      void this.phone.apply(!!s.phone?.enabled, s.phone?.port ?? 8791)
    })
    void this.phone.apply(!!this.settings.get().phone?.enabled, this.settings.get().phone?.port ?? 8791)
    void this.autoConnectMcp()
  }

  // ---------------------------------------------------------------- mcp (one set of servers for every window)

  mcpStatuses(): McpStatus[] {
    return this.settings.get().mcp.map((cfg) => {
      const live = this.mcpClients.get(cfg.id)
      const connected = live?.client.isConnected && live.state === 'connected'
      return {
        ...cfg,
        state: !live ? 'disconnected' : connected ? 'connected' : live.state === 'connecting' ? 'connecting' : 'error',
        toolCount: connected ? live.client.tools.length : 0,
        error: live?.error ?? null,
        tools: connected ? live.client.tools.map((t) => ({ name: t.name, description: t.description })) : []
      }
    })
  }

  async connectMcp(id: string): Promise<McpStatus> {
    const cfg = this.settings.get().mcp.find((m) => m.id === id)
    if (!cfg) throw new Error('MCP server not found')
    this.mcpClients.get(id)?.client.close()
    // tokens and passwords come out of the vault only now, for the server's own process
    const secrets = Object.fromEntries((cfg.secrets ?? []).map((n) => [n, this.vault.get(`mcp:${cfg.id}:${n}`) ?? '']))
    const client = new McpClient(cfg.command, cfg.args, { ...cfg.env, ...secrets })
    const rec = { client, error: null as string | null, state: 'connecting' as 'connecting' | 'connected' | 'error' }
    this.mcpClients.set(id, rec)
    try {
      await client.connect()
      rec.state = 'connected'
    } catch (e) {
      client.close()
      rec.state = 'error'
      rec.error = e instanceof Error ? e.message : String(e)
      if (client.log.length) rec.error += `\n${client.log.slice(-3).join('\n')}`
    }
    return this.mcpStatuses().find((s) => s.id === id)!
  }

  disconnectMcp(id: string): McpStatus {
    this.mcpClients.get(id)?.client.close()
    this.mcpClients.delete(id)
    return this.mcpStatuses().find((s) => s.id === id)!
  }

  liveMcp(): Array<{ name: string; client: McpClient }> {
    const out: Array<{ name: string; client: McpClient }> = []
    for (const cfg of this.settings.get().mcp) {
      const live = this.mcpClients.get(cfg.id)
      if (cfg.enabled && live?.state === 'connected' && live.client.isConnected) out.push({ name: cfg.name, client: live.client })
    }
    return out
  }

  private async autoConnectMcp(): Promise<void> {
    for (const cfg of this.settings.get().mcp) {
      if (!cfg.enabled) continue
      try {
        await this.connectMcp(cfg.id)
      } catch {
        /* status reflects the failure */
      }
    }
  }

  dispose(): void {
    this.remote.dispose()
    for (const [, rec] of this.mcpClients) rec.client.close()
    killAllJobs()
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/** The client and workbench a request is running for. */
export const asClient = new AsyncLocalStorage<{ client: Client; wb: Services }>()

export class Host {
  readonly shared: Shared
  private benches = new Set<Services>()
  private clients = new Map<string, { client: Client; wb: Services }>()
  private seq = 0
  /** Open another window (index.ts sets it). */
  newWindow: ((root: string | null) => void) | null = null
  /** Tabs out on the desktop (main/float.ts); set once the app is ready. */
  floats: Floats | null = null
  /** Requests from clients that are not windows (ipc.ts sets it). */
  dispatch: import('./ipc').IpcDispatch | null = null

  constructor() {
    this.shared = new Shared(this)
    // a workbench nobody has open is closed once its agents are done
    setInterval(() => this.sweep(), 30_000).unref()
    // a timer due in a project no window has open: the project opens in the background to take it
    setInterval(() => this.wakeClosedProjects(), 60_000).unref()
    // a session Prism went down under while it was working: its project opens to let it carry on,
    // after windows have had time to open their own projects
    setTimeout(() => this.reopenCutOff(), 20_000).unref()
  }

  private reopenCutOff(): void {
    for (const id of this.shared.repo.sessionsCutOff()) {
      const s = this.shared.repo.getSession(id)
      if (!s || this.byRoot(s.workspace)) continue
      if (placeOf(s.workspace).kind === 'local' && !existsSync(s.workspace)) continue
      try {
        this.newBench().setWorkspace(s.workspace)
      } catch {
        /* its project is picked up when a window opens it */
      }
    }
  }

  private wakeClosedProjects(): void {
    const now = Date.now()
    for (const id of this.shared.repo.sessionsWithWakeups()) {
      const s = this.shared.repo.getSession(id)
      if (!s || this.byRoot(s.workspace)) continue
      if (!(this.shared.repo.getSessionExtras(id).wakeups ?? []).some((w) => w.dueAt <= now + 60_000)) continue
      if (placeOf(s.workspace).kind === 'local' && !existsSync(s.workspace)) continue
      try {
        this.newBench().setWorkspace(s.workspace)
      } catch {
        /* tried again next minute */
      }
    }
  }

  private newBench(): Services {
    const wb = new Services(this.shared, this, `w${(++this.seq).toString(36)}`)
    this.benches.add(wb)
    return wb
  }

  /** Every open workbench. */
  workbenches(): Services[] {
    return [...this.benches]
  }

  byRoot(root: string): Services | undefined {
    const key = root.toLowerCase()
    return [...this.benches].find((b) => b.workspace?.root.toLowerCase() === key)
  }

  byId(id: string): Services | undefined {
    return [...this.benches].find((b) => b.id === id)
  }

  /** The workbench that holds this session. */
  bySession(sessionId: string): Services | undefined {
    const s = this.shared.repo.getSession(sessionId)
    return s ? this.byRoot(s.workspace) : undefined
  }

  clientsOf(wb: Services): Client[] {
    return [...this.clients.values()].filter((c) => c.wb === wb).map((c) => c.client)
  }

  clientById(id: string): { client: Client; wb: Services } | undefined {
    return this.clients.get(id)
  }

  /** A new client: on a project (sharing its workbench when it is open already) or on a fresh, empty one. */
  attach(client: Client, root: string | null): Services {
    const existing = root ? this.byRoot(root) : undefined
    const wb = existing ?? this.newBench()
    this.clients.set(client.id, { client, wb })
    if (root && !existing) wb.setWorkspace(root)
    return wb
  }

  detach(clientId: string): void {
    this.clients.delete(clientId)
    this.sweep()
  }

  /**
   * The client opens a project. A window whose project is open in another window brings that window forward
   * instead (as VS Code does); otherwise the client moves to that project's workbench, or this one takes it.
   */
  open(clientId: string, root: string): { root: string; elsewhere: boolean } {
    const me = this.clients.get(clientId)
    if (!me) throw new Error('This window is not known.')
    const there = this.byRoot(root)
    // Already on it: nothing to do. A phone that comes back from the background opens
    // the project it never left, and without this the busy check below decided this
    // workbench could not take it and opened a second copy of the same project — whose
    // first act was to see a turn it could not see running, announce that Prism had
    // restarted, and start that conversation over again on its own.
    if (there && there === me.wb) return { root: there.workspace!.root, elsewhere: false }
    if (there && there !== me.wb) {
      const other = me.client.kind === 'window' ? this.clientsOf(there).find((c) => c.kind === 'window') : undefined
      if (other) {
        other.focus()
        return { root: there.workspace!.root, elsewhere: true }
      }
      const old = me.wb
      me.wb = there
      this.sweep(old)
      me.client.send(CH.TermChanged, null)
      return { root: there.workspace!.root, elsewhere: false }
    }
    // this workbench takes the project when nobody else is on it; else the client moves to a new one
    if (!me.wb.workspace || (this.clientsOf(me.wb).length === 1 && !me.wb.agent.anyRunning())) {
      if (me.wb.workspace && me.wb.workspace.root !== root) {
        // a workbench keeps its project for life: a fresh one for the new project
        const old = me.wb
        me.wb = this.newBench()
        this.sweep(old)
        me.client.send(CH.TermChanged, null)
      }
      return { root: me.wb.setWorkspace(root).root, elsewhere: false }
    }
    me.wb = this.newBench()
    me.client.send(CH.TermChanged, null)
    return { root: me.wb.setWorkspace(root).root, elsewhere: false }
  }

  /** To every client of every workbench. */
  broadcast(channel: string, payload: unknown): void {
    for (const { client } of this.clients.values()) client.send(channel, payload)
  }

  /** Close workbenches nobody has open and nothing runs in. */
  private sweep(only?: Services): void {
    for (const wb of only ? [only] : [...this.benches]) {
      if (this.clientsOf(wb).length || wb.agent.anyRunning() || wb.busyInBackground()) continue
      this.benches.delete(wb)
      wb.dispose()
    }
  }

  /** Run fn as this client (its workbench is the one requests act on). */
  run<T>(clientId: string, fn: () => T): T {
    const c = this.clients.get(clientId)
    if (!c) throw new Error('This window is not known.')
    return asClient.run({ client: c.client, wb: c.wb }, fn)
  }

  dispose(): void {
    for (const wb of this.benches) wb.dispose()
    this.benches.clear()
    this.shared.dispose()
  }
}
