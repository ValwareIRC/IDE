import { create } from 'zustand'
import { useGadgets } from './gadgets'
import { useBrowser } from './browser'

export type PanelKind = 'editor' | 'diff' | 'agent' | 'terminal' | 'preview' | 'settings' | 'welcome' | 'usage' | 'gadget' | 'problems' | 'review' | 'plan' | 'context' | 'compare' | 'automations' | 'history' | 'conflict' | 'refactor' | 'references' | 'browser' | 'scratch' | 'dashboard' | 'timeline' | 'impact' | 'spec' | 'tours' | 'catchup' | 'mission' | 'tasks' | 'multiverse' | 'work' | 'searchChats' | 'prs'

export interface Reveal {
  line: number
  column?: number
  /** Show the location without taking keyboard focus (agent-driven opens). */
  quiet?: boolean
}

export interface OpenPanelOptions {
  kind: PanelKind
  /** Stable id; editors use `editor:<path>`. */
  id?: string
  title?: string
  params?: Record<string, unknown>
  /** Where to place a brand-new panel. */
  area?: 'center' | 'right' | 'bottom'
  /** Put a brand-new panel to the right of this existing one instead. */
  beside?: string
  /** A look-only tab: the next look-only open takes its place. */
  preview?: boolean
  focus?: boolean
}

/** The dock implements this; everything else talks to the store. */
export interface DockController {
  open(opts: OpenPanelOptions): void
  close(id: string): void
  has(id: string): boolean
  focus(id: string): void
  setTitle(id: string, title: string): void
  resetLayout(): void
  /** Give the active panel the whole workbench, or put things back. */
  setMaximized(on: boolean): void
}

interface LayoutState {
  controller: DockController | null
  setController(c: DockController | null): void
  openEditor(path: string, reveal?: Reveal | null, opts?: { preview?: boolean }): void
  /** A second view of the same file, to the right. */
  openEditorBeside(path: string): void
  /** The rendered page next to its source (markdown, html). */
  openPreviewBeside(path: string): void
  openDiff(path: string, before: string, after: string, title?: string): void
  openPreview(path: string, note?: string, opts?: { quiet?: boolean }): void
  openAgent(): void
  /** A second agent panel pinned to one session, so several sessions can run side by side. */
  openAgentSession(sessionId: string, title?: string): void
  openTerminal(): void
  openProblems(): void
  /** The in-app browser; with an address (or a workspace file) it goes there. */
  openBrowser(url?: string | null, blank?: boolean): void
  /** The notebook for trying code against the project. */
  openScratch(): void
  /** The project's home page. */
  openDashboard(): void
  /** A rename or move worked out but not yet written. */
  openRefactor(id: string, title: string): void
  /** Step through a session and see the project as it was at each step. */
  openTimeline(sessionId: string): void
  /** What a set of changes could break. */
  openImpact(id: string): void
  /** The project's spec and how the code follows it. */
  openSpec(): void
  /** Guided walks through the code. */
  openTours(): void
  /** What happened while you were away. */
  openCatchUp(): void
  /** Every session at a glance. */
  openMission(): void
  openWork(): void
  openSearchChats(): void
  openPrs(): void
  /** Jobs the agent works through by itself. */
  openTasks(): void
  /** The latest request tried several ways at once. */
  openMultiverse(): void
  /** Everywhere a name is used. */
  openReferences(): void
  /** What the model is holding for the active session. */
  openContext(): void
  /** Several models answering the same question side by side. */
  openCompare(): void
  openAutomations(): void
  /** The commit graph; focus selects one commit. */
  openHistory(focus?: string): void
  /** Settle a file both sides changed. */
  openConflict(path: string): void
  /** A proposed change set (reviewId) or what the agent changed this turn (no reviewId). */
  openReview(sessionId: string, reviewId?: string, title?: string): void
  /** What a session's own copy of the project changed. */
  openCopyChanges(sessionId: string): void
  openPlan(sessionId: string, planId: string, title?: string): void
  openGadget(id: string, title?: string): void
  openSettings(section?: string): void
  openWelcome(): void
  openUsage(): void
  closePanel(id: string): void
  resetLayout(): void
}

