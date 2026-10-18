import { useEffect } from 'react'
import { useApp } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useUi } from '@/state/ui'
import { useLayout } from '@/state/layout'
import { prism } from '@/lib/ipc'
import { useGlobalKeys } from '@/lib/keys'
import { bootMark } from '@/lib/bootMark'
import { installGadgetBridge } from '@/lib/gadgetBridge'
import { watchSpecEdits } from '@/panels/spec/SpecPanel'
import { TourBar } from '@/panels/tour/Tour'
import { DemoBar, DemoPointer } from '@/demo/DemoBar'
import { LessonsLayer } from '@/demo/LessonsUI'
import { CatchUpBar, watchPresence } from '@/panels/catchup/CatchUp'
import { TitleBar } from '@/shell/TitleBar'
import { ActivityRail } from '@/shell/ActivityRail'
import { Sidebar } from '@/shell/Sidebar'
import { StatusBar } from '@/shell/StatusBar'
import { Toasts } from '@/shell/Toasts'
import { Modals } from '@/shell/Modals'
import { CommandPalette } from '@/shell/CommandPalette'
import { Dock } from '@/shell/Dock'
import { Logo } from '@/components/Logo'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { QuickAsk } from './shell/QuickAsk'
import { MobileShell } from './shell/MobileShell'
import { FloatShell, floatSpec } from './shell/FloatShell'
import { WidgetShell, widgetWanted } from './shell/WidgetShell'

/** Set once, for the life of the window: a floating tab is not something that changes. */
const FLOAT = floatSpec()
/** Set once: this page was opened to be photographed for a widget. */
const WIDGET = widgetWanted()

export function App(): React.JSX.Element {
  const booted = useApp((s) => s.booted)
  const boot = useApp((s) => s.boot)
  const bootProblem = useApp((s) => s.bootProblem)
  const workspace = useApp((s) => s.workspace)
  const zen = useUi((s) => s.zen)
  useGlobalKeys()

  useEffect(() => {
    // the first thing on screen: from here the window has something to show
    bootMark('first screen put up')
    requestAnimationFrame(() => requestAnimationFrame(() => bootMark('first screen drawn')))
    void boot()
  }, [boot])

  useEffect(() => {
    document.title = workspace ? `${workspace.split(/[\\/]/).pop()} — Prism` : 'Prism'
  }, [workspace])

  useEffect(() => {
    if (!booted) return
    return installGadgetBridge()
  }, [booted])

  // the phone has no speech model: this window answers its voice button for it
  useEffect(() => {
    if (!booted || window.__prismMobile) return
    let stop: (() => void) | undefined
    void import('@/lib/voice').then((v) => (stop = v.serveSpeechForPhone()))
    return () => stop?.()
  }, [booted])

  // the agent's browser tools ask for the Browser panel through the main process
  useEffect(() => {
    if (!booted) return
    const offOpen = prism.preview.onOpen(() => useLayout.getState().openBrowser(null, true))
    const offFocus = prism.preview.onFocus(() => useLayout.getState().openBrowser())
    return () => {
      offOpen()
      offFocus()
    }
  }, [booted])

  // not following the agent: it browses in a page of its own and leaves the Browser panel alone
  useEffect(() => {
    if (!booted || window.__prismMobile) return
    void prism.preview.follow(useUi.getState().follow).catch(() => {})
    return useUi.subscribe((s, was) => {
      if (s.follow !== was.follow) void prism.preview.follow(s.follow).catch(() => {})
    })
  }, [booted])

  useEffect(() => {
    if (!booted) return
    return watchSpecEdits()
  }, [booted])

  useEffect(() => {
    if (!booted) return
    return watchPresence()
  }, [booted])

  // a tool file that appeared or changed outside Settings cannot be used until the user allows it: say so, once
  useEffect(() => {
    if (!booted) return
    const told = new Set<string>()
    return prism.extend.onChanged(() => {
      void prism.extend
        .list()
        .then((st) => {
          const waiting = new Set(st.tools.filter((t) => t.waiting).map((t) => t.file))
          for (const f of told) if (!waiting.has(f)) told.delete(f)
          for (const f of waiting) {
            if (told.has(f)) continue
            told.add(f)
            useUi.getState().toast('info', 'A tool is waiting for your OK', `${f.split(/[\\/]/).pop()}: look at it under Settings, Skills & tools.`)
          }
        })
        .catch(() => {})
    })
  }, [booted])

  useEffect(() => {
    if (!booted) return
    const s = useSessions.getState()
    if (workspace) {
      void s.refresh()
      void s.loadCommands()
    } else {
      useSessions.setState({ sessions: [], active: null })
    }
  }, [workspace, booted])

  if (!booted) {
    return (
      <>
        <div className="ambience" />
        <div className="grain" />
        <div className="app" style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center' }}>
          <Logo size={40} />
          {bootProblem && (
            <div style={{ maxWidth: 460, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
              <div>Prism could not finish starting.</div>
              <div className="faint">{bootProblem}</div>
              <button
                onClick={() => {
                  useApp.setState({ bootProblem: null })
                  void boot()
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </>
    )
  }

  // a widget's picture: the gadget alone, and nothing of the app around it
  if (WIDGET) return <WidgetShell want={WIDGET} />

  // a tab out on the desktop is this window's whole contents
  if (FLOAT) {
    return (
      <>
        <FloatShell spec={FLOAT} />
        <Modals />
        <Toasts />
      </>
    )
  }

  if (window.__prismMobile) {
    return (
      <>
        <div className="ambience" />
        <ErrorBoundary label="Workbench">
          <MobileShell />
        </ErrorBoundary>
        <CommandPalette />
        <Modals />
        <Toasts />
      </>
    )
  }

  return (
    <>
      <div className="ambience" />
      <div className="grain" />
      <div className={zen ? 'app zen' : 'app'}>
        <TitleBar />
        {zen && (
          <button className="zen-exit" onClick={() => useUi.getState().setZen(false)} title="Leave zen mode (Ctrl+Alt+Z)">
            zen · leave
          </button>
        )}
        <div className="app-body">
          <ActivityRail />
          <div style={{ display: 'flex', minWidth: 0, minHeight: 0 }}>
            <ErrorBoundary label="Sidebar">
              <Sidebar />
            </ErrorBoundary>
            <div className="dock-host grow">
              <ErrorBoundary label="Workbench">
                <Dock />
              </ErrorBoundary>
            </div>
          </div>
        </div>
        <StatusBar />
      </div>
      <CommandPalette />
      <QuickAsk />
      <Modals />
      <TourBar />
      <DemoBar />
      <LessonsLayer />
      <DemoPointer />
      <CatchUpBar />
      <Toasts />
    </>
  )
}
