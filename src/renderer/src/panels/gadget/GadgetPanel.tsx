import { useEffect, useRef, useState } from 'react'
import { Bot, FolderOpen, Monitor, RefreshCw, ScrollText, Square, TriangleAlert, Wand2, Wrench } from 'lucide-react'
import type { GadgetInfo } from '@shared/ipc'
import { prism } from '@/lib/ipc'
import { useGadgets } from '@/state/gadgets'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { cx } from '@/lib/format'
import { GadgetIntro } from './GadgetIntro'

/** Hosts one gadget: sandboxed iframe + the postMessage bridge to its backend and host services. */
export function GadgetPanel({ id }: { id: string }): React.JSX.Element {
  const info = useGadgets((s) => s.list.find((g) => g.id === id))
  const refresh = useGadgets((s) => s.refresh)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [changing, setChanging] = useState(false)
  const [change, setChange] = useState('')
  // The phone app has no prism-gadget:// address to load from, so it is handed the
  // page with everything folded into it (see core/gadgets/inline.ts).
  const folded = !!window.__prismMobile
  const [page, setPage] = useState<string | null>(null)
  const [pageError, setPageError] = useState('')

  useEffect(() => {
    if (!folded) return
    let gone = false
    setPage(null)
    setPageError('')
    void prism.gadgets
      .page(id)
      .then((html) => {
        if (!gone) setPage(html)
      })
      .catch((e: unknown) => {
        if (!gone) setPageError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      gone = true
    }
  }, [id, folded, reloadKey])

  useEffect(() => {
    void refresh()
    void prism.gadgets.log(id).then(setLog)
    const offLog = prism.gadgets.onLog(id, (line) => setLog((l) => [...l.slice(-299), line]))
    const offEv = prism.gadgets.onEvent(id, (ev) => {
      if (ev.event === '__reload') {
        setReloadKey((k) => k + 1)
        return
      }
      frameRef.current?.contentWindow?.postMessage({ __prism: true, type: 'event', event: ev.event, data: ev.data }, '*')
    })
    return () => {
      offLog()
      offEv()
    }
  }, [id, refresh])

  // bridge: messages from the iframe
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const m = e.data as { __prism?: boolean; __prismGadgetBoot?: boolean; type?: string; id?: number; method?: string; args?: Record<string, unknown> }
      // on the phone the frame is an empty document of the app's own, which asks for
      // the gadget's page the moment it is ready for it
      if (m?.__prismGadgetBoot) {
        if (page) frame.contentWindow?.postMessage({ __prismGadgetPage: true, html: page }, '*')
        return
      }
      if (!m?.__prism) return
      const reply = (payload: Record<string, unknown>): void => frame.contentWindow?.postMessage({ __prism: true, ...payload }, '*')
      if (m.type === 'hello') {
        reply({ type: 'theme', theme: { vars: themeVars() } })
        void prism.gadgets.start(id).finally(() => reply({ type: 'ready' }))
        return
      }
      if (m.type === 'call' && typeof m.id === 'number') {
        void prism.gadgets
          .call(id, m.method ?? '', m.args ?? {})
          .then((result) => reply({ type: 'result', id: m.id, result }))
          .catch((err: unknown) => reply({ type: 'result', id: m.id, error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [id, page])

  // re-send theme when the accent changes
  useEffect(() => {
    const obs = new MutationObserver(() => frameRef.current?.contentWindow?.postMessage({ __prism: true, type: 'theme', theme: { vars: themeVars() } }, '*'))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-accent', 'data-density', 'data-theme', 'style'] })
    return () => obs.disconnect()
  }, [])

  if (!info) {
    return (
      <div className="empty">
        <div className="title">This gadget is gone</div>
        <div className="faint small">{id} was deleted or belongs to another project.</div>
      </div>
    )
  }

  const askAgent = (text: string): void => {
    useLayout.getState().openAgent()
    void useSessions.getState().send(text)
  }

  const sendChange = (): void => {
    const t = change.trim()
    if (!t) return
    setChanging(false)
    setChange('')
    askAgent(`Change the gadget "${id}" (read it with gadget_read first): ${t}\n\nWhen done, check it with gadget_look.`)
  }

  const fix = (): void =>
    askAgent(
      `The gadget "${id}" is failing. Read it with gadget_read, find the cause and fix it.\n\nProblem: ${info.error ?? 'unknown'}\n\nRecent log:\n${log.slice(-12).join('\n') || '(empty)'}`
    )

  // one that comes with Prism says what it is the first time, and runs only once the user says yes
  if (info.scope === 'builtin' && !info.on && info.intro)
    return <GadgetIntro info={info} onTurnOn={() => void prism.gadgets.turnOn(id, true).then((list) => useGadgets.setState({ list }))} onLater={() => useLayout.getState().closePanel(`gadget:${id}`)} />

  const busy = info.state === 'starting' || info.state === 'installing'

  return (
    <div className="gadget">
      <div className="gadget-bar">
        <span className={cx('dot', info.state === 'running' && 'live', info.state === 'error' && 'rose', busy && 'amber')} title={stateWords(info)} />
        <span className="gadget-name">{info.name}</span>
        <span className="faint xs truncate gadget-desc" title={info.description}>
          {info.description}
        </span>
        <span className="grow" />
        {info.tools.length > 0 && (
          <span className="chip xs accent" title={`The agent can operate this gadget:\n${info.tools.map((t) => `• ${t.name}: ${t.description}`).join('\n')}`}>
            <Bot size={10} /> <span className="chip-label">agent can use it</span>
          </span>
        )}
        {info.hasBackend && (
          <span className="chip xs" title="This gadget runs its own program on your computer">
            <Monitor size={10} /> <span className="chip-label">runs on this PC</span>
          </span>
        )}
        <button className={cx('icon-btn sm', changing && 'on')} title="Ask Prism to change this gadget" onClick={() => setChanging((v) => !v)}>
          <Wand2 size={13} />
        </button>
        {info.hasBackend && info.state === 'running' && (
          <button className="icon-btn sm" title="Stop it" onClick={() => void prism.gadgets.stop(id)}>
            <Square size={12} />
          </button>
        )}
        <button className={cx('icon-btn sm', showLog && 'on')} title="Activity log" onClick={() => setShowLog((v) => !v)}>
          <ScrollText size={13} />
        </button>
        <button className="icon-btn sm" title="Restart" onClick={() => void prism.gadgets.reload(id).then(() => setReloadKey((k) => k + 1))}>
          <RefreshCw size={13} />
        </button>
        {!folded && (
          <button className="icon-btn sm" title="Open its folder" onClick={() => void prism.gadgets.openDir(id)}>
            <FolderOpen size={13} />
          </button>
        )}
      </div>
      {changing && (
        <div className="gadget-change">
          <Wand2 size={13} className="accent" />
          <input
            className="input sm grow"
            autoFocus
            placeholder="What should change? e.g. add a dark red theme, show memory per machine…"
            value={change}
            onChange={(e) => setChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendChange()
              if (e.key === 'Escape') setChanging(false)
            }}
          />
          <button className="btn sm solid" disabled={!change.trim()} onClick={sendChange}>
            Ask Prism
          </button>
        </div>
      )}
      <div className="gadget-body">
        <iframe
          key={reloadKey}
          ref={frameRef}
          data-gadget={id}
          className="gadget-frame"
          title={info.name}
          {...(folded ? { src: `./gadget.html?g=${encodeURIComponent(id)}&t=${reloadKey}` } : { src: `prism-gadget://${id}/${info.ui ?? 'index.html'}?t=${reloadKey}` })}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
        />
        {folded && !page && !pageError && (
          <div className="gadget-veil">
            <span className="spinner" />
            <div>Fetching this gadget…</div>
          </div>
        )}
        {folded && pageError && (
          <div className="gadget-veil">
            <TriangleAlert size={22} className="rose" />
            <div style={{ fontWeight: 600 }}>This gadget could not be shown here</div>
            <div className="gadget-veil-error mono">{pageError}</div>
          </div>
        )}
        {info.state === 'installing' && (
          <div className="gadget-veil">
            <span className="spinner" />
            <div>Getting what this gadget needs…</div>
            <div className="faint xs">This happens once.</div>
          </div>
        )}
        {info.state === 'error' && (
          <div className="gadget-veil">
            <TriangleAlert size={22} className="rose" />
            <div style={{ fontWeight: 600 }}>This gadget hit a problem</div>
            <div className="gadget-veil-error mono">{info.error}</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={fix}>
                <Wrench size={13} /> Fix with Prism
              </button>
              <button className="btn ghost" onClick={() => void prism.gadgets.reload(id)}>
                <RefreshCw size={13} /> Try again
              </button>
            </div>
          </div>
        )}
        {showLog && (
          <div className="gadget-log mono">
            {log.length === 0 && <div className="faint">Nothing has happened yet.</div>}
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function stateWords(info: GadgetInfo): string {
  if (!info.hasBackend) return 'Ready'
  switch (info.state) {
    case 'running':
      return 'Running'
    case 'starting':
      return 'Starting…'
    case 'installing':
      return 'Getting what it needs…'
    case 'error':
      return 'Hit a problem'
    default:
      return 'Stopped'
  }
}

function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const names = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--line', '--line-strong', '--text', '--text-2', '--text-3', '--text-4', '--accent', '--accent-2', '--mint', '--amber', '--rose', '--violet', '--font-ui', '--font-mono']
  const out: Record<string, string> = {}
  for (const n of names) out[n] = cs.getPropertyValue(n).trim()
  out['--bg'] = out['--bg-1'] ?? ''
  return out
}

export type { GadgetInfo }
