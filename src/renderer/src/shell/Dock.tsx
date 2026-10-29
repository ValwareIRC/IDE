import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { prism } from '@/lib/ipc'
import { askAgentAbout } from '@/lib/monacoActions'
import {
  DockviewReact,
  type AddPanelPositionOptions,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps
} from 'dockview-react'
import { Maximize2, Minimize2, Pin, Sparkles, X } from 'lucide-react'
import { useLayout, type DockController, type OpenPanelOptions, type PanelKind } from '@/state/layout'
import { useEditor, isDirty } from '@/state/editor'
import { useSessions } from '@/state/sessions'
import { useApp } from '@/state/app'
import { describeTabs, noteGroupUsed, pickGroup } from './dockPlace'
import { useUi } from '@/state/ui'
import { useOutline } from '@/state/outline'
import { EditorPanel } from '@/panels/editor/EditorPanel'
import { disposeModel } from '@/lib/models'
import { DiffPanel } from '@/panels/editor/DiffPanel'
import { AgentPanel } from '@/panels/agent/AgentPanel'
import { TerminalPanel } from '@/panels/terminal/TerminalPanel'
import { PreviewPanel } from '@/panels/preview/PreviewPanel'
import { SettingsPanel } from '@/panels/settings/SettingsPanel'
import { UsagePanel } from '@/panels/settings/UsagePanel'
import { WelcomePanel } from '@/panels/welcome/WelcomePanel'
import { GadgetPanel } from '@/panels/gadget/GadgetPanel'
import { ProblemsPanel } from '@/panels/problems/ProblemsPanel'
import { ReviewPanel } from '@/panels/review/ReviewPanel'
import { CopyChanges } from '@/panels/review/CopyChanges'
import { PlanPanel } from '@/panels/plan/PlanPanel'
import { ContextPanel } from '@/panels/context/ContextPanel'
import { ComparePanel } from '@/panels/compare/ComparePanel'
import { AutomationsPanel } from '@/panels/automations/AutomationsPanel'
import { HistoryPanel } from '@/panels/git/HistoryPanel'
import { ConflictPanel } from '@/panels/git/ConflictPanel'
import { RefactorPanel } from '@/panels/refactor/RefactorPanel'
import { BrowserPanel } from '@/panels/browser/BrowserPanel'
import { ScratchPanel } from '@/panels/scratch/ScratchPanel'
import { DashboardPanel } from '@/panels/dashboard/DashboardPanel'
import { ReferencesPanel } from '@/panels/refactor/ReferencesPanel'
import { TimelinePanel } from '@/panels/timeline/TimelinePanel'
import { ImpactPanel } from '@/panels/impact/ImpactPanel'
import { SpecPanel } from '@/panels/spec/SpecPanel'
import { ToursPanel } from '@/panels/tour/Tour'
import { CatchUpPanel } from '@/panels/catchup/CatchUp'
import { MissionPanel } from '@/panels/mission/Mission'
import { WorkPane } from '@/panels/agent/Turns'
import { ConversationSearch } from '@/panels/search/ConversationSearch'
import { PullRequestsPanel } from '@/panels/prs/PullRequests'
import { TasksPanel } from '@/panels/tasks/Tasks'
import { MultiversePanel } from '@/panels/multiverse/Multiverse'
import { FileIcon } from '@/components/FileIcon'
import { cx } from '@/lib/format'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { copyText } from '@/lib/copy'
import { Footprints, GitPullRequest, TextSearch, Gauge, ListTodo, Split, BookCheck, Clock3, Coffee, Compass, Radar, LayoutDashboard, FlaskConical, Globe, LocateFixed, Replace, Box, CircleAlert, Columns3, GitCompare, GitMerge, History as HistoryIcon, Layers, Workflow, ListChecks, Map as MapIcon, Puzzle, Settings, Sparkle, TerminalSquare, BarChart3 } from 'lucide-react'

const THEME: DockviewTheme = { name: 'prism', className: 'dockview-theme-prism', colorScheme: 'dark', gap: 6 }
/** Each project keeps its own arrangement of tabs, so switching back brings your work back. */
function layoutKey(workspace: string | null): string {
  return `prism.layout.v2:${workspace ?? ''}`
}

