import { create } from 'zustand'
import type { AppInfo, Endpoint, ModelInfo, ModelRef, Settings } from '@shared/types'
import { prism } from '@/lib/ipc'
import { activeTheme, applyTheme } from '@/theme/apply'
import { bootMark, bootStep } from '@/lib/bootMark'

interface AppState {
  info: AppInfo | null
  settings: Settings | null
  workspace: string | null
  endpoints: Endpoint[]
  models: ModelInfo[]
  booted: boolean
  /** Why start-up could not finish, shown on the start screen instead of waiting for ever. */
  bootProblem: string | null
  boot(): Promise<void>
  refreshModels(): Promise<void>
  updateSettings(patch: Parameters<typeof prism.settings.update>[0]): Promise<void>
  openWorkspace(): Promise<void>
  setWorkspace(path: string): Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  info: null,
  settings: null,
  workspace: null,
  endpoints: [],
  models: [],
  booted: false,
  bootProblem: null,

  async boot() {
    bootMark('starting')
    // the phone asks over its own connection, which has its own limits (remote/connection.ts)
    const limit = window.__prismMobile ? 10 * 60_000 : 30_000
    let info: AppInfo, settings: Settings, workspace: string | null
    try {
      ;[info, settings, workspace] = await Promise.all([
        bootStep('what Prism this is', prism.app.info(), limit),
        bootStep('the settings', prism.settings.get(), limit),
        bootStep('the open project', prism.workspace.current(), limit)
      ])
    } catch (e) {
      set({ bootProblem: e instanceof Error ? e.message : String(e) })
      return
    }
    set({ info, settings, workspace })
    applyAppearance(settings)
    try {
      // the model list can wait on the network: without it Prism still starts, and fills it in later
      await bootStep('the list of models', get().refreshModels(), window.__prismMobile ? limit : 15_000, () => undefined)
    } catch (e) {
      console.error('[prism] model list failed', e)
    }
    prism.settings.onChanged((s) => {
      set({ settings: s })
      applyAppearance(s)
    })
    // Claude Code was asked what it offers: its models may have changed
    prism.claude.onChanged(() => void get().refreshModels().catch(() => {}))
    prism.workspace.onChanged((w) => set({ workspace: w }))
    set({ booted: true })
    bootMark('ready')
  },

  async refreshModels() {
    const [endpoints, models] = await Promise.all([prism.endpoints.list(), prism.models.list()])
    set({ endpoints, models })
  },

  async updateSettings(patch) {
    const s = await prism.settings.update(patch)
    set({ settings: s })
    applyAppearance(s)
  },

  async openWorkspace() {
    await flushEdits()
    const p = await prism.workspace.open()
    if (p) set({ workspace: p })
  },

  async setWorkspace(path) {
    await flushEdits()
    const p = await prism.workspace.set(path)
    set({ workspace: p })
  }
}))

/**
 * Writes out anything unsaved while this project is still the open one. It has to
 * happen before the switch: afterwards a path like `src/main.ts` means a file in
 * the *other* project, so saving then would put your work in the wrong place.
 * Imported here rather than at the top because the editor store reads this one.
 */
async function flushEdits(): Promise<void> {
  const { useEditor, isDirty } = await import('./editor')
  const unsaved = Object.values(useEditor.getState().docs).filter(isDirty).length
  if (!unsaved) return
  await useEditor.getState().saveAll()
  const { useUi } = await import('./ui')
  useUi.getState().toast('info', `Saved ${unsaved} file${unsaved === 1 ? '' : 's'} before switching project`)
}

function applyAppearance(s: Settings): void {
  const root = document.documentElement
  applyTheme(activeTheme(s), { glow: s.appearance.glow })
  root.dataset['accent'] = s.appearance.accent
  root.dataset['motion'] = s.appearance.motion ? 'on' : 'off'
  root.dataset['glow'] = s.appearance.glow ? 'on' : 'off'
  root.dataset['density'] = s.appearance.density
}

export function modelKey(ref: ModelRef | null | undefined): string {
  return ref ? `${ref.endpointId}::${ref.modelId}` : ''
}

export function refFromKey(key: string): ModelRef | null {
  const i = key.indexOf('::')
  if (i < 0) return null
  return { endpointId: key.slice(0, i), modelId: key.slice(i + 2) }
}

/** Sessions on this endpoint are run by Claude Code instead of Prism's own agent. */
export const CLAUDE_ENDPOINT = 'claude-agent'

export function isClaude(ref: { endpointId: string } | null | undefined): boolean {
  return ref?.endpointId === CLAUDE_ENDPOINT
}

/**
 * Whether a model's visible thinking is a summary. Claude never sends its raw reasoning,
 * only a summary written for display, so the screen calls it that; other providers send
 * their own reasoning text.
 */
export function thoughtIsSummary(ref: { endpointId: string; modelId?: string } | null | undefined): boolean {
  return isClaude(ref) || /claude/i.test(ref?.modelId ?? '')
}

/** A model's name in a list that already says which provider it belongs to. */
export function modelName(m: ModelInfo): string {
  return m.label ?? m.modelId
}

export function modelLabel(models: ModelInfo[], ref: ModelRef | null | undefined): string {
  if (!ref) return 'no model'
  const m = models.find((x) => x.endpointId === ref.endpointId && x.modelId === ref.modelId)
  if (isClaude(ref)) return `Claude · ${m?.label ?? ref.modelId}`
  return m ? m.modelId : ref.modelId
}
