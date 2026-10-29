import type { ReviewFinding } from '@shared/types'
import type { FloatSpec } from './float'
import { forgetModel, keptModels, startWindowsDictation, transcribeWithProvider } from './voice'
import { installedVoices, speakToWav } from './speech'
import { checkKokoro, kokoroToWav, kokoroVoices, whereKokoro } from './kokoro'
import { faceInfo, facePart } from './face'
import { setCall } from '@core/agent/calls'
import { searchConversations } from '@core/search/conversations'
import { EMPTY_QUERY, type ConvQuery } from '@shared/convSearch'
import type { BoardTask, Effort, ModelRef, PermissionMode, PlanDecision, ReviewDecision, SessionExtras, ToolCall, TranscriptItem } from '@shared/types'
import { appendNote } from '@core/agent/tools/remember'
import { listCheckers, runChecker } from '@core/checks/checks'
import * as gitMore from '@core/git/more'
import { killJob, listJobs } from '@core/agent/tools/shell'
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, open, readFile, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { CH } from '@shared/ipc'
import type { Attachment, EndpointInput, GadgetIdea, LearnOffer, ModelMeta, ReviewFile, ScratchLang, SettingsPatch, UserRule } from '@shared/types'
import { THEME_FILE_KIND, THEME_PACK_KIND, type Theme, type ThemeFile, type ThemePackFile } from '@shared/theme'
import { SKILL_TEMPLATE, TOOL_TEMPLATE, TOOL_TYPES } from '@shared/extend'
import { buildTools } from '@core/agent/tools'
import { settingsThemeHost } from '@core/agent/tools/theme'
import * as history from '@core/history/history'
import { analyseImpact } from '@core/impact/impact'
import { sameEditElsewhere } from '@core/nextedit/nextedit'
import { catchUp } from '@core/history/catchup'
import { bootLog, booting } from './bootlog'
import { isClaudeRef } from '@core/claude/translate'
import { bitebackOn, setBiteback } from '@core/biteback/biteback'
import { listLessons, readLesson, removeLesson, writeLesson, type LessonScope } from '@core/lessons/lessons'
import { exportSession, importSession, type SessionFile } from '@core/history/portable'
import { sessionFromPage, sessionPage } from '@core/history/page'
import { SPEC_TEMPLATE } from '@shared/extend'
import { ruleFromSentence } from '@core/learning/rules'
import { skillFromHabit } from '@core/learning/learn'
import { mkdir, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { DEFAULT_SETTINGS } from '@core/store/settings'
import { MemoryStore } from '@core/memory/memory'
import { explainCall, judgeWays, pairGlance, planSplit, reviewDiff, sharpen, whyCall } from './assist'
import { addReviewRule, branchDiff, githubRepo, listPulls, postFinding, pullDiff, reviewRules, whoAmI } from '@core/review/prs'
import { applySplit, type SplitCommit } from '@core/git/split'
import { existsSync } from 'node:fs'
import { installedFonts } from './fonts'
import * as refactor from '@core/refactor/refactor'
import * as dashboard from '@core/dashboard/overview'
import { placeOf, wslRoot } from '@shared/place'
import { RemoteWorkspace } from '@core/remote/remoteWorkspace'
import { Workspace } from '@core/fs/workspace'
import { execFile } from 'node:child_process'
import { getAdapter } from '@core/providers'
import { isChatModel } from '@core/models/known'
import { quickOpenRank, searchWorkspace } from '@core/fs/search'
import * as gitOps from '@core/git/git'
import { inlineCompletion, inlineEdit } from '@core/agent/assist'
import type { Services } from './services'
import { listClaudeConversations, placeForResume, readClaudeConversation } from '@core/claude/conversations'
import { asClient, type Host } from './host'

type Handler = (e: { sender: { id: number } }, ...args: never[]) => unknown

/** How a client that is not a window (a remote app) asks for the same things. */
export interface IpcDispatch {
  invoke(clientId: string, channel: string, args: unknown[]): Promise<unknown>
  send(clientId: string, channel: string, args: unknown[]): void
  has(channel: string): boolean
}

const EndpointInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  adapter: z.enum(['openai-compat', 'anthropic', 'gemini']),
  baseUrl: z.string().min(1),
  auth: z.object({ kind: z.enum(['none', 'bearer', 'header', 'query']), name: z.string().optional() }),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  apiKey: z.string().optional()
})

const SearchSchema = z.object({
  query: z.string(),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  include: z.string().optional(),
  exclude: z.string().optional(),
  maxResults: z.number().int().positive().optional()
})

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** The files a session's most recent changing request touched: as they were before it, and as they are now. */
export async function latestChanges(s: Services, sessionId: string): Promise<ReviewFile[]> {
  const versions = s.repo.listFileVersions(sessionId)
  const last = versions[versions.length - 1]
  if (!last) return []
  const mine = versions.filter((v) => v.turnItemId === last.turnItemId)
  const ws = s.agent.workspaceFor(sessionId)
  const out: ReviewFile[] = []
  for (const path of [...new Set(mine.map((v) => v.path))]) {
    const before = mine.find((v) => v.path === path)!.before
    const after = await ws.read(path).then((f) => f.content).catch(() => null)
    if (before !== after) out.push({ path, before, after })
  }
  return out
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** How much of a tool's output and arguments travel to the phone. */
const PHONE_CHARS = 2000

/** Recordings sent from the phone, waiting for a window of the app to say what was said. */
const speechJobs = new Map<string, { resolve(text: string): void; reject(e: Error): void; timer: NodeJS.Timeout }>()

/**
 * A conversation for the phone: the words, not the payloads. Tool output, file
 * contents and the before/after of a diff are the bulk of a long conversation and
 * are no use on a small screen, so only the beginning of each travels; the whole
 * thing stays on this computer.
 */
function light(item: TranscriptItem): TranscriptItem {
  if (item.kind !== 'tool') return item
  const cut = (v: string): string => (v.length > PHONE_CHARS ? `${v.slice(0, PHONE_CHARS)}\n… ${v.length - PHONE_CHARS} more characters, kept on the computer` : v)
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item.args)) args[k] = typeof v === 'string' ? cut(v) : v
  return { ...item, args, content: cut(item.content), diff: item.diff ? { ...item.diff, before: null, after: null } : null }
}

