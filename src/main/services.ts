import type { Webhooks } from './webhooks'
import { asClient, type Host, type Shared } from './host'
import { githubRepo } from '@core/review/prs'
import type { PhoneRemote } from './phone'
import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { McpStatus, ModelInfo, ModelRef, Settings } from '@shared/types'
import { CH } from '@shared/ipc'
import { Workspace } from '@core/fs/workspace'
import type { McpClient } from '@core/mcp/client'
import { Terminals } from '@core/pty/terminals'
import type { Db } from '@core/store/db'
import type { Repo } from '@core/store/repo'
import type { SettingsStore } from '@core/store/settings'
import type { Vault } from '@core/store/vault'
import { isChatModel } from '@core/models/known'
import type { ResolvedModel } from '@core/agent/engine'
import { GadgetManager, type GadgetLayoutCheck } from '@core/gadgets/manager'
import { AutomationManager } from '@core/automations/automations'
import type { ClaudeCatalog } from '@core/claude/catalog'
import { PreviewManager } from './preview'
import { placeOf } from '@shared/place'
import { RemoteWorkspace } from '@core/remote/remoteWorkspace'
import { ScratchManager } from '@core/scratch/manager'
import { CustomToolManager } from '@core/customTools/manager'
import toolHost from '@core/customTools/toolhost.mjs?raw'
import { loadSkills, type Skill } from '@core/skills/skills'
import { SPEC_FILES, type SpecKeeper } from '@core/spec/spec'
import type { RuleBook } from '@core/learning/rules'
import type { Learner } from '@core/learning/learn'
import type { GadgetScout } from '@core/gadgets/scout'
import scratchJs from '@core/scratch/runtime.mjs?raw'
import scratchPy from '@core/scratch/runtime.py?raw'
import { isClaudeRef } from '@core/claude/translate'
import { homedir } from 'node:os'
import gadgetRuntime from '@core/gadgets/runtime.mjs?raw'
import { AgentHost } from './agent-host'
import { TaskBoard } from './tasks'

/**
 * One workbench: a project open in Prism (or a window with none yet), with its own agent, terminals,
 * automations and previews. What every workbench shares lives in Shared (main/host.ts); these fields point at it.
 */
export class Services {
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
  readonly terminals: Terminals
  readonly agent: AgentHost
  readonly tasks: TaskBoard
  readonly gadgets: GadgetManager
  readonly automations: AutomationManager
  readonly preview: PreviewManager
  readonly scratch: ScratchManager
  readonly customTools: CustomToolManager
  workspace: Workspace | null = null
  private offWorkspace: (() => void) | null = null
  private offSettings: () => void