/** The one layout kept before they were per project; it becomes the first project's. */
const LEGACY_LAYOUT_KEY = 'prism.layout.v2'

export type Params = {
  kind: PanelKind
  path?: string
  reveal?: { line: number; column?: number; quiet?: boolean } | null
  before?: string
  after?: string
  note?: string
  section?: string
  /** Changes on every "open settings at…" request, so asking for the same page twice still switches to it. */
  at?: number
  sessionId?: string
  gadgetId?: string
  reviewId?: string
  refactorId?: string
  impactId?: string
  /** Review panel: show what the session's own copy changed. */
  copy?: boolean
  planId?: string
  /** History: the commit to select. */
  focus?: string
  /** Look-only tab (italic): replaced by the next file you look at, kept once you edit or double-click it. */
  preview?: boolean
  /** Pinned tabs sit first and are skipped by "close others / all". */
  pinned?: boolean
}

// ---------------------------------------------------------------- panel hosts

function EditorHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Editor">
      <EditorPanel path={p.params.path ?? ''} reveal={p.params.reveal ?? null} />
    </ErrorBoundary>
  )
}
function DiffHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Diff">
      <DiffPanel path={p.params.path ?? ''} before={p.params.before ?? ''} after={p.params.after ?? ''} />
    </ErrorBoundary>
  )
}
function AgentHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Agent">
      <AgentPanel sessionId={p.params.sessionId} />
    </ErrorBoundary>
  )
}
function TerminalHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Terminal">
      <TerminalPanel />
    </ErrorBoundary>
  )
}
function PreviewHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Preview">
      <PreviewPanel path={p.params.path ?? ''} note={p.params.note} />
    </ErrorBoundary>
  )
}
function SettingsHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Settings">
      <SettingsPanel section={p.params.section} at={p.params.at} />
    </ErrorBoundary>
  )
}
function WelcomeHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Welcome">
      <WelcomePanel />
    </ErrorBoundary>
  )
}
function UsageHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Usage">
      <UsagePanel />
    </ErrorBoundary>
  )
}
function HistoryHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="History">
      <HistoryPanel focus={p.params.focus} />
    </ErrorBoundary>
  )
}
function ConflictHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Conflict">
      <ConflictPanel path={p.params.path ?? ''} />
    </ErrorBoundary>
  )
}
function AutomationsHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Automations">
      <AutomationsPanel />
    </ErrorBoundary>
  )
}
function CompareHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Compare">
      <ComparePanel />
    </ErrorBoundary>
  )
}
function ContextHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Context">
      <ContextPanel />
    </ErrorBoundary>
  )
}
function PlanHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Plan">
      <PlanPanel sessionId={p.params.sessionId ?? ''} planId={p.params.planId ?? ''} />
    </ErrorBoundary>
  )
}
function ReviewHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Review">
      {p.params.copy ? <CopyChanges sessionId={p.params.sessionId ?? ''} /> : <ReviewPanel sessionId={p.params.sessionId ?? ''} reviewId={p.params.reviewId} />}
    </ErrorBoundary>
  )
}
function DashboardHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Project">
      <DashboardPanel />
    </ErrorBoundary>
  )
}
function ScratchHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Scratchpad">
      <ScratchPanel />
    </ErrorBoundary>
  )
}
function BrowserHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Browser">
      <BrowserPanel />
    </ErrorBoundary>
  )
}
function RefactorHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Change set">
      <RefactorPanel id={p.params.refactorId ?? ''} />
    </ErrorBoundary>
  )
}
function MissionHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Mission control">
      <MissionPanel />
    </ErrorBoundary>
  )
}
function PrsHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Pull requests">
      <PullRequestsPanel />
    </ErrorBoundary>
  )
}
function SearchChatsHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Search conversations">
      <ConversationSearch />
    </ErrorBoundary>
  )
}
function WorkHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Work">
      <WorkPane />
    </ErrorBoundary>
  )
}
function TasksHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Task board">
      <TasksPanel />
    </ErrorBoundary>
  )
}
function MultiverseHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Tried several ways">
      <MultiversePanel />
    </ErrorBoundary>
  )
}
function CatchUpHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="While you were away">
      <CatchUpPanel />
    </ErrorBoundary>
  )
}
function ToursHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Tours">
      <ToursPanel />
    </ErrorBoundary>
  )
}
function SpecHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Spec">
      <SpecPanel />
    </ErrorBoundary>
  )
}
function ImpactHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="What could break">
      <ImpactPanel id={p.params.impactId ?? ''} />
    </ErrorBoundary>
  )
}
function TimelineHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Time machine">
      <TimelinePanel sessionId={p.params.sessionId ?? ''} />
    </ErrorBoundary>
  )
}
function ReferencesHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Uses">
      <ReferencesPanel />
    </ErrorBoundary>
  )
}
function ProblemsHost(): React.JSX.Element {
  return (
    <ErrorBoundary label="Problems">
      <ProblemsPanel />
    </ErrorBoundary>
  )
}
function GadgetHost(p: IDockviewPanelProps<Params>): React.JSX.Element {
  return (
    <ErrorBoundary label="Gadget">
      <GadgetPanel id={p.params.gadgetId ?? ''} />
    </ErrorBoundary>
  )
}

