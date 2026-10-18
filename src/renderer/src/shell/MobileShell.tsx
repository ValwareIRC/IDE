// The phone app's workbench. The same panels as a window, one at a time and full screen, with tabs along the
// bottom for the places used most and a sheet for everything in the menus.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { ArrowLeft, ChevronDown, Files, FolderOpen, GitBranch, Menu, MessagesSquare, PanelLeft, Puzzle, Sparkles, TerminalSquare, X } from 'lucide-react'
import { useLayout, type OpenPanelOptions, type PanelKind } from '@/state/layout'
import { useApp } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { prism } from '@/lib/ipc'
import { cx } from '@/lib/format'
import { MENUS, type MenuItem } from '@/lib/menus'
import { toastError } from '@/state/ui'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ExplorerView } from '@/panels/side/ExplorerView'
import { GitView } from '@/panels/side/GitView'
import { SessionsView } from '@/panels/side/SessionsView'
import { GadgetsView } from '@/panels/side/GadgetsView'
import { COMPONENTS, type Params } from './Dock'
import '@/styles/mobile.css'

interface Page {
  id: string
  kind: PanelKind | 'side'
  title: string
  params: Record<string, unknown>
}

/** Kept small on a phone: the oldest page goes when there are more. */
const MAX_PAGES = 10
/** Shown in the computer only. */
const DESKTOP_ONLY = new Set<string>(['browser'])
/** Menu entries that act on the computer's windows. */
const HIDDEN = new Set(['file.newWindow', 'file.open', 'file.openRemote', 'file.reveal', 'file.quit'])

const SIDES: Record<string, { title: string; view: () => React.JSX.Element }> = {
  'side:files': { title: 'Files', view: ExplorerView },
  'side:git': { title: 'Source control', view: GitView },
  'side:chats': { title: 'Chats', view: SessionsView },
  'side:gadgets': { title: 'Gadgets', view: GadgetsView }
}

interface Pages {
  pages: Page[]
  /** Which page shows; the order they were visited in, latest last. */
  trail: string[]
  open(p: Page): void
  close(id: string): void
  back(): void
}

const usePages = create<Pages>((set, get) => ({
  pages: [],
  trail: [],
  open(p) {
    const s = get()
    const have = s.pages.find((x) => x.id === p.id)
    let pages = have ? s.pages.map((x) => (x.id === p.id ? { ...x, ...p, params: { ...x.params, ...p.params } } : x)) : [...s.pages, p]
    // agent and terminal stay: they hold a running conversation and a shell
    while (pages.length > MAX_PAGES) {
      const drop = pages.find((x) => x.kind !== 'agent' && x.kind !== 'terminal' && x.id !== p.id)
      if (!drop) break
      pages = pages.filter((x) => x !== drop)
    }
    const ids = new Set(pages.map((x) => x.id))
    set({ pages, trail: [...s.trail.filter((t) => t !== p.id && ids.has(t)), p.id] })
  },
  close(id) {
    const s = get()
    set({ pages: s.pages.filter((x) => x.id !== id), trail: s.trail.filter((t) => t !== id) })
  },
  back() {
    const s = get()
    const cur = s.trail.at(-1)
    const page = s.pages.find((x) => x.id === cur)
    // pages reached from a tab are left as they are; others close on the way back
    if (page && page.kind !== 'agent' && page.kind !== 'terminal' && page.kind !== 'side') set({ pages: s.pages.filter((x) => x.id !== cur), trail: s.trail.slice(0, -1) })
    else set({ trail: s.trail.slice(0, -1) })
  }
}))

function openSide(id: keyof typeof SIDES): void {
  usePages.getState().open({ id, kind: 'side', title: SIDES[id]!.title, params: {} })
}

function useConnection(): { state: string; error?: string; trying?: boolean } {
  return useSyncExternalStore(
    (cb) => {
      const m = window.__prismMobile
      m?.onState.add(cb)
      return () => m?.onState.delete(cb)
    },
    () => window.__prismMobile?.state ?? { state: 'connected' }
  )
}

function PageView({ page }: { page: Page }): React.JSX.Element {
  if (page.kind === 'side') {
    const V = SIDES[page.id]!.view
    return (
      <ErrorBoundary label={page.title}>
        <div className="m-side">
          <V />
        </div>
      </ErrorBoundary>
    )
  }
  if (DESKTOP_ONLY.has(page.kind)) {
    return (
      <div className="m-empty">
        <div className="m-empty-title">{page.title}</div>
        <div>This one only works on the computer.</div>
      </div>
    )
  }
  const Host = COMPONENTS[page.kind as keyof typeof COMPONENTS] as unknown as (p: { params: Params; api: unknown }) => React.JSX.Element
  const api = { id: page.id, title: page.title, close: () => usePages.getState().close(page.id), updateParameters: (params: Record<string, unknown>) => usePages.getState().open({ ...page, params }), setTitle: () => {} }
  return <Host params={{ ...page.params, kind: page.kind } as Params} api={api} />
}