  constructor(
    readonly shared: Shared,
    readonly host: Host,
    readonly id: string
  ) {
    this.userData = shared.userData
    this.settings = shared.settings
    this.vault = shared.vault
    this.db = shared.db
    this.repo = shared.repo
    this.claude = shared.claude
    this.spec = shared.spec
    this.rules = shared.rules
    this.learner = shared.learner
    this.gadgetScout = shared.gadgetScout
    this.phone = shared.phone
    this.webhooks = shared.webhooks
    this.terminals = new Terminals(() => this.settings.get().terminal.shell)
    this.agent = new AgentHost(this)
    this.agent.onEvent((sid, ev) => this.phone.event(sid, ev))
    this.tasks = new TaskBoard(this)
    this.gadgets = new GadgetManager({
      userData: this.userData,
      builtinDir: builtinGadgets(),
      nodeExe: process.execPath,
      runtimeSource: gadgetRuntime,
      // gadgets saved in a project are folders on this computer's disk: a folder on another computer has none
      workspace: () => (this.workspace && placeOf(this.workspace.root).kind !== 'ssh' ? this.workspace : null),
      send: (ch, payload) => this.send(ch, payload),
      agentSend: (text) => this.agent.sendToCurrent(text),
      capture: (id) => this.captureGadget(id),
      inspect: (id) => this.inspectGadget(id),
      suggest: (sessionId, idea) => this.agent.suggestGadget(sessionId, idea),
      failed: (id, error, log) => void this.agent.repair({ kind: 'gadget', name: id }, `${error}\n\nRecent log:\n${log.join('\n')}`).catch(() => {}),
      attach: (path, note, from) => this.agent.attachToCurrent(path, note, from),
      notify: (title, body) => this.send(CH.Notice, { sessionId: '', title, body }),
      capturePage: (url, o) => this.preview.capture(url, o),
      secrets: { get: (key) => this.vault.get(key), set: (key, value) => (value == null ? this.vault.delete(key) : this.vault.set(key, value)) }
    })
    this.automations = new AutomationManager({
      root: () => this.workspace?.root ?? null,
      runPrompt: (id, name, prompt, mode) => this.agent.runAutomation(id, name, prompt, mode),
      agentActive: () => this.agent.anyRunning(),
      send: (ch, payload) => this.send(ch, payload),
      github: async () => {
        const root = this.workspace?.root
        const token = this.vault.get('github-token')
        const repo = root && token ? await githubRepo(root) : null
        return repo && token ? { ...repo, token } : null
      },
      webhookUrl: (id) => (this.workspace ? this.webhooks.url(this.workspace.root, id) : null)
    })
    this.scratch = new ScratchManager({ userData: this.userData, nodeExe: process.execPath, runtimeJs: scratchJs, runtimePy: scratchPy })
    this.customTools = new CustomToolManager({ userData: this.userData, nodeExe: process.execPath, runtimeSource: toolHost, workspace: () => this.workspace, failed: (t, error) => void this.agent.repair({ kind: 'tool', name: t.name, file: t.file, scope: t.scope }, error).catch(() => {}) })
    this.preview = new PreviewManager(
      () => this.workspace,
      (ch, payload) => this.send(ch, payload)
    )
    // the trigger addresses are known once the server is up
    this.offSettings = (() => {
      let alive = true
      void this.webhooks.start().then(() => alive && this.automations.reload())
      return () => {
        alive = false
      }
    })()
    setTimeout(() => this.claude.ensure(this.workspace?.root ?? homedir()), 4000)
  }

  /** To every client on this workbench. */
  send(channel: string, payload: unknown): void {
    const clients = this.host.clientsOf(this)
    // a desktop notice from a project no window shows still reaches the person
    if (!clients.length && channel === CH.Notice) return this.host.broadcast(channel, payload)
    for (const c of clients) c.send(channel, payload)
  }

  /** The window that asked, when a window asked; else a window on this workbench. */
  win(): BrowserWindow | null {
    const me = asClient.getStore()
    if (me && me.wb === this) {
      const w = me.client.window()
      if (w) return w
    }
    for (const c of this.host.clientsOf(this)) {
      const w = c.window()
      if (w && !w.isDestroyed()) return w
    }
    return null
  }

  /** Something keeps this workbench going with no window on it: a job, a helper, a timer. */
  busyInBackground(): boolean {
    return this.agent.backgroundBusy()
  }

  /** What the user currently sees in a gadget's panel, as a picture the agent can look at. */
  private async captureGadget(id: string): Promise<{ mime: string; base64: string } | null> {
    const w = this.win()
    if (!w || w.isDestroyed()) return null
    const rectOf = async (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      (await w.webContents.executeJavaScript(`window.__prismGadgetRect ? window.__prismGadgetRect(${JSON.stringify(id)}) : null`)) as { x: number; y: number; width: number; height: number } | null
    let rect = await rectOf()
    if (!rect) {
      this.send('gadget:ui', { kind: 'openGadget', id })
      await new Promise((r) => setTimeout(r, 1200))
      rect = await rectOf()
    }
    if (!rect || rect.width < 20 || rect.height < 20) return null
    const z = w.webContents.getZoomFactor()
    const shoot = (r: { x: number; y: number; width: number; height: number }): Promise<Electron.NativeImage> => w.webContents.capturePage({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z) })
    let img: Electron.NativeImage
    try {
      img = await shoot(rect)
    } catch {
      // nothing was being drawn there (a hidden tab, a window in the background): bring it forward and try once more
      this.send('gadget:ui', { kind: 'openGadget', id })
      await new Promise((r) => setTimeout(r, 1200))
      const again = await rectOf()
      if (!again) return null
      img = await shoot(again)
    }
    if (img.isEmpty()) return null
    const scaled = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img
    return { mime: 'image/jpeg', base64: scaled.toJPEG(84).toString('base64') }
  }