export const COMPONENTS = {
  editor: EditorHost,
  diff: DiffHost,
  agent: AgentHost,
  terminal: TerminalHost,
  preview: PreviewHost,
  settings: SettingsHost,
  welcome: WelcomeHost,
  usage: UsageHost,
  gadget: GadgetHost,
  problems: ProblemsHost,
  review: ReviewHost,
  plan: PlanHost,
  context: ContextHost,
  compare: CompareHost,
  automations: AutomationsHost,
  history: HistoryHost,
  conflict: ConflictHost,
  refactor: RefactorHost,
  references: ReferencesHost,
  browser: BrowserHost,
  scratch: ScratchHost,
  dashboard: DashboardHost,
  timeline: TimelineHost,
  impact: ImpactHost,
  spec: SpecHost,
  tours: ToursHost,
  catchup: CatchUpHost,
  mission: MissionHost,
  tasks: TasksHost,
  multiverse: MultiverseHost,
  work: WorkHost,
  searchChats: SearchChatsHost,
  prs: PrsHost
}

// ---------------------------------------------------------------- tab

function Tab(p: IDockviewPanelHeaderProps<Params>): React.JSX.Element {
  const kind = p.params.kind
  const path = p.params.path
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const tabMenu = (): MenuEntry[] => {
    const api = p.containerApi
    const me = api.getPanel(p.api.id)
    const group = p.api.group
    const siblings = group.panels
    const idx = siblings.findIndex((x) => x.id === p.api.id)
    const out: MenuEntry[] = [
      { label: 'Close', hint: 'Ctrl+W', onClick: () => p.api.close() },
      { label: 'Close others', disabled: siblings.length < 2, onClick: () => siblings.forEach((x) => x.id !== p.api.id && !isPinned(x) && x.api.close()) },
      { label: 'Close to the right', disabled: idx >= siblings.length - 1, onClick: () => siblings.slice(idx + 1).forEach((x) => !isPinned(x) && x.api.close()) },
      { label: 'Close all in group', onClick: () => siblings.forEach((x) => !isPinned(x) && x.api.close()) },
      { sep: true },
      {
        label: p.params.pinned ? 'Unpin tab' : 'Pin tab',
        onClick: () => {
          const pin = !p.params.pinned
          p.api.updateParameters({ ...p.params, pinned: pin, preview: false })
          if (pin) p.api.moveTo({ group, index: siblings.filter((x) => isPinned(x) && x.id !== p.api.id).length })
        }
      },
      ...(kind === 'editor' && path ? [{ label: 'Open a second view beside', hint: 'Ctrl+\\', onClick: () => useLayout.getState().openEditorBeside(path) }] : []),
      { sep: true },
      { label: 'Split right', onClick: () => p.api.moveTo({ group, position: 'right' }) },
      { label: 'Split down', onClick: () => p.api.moveTo({ group, position: 'bottom' }) },
      { label: 'Float', disabled: !me, onClick: () => me && api.addFloatingGroup(me, { width: 640, height: 480 }) },
      {
        label: 'Put on the desktop',
        // out of Prism altogether: its own small window, above other programs
        onClick: () => {
          void prism.float.open({ kind, key: `${kind}:${p.api.id}`, title, params: { ...p.params } })
          p.api.close()
        }
      },
      { label: api.hasMaximizedGroup() ? 'Restore size' : 'Maximize group', onClick: () => (api.hasMaximizedGroup() ? api.exitMaximizedGroup() : me && api.maximizeGroup(me)) }
    ]
    if (path) {
      out.push(
        { sep: true },
        { label: 'Copy path', onClick: () => void copyText(path) },
        { label: 'Reveal in file manager', onClick: () => void prism.app.reveal(path) }
      )
      if (kind === 'editor') {
        out.push({ label: 'Mention in agent', onClick: () => askAgentAbout(path, 1, '', `Look at @${path}`) })
        out.push({ label: 'Pin for the agent (this session)', onClick: () => void pinForAgent(path) })
      }
    }
    return out
  }
  const dirty = useEditor((s) => (kind === 'editor' && path ? isDirty(s.docs[path]) : false))
  // typing in a look-only tab keeps it
  useEffect(() => {
    if (dirty && p.params.preview) p.api.updateParameters({ ...p.params, preview: false })
  }, [dirty]) // eslint-disable-line react-hooks/exhaustive-deps
  const pinned = kind === 'agent' ? p.params.sessionId : undefined
  const running = useSessions((s) => (kind === 'agent' ? (pinned ? !!s.live[pinned]?.running : s.active ? !!s.live[s.active]?.running : false) : false))
  const pinnedTitle = useSessions((s) => (pinned ? s.sessions.find((x) => x.id === pinned)?.title : undefined))
  const title = pinnedTitle ?? p.api.title ?? ''
  const icon =
    kind === 'editor' || kind === 'preview' ? (
      <FileIcon name={path ?? ''} size={13} />
    ) : kind === 'agent' ? (
      <Sparkles size={13} className={running ? 'accent' : undefined} />
    ) : kind === 'terminal' ? (
      <TerminalSquare size={13} />
    ) : kind === 'diff' ? (
      <GitCompare size={13} />
    ) : kind === 'settings' ? (
      <Settings size={13} />
    ) : kind === 'usage' ? (
      <BarChart3 size={13} />
    ) : kind === 'welcome' ? (
      <Sparkle size={13} />
    ) : kind === 'gadget' ? (
      <Puzzle size={13} className="accent" />
    ) : kind === 'problems' ? (
      <CircleAlert size={13} />
    ) : kind === 'review' ? (
      <ListChecks size={13} className="accent" />
    ) : kind === 'plan' ? (
      <MapIcon size={13} className="accent" />
    ) : kind === 'context' ? (
      <Layers size={13} />
    ) : kind === 'compare' ? (
      <Columns3 size={13} />
    ) : kind === 'automations' ? (
      <Workflow size={13} />
    ) : kind === 'history' ? (
      <HistoryIcon size={13} />
    ) : kind === 'conflict' ? (
      <GitMerge size={13} className="amber" />
    ) : kind === 'browser' ? (
      <Globe size={13} />
    ) : kind === 'scratch' ? (
      <FlaskConical size={13} />
    ) : kind === 'dashboard' ? (
      <LayoutDashboard size={13} className="accent" />
    ) : kind === 'refactor' ? (
      <Replace size={13} className="accent" />
    ) : kind === 'references' ? (
      <LocateFixed size={13} />
    ) : kind === 'catchup' ? (
      <Coffee size={13} className="accent" />
    ) : kind === 'mission' ? (
      <Gauge size={13} className="accent" />
    ) : kind === 'prs' ? (
      <GitPullRequest size={13} className="accent" />
    ) : kind === 'searchChats' ? (
      <TextSearch size={13} className="accent" />
    ) : kind === 'work' ? (
      <Footprints size={13} className="accent" />
    ) : kind === 'tasks' ? (
      <ListTodo size={13} className="accent" />
    ) : kind === 'multiverse' ? (
      <Split size={13} className="accent" />
    ) : kind === 'tours' ? (
      <Compass size={13} className="accent" />
    ) : kind === 'spec' ? (
      <BookCheck size={13} className="accent" />
    ) : kind === 'impact' ? (
      <Radar size={13} className="accent" />
    ) : kind === 'timeline' ? (
      <Clock3 size={13} className="accent" />
    ) : (
      <Box size={13} />
    )
  return (
    <div
      className={cx('ptab', p.params.preview && 'look', p.params.pinned && 'pinned')}
      title={p.params.preview ? `${path ?? title}  ·  look-only: double-click to keep` : (path ?? title)}
      onMouseDown={(e) => e.button === 1 && p.api.close()}
      onDoubleClick={() => p.params.preview && p.api.updateParameters({ ...p.params, preview: false })}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={tabMenu()} onClose={() => setMenu(null)} />}
      <span className="ptab-icon">{icon}</span>
      <span className="ptab-title">{title}</span>
      {dirty ? (
        <span className="ptab-dirty" title="Unsaved changes" />
      ) : p.params.pinned ? (
        <span className="ptab-pin" title="Pinned. Right-click to unpin.">
          <Pin size={11} />
        </span>
      ) : (
        <span
          className="ptab-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            p.api.close()
          }}
        >
          <X size={12} />
        </span>
      )}
    </div>
  )
}