function Sheet({ onClose, children, title }: { onClose: () => void; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="m-sheet-back" onClick={onClose}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-head">
          <span>{title}</span>
          <button className="m-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>
  )
}

function MenuSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [group, setGroup] = useState<string | null>(null)
  const [sub, setSub] = useState<MenuItem[] | null>(null)
  const g = MENUS.find((x) => x.id === group)
  const items = sub ?? g?.items().filter((i) => i.sep || !HIDDEN.has(i.id)) ?? []
  const run = (i: Extract<MenuItem, { id: string }>): void => {
    if (i.submenu) return setSub(i.submenu)
    onClose()
    try {
      i.run?.()
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <Sheet title={g ? g.label : 'Menu'} onClose={onClose}>
      {g && (
        <button className="m-row m-row-back" onClick={() => (sub ? setSub(null) : setGroup(null))}>
          <ArrowLeft size={16} /> Back
        </button>
      )}
      {!g &&
        MENUS.map((m) => (
          <button key={m.id} className="m-row" onClick={() => setGroup(m.id)}>
            {m.label}
          </button>
        ))}
      {g &&
        items.map((i, n) =>
          i.sep ? (
            <div key={n} className="m-sep" />
          ) : (
            <button key={i.id} className={cx('m-row', i.danger && 'danger')} disabled={i.disabled} onClick={() => run(i)}>
              <span className="m-row-check">{i.checked ? '✓' : ''}</span>
              <span className="grow">{i.label}</span>
              {i.submenu && <span className="m-row-hint">›</span>}
            </button>
          )
        )}
    </Sheet>
  )
}

function ProjectSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<Array<{ root: string; name: string; open: boolean }> | null>(null)
  const current = useApp((s) => s.workspace)
  useEffect(() => {
    void prism.host.projects().then(setList).catch(toastError)
  }, [])
  return (
    <Sheet title="Projects" onClose={onClose}>
      {!list && <div className="m-note">Asking the computer…</div>}
      {list?.length === 0 && <div className="m-note">No projects yet. Open one in Prism on the computer first.</div>}
      {list?.map((p) => (
        <button
          key={p.root}
          className={cx('m-row', p.root === current && 'on')}
          onClick={() => {
            onClose()
            if (p.root !== current) void useApp.getState().setWorkspace(p.root).catch(toastError)
          }}
        >
          <FolderOpen size={16} />
          <span className="grow m-row-two">
            <span>{p.name}</span>
            <span className="m-row-sub">{p.root}</span>
          </span>
          {p.open && <span className="m-pill">open</span>}
        </button>
      ))}
    </Sheet>
  )
}