export const useLayout = create<LayoutState>((set, get) => ({
  controller: null,
  setController: (controller) => set({ controller }),

  openEditor(path, reveal, opts) {
    get().controller?.open({
      kind: 'editor',
      id: `editor:${path}`,
      title: path.split('/').pop() ?? path,
      params: { path, reveal: reveal ?? null },
      area: 'center',
      preview: opts?.preview,
      focus: true
    })
  },
  openEditorBeside(path) {
    get().controller?.open({ kind: 'editor', id: `editor:${path}::${Date.now()}`, title: path.split('/').pop() ?? path, params: { path, reveal: null }, beside: `editor:${path}`, focus: true })
  },
  openPreviewBeside(path) {
    get().controller?.open({ kind: 'preview', id: `preview:${path}`, title: path.split('/').pop() ?? path, params: { path, note: '' }, beside: `editor:${path}`, focus: false })
  },
  openDiff(path, before, after, title) {
    get().controller?.open({ kind: 'diff', id: `diff:${path}:${Date.now()}`, title: title ?? `Δ ${path.split('/').pop()}`, params: { path, before, after }, area: 'center', focus: true })
  },
  openPreview(path, note, opts) {
    // Previews never take keyboard focus, so "quiet" opens can still be shown.
    void opts
    get().controller?.open({ kind: 'preview', id: `preview:${path}`, title: path.split('/').pop() ?? path, params: { path, note: note ?? '' }, area: 'center', focus: true })
  },
  openAgent: () => get().controller?.open({ kind: 'agent', id: 'agent', title: 'Agent', area: 'right', focus: true }),
  openAgentSession: (sessionId, title) =>
    get().controller?.open({ kind: 'agent', id: `agent:${sessionId}`, title: title ?? 'Agent', params: { sessionId }, area: 'right', focus: true }),
  openTerminal: () => get().controller?.open({ kind: 'terminal', id: 'terminal', title: 'Terminal', area: 'bottom', focus: true }),
  openHistory: (focus) => get().controller?.open({ kind: 'history', id: 'history', title: 'History', params: focus ? { focus, at: Date.now() } : {}, area: 'center', focus: true }),
  openConflict: (path) => get().controller?.open({ kind: 'conflict', id: `conflict:${path}`, title: `Settle: ${path.split('/').pop()}`, params: { path }, area: 'center', focus: true }),
  openAutomations: () => get().controller?.open({ kind: 'automations', id: 'automations', title: 'Automations', area: 'center', focus: true }),
  openCompare: () => get().controller?.open({ kind: 'compare', id: 'compare', title: 'Compare models', area: 'center', focus: true }),
  openContext: () => get().controller?.open({ kind: 'context', id: 'context', title: 'Context', area: 'center', focus: true }),
  openPlan: (sessionId, planId, title) =>
    get().controller?.open({ kind: 'plan', id: `plan:${planId}`, title: `Plan: ${(title ?? '').slice(0, 30)}`, params: { sessionId, planId }, area: 'center', focus: true }),
  openCopyChanges: (sessionId) => get().controller?.open({ kind: 'review', id: `review:copy:${sessionId}`, title: 'Changes in the copy', params: { sessionId, copy: true }, area: 'center', focus: true }),
  openReview: (sessionId, reviewId, title) =>
    get().controller?.open({
      kind: 'review',
      id: reviewId ? `review:${reviewId}` : `review:turn:${sessionId}`,
      title: reviewId ? `Review: ${(title ?? 'changes').slice(0, 28)}` : 'Changes this turn',
      params: { sessionId, ...(reviewId ? { reviewId } : {}) },
      area: 'center',
      focus: true
    }),
  openBrowser: (url, blank) => {
    if (url || blank) useBrowser.getState().ask(url ?? null, blank)
    get().controller?.open({ kind: 'browser', id: 'browser', title: 'Browser', area: 'center', focus: true })
  },
  openDashboard: () => get().controller?.open({ kind: 'dashboard', id: 'dashboard', title: 'Project', area: 'center', focus: true }),
  openScratch: () => get().controller?.open({ kind: 'scratch', id: 'scratch', title: 'Scratchpad', area: 'center', focus: true }),
  openCatchUp: () => get().controller?.open({ kind: 'catchup', id: 'catchup', title: 'While you were away', area: 'center', focus: true }),
  openTours: () => get().controller?.open({ kind: 'tours', id: 'tours', title: 'Tours', area: 'center', focus: true }),
  openMission: () => get().controller?.open({ kind: 'mission', id: 'mission', title: 'Mission control', area: 'center', focus: true }),
  openWork: () => get().controller?.open({ kind: 'work', id: 'work', title: 'Work', area: 'center', focus: true }),
  openPrs: () => get().controller?.open({ kind: 'prs', id: 'prs', title: 'Pull requests', area: 'center', focus: true }),
  openSearchChats: () => get().controller?.open({ kind: 'searchChats', id: 'searchChats', title: 'Search conversations', area: 'center', focus: true }),
  openTasks: () => get().controller?.open({ kind: 'tasks', id: 'tasks', title: 'Task board', area: 'center', focus: true }),
  openMultiverse: () => get().controller?.open({ kind: 'multiverse', id: 'multiverse', title: 'Tried several ways', area: 'center', focus: true }),
  openSpec: () => get().controller?.open({ kind: 'spec', id: 'spec', title: 'Spec', area: 'center', focus: true }),
  openImpact: (id) => get().controller?.open({ kind: 'impact', id: `impact:${id}`, title: 'What could break', params: { impactId: id }, area: 'center', focus: true }),
  openTimeline: (sessionId) => get().controller?.open({ kind: 'timeline', id: `timeline:${sessionId}`, title: 'Time machine', params: { sessionId }, area: 'center', focus: true }),
  openRefactor: (id, title) => get().controller?.open({ kind: 'refactor', id: `refactor:${id}`, title: title.length > 34 ? `${title.slice(0, 33)}…` : title, params: { refactorId: id }, area: 'center', focus: true }),
  openReferences: () => get().controller?.open({ kind: 'references', id: 'references', title: 'Uses', area: 'bottom', focus: true }),
  openProblems: () => get().controller?.open({ kind: 'problems', id: 'problems', title: 'Problems', area: 'bottom', beside: undefined, focus: true }),
  openGadget: (id, title) => get().controller?.open({ kind: 'gadget', id: `gadget:${id}`, title: title ?? useGadgets.getState().list.find((g) => g.id === id)?.name ?? id, params: { gadgetId: id }, area: 'center', focus: true }),
  openSettings: (section) => get().controller?.open({ kind: 'settings', id: 'settings', title: 'Settings', params: section ? { section, at: Date.now() } : {}, area: 'center', focus: true }),
  openWelcome: () => get().controller?.open({ kind: 'welcome', id: 'welcome', title: 'Welcome', area: 'center', focus: true }),
  openUsage: () => get().controller?.open({ kind: 'usage', id: 'usage', title: 'Usage', area: 'center', focus: true }),
  closePanel: (id) => get().controller?.close(id),
  resetLayout: () => get().controller?.resetLayout()
}))