/** Add a file to the active session's pinned files: the model gets its current content every turn. */
/** Panels holding a live page, which must not be torn down when their tab is hidden. */
const KEEP_ALIVE = new Set<string>(['browser', 'gadget'])

/** Keeps this project's arrangement. `ws` says which project it belongs to. */
function saveLayout(api: DockviewApi, ws: string | null = useApp.getState().workspace): void {
  try {
    localStorage.setItem(layoutKey(ws), JSON.stringify(api.toJSON()))
  } catch {
    /* quota */
  }
}

/** Puts a saved arrangement back. False when there was nothing usable to put back. */
function applySaved(api: DockviewApi, raw: string | null): boolean {
  if (!raw) return false
  try {
    api.fromJSON(JSON.parse(raw))
    // a file opened from outside the project (by its full path) was only let in for that window's life
    for (const p of [...api.panels]) if (/^([a-z]:)?[\\/]/i.test((p.params as Params | undefined)?.path ?? '')) api.removePanel(p)
    if (api.totalPanels === 0) return false
    // layouts saved before a kind kept its page alive
    for (const p of api.panels) if (KEEP_ALIVE.has((p.params as Params | undefined)?.kind ?? '') && p.api.renderer !== 'always') p.api.setRenderer('always')
    // a group holding a kept-alive page restores its front tab empty; showing it again attaches it
    for (const g of api.groups) if (g.activePanel) g.model.openPanel(g.activePanel)
    return true
  } catch {
    return false
  }
}