  private async inspectGadget(id: string): Promise<GadgetLayoutCheck | null> {
    const w = this.win()
    if (!w || w.isDestroyed()) return null
    try {
      return (await w.webContents.executeJavaScript(`window.__prismGadgetInspect ? window.__prismGadgetInspect(${JSON.stringify(id)}) : null`)) as GadgetLayoutCheck | null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- workspace

  setWorkspace(path: string): Workspace {
    if (this.workspace?.root === path) return this.workspace
    if (this.workspace) throw new Error('This workbench already has a project.')
    this.offWorkspace?.()
    this.workspace = placeOf(path).kind === 'ssh' ? new RemoteWorkspace(path) : new Workspace(path)
    this.offWorkspace = this.workspace.onChange((changes) => {
      this.send(CH.FsChanged, changes)
      this.automations?.onFsChange(changes)
      if (changes.some((c) => c.path.startsWith('.prism/tools'))) this.customTools.invalidate()
      if (changes.some((c) => SPEC_FILES.includes(c.path))) this.send(CH.SpecChanged, null)
      if (changes.some((c) => c.path.startsWith('.prism/tools') || c.path.startsWith('.prism/skills'))) this.send(CH.ExtendChanged, null)
    })
    this.customTools?.invalidate()
    const recent = [path, ...this.settings.get().recentWorkspaces.filter((p) => p !== path)].slice(0, 12)
    this.settings.update({ recentWorkspaces: recent })
    this.send(CH.WorkspaceChanged, path)
    this.send(CH.SessionChanged, this.agent.listSessions())
    this.gadgets?.rescan()
    this.automations?.reload()
    // sessions Prism went down under carry on, once a window has had a moment to connect
    setTimeout(() => this.agent.resumeCutOff(), 3000)
    return this.workspace
  }

  requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error('Open a folder first.')
    return this.workspace
  }

  /** Where the user's own skills live (the ones for every project). */
  skillsDir(): string {
    return join(this.userData, 'skills')
  }

  /** Every skill available right now: the open project's, then the user's own. */
  skills(): Promise<Skill[]> {
    return this.workspace ? loadSkills(this.workspace, this.skillsDir()) : Promise.resolve([])
  }

  themesDir(): string {
    const dir = join(this.userData, 'themes')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** A background picture that belongs to a theme. */
  themeFile(name: string): string | null {
    const p = join(this.themesDir(), basename(name))
    return existsSync(p) ? p : null
  }

  attachmentPath(name: string): string | null {
    const safe = basename(name)
    const p = join(this.userData, 'attachments', safe)
    return existsSync(p) ? p : null
  }

  /** Images produced by tools (MCP screenshots, read_file on images) are kept beside attachments. */
  async storeImage(im: { mime: string; base64: string }): Promise<string> {
    const ext = im.mime === 'image/jpeg' ? '.jpg' : im.mime === 'image/webp' ? '.webp' : im.mime === 'image/gif' ? '.gif' : '.png'
    const name = `tool-${randomUUID()}${ext}`
    await writeFile(join(this.userData, 'attachments', name), Buffer.from(im.base64, 'base64'))
    return name
  }

  // ---------------------------------------------------------------- models

  resolveModel(ref: ModelRef): ResolvedModel | null {
    // A Claude Agent model has no key to call it with: one-off requests (the Fast, Vision and
    // Review roles, second opinions) go through the Claude Code on this computer instead
    // (providers/claudecode.ts). Its sessions never come here; they run on Claude Code itself.
    if (isClaudeRef(ref)) {
      const exe = this.claude.exe()
      const info = exe ? this.claude.models().find((m) => m.modelId === ref.modelId) : null
      if (!exe || !info) return null
      return {
        ep: { id: ref.endpointId, name: info.endpointName, adapter: 'claude-code', baseUrl: exe, auth: { kind: 'none' }, extraHeaders: {}, enabled: true, createdAt: 0, probedAt: null, probeLatencyMs: null, probeError: null, hasKey: false },
        key: null,
        info: { ...info, adapter: 'claude-code' }
      }
    }
    const ep = this.repo.getEndpoint(ref.endpointId)
    if (!ep || !ep.enabled) return null
    const info = this.repo.getModel(ref)
    if (!info) return null
    return { ep, key: this.vault.get(ep.id), info }
  }

  /** Every model the pickers offer: the configured endpoints, then Claude Code's own when it is installed. */
  listModels(): ModelInfo[] {
    return [...this.repo.listModels(), ...this.claude.models()]
  }

  /** Can a session run on this model right now? */
  usable(ref: ModelRef): boolean {
    return isClaudeRef(ref) ? !!this.claude.exe() : !!this.resolveModel(ref)
  }

  findModel(id: string): ModelRef | null {
    const all = this.repo.listModels()
    const hit = all.find((m) => m.key === id) ?? all.find((m) => m.modelId === id) ?? all.find((m) => m.modelId.toLowerCase().includes(id.toLowerCase()))
    return hit ? { endpointId: hit.endpointId, modelId: hit.modelId } : null
  }

  /** Lead model: explicit role, else the first favourite tool-capable chat model. */
  defaultModel(): ModelRef | null {
    const s = this.settings.get()
    if (s.roles.lead && this.usable(s.roles.lead)) return s.roles.lead
    const pick = (ms: ModelInfo[]): ModelInfo | undefined =>
      ms.find((m) => m.favorite && m.supportsTools && isChatModel(m.modelId)) ?? ms.find((m) => m.supportsTools && isChatModel(m.modelId))
    const m = pick(this.repo.listModels())
    if (m) return { endpointId: m.endpointId, modelId: m.modelId }
    // nothing configured, but Claude Code is installed: use that
    const c = this.claude.models()[0]
    return c ? { endpointId: c.endpointId, modelId: c.modelId } : null
  }

  /** The vision role, else any favourite or available model that can see. */
  visionModel(): ResolvedModel | null {
    const ref = this.settings.get().roles.vision
    if (ref) {
      const r = this.resolveModel(ref)
      if (r?.info.supportsVision) return r
    }
    const all = this.repo.listModels().filter((m) => m.supportsVision && isChatModel(m.modelId))
    const pick = all.find((m) => m.favorite) ?? all[0]
    return pick ? this.resolveModel({ endpointId: pick.endpointId, modelId: pick.modelId }) : null
  }

  roleModel(role: keyof Settings['roles']): ResolvedModel | null {
    const ref = this.settings.get().roles[role] ?? this.defaultModel()
    return ref ? this.resolveModel(ref) : null
  }

  // ---------------------------------------------------------------- mcp

  mcpStatuses(): McpStatus[] {
    return this.shared.mcpStatuses()
  }

  connectMcp(id: string): Promise<McpStatus> {
    return this.shared.connectMcp(id)
  }

  disconnectMcp(id: string): McpStatus {
    return this.shared.disconnectMcp(id)
  }

  liveMcp(): Array<{ name: string; client: McpClient }> {
    return this.shared.liveMcp()
  }

  /** This workbench only: what every workbench shares is closed by the host. */
  dispose(): void {
    this.offSettings()
    // what each session was in the middle of is noted, so it carries on when Prism is back
    this.agent.shutdown()
    this.agent.dispose()
    this.gadgets.disposeNow()
    this.automations.dispose()
    this.preview.dispose()
    this.scratch.dispose()
    this.customTools.dispose()
    this.terminals.killAll()
    this.offWorkspace?.()
    this.workspace?.close()
  }
}

/** The gadgets that come with Prism: beside the program once installed, in build/gadgets in a checkout. */
function builtinGadgets(): string | null {
  const places = [join(process.resourcesPath, 'gadgets'), join(app.getAppPath(), 'build', 'gadgets'), join(app.getAppPath(), '..', 'build', 'gadgets'), join(process.cwd(), 'build', 'gadgets')]
  return places.find((p) => existsSync(p)) ?? null
}