export function MobileShell(): React.JSX.Element {
  const pages = usePages((s) => s.pages)
  const trail = usePages((s) => s.trail)
  const workspace = useApp((s) => s.workspace)
  const conn = useConnection()
  const [sheet, setSheet] = useState<'menu' | 'projects' | null>(null)
  const running = useSessions((s) => Object.values(s.live).some((l) => l.running))
  const waiting = useSessions((s) => Object.values(s.live).some((l) => l.approvals.length || l.questions.length))
  const current = pages.find((p) => p.id === trail.at(-1)) ?? null

  useEffect(() => {
    const pagesFor = (o: OpenPanelOptions): Page => ({ id: o.id ?? o.kind, kind: o.kind, title: o.title ?? o.kind, params: o.params ?? {} })
    useLayout.getState().setController({
      open: (o) => usePages.getState().open(pagesFor(o)),
      close: (id) => usePages.getState().close(id),
      has: (id) => usePages.getState().pages.some((p) => p.id === id),
      focus: (id) => {
        const p = usePages.getState().pages.find((x) => x.id === id)
        if (p) usePages.getState().open(p)
      },
      setTitle: (id, title) => usePages.setState((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, title } : p)) })),
      resetLayout: () => {
        usePages.setState({ pages: [], trail: [] })
        useLayout.getState().openAgent()
      },
      setMaximized: () => {}
    })
    if (!usePages.getState().pages.length) useLayout.getState().openAgent()
    return () => useLayout.getState().setController(null)
  }, [])

  // the phone's back button goes back a page
  useEffect(() => {
    history.pushState(null, '')
    const onPop = (): void => {
      if (usePages.getState().trail.length > 1) usePages.getState().back()
      history.pushState(null, '')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // after a gap the computer sees a new connection: back to this project, and what shows is asked for again
  useEffect(() => {
    const m = window.__prismMobile
    if (!m) return
    let was: string = m.state.state
    const on = (s: { state: string }): void => {
      if (s.state === 'connected' && was !== 'connected') {
        const ws = useApp.getState().workspace
        void (ws ? prism.workspace.set(ws) : prism.workspace.current())
          .then(async (w) => {
            useApp.setState({ workspace: w, settings: await prism.settings.get() })
            if (w) await useSessions.getState().refresh(true)
          })
          .catch(toastError)
      }
      was = s.state
    }
    m.onState.add(on)
    return () => void m.onState.delete(on)
  }, [])

  // The places, in a drawer from the left rather than a bar along the bottom: the bar
  // took a strip of the screen all the time for something used now and then.
  const [drawer, setDrawer] = useState(false)
  const status = waiting ? 'waiting' : running ? 'running' : undefined
  const place = (id: string, label: string, icon: React.ReactNode, go: () => void, badge?: string): React.JSX.Element => (
    <button
      className={cx('m-row', 'm-drawer-row', current?.id === id && 'on')}
      onClick={() => {
        setDrawer(false)
        go()
      }}
    >
      <span className="m-tab-icon">
        {icon}
        {badge && <span className={cx('m-badge', badge)} />}
      </span>
      <span>{label}</span>
    </button>
  )

  // Swiping in from the left edge opens it. Not from the very edge: on phones with
  // gesture navigation that strip is Android's own back gesture.
  useEffect(() => {
    let from: { x: number; y: number } | null = null
    const start = (e: TouchEvent): void => {
      const t = e.touches[0]
      from = t && t.clientX < 48 ? { x: t.clientX, y: t.clientY } : null
    }
    const move = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!from || !t) return
      const dx = t.clientX - from.x
      if (Math.abs(t.clientY - from.y) > 40) from = null
      else if (dx > 60) {
        from = null
        setDrawer(true)
      }
    }
    window.addEventListener('touchstart', start, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    return () => {
      window.removeEventListener('touchstart', start)
      window.removeEventListener('touchmove', move)
    }
  }, [])

  const name = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : 'No project'

  return (
    <div className="m-app">
      <header className="m-top">
        <button className="m-icon" onClick={() => setDrawer(true)} aria-label="Places" title="Agent, chats, files, git, gadgets and the terminal">
          <span className="m-tab-icon">
            <PanelLeft size={20} />
            {status && <span className={cx('m-badge', status)} />}
          </span>
        </button>
        {trail.length > 1 && (
          <button className="m-icon" onClick={() => usePages.getState().back()} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
        )}
        <div className="m-title">
          <div className="m-title-main">{current?.title ?? 'Prism'}</div>
          <button className="m-project" onClick={() => setSheet('projects')}>
            <span className={cx('m-dot', conn.state)} />
            {name}
            <ChevronDown size={13} />
          </button>
        </div>
        {current && current.kind !== 'agent' && current.kind !== 'terminal' && current.kind !== 'side' && (
          <button className="m-icon" onClick={() => usePages.getState().close(current.id)} aria-label="Close">
            <X size={20} />
          </button>
        )}
        <button className="m-icon" onClick={() => setSheet('menu')} aria-label="Menu">
          <Menu size={20} />
        </button>
      </header>
      {conn.state !== 'connected' && (
        <div className="m-banner">
          <span>{conn.error ?? 'Reconnecting to the computer…'}</span>
          {/* once it has stopped trying by itself, the way to make it try is right here,
              not closing the app and opening it again */}
          {conn.state === 'lost' && !conn.trying && window.__prismMobile?.retry && (
            <button className="m-banner-retry" onClick={() => window.__prismMobile?.retry?.()}>
              Try again
            </button>
          )}
        </div>
      )}
      <main className="m-body">
        {pages.map((p) => (
          <div key={p.id} className="m-page" hidden={p !== current}>
            <PageView page={p} />
          </div>
        ))}
      </main>
      {drawer && <Drawer project={name} onClose={() => setDrawer(false)}>
        {place('agent', 'Agent', <Sparkles size={20} />, () => useLayout.getState().openAgent(), status)}
        {place('side:chats', 'Chats', <MessagesSquare size={20} />, () => openSide('side:chats'))}
        {place('side:files', 'Files', <Files size={20} />, () => openSide('side:files'))}
        {place('side:git', 'Git', <GitBranch size={20} />, () => openSide('side:git'))}
        {place('side:gadgets', 'Gadgets', <Puzzle size={20} />, () => openSide('side:gadgets'))}
        {place('terminal', 'Terminal', <TerminalSquare size={20} />, () => useLayout.getState().openTerminal())}
      </Drawer>}
      {sheet === 'menu' && <MenuSheet onClose={() => setSheet(null)} />}
      {sheet === 'projects' && <ProjectSheet onClose={() => setSheet(null)} />}
    </div>
  )
}

/** The places, sliding in from the left. Closes on a tap outside it, or swiping it back. */
function Drawer({ project, onClose, children }: { project: string | undefined; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const from = useRef<number | null>(null)
  return (
    <div className="m-drawer-back" onClick={onClose}>
      <nav
        className="m-drawer"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => (from.current = e.touches[0]?.clientX ?? null)}
        onTouchMove={(e) => {
          const x = e.touches[0]?.clientX
          if (from.current !== null && x !== undefined && from.current - x > 60) {
            from.current = null
            onClose()
          }
        }}
      >
        <div className="m-drawer-head">
          <span className="m-drawer-name">Prism</span>
          <span className="m-row-sub">{project}</span>
        </div>
        {children}
      </nav>
    </div>
  )
}