export async function pinForAgent(path: string): Promise<void> {
  const st = useSessions.getState()
  const id = st.active ?? (await st.create())?.id
  if (!id) return
  const cur = await prism.sessions.extras(id)
  if (!cur.pins.includes(path)) await prism.sessions.setExtras(id, { pins: [...cur.pins, path] })
  useUi.getState().toast('success', 'Pinned for the agent', `${path} is now sent with every message of this session.`)
}

function isPinned(panel: { params?: unknown }): boolean {
  return !!(panel.params as Params | undefined)?.pinned
}

function GroupActions(p: IDockviewHeaderActionsProps): React.JSX.Element {
  const max = p.containerApi.hasMaximizedGroup()
  return (
    <div className="pgroup-actions">
      <button
        className="icon-btn sm"
        title={max ? 'Restore' : 'Maximize group'}
        onClick={() => {
          if (p.containerApi.hasMaximizedGroup()) p.containerApi.exitMaximizedGroup()
          else if (p.activePanel) p.containerApi.maximizeGroup(p.activePanel)
        }}
      >
        {max ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
    </div>
  )
}

function Watermark(_p: IWatermarkPanelProps): React.JSX.Element {
  return <div className="dock-watermark">drop a tab here</div>
}

// ---------------------------------------------------------------- dock

export function Dock(): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null)
  const saveSoon = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setController = useLayout((s) => s.setController)
  const showQueue = useSessions((s) => s.showQueue)
  const workspace = useApp((s) => s.workspace)

  const centerGroup = useCallback((api: DockviewApi) => {
    const pref = api.panels.find((p) => ['welcome', 'editor', 'preview', 'diff', 'settings', 'usage', 'gadget', 'review', 'plan', 'context', 'compare', 'automations', 'history', 'conflict', 'refactor', 'browser', 'scratch', 'dashboard'].includes((p.params as Params | undefined)?.kind ?? ''))
    return pref?.group ?? api.groups.find((g) => g.panels.every((p) => (p.params as Params | undefined)?.kind !== 'agent' && (p.params as Params | undefined)?.kind !== 'terminal')) ?? null
  }, [])

  const defaultLayout = useCallback((api: DockviewApi) => {
    api.clear()
    if (useApp.getState().workspace) api.addPanel({ id: 'dashboard', component: 'dashboard', title: 'Project', params: { kind: 'dashboard' } })
    else api.addPanel({ id: 'welcome', component: 'welcome', title: 'Welcome', params: { kind: 'welcome' } })
    api.addPanel({ id: 'agent', component: 'agent', title: 'Agent', params: { kind: 'agent' }, position: { direction: 'right' }, initialWidth: 480 })
  }, [])

  const makeController = useCallback(
    (api: DockviewApi): DockController => ({
      open(opts: OpenPanelOptions) {
        const id = opts.id ?? opts.kind
        const existing = api.getPanel(id)
        if (existing) {
          // activating re-attaches the panel's content, which would reload a web page: skip it when already in front
          if (!(existing.api.isActive && existing.api.isVisible)) existing.api.setActive()
          // opening for real a file that was only being looked at keeps its tab
          const keep = opts.kind === 'editor' && !opts.preview ? { preview: false } : {}
          if (opts.params && (opts.kind === 'editor' || opts.kind === 'settings' || opts.kind === 'history')) existing.api.updateParameters({ ...(existing.params as object), ...opts.params, ...keep, kind: opts.kind })
          if (opts.params && opts.kind === 'editor' && opts.params['reveal']) {
            void useEditor.getState().open(String(opts.params['path']), opts.params['reveal'] as { line: number; column?: number })
          }
          return
        }
        const params: Params = { kind: opts.kind, ...(opts.params as Partial<Params>), ...(opts.preview ? { preview: true } : {}) }
        const center = opts.area === 'center' ? (pickGroup(api, opts.kind) ?? centerGroup(api)) : centerGroup(api)
        let position: AddPanelPositionOptions | undefined
        // a look-only tab takes the place of the previous one
        const stale = opts.preview ? api.panels.find((x) => (x.params as Params | undefined)?.preview && !isDirty(useEditor.getState().docs[(x.params as Params).path ?? ''])) : undefined
        const besideGroup = opts.beside ? api.getPanel(opts.beside)?.group : undefined
        if (besideGroup) position = { referenceGroup: besideGroup, direction: 'right' }
        else if (stale) position = { referencePanel: stale.id, direction: 'within' }
        else if (opts.area === 'right') position = { direction: 'right' }
        else if (opts.area === 'bottom') {
          const bottom = api.panels.find((x) => ['terminal', 'problems', 'references'].includes((x.params as Params | undefined)?.kind ?? ''))?.group
          position = bottom ? { referenceGroup: bottom, direction: 'within' } : center ? { referenceGroup: center, direction: 'below' } : { direction: 'below' }
        }
        else if (center) position = { referenceGroup: center, direction: 'within' }
        api.addPanel({
          id,
          component: opts.kind,
          title: opts.title ?? opts.kind,
          params,
          ...(position ? { position } : {}),
          ...(opts.area === 'right' ? { initialWidth: 480 } : {}),
          ...(opts.area === 'bottom' ? { initialHeight: 280 } : {}),
          // pages (the browser, gadgets) live on while their tab is hidden; otherwise they would start over on every switch
          ...(KEEP_ALIVE.has(opts.kind) ? { renderer: 'always' as const } : {}),
          inactive: opts.focus === false
        })
        if (stale) api.removePanel(stale)
      },
      close(id) {
        // Ctrl+W acts on the tab in front, which may be a second view of the file
        const active = api.activePanel
        const p = active && (active.id === id || active.id.startsWith(`${id}::`)) ? active : api.getPanel(id)
        if (p && !isPinned(p)) api.removePanel(p)
      },
      has: (id) => !!api.getPanel(id),
      focus(id) {
        api.getPanel(id)?.api.setActive()
      },
      setTitle(id, title) {
        api.getPanel(id)?.api.setTitle(title)
      },
      resetLayout() {
        defaultLayout(api)
      },
      setMaximized(on) {
        if (on && api.activePanel) api.maximizeGroup(api.activePanel)
        else if (!on && api.hasMaximizedGroup()) api.exitMaximizedGroup()
      }
    }),
    [centerGroup, defaultLayout]
  )

  const onReady = useCallback(
    (ev: DockviewReadyEvent) => {
      const api = ev.api
      apiRef.current = api
      const debug = (window as unknown as { __prism?: Record<string, unknown> }).__prism
      if (debug) debug['dock'] = api
      const ws = useApp.getState().workspace
      const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY)
      if (legacy !== null) {
        // what was open before layouts were kept per project belongs to the project that was open
        if (!localStorage.getItem(layoutKey(ws))) localStorage.setItem(layoutKey(ws), legacy)
        localStorage.removeItem(LEGACY_LAYOUT_KEY)
      }
      if (!applySaved(api, localStorage.getItem(layoutKey(ws)))) defaultLayout(api)
      if (!api.getPanel('agent')) api.addPanel({ id: 'agent', component: 'agent', title: 'Agent', params: { kind: 'agent' }, position: { direction: 'right' }, initialWidth: 480 })

      api.onDidLayoutChange(() => {
        if (saveSoon.current) clearTimeout(saveSoon.current)
        saveSoon.current = setTimeout(() => {
          saveSoon.current = null
          saveLayout(api)
        }, 400)
      })
      api.onDidRemovePanel((p) => {
        const params = p.params as Params | undefined
        if (params?.kind === 'editor' && params.path) {
          const path = params.path
          if (api.panels.some((x) => (x.params as Params | undefined)?.kind === 'editor' && (x.params as Params).path === path)) return
          useEditor.getState().close(path)
          disposeModel(path)
          useOutline.getState().forget(path)
        }
      })
      api.onDidActiveGroupChange((g) => noteGroupUsed(g))
      // the agent's tabs_look reads this (main/services.ts)
      ;(window as unknown as { __prismTabs?: () => unknown }).__prismTabs = () => describeTabs(api)
      api.onDidActivePanelChange((ev) => {
        const params = ev.panel?.params as Params | undefined
        if (params?.kind === 'editor' && params.path) useEditor.getState().setActive(params.path)
      })
      setController(makeController(api))
    },
    [defaultLayout, makeController, setController]
  )

  const zen = useUi((st) => st.zen)
  useEffect(() => {
    useLayout.getState().controller?.setMaximized(zen)
  }, [zen])

  // files the agent asked to show
  useEffect(() => {
    if (!showQueue.length) return
    const item = useSessions.getState().takeShow()
    if (item) useLayout.getState().openPreview(item.path, item.note)
  }, [showQueue])

  // Switching project puts this one's tabs away and brings the other one's back.
  // `seen` is set even before the dock is ready, or the first switch of a session
  // would look like the first project we ever saw and leave the old files open.
  const seen = useRef<{ ws: string | null } | null>(null)
  useEffect(() => {
    const api = apiRef.current
    const was = seen.current
    seen.current = { ws: workspace }
    if (!api || !was || was.ws === workspace) return

    if (saveSoon.current) {
      clearTimeout(saveSoon.current)
      saveSoon.current = null
    }
    saveLayout(api, was.ws)

    // anything unsaved was written out before the switch, while the paths still
    // meant files in the project being left
    for (const p of [...api.panels]) {
      const k = (p.params as Params | undefined)?.kind
      if (k === 'editor' || k === 'preview' || k === 'diff') api.removePanel(p)
    }
    if (!applySaved(api, localStorage.getItem(layoutKey(workspace)))) defaultLayout(api)
    if (!api.getPanel('agent')) api.addPanel({ id: 'agent', component: 'agent', title: 'Agent', params: { kind: 'agent' }, position: { direction: 'right' }, initialWidth: 480 })
  }, [workspace, defaultLayout])

  useEffect(() => () => setController(null), [setController])

  return (
    <DockviewReact
      className="dock"
      theme={THEME}
      components={COMPONENTS}
      defaultTabComponent={Tab}
      rightHeaderActionsComponent={GroupActions}
      watermarkComponent={Watermark}
      onReady={onReady}
      floatingGroupBounds="boundedWithinViewport"
    />
  )
}