export function registerIpc(host: Host): IpcDispatch {
  // `s` is the workbench of whoever is asking: every request runs as its client (host.run)
  const s = new Proxy({} as Services, {
    get: (_t, k) => {
      const c = asClient.getStore()
      if (!c) throw new Error(`Prism: "${String(k)}" was used outside a request`)
      const v = (c.wb as unknown as Record<string | symbol, unknown>)[k]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c.wb) : v
    },
    set: (_t, k, v) => {
      ;(asClient.getStore()!.wb as unknown as Record<string | symbol, unknown>)[k] = v
      return true
    }
  })
  const handlers = new Map<string, Handler>()
  const oneWay = new Map<string, Handler>()
  const windowClient = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string => `win:${e.sender.id}`
  const h = (channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    handlers.set(channel, fn as unknown as Handler)
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      const run = (): unknown => host.run(windowClient(e), () => (fn as (e: unknown, ...a: unknown[]) => unknown)(e, ...args))
      if (!booting()) return run()
      // during start-up every request is logged going in and coming out, to find one that never answers
      const t0 = Date.now()
      bootLog('request', channel, `from window ${e.sender.id}`)
      const done = (how: string): void => bootLog('answered', channel, `${how} after ${Date.now() - t0}ms`)
      try {
        const r = run()
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          ;(r as Promise<unknown>).then(() => done('ok'), (err: unknown) => done(`failed (${err instanceof Error ? err.message : String(err)})`))
        } else done('ok')
        return r
      } catch (err) {
        done(`failed (${err instanceof Error ? err.message : String(err)})`)
        throw err
      }
    })
  }
  const on = (channel: string, fn: (e: Electron.IpcMainEvent, ...args: never[]) => unknown): void => {
    oneWay.set(channel, fn as unknown as Handler)
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      try {
        host.run(windowClient(e), () => (fn as (e: unknown, ...a: unknown[]) => unknown)(e, ...args))
      } catch {
        /* a window that is closing */
      }
    })
  }

  // ---------------------------------------------------------------- app / window
  h(CH.AppInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: s.userData,
    encryptionAvailable: s.vault.encryptionAvailable,
    homeDir: app.getPath('home')
  }))
  h(CH.AppOpenExternal, (_e, url: string) => (/^https?:/i.test(url) ? shell.openExternal(url) : Promise.resolve()))
  // A file the agent handed over is found through the transcript item that attached it,
  // never by a path from the asker, so the phone can fetch those files and nothing else.
  const attached = (sid: string, itemId: string): { path: string } => {
    const it = s.repo.getItem(sid, itemId)
    const a = it?.kind === 'tool' ? (it.meta?.['attach'] as { path?: unknown } | undefined) : undefined
    if (!a || typeof a.path !== 'string') throw new Error('That attachment is not in this conversation.')
    return { path: a.path }
  }
  h(CH.FileOpen, async (_e, sid: string, itemId: string) => {
    const why = await shell.openPath(attached(sid, itemId).path)
    if (why) throw new Error(why)
  })
  h(CH.FileReveal, (_e, sid: string, itemId: string) => shell.showItemInFolder(attached(sid, itemId).path))
  h(CH.FilePart, async (_e, sid: string, itemId: string, offset: number) => {
    const { path } = attached(sid, itemId)
    const f = await open(path, 'r').catch(() => {
      throw new Error('The file is no longer on the computer.')
    })
    try {
      const size = (await f.stat()).size
      const at = Math.max(0, Math.min(Number(offset) || 0, size))
      const buf = Buffer.alloc(Math.min(512 * 1024, size - at))
      const { bytesRead } = await f.read(buf, 0, buf.length, at)
      return { data: buf.subarray(0, bytesRead).toString('base64'), size, next: at + bytesRead }
    } finally {
      await f.close()
    }
  })
  h(CH.AppCopy, (_e, text: string) => clipboard.writeText(String(text ?? '')))
  h(CH.AppReveal, (_e, p: string) => {
    const ws = s.requireWorkspace()
    if (placeOf(ws.root).kind === 'ssh') throw new Error('That file is on another computer, so it cannot be shown in this one\'s file manager.')
    shell.showItemInFolder(ws.abs(p))
  })
  on(CH.WinMinimize, () => s.win()?.minimize())
  on(CH.WinMaximize, () => {
    const w = s.win()
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  on(CH.WinClose, () => s.win()?.close())
  h(CH.WinNew, (_e, root: string | null) => host.newWindow?.(typeof root === 'string' && root ? root : null))
  h(CH.WinHanded, (e) => {
    const file = host.handedFiles.get(e.sender.id) ?? null
    host.handedFiles.delete(e.sender.id)
    return file
  })
  h(CH.FloatOpen, (_e, spec: FloatSpec) => void host.floats?.open(spec, s.workspace?.root ?? null))
  h(CH.FloatList, () => host.floats?.keys() ?? [])
  h(CH.FloatPin, (e, on: boolean) => host.floats?.pin(e.sender.id, on !== false))
  h(CH.FloatOpacity, (e, value: number) => host.floats?.opacity(e.sender.id, Number(value)))
  h(CH.FloatClose, (e) => host.floats?.close(e.sender.id))
  h(CH.FloatDrag, (e, on: boolean) => host.floats?.drag(e.sender.id, on === true))
  h(CH.FloatBar, (e, on: boolean) => host.floats?.bar(e.sender.id, on === true))
  h(CH.WinIsMaximized, () => s.win()?.isMaximized() ?? false)
  h(CH.WinZoom, (_e, step: number) => {
    const wc = s.win()?.webContents
    if (!wc) return 0
    if (!Number.isFinite(step)) return wc.getZoomLevel()
    const next = step === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + step))
    wc.setZoomLevel(next)
    return next
  })

  // ---------------------------------------------------------------- settings
  h(CH.SettingsGet, () => s.settings.get())
  h(CH.SettingsUpdate, (_e, patch: SettingsPatch) => s.settings.update(patch))
  h(CH.SettingsDefaults, () => DEFAULT_SETTINGS)
  h(CH.FaceInfo, () => faceInfo(s.settings.get().face.path))
  h(CH.FacePart, (_e, offset: number) => facePart(s.settings.get().face.path, offset))
  h(CH.FacePick, async () => {
    const r = await dialog.showOpenDialog(s.win()!, { title: 'Choose a face', properties: ['openFile'], filters: [{ name: 'VRM avatar', extensions: ['vrm'] }] })
    const p = r.filePaths[0]
    if (!p) return null
    await s.settings.update({ face: { path: p } })
    return faceInfo(p)
  })

  // ---------------------------------------------------------------- endpoints / models
  h(CH.EndpointList, () => s.repo.listEndpoints())
  h(CH.EndpointSave, (_e, raw: unknown) => {
    const input = EndpointInputSchema.parse(raw) as EndpointInput
    const id = input.id ?? randomUUID()
    if (input.apiKey && input.apiKey.trim()) s.vault.set(id, input.apiKey.trim())
    s.repo.upsertEndpoint({ id, name: input.name, adapter: input.adapter, baseUrl: input.baseUrl, auth: input.auth, extraHeaders: input.extraHeaders ?? {} })
    return s.repo.getEndpoint(id)
  })
  h(CH.EndpointDelete, (_e, id: string) => {
    s.vault.delete(id)
    s.repo.deleteEndpoint(id)
  })
  h(CH.EndpointProbe, async (_e, id: string) => {
    const ep = s.repo.getEndpoint(id)
    if (!ep) return { ok: false, latencyMs: 0, models: [], error: 'Endpoint not found' }
    const t0 = Date.now()
    try {
      const models = (await getAdapter(ep.adapter).listModels(ep, s.vault.get(id))).filter(isChatModel)
      const latencyMs = Date.now() - t0
      s.repo.replaceModels(id, models)
      s.repo.recordProbe(id, latencyMs, null)
      return { ok: true, latencyMs, models }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      s.repo.recordProbe(id, Date.now() - t0, error)
      return { ok: false, latencyMs: Date.now() - t0, models: [], error }
    }
  })
  h(CH.ModelList, () => s.listModels())
  h(CH.ClaudeStatus, () => s.claude.current())
  h(CH.ClaudeRefresh, () => s.claude.refresh(s.workspace?.root ?? homedir()))
  h(CH.ModelFavorite, (_e, key: string, on: boolean) => s.repo.setFavorite(key, on))
  h(CH.ModelSetMeta, (_e, key: string, meta: Partial<ModelMeta>) => s.repo.setModelMeta(key, meta))

  // ---------------------------------------------------------------- workspace / fs
  h(CH.WorkspaceOpen, async (_e, at?: string) => {
    const w = s.win()
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory'], title: 'Open a project folder', ...(at ? { defaultPath: at } : {}) })
    if (r.canceled || !r.filePaths[0]) return null
    return openFor(r.filePaths[0])
  })
  h(CH.WorkspaceSet, async (_e, p: string) => {
    // a folder on another computer is tried before the app switches to it
    if (placeOf(p).kind === 'ssh') await new RemoteWorkspace(p).connect()
    return openFor(p)
  })
  /** The project for the asking client; when another window has it, that window comes forward and this one stays as it is. */
  function openFor(p: string): string | null {
    const me = asClient.getStore()!
    const r = host.open(me.client.id, p)
    return r.elsewhere ? (host.clientById(me.client.id)?.wb.workspace?.root ?? null) : r.root
  }
  h(CH.WorkspaceWsl, async () => {
    if (process.platform !== 'win32') return []
    const run = (args: string[], encoding: BufferEncoding): Promise<string> => new Promise((resolve) => execFile('wsl.exe', args, { timeout: 15_000, windowsHide: true, encoding: 'buffer' }, (err, out) => resolve(err ? '' : (out as Buffer).toString(encoding))))
    // the list of systems comes back in UTF-16
    const names = (await run(['-l', '-q'], 'utf16le')).split(/\r?\n/).map((n) => n.replace(/\0/g, '').trim()).filter((n) => n && !/^docker-desktop/i.test(n))
    const out: Array<{ distro: string; home: string }> = []
    for (const distro of names) {
      const home = (await run(['-d', distro, '--exec', 'sh', '-c', 'printf %s "$HOME"'], 'utf8')).trim()
      out.push({ distro, home: wslRoot(distro, home || '/') })
    }
    return out
  })
  h(CH.WorkspaceSshHosts, async () => {
    try {
      const text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
      return [...new Set([...text.matchAll(/^\s*Host\s+(.+)$/gim)].flatMap((m) => m[1]!.trim().split(/\s+/)).filter((h) => !/[*?!]/.test(h)))]
    } catch {
      return []
    }
  })
  h(CH.WorkspaceCurrent, () => s.workspace?.root ?? null)
  h(CH.FsList, (_e, p: string) => s.requireWorkspace().list(p))
  // a file the user opened from outside the project goes by its full path (Services.outsideFile)
  const beside = (abs: string): Workspace => new Workspace(dirname(abs))
  h(CH.FsRead, async (_e, p: string) => {
    const out = s.outsideFile(p)
    if (!out) return s.requireWorkspace().read(p)
    return { ...(await beside(out).read(basename(out))), path: p }
  })
  h(CH.FsWrite, (_e, p: string, content: string) => {
    const out = s.outsideFile(p)
    return out ? beside(out).write(basename(out), content) : s.requireWorkspace().write(p, content)
  })
  h(CH.FsWriteBinary, (_e, p: string, base64: string) => {
    const out = s.outsideFile(p)
    return out ? beside(out).writeRaw(basename(out), Buffer.from(base64, 'base64')) : s.requireWorkspace().writeRaw(p, Buffer.from(base64, 'base64'))
  })
  h(CH.FsCreate, (_e, p: string, kind: 'file' | 'dir') => s.requireWorkspace().create(p, kind))
  h(CH.FsRename, (_e, a: string, b: string) => s.requireWorkspace().rename(a, b))
  h(CH.FsDelete, (_e, p: string) => s.requireWorkspace().delete(p))
  h(CH.FsAssetUrl, async (_e, p: string) => {
    const out = s.outsideFile(p)
    if (out) {
      let v = Date.now()
      try {
        v = Math.floor((await stat(out)).mtimeMs)
      } catch {
        /* missing: let the preview show an error */
      }
      // the folders stay as folders, so a model's textures beside it are found (index.ts serves them)
      return `prism://out-${s.id}/${out.split(/[\\/]/).map(encodeURIComponent).join('/')}?v=${v}`
    }
    const ws = s.requireWorkspace()
    let v = Date.now()
    try {
      if (placeOf(ws.root).kind !== 'ssh') v = Math.floor((await stat(ws.abs(p))).mtimeMs)
    } catch {
      /* missing: let the preview show an error */
    }
    return `prism://wb-${s.id}/${p.split('/').map(encodeURIComponent).join('/')}?v=${v}`
  })
  h(CH.FsSearch, (_e, raw: unknown) => searchWorkspace(s.requireWorkspace().root, SearchSchema.parse(raw)))
  const fileIndex = new Map<string, { at: number; files: string[] }>()
  h(CH.FsQuickOpen, async (_e, query: string, limit?: number) => {
    const ws = s.requireWorkspace()
    let idx = fileIndex.get(ws.root)
    if (!idx || Date.now() - idx.at > 15_000) {
      idx = { at: Date.now(), files: await ws.walk() }
      fileIndex.set(ws.root, idx)
    }
    return quickOpenRank(idx.files, query, limit ?? 50)
  })

  // ---------------------------------------------------------------- git
  h(CH.GitStatus, () => gitOps.status(s.requireWorkspace().root))
  h(CH.GitBlob, async (_e, p: string) => (await gitOps.blobAtHead(s.requireWorkspace().root, p))?.toString('base64') ?? null)
  h(CH.GitDiff, async (_e, p: string, staged: boolean) => {
    const ws = s.requireWorkspace()
    const d = await gitOps.diffFile(ws.root, p, staged)
    if (!staged) {
      try {
        const f = await ws.read(p)
        d.after = f.binary ? '' : f.content
      } catch {
        d.after = ''
      }
    }
    return d
  })
  h(CH.GitStage, (_e, paths: string[]) => gitOps.stage(s.requireWorkspace().root, paths))
  h(CH.GitUnstage, (_e, paths: string[]) => gitOps.unstage(s.requireWorkspace().root, paths))
  h(CH.GitDiscard, (_e, paths: string[]) => gitOps.discard(s.requireWorkspace().root, paths))
  h(CH.GitCommit, (_e, message: string) => gitOps.commit(s.requireWorkspace().root, message))
  h(CH.GitLog, (_e, limit?: number) => gitOps.log(s.requireWorkspace().root, limit))
  // every further git operation goes through one channel: (name, ...args) → core/git/more.ts
  const GIT_OPS: Record<string, (cwd: string, ...args: never[]) => unknown> = {
    branches: gitMore.branches,
    checkout: gitMore.checkout,
    createBranch: gitMore.createBranch,
    deleteBranch: gitMore.deleteBranch,
    merge: gitMore.mergeBranch,
    fetch: gitMore.fetch,
    pull: gitMore.pull,
    push: gitMore.push,
    stashList: gitMore.stashList,
    stashSave: gitMore.stashSave,
    stashApply: gitMore.stashApply,
    stashDrop: gitMore.stashDrop,
    graph: gitMore.graph,
    commitFiles: gitMore.commitFiles,
    commitFileDiff: gitMore.commitFileDiff,
    blame: gitMore.blame,
    operation: gitMore.operation,
    abortOperation: gitMore.abortOperation,
    conflict: gitMore.conflict,
    resolveConflict: gitMore.resolveConflict
  }
  h(CH.GitOp, (_e, name: string, ...args: unknown[]) => {
    const op = GIT_OPS[String(name)]
    if (!op) throw new Error(`Unknown git operation ${name}`)
    return (op as (cwd: string, ...a: unknown[]) => unknown)(s.requireWorkspace().root, ...args)
  })

  // ---------------------------------------------------------------- sessions / agent
  h(CH.SessionList, () => s.agent.listSessions())
  h(CH.SessionCreate, (_e, title?: string) => {
    const ws = s.requireWorkspace()
    const session = s.repo.createSession(ws.root, title ?? 'New session', s.defaultModel(), s.settings.get().permissions.mode)
    s.send(CH.SessionChanged, s.agent.listSessions())
    return session
  })
  h(CH.SessionDelete, async (_e, id: string) => {
    s.agent.abort(id)
    s.agent.forget(id)
    // a session's own copy of the project goes with it
    await s.agent.discardCopy(id).catch(() => undefined)
    s.repo.deleteSession(id)
    s.send(CH.SessionChanged, s.agent.listSessions())
  })
  h(CH.SessionRename, (_e, id: string, title: string) => {
    s.repo.updateSession(id, { title })
    s.send(CH.SessionChanged, s.agent.listSessions())
  })
  h(CH.SessionDuplicate, (_e, id: string, opts?: { upTo?: string; before?: string; title?: string; sideOf?: string }) => {
    const src = s.repo.getSession(id)
    if (!src) throw new Error('Session not found')
    let items = s.repo.listItems(id)
    const cut = (itemId: string | undefined, keep: 0 | 1): void => {
      if (!itemId) return
      const at = items.findIndex((x) => x.id === itemId)
      if (at >= 0) items = items.slice(0, at + keep)
    }
    cut(opts?.upTo, 1)
    cut(opts?.before, 0)
    const copy = s.repo.createSession(src.workspace, typeof opts?.title === 'string' && opts.title.trim() ? opts.title.trim().slice(0, 120) : `${src.title} (copy)`, src.model, src.mode)
    if (opts?.sideOf) s.repo.setSessionExtras(copy.id, { sideOf: String(opts.sideOf) })
    for (const it of items) s.repo.appendItem(copy.id, { ...it, id: randomUUID() })
    s.send(CH.SessionChanged, s.agent.listSessions())
    return s.repo.getSession(copy.id)
  })
  h(CH.SessionItems, (_e, id: string, limit?: number) => (limit && limit > 0 ? s.repo.listItemsTail(id, limit).map(light) : s.repo.listItems(id)))
  h(CH.SessionExtras, (_e, id: string) => s.repo.getSessionExtras(id))
  h(CH.SessionSetExtras, (_e, id: string, patch: Partial<SessionExtras>) => s.repo.setSessionExtras(id, { ...(Array.isArray(patch?.pins) ? { pins: patch.pins.map(String) } : {}), ...(typeof patch?.instructions === 'string' ? { instructions: patch.instructions.slice(0, 20_000) } : {}), ...(Array.isArray(patch?.skills) ? { skills: patch.skills.map(String).slice(0, 40) } : {}), ...(patch && 'budget' in patch ? { budget: cleanBudget(patch.budget) } : {}), ...(patch && 'effort' in patch ? { effort: EFFORTS.includes(patch.effort as Effort) ? (patch.effort as Effort) : null } : {}) }))
  h(CH.SessionCreateCopy, (_e, title?: string) => s.agent.createInCopy(title))
  h(CH.SessionCopyChanges, (_e, sessionId: string) => s.agent.copyChanges(sessionId))
  h(CH.SessionCopyIntegrate, (_e, sessionId: string) => s.agent.integrateCopy(sessionId))
  h(CH.SessionCopyDiscard, (_e, sessionId: string) => s.agent.discardCopy(sessionId))
  h(CH.SessionPrune, (_e, sessionId: string, itemId: string) => s.agent.pruneItem(sessionId, itemId))
  h(CH.AgentContext, (_e, sessionId: string) => s.agent.context(sessionId))
  h(CH.AgentOpinion, (_e, sessionId: string, itemId: string, model: ModelRef) => s.agent.opinion(sessionId, itemId, model))
  h(CH.AgentCompare, (_e, runId: string, sessionId: string | null, question: string, models: ModelRef[]) => s.agent.compare(String(runId), sessionId, String(question), Array.isArray(models) ? models : []))
  h(CH.AgentCompareStop, (_e, runId: string) => s.agent.compareStop(runId))
  h(CH.AgentAdopt, (_e, sessionId: string, question: string, answer: string, model: ModelRef) => s.agent.adopt(sessionId, question, answer, model))
  h(CH.NotesRemember, (_e, note: string) => {
    const ws = s.requireWorkspace()
    return appendNote(
      async (p) => {
        try {
          return (await ws.read(p)).content
        } catch {
          return null
        }
      },
      (p, c) => ws.write(p, c),
      String(note).slice(0, 2000)
    )
  })
  h(CH.AgentSend, (_e, sessionId: string, text: string, opts?: Parameters<typeof s.agent.send>[2]) => s.agent.send(sessionId, text, opts))
  h(CH.AgentAbort, (_e, sessionId: string) => s.agent.abort(sessionId))
  h(CH.AgentApprove, (_e, sessionId: string, approvalId: string, decision: 'once' | 'always' | 'deny') => s.agent.approve(sessionId, approvalId, decision))
  h(CH.LessonList, () => listLessons(s.workspace?.root ?? null, s.userData))
  h(CH.LessonRead, (_e, id: string) => readLesson(String(id), s.workspace?.root ?? null, s.userData))
  h(CH.LessonWrite, (_e, scope: LessonScope, lesson: { title: string; steps: unknown[] }, id: string | null) => writeLesson(scope === 'personal' ? 'personal' : 'project', lesson, s.workspace?.root ?? null, s.userData, id))
  h(CH.LessonRemove, (_e, id: string) => removeLesson(String(id), s.workspace?.root ?? null, s.userData))
  h(CH.Biteback, (_e, on: boolean | null) => {
    const root = s.workspace?.root
    if (!root) return false
    return typeof on === 'boolean' ? setBiteback(s.userData, root, on) : bitebackOn(s.userData, root)
  })
  h(CH.AgentAnswer, (_e, sessionId: string, questionId: string, answer: string) => s.agent.answer(sessionId, questionId, answer))
  h(CH.AgentPlan, (_e, sessionId: string, planId: string, decision: PlanDecision) => s.agent.plan(sessionId, planId, decision))
  h(CH.AgentReview, (_e, sessionId: string, reviewId: string, decision: ReviewDecision) => s.agent.review(sessionId, reviewId, decision))
  h(CH.AgentSetMode, (_e, sessionId: string, mode: PermissionMode) => s.agent.setMode(sessionId, mode))
  h(CH.TasksList, () => s.tasks.list())
  h(CH.TasksSave, (_e, tasks: unknown) => s.tasks.save(Array.isArray(tasks) ? (tasks as Array<Partial<BoardTask> & { title: string; prompt: string }>).filter((x) => x && typeof x.title === 'string' && typeof x.prompt === 'string') : []))
  h(CH.TasksRun, (_e, ids: unknown, parallel: unknown) => s.tasks.run(Array.isArray(ids) ? ids.map(String) : null, Number(parallel) || 1))
  h(CH.TasksStop, () => s.tasks.stop())
  h(CH.MemoryList, async () => {
    const ws = s.workspace
    if (!ws) return []
    return new MemoryStore(ws, join(s.userData, 'memory')).list()
  })
  h(CH.MemoryRemove, async (_e, name: string) => {
    const ws = s.requireWorkspace()
    return new MemoryStore(ws, join(s.userData, 'memory')).remove(String(name))
  })
  h(CH.AgentWhy, (_e, sessionId: string, itemId: string) => whyCall(s, String(sessionId), String(itemId)))
  h(CH.AgentSharpen, async (_e, text: string) => sharpen(s, String(text ?? '').slice(0, 20_000), s.workspace?.root ?? null, s.workspace ? await s.workspace.walk(400).catch(() => []) : []))
  h(CH.AgentExplainCall, (_e, call: ToolCall) => explainCall(s, { id: String(call?.id ?? ''), name: String(call?.name ?? ''), args: call?.args && typeof call.args === 'object' ? call.args : {} }, s.workspace?.root ?? null))
  h(CH.PairGlance, (_e, path: string, before: string, after: string) => pairGlance(s, String(path), String(before ?? ''), String(after ?? '')))
  h(CH.AgentQuickAsk, (_e, text: string) => s.agent.quickAsk(String(text ?? '').slice(0, 20_000)))
  h(CH.AgentQuickStop, (_e, id: string) => s.agent.stopQuick(String(id)))
  h(CH.AgentPending, (_e, sessionId: string) => s.agent.pending(String(sessionId)))
  h(CH.AgentSteer, (_e, sessionId: string, text: string) => s.agent.steer(String(sessionId), String(text ?? '').slice(0, 50_000)))
  h(CH.AgentBackground, (_e, sessionId: string) => s.agent.backgroundState(String(sessionId)))
  h(CH.AgentBackgroundCancel, (_e, sessionId: string, kind: string, id: string) => s.agent.cancelBackground(String(sessionId), kind === 'job' || kind === 'timer' ? kind : 'helper', String(id)))
  h(CH.AgentSetModel, (_e, sessionId: string, model: ModelRef | null) => s.agent.setModel(sessionId, model && typeof model.endpointId === 'string' && typeof model.modelId === 'string' ? { endpointId: model.endpointId, modelId: model.modelId } : null))
  h(CH.AgentCompact, (_e, sessionId: string) => s.agent.compact(sessionId))
  h(CH.SlashList, () => s.agent.commands())
  h(CH.CheckpointList, (_e, sessionId: string) => s.repo.listCheckpoints(sessionId))
  const restoreFiles = async (files: Array<{ path: string; content: Buffer | null }>, sessionId?: string | null): Promise<string[]> => {
    const ws = sessionId ? s.agent.workspaceFor(sessionId) : s.requireWorkspace()
    const restored: string[] = []
    for (const f of files) {
      try {
        if (f.content === null) await ws.delete(f.path)
        else await ws.writeRaw(f.path, f.content)
        restored.push(f.path)
      } catch {
        /* keep going */
      }
    }
    return restored
  }
  h(CH.CheckpointRestore, (_e, id: string) => restoreFiles(s.repo.getCheckpointFiles(id), s.repo.getCheckpoint(id)?.sessionId))
  h(CH.CheckpointFile, (_e, id: string, path: string) => {
    const f = s.repo.getCheckpointFiles(id).find((x) => x.path === path)
    return f ? { existed: f.content !== null, content: f.content ? f.content.toString('utf8') : '' } : null
  })
  h(CH.CheckpointRestoreFile, async (_e, id: string, path: string) => {
    const f = s.repo.getCheckpointFiles(id).find((x) => x.path === path)
    if (!f) return false
    return (await restoreFiles([f], s.repo.getCheckpoint(id)?.sessionId)).length === 1
  })
  h(CH.SessionRewind, async (_e, sessionId: string, itemId: string) => {
    const item = s.repo.getItem(sessionId, itemId)
    if (!item || item.kind !== 'user') throw new Error('Rewind points must be one of your messages.')
    s.agent.abort(sessionId)
    // Newest first, so the oldest snapshot at or after this turn is written last and wins.
    const cps = s.repo.listCheckpoints(sessionId).filter((c) => c.ts >= item.ts)
    const touched = new Set<string>()
    for (const cp of cps) for (const p of await restoreFiles(s.repo.getCheckpointFiles(cp.id), sessionId)) touched.add(p)
    s.repo.truncateItemsFrom(sessionId, itemId)
    s.agent.rewound(sessionId)
    s.send(CH.SessionChanged, s.agent.listSessions())
    return { text: item.text, files: [...touched] }
  })

  // ---------------------------------------------------------------- terminals
  h(CH.TermCreate, async (_e, opts?: { cwd?: string; kind?: 'user' | 'agent'; title?: string }) => {
    const cwd = opts?.cwd ? s.requireWorkspace().abs(opts.cwd) : (s.workspace?.root ?? app.getPath('home'))
    const info = await s.terminals.create({ cwd, kind: opts?.kind, title: opts?.title })
    const wb = asClient.getStore()!.wb
    wb.terminals.onData(info.id, (d) => wb.send(CH.TermDataPrefix + info.id, d))
    wb.terminals.onExit(info.id, (code) => wb.send(CH.TermExitPrefix + info.id, code))
    const rec = s.terminals.get(info.id)
    if (rec?.buffer) s.send(CH.TermDataPrefix + info.id, rec.buffer)
    return info
  })
  on(CH.TermWrite, (_e, id: string, data: string) => s.terminals.write(id, data))
  on(CH.TermResize, (_e, id: string, cols: number, rows: number) => s.terminals.resize(id, cols, rows))
  h(CH.TermKill, (_e, id: string) => s.terminals.kill(id))
  h(CH.TermList, () => s.terminals.list())

  // ---------------------------------------------------------------- completions
  h(CH.CompletionInline, async (_e, req: Parameters<typeof inlineCompletion>[1]) => {
    // only a model picked for it: ghost text asks on every pause in typing, which through Claude
    // Code (seconds to start, and the user's plan) would be slow and use the plan up
    const ref = s.settings.get().roles.completion
    const model = ref && !isClaudeRef(ref) ? s.resolveModel(ref) : null
    if (!model) return null
    return inlineCompletion(model, req, AbortSignal.timeout(12_000))
  })
  h(CH.CompletionEdit, async (_e, req: Parameters<typeof inlineEdit>[1]) => {
    const model = s.roleModel('lead')
    if (!model) throw new Error('No model configured.')
    return inlineEdit(model, req, AbortSignal.timeout(120_000))
  })

  // ---------------------------------------------------------------- mcp
  h(CH.McpList, () => s.mcpStatuses())
  h(CH.McpConnect, (_e, id: string) => s.connectMcp(id))
  h(CH.McpDisconnect, (_e, id: string) => s.disconnectMcp(id))
  h(CH.McpSetSecret, (_e, id: string, name: string, value: string) => {
    const key = `mcp:${String(id)}:${String(name)}`
    if (value) s.vault.set(key, String(value))
    else s.vault.delete(key)
  })

  // ---------------------------------------------------------------- rules and learning
  const quick = (): NonNullable<ReturnType<typeof s.roleModel>> => {
    const m = s.roleModel('fast')
    if (!m) throw new Error('Set up a model under Settings, Providers first (a quick one is best for this).')
    return m
  }
  const preview = async (sentence: string): Promise<UserRule> => {
    const ws = s.workspace
    const files = ws ? await ws.walk(2000).catch(() => []) : []
    const r = await ruleFromSentence(quick(), String(sentence).slice(0, 500), files)
    return { id: randomUUID(), enabled: true, scope: 'project', ...r }
  }
  // the rules list in Settings follows changes made from the conversation too
  const saveRule = async (rule: UserRule): Promise<void> => {
    await s.rules.save(s.workspace, rule)
    s.send(CH.ExtendChanged, null)
  }
  h(CH.RulesList, () => s.rules.list(s.workspace))
  h(CH.RulesPreview, (_e, sentence: string) => preview(sentence))
  h(CH.RulesSave, (_e, rule: UserRule) => saveRule({ id: String(rule.id), text: String(rule.text), block: rule.block, paths: (rule.paths ?? []).map(String), command: rule.command ? String(rule.command) : null, enabled: rule.enabled !== false, scope: rule.scope === 'personal' ? 'personal' : 'project' }))
  h(CH.RulesRemove, async (_e, id: string) => {
    await s.rules.remove(s.workspace, String(id))
    s.send(CH.ExtendChanged, null)
  })
  h(CH.LearnAccept, async (_e, offer: LearnOffer, scope: 'project' | 'personal') => {
    if (offer.kind === 'rule') {
      const rule = { ...(await preview(offer.sentence)), scope }
      await saveRule(rule)
      return { rule }
    }
    const { name, text } = skillFromHabit(offer)
    if (scope === 'project') {
      const ws = s.requireWorkspace()
      const path = `.prism/skills/${name}.md`
      await ws.write(path, text)
      return { path }
    }
    await mkdir(s.skillsDir(), { recursive: true })
    const path = join(s.skillsDir(), `${name}.md`)
    await writeFile(path, text, 'utf8')
    return { path }
  })
  h(CH.LearnDismiss, (_e, offer: LearnOffer) => {
    if (offer.kind === 'skill' && s.workspace) s.learner.dismiss(s.workspace.root, offer.id)
  })

  // ---------------------------------------------------------------- living spec
  h(CH.SpecState, () => (s.workspace ? s.spec.state(s.workspace) : null))
  h(CH.SpecCreate, async () => {
    const ws = s.requireWorkspace()
    if (await ws.exists('SPEC.md')) return 'SPEC.md'
    await ws.write('SPEC.md', SPEC_TEMPLATE(ws.name))
    await s.spec.markSynced(ws)
    return 'SPEC.md'
  })
  h(CH.SpecMakeCodeMatch, async () => {
    const ws = s.requireWorkspace()
    const request = await s.spec.editRequest(ws)
    if (!request) throw new Error('The code already follows the spec as it is.')
    return s.agent.specTurn(request, 'plan', null, { sync: true })
  })
  h(CH.SpecResolve, async (_e, title: string, how: 'spec' | 'code' | 'ignore', sessionId: string | null) => {
    const ws = s.requireWorkspace()
    const st = await s.spec.state(ws)
    const sec = st?.sections.find((x) => x.title === title)
    if (!st || !sec) throw new Error('That part of the spec is gone.')
    s.spec.clear(ws.root, title)
    s.send(CH.SpecChanged, null)
    if (how === 'ignore') return null
    const prompt =
      how === 'spec'
        ? `The code no longer matches the "${title}" section of ${st.path}: ${sec.note ?? ''}\nThe code is right. Update only that section of ${st.path} so it describes what the code does now. Do not change any code.`
        : `The code no longer matches the "${title}" section of ${st.path}: ${sec.note ?? ''}\nThe spec is right. Change the code so it does what that section says again, then run the tests. Do not change ${st.path}.`
    return s.agent.specTurn(prompt, how === 'spec' ? 'auto-edit' : 'ask', sessionId, { sync: how === 'spec' })
  })

  // ---------------------------------------------------------------- sessions as files
  h(CH.SessionExport, async (_e, sessionId: string) => {
    const file = await exportSession(s.repo, join(s.userData, 'attachments'), String(sessionId))
    const safe = file.session.title.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'session'
    const r = await dialog.showSaveDialog(s.win()!, { title: 'Save the session as a file', defaultPath: `${safe}.prism-session`, filters: [{ name: 'Prism session', extensions: ['prism-session'] }] })
    if (r.canceled || !r.filePath) return false
    await writeFile(r.filePath, JSON.stringify(file), 'utf8')
    return true
  })
  h(CH.SessionSharePage, async (_e, sessionId: string, tools: boolean) => {
    const file = await exportSession(s.repo, join(s.userData, 'attachments'), String(sessionId))
    const safe = file.session.title.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'conversation'
    const r = await dialog.showSaveDialog(s.win()!, { title: 'Save the conversation as a page anyone can read', defaultPath: `${safe}.html`, filters: [{ name: 'Web page', extensions: ['html'] }] })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, sessionPage(file, { tools: tools !== false }), 'utf8')
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  h(CH.SessionImport, async () => {
    const ws = s.requireWorkspace()
    const r = await dialog.showOpenDialog(s.win()!, { title: 'Open a session file', properties: ['openFile'], filters: [{ name: 'Prism session, or a shared conversation page', extensions: ['prism-session', 'json', 'html'] }] })
    const p = r.filePaths[0]
    if (r.canceled || !p) return null
    let file: SessionFile
    try {
      const text = await readFile(p, 'utf8')
      // a page someone shared carries the session inside it
      const fromPage = text.trimStart().startsWith('<') ? sessionFromPage(text) : null
      if (text.trimStart().startsWith('<') && !fromPage) throw new Error('page')
      file = fromPage ?? (JSON.parse(text) as SessionFile)
    } catch {
      throw new Error('That file could not be read as a session.')
    }
    const out = await importSession(s.repo, ws, join(s.userData, 'attachments'), file, (m) => s.usable(m))
    s.send(CH.SessionChanged, s.agent.listSessions())
    return out
  })

  // ---------------------------------------------------------------- catch-up
  h(CH.CatchUpSince, (_e, ts: number) => catchUp(s.repo, s.requireWorkspace(), Number(ts) || 0, (id) => s.agent.status(id), s.automations.state().runs))

  // ---------------------------------------------------------------- the same edit elsewhere
  h(CH.NextEditSuggest, (_e, path: string, before: string, after: string) => (s.workspace ? sameEditElsewhere(s.workspace, String(path), String(before), String(after), s.roleModel('fast')).catch(() => null) : null))

  // ---------------------------------------------------------------- impact
  h(CH.ImpactFiles, (_e, files: ReviewFile[]) => analyseImpact(s.requireWorkspace(), Array.isArray(files) ? files.slice(0, 200) : []))
  h(CH.ImpactSession, async (_e, sessionId: string) => {
    await s.agent.history.settled(sessionId)
    return analyseImpact(s.agent.workspaceFor(sessionId), await latestChanges(s, sessionId))
  })

  // ---------------------------------------------------------------- file history
  h(CH.HistoryTimeline, async (_e, sessionId: string) => {
    await s.agent.history.settled(sessionId)
    return history.timeline(s.repo, sessionId)
  })
  h(CH.HistoryVersion, (_e, id: number) => s.repo.getFileVersion(Number(id)))
  h(CH.HistoryState, (_e, sessionId: string, index: number, path?: string) => history.stateAt(s.repo, sessionId, Number(index), typeof path === 'string' ? path : undefined))
  h(CH.ConversationsSearch, (_e, q: ConvQuery) => (s.workspace ? searchConversations(s.repo, s.workspace.root, { ...EMPTY_QUERY, ...q }) : { hits: [], more: false }))
  h(CH.VoiceTranscribe, async (_e, endpointId: string, model: string, audio: Uint8Array, mime: string, language: string) => {
    const ep = s.repo.getEndpoint(String(endpointId))
    if (!ep) throw new Error('That provider is gone: pick another in Settings, Conversation, Voice input.')
    return transcribeWithProvider(ep, s.vault.get(ep.id), String(model), new Uint8Array(audio), String(mime), String(language ?? ''))
  })
  h(CH.VoiceDictate, () => startWindowsDictation())
  // The better voice can fail for a dozen ordinary reasons — a moved folder, a Python
  // that will not start. On a call, silence is the worst possible answer to that, so it
  // drops back to the computer's own voice and says what went wrong rather than
  // pretending nothing did.
  h(CH.VoiceSpeak, async (_e, text: string) => {
    const sp = s.settings.get().speech
    const words = String(text)
    if (sp.engine === 'kokoro') {
      try {
        return { wav: await kokoroToWav(words, { path: sp.kokoroPath, voice: sp.kokoroVoice }), trouble: null }
      } catch (e) {
        return { wav: await speakToWav(words, sp.windowsVoice, 1), trouble: (e as Error).message }
      }
    }
    return { wav: await speakToWav(words, sp.windowsVoice, 1), trouble: null }
  })
  h(CH.VoiceVoices, () => installedVoices())
  h(CH.VoiceInCall, (_e, sessionId: string, on: boolean, face: boolean) => setCall(String(sessionId), !!on, !!face))
  h(CH.VoiceKokoro, async (_e, path: string) => {
    const found = checkKokoro(String(path ?? ''))
    if (!found.ok) return { ok: false, why: found.why, path: whereKokoro(String(path ?? '')), voices: [] }
    return { ok: true, why: '', path: found.path, voices: await kokoroVoices(String(path ?? '')) }
  })
  h(CH.VoiceKept, () => keptModels(s.userData))
  h(CH.VoiceForget, (_e, repo: string) => forgetModel(s.userData, String(repo)))

  // The phone has no speech model and no business running one. It sends the
  // recording here and a window of the app on this computer, which already has
  // the model, turns it into words and hands them back.
  h(
    CH.VoiceOnComputer,
    (_e, audio: Uint8Array, mime: string, model: string, language: string) =>
      new Promise<string>((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          speechJobs.delete(id)
          reject(new Error('The computer did not answer. Prism has to be open on it for the voice button to work from here.'))
          // on a call this wait is the whole conversation stopping: fail while it can still be said out loud
        }, 45_000)
        speechJobs.set(id, { resolve, reject, timer })
        s.send(CH.VoiceDoLocal, { id, audio, mime, model, language })
      })
  )
  h(CH.VoiceLocalDone, (_e, id: string, text: string | null, error: string | null) => {
    const job = speechJobs.get(id)
    if (!job) return
    speechJobs.delete(id)
    clearTimeout(job.timer)
    if (error) job.reject(new Error(error))
    else job.resolve(text ?? '')
  })
  h(CH.HistoryLines, (_e, path: string, content: string) => (s.workspace ? history.agentLines(s.repo, s.workspace.root, String(path), String(content)) : []))
  h(CH.AgentJudgeWays, (_e, request: string, ways: Array<{ sessionId: string; label: string }>) => judgeWays(s, String(request), (Array.isArray(ways) ? ways : []).slice(0, 6).map((w) => ({ sessionId: String(w.sessionId), label: String(w.label) }))))
  h(CH.RemoteInfo, () => host.shared.remote.info())
  h(CH.RemotePair, () => host.shared.remote.startPairing())
  h(CH.RemoteForget, (_e, pub: string) => host.shared.remote.forget(String(pub)))
  h(CH.HostProjects, () => {
    const open = host.workbenches().filter((b) => b.workspace)
    const roots = new Set(open.map((b) => b.workspace!.root))
    return [
      ...open.map((b) => ({ root: b.workspace!.root, name: b.workspace!.name, open: true })),
      ...s.settings.get().recentWorkspaces.filter((p) => !roots.has(p)).map((p) => ({ root: p, name: basename(p.replace(/[\\/]+$/, '')), open: false }))
    ]
  })
  h(CH.AssetGet, async (_e, url: string) => {
    // what a window loads through prism://, read here for a client that cannot (the phone app)
    const u = new URL(String(url))
    if (u.protocol !== 'prism:') return null
    const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    const wb = u.hostname.startsWith('wb-') ? host.byId(u.hostname.slice(3)) : u.hostname === 'workspace' ? asClient.getStore()!.wb : null
    let data: Buffer | null = null
    if (wb?.workspace) data = await wb.workspace.readRaw(rel).catch(() => null)
    else if (u.hostname === 'attach') {
      const p = s.attachmentPath(rel)
      data = p ? await readFile(p) : null
    } else if (u.hostname === 'theme') {
      const p = s.themeFile(rel)
      data = p ? await readFile(p) : null
    }
    if (!data || data.length > 40 * 1024 * 1024) return null
    const ext = extname(rel).toLowerCase()
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.html': 'text/html' } as Record<string, string>)[ext] ?? 'application/octet-stream'
    return { mime, data: new Uint8Array(data) }
  })
  h(CH.PhoneInfo, () => s.phone.info())
  h(CH.PhoneForget, () => s.phone.forget())
  const GH = 'github-token'
  h(CH.PrsList, async () => {
    const ws = s.requireWorkspace()
    const repo = await githubRepo(ws.root)
    const token = s.vault.get(GH)
    let login: string | null = null
    if (token) login = await whoAmI(token).catch(() => null)
    if (!repo) return { repo, pulls: [], login, error: null }
    try {
      return { repo, pulls: await listPulls(repo, token), login, error: null }
    } catch (e) {
      return { repo, pulls: [], login, error: e instanceof Error ? e.message : String(e) }
    }
  })
  h(CH.PrsReview, async (_e, number: number | null, focus: 'general' | 'security') => {
    const ws = s.requireWorkspace()
    const rules = await reviewRules(ws)
    const f = focus === 'security' ? 'security' : 'general'
    if (typeof number === 'number') {
      const repo = await githubRepo(ws.root)
      if (!repo) throw new Error('This project is not on GitHub.')
      const token = s.vault.get(GH)
      const pull = (await listPulls(repo, token)).find((p) => p.number === number)
      const diff = await pullDiff(repo, number, token)
      const r = await reviewDiff(s, diff, `#${number} ${pull?.title ?? ''}`, f, rules)
      return { ...r, title: `#${number} ${pull?.title ?? ''}`, headSha: pull?.headSha ?? null }
    }
    const b = await branchDiff(ws.root)
    if (!b.diff.trim()) throw new Error(`${b.branch} has nothing that ${b.base} does not.`)
    const r = await reviewDiff(s, b.diff, `${b.branch} against ${b.base}`, f, rules)
    return { ...r, title: `${b.branch} against ${b.base}`, headSha: null }
  })
  h(CH.PrsPost, async (_e, number: number, finding: ReviewFinding, headSha: string) => {
    const ws = s.requireWorkspace()
    const repo = await githubRepo(ws.root)
    const token = s.vault.get(GH)
    if (!repo) throw new Error('This project is not on GitHub.')
    if (!token) throw new Error('Add a GitHub token first (at the top of this panel).')
    const body = `**${finding.title}** (${finding.severity})\n\n${finding.detail}${finding.fix ? `\n\n**Fix:** ${finding.fix}` : ''}\n\n<sub>Found by Prism's review.</sub>`
    return postFinding(repo, Number(number), token, { file: finding.file, line: finding.line, body }, String(headSha))
  })
  h(CH.PrsDismiss, (_e, finding: ReviewFinding, reason: string) => addReviewRule(s.requireWorkspace(), `${finding.title}: ${finding.detail}${finding.file ? ` (${finding.file})` : ''}`, String(reason ?? '')))
  h(CH.PrsToken, async (_e, token: string) => {
    const t = String(token ?? '').trim()
    if (!t) {
      s.vault.delete(GH)
      return null
    }
    const login = await whoAmI(t)
    s.vault.set(GH, t)
    return login
  })
  h(CH.GitSplitPlan, () => planSplit(s, s.requireWorkspace().root))
  h(CH.GitSplitApply, async (_e, commits: SplitCommit[]) => {
    const r = await applySplit(s.requireWorkspace(), (Array.isArray(commits) ? commits : []).map((c) => ({ message: String(c.message ?? '').trim() || 'Changes', why: '', pieces: Array.isArray(c.pieces) ? c.pieces.map(String) : [] })).filter((c) => c.pieces.length))
    return r
  })
  h(CH.HistoryWhy, (_e, path: string, line: string) => (s.workspace ? history.lineOrigin(s.repo, s.workspace.root, String(path), String(line)) : null))
  h(CH.HistoryUndoRequest, (_e, sessionId: string, turnItemId: string) => history.undoRequestPlan(s.repo, s.agent.workspaceFor(sessionId), sessionId, String(turnItemId)))
  h(CH.HistoryRestore, async (_e, sessionId: string, index: number) => {
    if (s.agent.status(sessionId) !== 'idle') throw new Error('Wait for the agent to finish first.')
    const ws = s.agent.workspaceFor(sessionId)
    const want = history.stateAt(s.repo, sessionId, Number(index))
    const now: Array<{ path: string; content: Buffer | null }> = []
    for (const f of want) now.push({ path: f.path, content: await ws.readRaw(f.path).catch(() => null) })
    // what is there now is kept as a checkpoint, so going back can itself be undone
    const cp = s.repo.createCheckpoint(sessionId, `Before going back to step ${Number(index) + 1}`, now, null)
    const written: string[] = []
    for (const f of want) {
      const cur = now.find((n) => n.path === f.path)?.content ?? null
      if ((cur?.toString('utf8') ?? null) === f.content) continue
      if (f.content === null) await ws.delete(f.path).catch(() => {})
      else await ws.write(f.path, f.content)
      written.push(f.path)
    }
    s.send(CH.AgentEventPrefix + sessionId, { type: 'checkpoint', id: cp.id, files: cp.files })
    return written
  })

  // ---------------------------------------------------------------- skills and the user's own tools
  type Kind = 'skill' | 'tool'
  type Scope = 'project' | 'personal'
  const personalDir = (kind: Kind): string => (kind === 'skill' ? s.skillsDir() : s.customTools.personalFolder)
  const projectDir = (kind: Kind): string => (kind === 'skill' ? '.prism/skills' : '.prism/tools')
  /** Only files directly inside the skills and tools folders can be reached through these calls. */
  const extendFile = (kind: Kind, path: string, scope: Scope): { project: string | null; personal: string | null } => {
    const name = basename(String(path).replace(/\\/g, '/'))
    if (!name || name.startsWith('.')) throw new Error('That is not a skill or tool file.')
    return scope === 'project' ? { project: `${projectDir(kind)}/${name}`, personal: null } : { project: null, personal: join(personalDir(kind), name) }
  }
  h(CH.ExtendList, async () => {
    const skills = (await s.skills()).map(({ body: _body, ...info }) => info)
    // names Prism already uses: a tool of the user's with one of these is not offered
    const reserved = new Set(buildTools({ shell: { shell: () => s.settings.get().terminal.shell }, readOnly: false, allowSpawn: true, mcp: s.liveMcp(), gadgets: s.gadgets, browser: s.preview, scratch: s.scratch, theme: settingsThemeHost(s.settings), skills: { all: () => [], use: () => {} }, plan: true }).keys())
    return { skills, tools: await s.customTools.list(reserved) }
  })
  h(CH.ExtendCreate, async (_e, kind: Kind, rawName: string, scope: Scope) => {
    const name = String(rawName).trim().toLowerCase().replace(/[^a-z0-9]+/g, kind === 'skill' ? '-' : '_').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40)
    if (name.length < 2 || !/^[a-z]/.test(name)) throw new Error('Give it a name that starts with a letter, at least two characters long.')
    const file = `${name}.${kind === 'skill' ? 'md' : 'ts'}`
    const content = kind === 'skill' ? SKILL_TEMPLATE(name) : TOOL_TEMPLATE(name)
    if (scope === 'project') {
      const ws = s.requireWorkspace()
      const path = `${projectDir(kind)}/${file}`
      if (await ws.exists(path)) throw new Error(`${path} already exists.`)
      await ws.write(path, content)
      // the declarations beside the tools give completions in any editor
      if (kind === 'tool') {
        await ws.write(`${projectDir(kind)}/prism-tools.d.ts`, TOOL_TYPES)
        await s.customTools.allow(path, 'project')
      }
      return path
    }
    const dir = personalDir(kind)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file)
    if (existsSync(path)) throw new Error(`You already have a ${kind} called ${name}.`)
    await writeFile(path, content, 'utf8')
    if (kind === 'tool') {
      await writeFile(join(dir, 'prism-tools.d.ts'), TOOL_TYPES, 'utf8')
      await s.customTools.allow(path, 'personal')
    }
    return path
  })
  h(CH.ExtendRead, async (_e, kind: Kind, path: string, scope: Scope) => {
    const f = extendFile(kind, path, scope)
    return f.project ? (await s.requireWorkspace().read(f.project)).content : readFile(f.personal!, 'utf8')
  })
  h(CH.ExtendWrite, async (_e, kind: Kind, path: string, scope: Scope, content: string) => {
    const f = extendFile(kind, path, scope)
    if (f.project) await s.requireWorkspace().write(f.project, String(content))
    else await writeFile(f.personal!, String(content), 'utf8')
    // saved by the user from the settings page: that is their OK for this version
    if (kind === 'tool') await s.customTools.allow(f.project ?? f.personal!, scope)
    s.send(CH.ExtendChanged, null)
  })
  h(CH.ExtendRepair, (_e, path: string, scope: Scope, error: string) => {
    const f = extendFile('tool', path, scope)
    const file = f.project ?? f.personal!
    return s.agent.repair({ kind: 'tool', name: basename(file).replace(/\.[^.]+$/, ''), file, scope }, String(error), true)
  })
  h(CH.ExtendAllow, async (_e, path: string, scope: Scope) => {
    const f = extendFile('tool', path, scope)
    await s.customTools.allow(f.project ?? f.personal!, scope)
    s.send(CH.ExtendChanged, null)
  })
  h(CH.ExtendRemove, async (_e, kind: Kind, path: string, scope: Scope) => {
    const f = extendFile(kind, path, scope)
    if (f.project) await s.requireWorkspace().delete(f.project)
    else await unlink(f.personal!)
    if (kind === 'tool') s.customTools.forget(f.project ?? f.personal!, scope)
    s.send(CH.ExtendChanged, null)
  })
  h(CH.ExtendOpenFolder, async (_e, kind: Kind) => {
    const dir = personalDir(kind)
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  h(CH.ExtendToolchain, async () => {
    const has = (exe: string): Promise<boolean> => new Promise((resolve) => execFile(process.platform === 'win32' ? 'where.exe' : 'which', [exe], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err)))
    const [npx, uvx, docker] = await Promise.all([has('npx'), has('uvx'), has('docker')])
    return { npx, uvx, docker }
  })

  // ---------------------------------------------------------------- attachments
  const attachDir = join(host.shared.userData, 'attachments')
  const storeAttachment = async (name: string, mime: string, buf: Buffer): Promise<Attachment> => {
    const id = randomUUID()
    const ext = extname(name) || (mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '')
    const file = `${id}${ext}`
    await writeFile(join(attachDir, file), buf)
    return { id, name, mime, path: join(attachDir, file), size: buf.length }
  }
  h(CH.ClaudeConversations, () => listClaudeConversations())
  h(CH.ClaudeBringIn, async (_e, file: string) => {
    const ws = s.requireWorkspace()
    if (placeOf(ws.root).kind !== 'local') throw new Error('Claude Code runs on this computer, so its conversations can only be carried on in a folder here.')
    const c = (await listClaudeConversations()).find((x) => x.file === String(file))
    if (!c) throw new Error('That conversation is no longer there.')
    const got = await readClaudeConversation(c, ws.root, s.claude.models().map((m) => m.modelId), (mime, buf) => storeAttachment('picture', mime, buf))
    if (!got.items.length) throw new Error('That conversation has nothing in it to bring in.')
    await placeForResume(c, ws.root)
    const session = s.repo.createSession(ws.root, got.title || 'From Claude Code', got.model, got.mode)
    s.repo.appendItems(session.id, got.items)
    s.repo.setSessionExtras(session.id, { claude: got.claude })
    s.send(CH.SessionChanged, s.agent.listSessions())
    return { sessionId: session.id, items: got.items.length }
  })
  h(CH.AttachPick, async () => {
    const r = await dialog.showOpenDialog(s.win()!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    const out: Attachment[] = []
    for (const p of r.filePaths.slice(0, 8)) {
      const mime = MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'
      const buf = await readFile(p)
      const a = await storeAttachment(p.split(/[\\/]/).pop() ?? 'image', mime, buf)
      void copyFile
      out.push(a)
    }
    return out
  })
  // ---------------------------------------------------------------- project dashboard
  h(CH.DashboardOverview, () => dashboard.projectOverview(s.requireWorkspace().root))
  h(CH.DashboardOutdated, () => dashboard.outdated(s.requireWorkspace().root))
  h(CH.DashboardSpend, (_e, days: number) => s.repo.spendByDay(s.requireWorkspace().root, Math.max(1, Math.min(90, days || 14))))
  h(CH.DashboardNotes, (_e, names: string[]) => dashboard.releaseNotes(Array.isArray(names) ? names.map(String) : []))

  // ---------------------------------------------------------------- scratchpad
  h(CH.ScratchRun, (_e, cell: string, lang: ScratchLang, code: string) =>
    s.scratch.run('notebook', s.requireWorkspace().root, cell, lang, code, (output) => s.send(CH.ScratchEvent, { cell, type: 'output', output })).then((r) => {
      s.send(CH.ScratchEvent, { cell, type: 'done', ok: r.ok, ms: r.ms })
      return r
    })
  )
  h(CH.ScratchStop, () => s.scratch.stop('notebook'))
  h(CH.ScratchStatus, () => s.scratch.status(s.workspace?.root ?? null))

  // ---------------------------------------------------------------- browser preview
  h(CH.PreviewAttach, (_e, id: number) => s.preview.attach(id))
  h(CH.PreviewDetach, (_e, id: number) => s.preview.detach(id))
  h(CH.PreviewServe, () => s.preview.serve())
  h(CH.PreviewBase, () => s.preview.base())
  h(CH.PreviewResolve, (_e, target: string) => s.preview.resolve(target))
  h(CH.PreviewScripts, () => s.preview.scripts())
  h(CH.PreviewAudit, () => s.preview.audit(undefined, true))
  h(CH.PreviewFollow, (_e, on: boolean) => s.preview.setFollow(on !== false))
  h(CH.PreviewHighlight, (_e, selectors: string[]) => s.preview.highlight(Array.isArray(selectors) ? selectors.map(String) : []))

  // ---------------------------------------------------------------- refactors
  // what the last apply changed, so it can be put back in one go
  let lastRefactor: { files: Array<{ path: string; content: string | null }>; move?: { from: string; to: string } } | null = null
  h(CH.RefactorRename, (_e, path: string, line: number, column: number, word: string, newName: string) => refactor.renameSymbol(s.requireWorkspace().root, path, line, column, word, newName))
  h(CH.RefactorReferences, (_e, path: string, line: number, column: number, word: string) => refactor.findReferences(s.requireWorkspace().root, path, line, column, word))
  h(CH.RefactorMove, (_e, from: string, to: string) => refactor.moveFile(s.requireWorkspace().root, from, to))
  h(CH.RefactorApply, async (_e, files: ReviewDecision['files'], then?: { from: string; to: string }) => {
    const ws = s.requireWorkspace()
    const undo: Array<{ path: string; content: string | null }> = []
    for (const f of files) {
      let before: string | null = null
      try {
        before = (await ws.read(f.path)).content
      } catch {
        before = null
      }
      undo.push({ path: f.path, content: before })
      if (f.content === null) await ws.delete(f.path)
      else await ws.write(f.path, f.content)
    }
    if (then) await ws.rename(then.from, then.to)
    lastRefactor = { files: undo, ...(then ? { move: then } : {}) }
    return { written: files.map((f) => f.path) }
  })
  h(CH.RefactorUndo, async () => {
    const last = lastRefactor
    if (!last) return null
    lastRefactor = null
    const ws = s.requireWorkspace()
    if (last.move) {
      await ws.rename(last.move.to, last.move.from)
      // rmdir only succeeds on an empty folder
      if (placeOf(ws.root).kind !== 'ssh') await rmdir(dirname(ws.abs(last.move.to))).catch(() => {})
    }
    for (const f of last.files) {
      if (f.content === null) await ws.delete(f.path).catch(() => {})
      else await ws.write(f.path, f.content)
    }
    return last.files.map((f) => f.path)
  })

  // ---------------------------------------------------------------- themes
  h(CH.ThemeExport, async (_e, theme: Theme) => {
    const safe = (theme.name || 'theme').replace(/[^\w -]+/g, '').trim() || 'theme'
    const r = await dialog.showSaveDialog(s.win()!, { title: 'Save theme', defaultPath: `${safe}.prism-theme.json`, filters: [{ name: 'Prism theme', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    const file: ThemeFile = { kind: THEME_FILE_KIND, version: 1, theme: { ...theme, builtin: undefined } }
    const pic = theme.look.picture ? s.themeFile(theme.look.picture) : null
    // the picture travels inside the file, so the theme works on another computer
    if (pic && theme.look.picture) file.picture = { name: theme.look.picture, base64: (await readFile(pic)).toString('base64') }
    await writeFile(r.filePath, JSON.stringify(file, null, 2), 'utf8')
    return true
  })
  h(CH.ThemeExportAll, async (_e, themes: Theme[]) => {
    if (!Array.isArray(themes) || !themes.length) return false
    const r = await dialog.showSaveDialog(s.win()!, { title: 'Save your themes as a pack', defaultPath: 'My themes.prism-themes.json', filters: [{ name: 'Prism theme pack', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    const pack: ThemePackFile = { kind: THEME_PACK_KIND, version: 1, themes: [] }
    for (const theme of themes) {
      const pic = theme.look.picture ? s.themeFile(theme.look.picture) : null
      pack.themes.push({ theme: { ...theme, builtin: undefined }, ...(pic && theme.look.picture ? { picture: { name: theme.look.picture, base64: (await readFile(pic)).toString('base64') } } : {}) })
    }
    await writeFile(r.filePath, JSON.stringify(pack, null, 2), 'utf8')
    return true
  })
  h(CH.ThemeImport, async () => {
    const r = await dialog.showOpenDialog(s.win()!, { title: 'Open a theme or a theme pack', properties: ['openFile'], filters: [{ name: 'Prism theme', extensions: ['json'] }] })
    const p = r.filePaths[0]
    if (r.canceled || !p) return null
    let file: Partial<ThemeFile> | Partial<ThemePackFile>
    try {
      file = JSON.parse(await readFile(p, 'utf8')) as Partial<ThemeFile> | Partial<ThemePackFile>
    } catch {
      throw new Error('That file could not be read as a theme.')
    }
    // a pack holds several themes, each stored the way a single theme file stores one
    const entries: ThemePackFile['themes'] =
      file.kind === THEME_PACK_KIND && Array.isArray((file as ThemePackFile).themes) ? (file as ThemePackFile).themes : file.kind === THEME_FILE_KIND && (file as ThemeFile).theme ? [{ theme: (file as ThemeFile).theme, picture: (file as ThemeFile).picture }] : []
    const out: Theme[] = []
    for (const entry of entries.slice(0, 200)) {
      const theme = entry?.theme
      if (!theme || typeof theme !== 'object') continue
      if (entry.picture?.base64 && theme.look) {
        const ext = extname(entry.picture.name || '').toLowerCase()
        const name = `${randomUUID()}${MIME[ext] ? ext : '.png'}`
        await writeFile(join(s.themesDir(), name), Buffer.from(entry.picture.base64, 'base64'))
        theme.look.picture = name
      } else if (theme.look) theme.look.picture = null
      out.push(theme)
    }
    if (!out.length) throw new Error('That file is not a Prism theme.')
    return out
  })
  h(CH.ThemePicture, async () => {
    const r = await dialog.showOpenDialog(s.win()!, { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
    const p = r.filePaths[0]
    if (r.canceled || !p) return null
    const name = `${randomUUID()}${extname(p).toLowerCase()}`
    await copyFile(p, join(s.themesDir(), name))
    return name
  })
  h(CH.ThemeFonts, () => installedFonts())

  h(CH.AttachFromData, (_e, name: string, mime: string, base64: string) => storeAttachment(name, mime, Buffer.from(base64, 'base64')))

  // ---------------------------------------------------------------- gadgets
  h(CH.GadgetList, () => s.gadgets.list())
  h(CH.GadgetStart, (_e, id: string) => s.gadgets.start(id))
  h(CH.GadgetStop, (_e, id: string) => s.gadgets.stop(id))
  h(CH.GadgetReload, (_e, id: string) => s.gadgets.reload(id))
  h(CH.GadgetRemove, (_e, id: string) => s.gadgets.remove(id))
  h(CH.GadgetTurnOn, (_e, id: string, on: boolean) => s.gadgets.turnOn(String(id), on !== false))
  h(CH.GadgetCall, (_e, id: string, method: string, args: Record<string, unknown>) => s.gadgets.call(id, method, args ?? {}))
  h(CH.GadgetWrite, (_e, id: string, files: Record<string, string>, scope: 'project' | 'global') => s.gadgets.write(id, files, scope))
  h(CH.GadgetRead, (_e, id: string) => s.gadgets.readFiles(id))
  h(CH.GadgetPage, (_e, id: string) => s.gadgets.page(id))
  h(CH.GadgetIdeaDecide, async (_e, idea: GadgetIdea, answer: 'build' | 'later' | 'never', sessionId: string | null) => {
    const ws = s.requireWorkspace()
    s.gadgetScout.decide(ws.root, idea.kind, answer)
    if (answer !== 'build') return
    // the agent builds it, told what it is for rather than how to write it
    const ask = [
      `Build the gadget we just talked about: "${idea.title}".`,
      idea.what ? `What it should show and do: ${idea.what}` : '',
      idea.why ? `Why it is worth having: ${idea.why}` : '',
      'Read gadget_sdk first, then write it with gadget_write and open it with gadget_open. Give it tools of its own where that helps me drive it, declare a widget block in gadget.json if it would suit a phone home screen, and check it with gadget_look before you say it is done.'
    ]
      .filter(Boolean)
      .join('\n\n')
    if (sessionId) await s.agent.send(sessionId, ask)
    else await s.agent.sendToCurrent(ask)
  })
  h(CH.GadgetIdeaRefused, () => (s.workspace ? s.gadgetScout.refused(s.workspace.root) : []))
  h(CH.GadgetIdeaAllow, (_e, kind: string) => {
    if (s.workspace) s.gadgetScout.allow(s.workspace.root, String(kind))
  })
  h(CH.GadgetLog, (_e, id: string) => s.gadgets.logOf(id))
  h(CH.GadgetOpenDir, async (_e, id: string) => {
    const dir = s.gadgets.dirOf(id)
    if (dir) await shell.openPath(dir)
  })

  // ---------------------------------------------------------------- usage
  h(CH.UsageSummary, () => s.repo.usageSummary())
  h(CH.ClaudePlanUsage, (_e, fresh: boolean) => s.claude.planUsage(s.workspace?.root ?? homedir(), fresh === true))

  h(CH.AutomationsGet, () => s.automations.state())
  h(CH.AutomationsSave, (_e, config: unknown) => s.automations.save(config))
  h(CH.AutomationsRun, (_e, id: string) => s.automations.runNow(String(id)))
  h(CH.JobsList, () => listJobs())
  h(CH.JobsKill, (_e, id: string) => killJob(String(id)))
  h(CH.ChecksList, () => (s.workspace ? listCheckers(s.workspace.root) : []))
  h(CH.ChecksRun, (_e, id: string) => runChecker(s.requireWorkspace().root, id))

  return {
    has: (channel) => handlers.has(channel) || oneWay.has(channel),
    invoke: (clientId, channel, args) => {
      const fn = handlers.get(channel)
      if (!fn) return Promise.reject(new Error(`Unknown request ${channel}`))
      return Promise.resolve(host.run(clientId, () => (fn as (e: unknown, ...a: unknown[]) => unknown)({ sender: { id: -1 } }, ...args)))
    },
    send: (clientId, channel, args) => {
      const fn = oneWay.get(channel)
      if (fn) host.run(clientId, () => (fn as (e: unknown, ...a: unknown[]) => unknown)({ sender: { id: -1 } }, ...args))
    }
  }
}

/** A budget from the window: positive numbers or nothing. */
function cleanBudget(b: unknown): { cost: number | null; minutes: number | null } | null {
  if (!b || typeof b !== 'object') return null
  const v = b as Record<string, unknown>
  const pos = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null)
  const cost = pos(v['cost'])
  const minutes = pos(v['minutes'])
  return cost === null && minutes === null ? null : { cost, minutes }
}
