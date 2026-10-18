import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { Accessibility, PenLine, ArrowLeft, ArrowRight, Bug, Camera, ExternalLink, FolderOpen, Globe, MousePointerClick, Play, RefreshCw, RotateCw, Square, TerminalSquare, Trash2, Wrench, X } from 'lucide-react'
import type { Attachment, BrowserConsoleEntry, DevScript } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useTerminals } from '@/state/terminals'
import { useApp } from '@/state/app'
import { useBrowser } from '@/state/browser'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { cx } from '@/lib/format'
import { MARKUP_SCRIPT, type Mark } from './markup'
import { MarkUpTray } from './MarkUpTray'
import { A11yTray } from './A11yTray'

const LEVELS = ['log', 'info', 'warn', 'error'] as const
// strips the colour codes dev servers print, so their address can be read
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?[^\s'"<>)]*/i

interface Picked {
  selector: string
  tag: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

/** Runs inside the page: outlines whatever is under the pointer and resolves with a description of what is clicked (null on Escape). */
const PICKER = `(() => new Promise((resolve) => {
  if (window.__prismPick) window.__prismPick.stop()
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #8ad8ff;background:rgba(138,216,255,.16);border-radius:3px'
  const tag = document.createElement('div')
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:11px/1.4 ui-monospace,Consolas,monospace;background:#0b0d13;color:#e9ecf4;padding:2px 6px;border-radius:4px;white-space:nowrap'
  document.documentElement.append(box, tag)
  let cur = null
  const path = (el) => {
    const parts = []
    let e = el
    while (e && e.nodeType === 1 && parts.length < 5) {
      let s = e.tagName.toLowerCase()
      if (e.id) { parts.unshift(s + '#' + CSS.escape(e.id)); break }
      s += [...e.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('')
      const p = e.parentElement
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName)
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'
      }
      parts.unshift(s)
      e = e.parentElement
    }
    return parts.join(' > ')
  }
  const move = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)
    if (!el || el === box || el === tag) return
    cur = el
    const r = el.getBoundingClientRect()
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    tag.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '  ' + Math.round(r.width) + ' x ' + Math.round(r.height)
    tag.style.left = Math.max(2, r.left) + 'px'
    tag.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 4) + 'px'
  }
  const stop = (result) => {
    document.removeEventListener('mousemove', move, true)
    document.removeEventListener('click', click, true)
    document.removeEventListener('keydown', key, true)
    box.remove()
    tag.remove()
    delete window.__prismPick
    resolve(result)
  }
  const click = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    const el = cur || ev.target
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    stop({
      selector: path(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 300),
      html: el.outerHTML.slice(0, 2500),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      styles: { color: cs.color, background: cs.backgroundColor, font: cs.fontSize + ' ' + cs.fontFamily.split(',')[0], display: cs.display, position: cs.position, margin: cs.margin, padding: cs.padding }
    })
  }
  const key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); stop(null) } }
  document.addEventListener('mousemove', move, true)
  document.addEventListener('click', click, true)
  document.addEventListener('keydown', key, true)
  window.__prismPick = { stop: () => stop(null) }
}))()`

const lastKey = (ws: string | null): string => `prism.browser.last:${ws ?? ''}`

/** Text and pictures for the agent: they land in the message box of the current session. */
function handToAgent(text: string, attachments: Attachment[]): void {
  useLayout.getState().openAgent()
  const st = useSessions.getState()
  const give = (id: string): void => useSessions.getState().hand(id, text, attachments)
  if (st.active) give(st.active)
  else void st.create().then((s) => s && give(s.id))
}

export function BrowserPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const request = useBrowser((s) => s.request)
  const view = useRef<WebviewTag | null>(null)
  const ready = useRef(false)
  const queued = useRef<string | null>(null)
  const [initial] = useState(() => (useBrowser.getState().blank ? 'about:blank' : (localStorage.getItem(lastKey(workspace)) ?? 'about:blank')))
  const [address, setAddress] = useState(initial === 'about:blank' ? '' : initial)
  const [current, setCurrent] = useState(initial)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [failed, setFailed] = useState<string | null>(null)
  const [logs, setLogs] = useState<BrowserConsoleEntry[]>([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [picking, setPicking] = useState(false)
  // marking up: several things numbered on the page, each with a note and styles tried live
  const [markup, setMarkup] = useState(false)
  const [marks, setMarks] = useState<Mark[]>([])
  const [selecting, setSelecting] = useState(false)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [scripts, setScripts] = useState<DevScript[]>([])
  const [dev, setDev] = useState<{ id: string; command: string } | null>(null)
  const [staticBase, setStaticBase] = useState<string | null>(null)
  const [auto, setAuto] = useState<'on' | 'off' | null>(() => (localStorage.getItem('prism.browser.auto') as 'on' | 'off' | null) ?? null)

  // a plain folder has nothing reloading it; a dev server usually refreshes the page itself
  const autoOn = auto ? auto === 'on' : !!staticBase && current.startsWith(staticBase)

  const go = useCallback(async (target: string): Promise<void> => {
    const t = target.trim()
    if (!t) return
    try {
      const url = await prism.preview.resolve(t)
      setFailed(null)
      setAddress(url)
      if (ready.current) void view.current?.loadURL(url).catch(() => {})
      else queued.current = url
    } catch (e) {
      toastError(e, 'Could not open that')
    }
  }, [])

  useEffect(() => {
    void prism.preview.scripts().then(setScripts).catch(() => {})
  }, [workspace])

  // someone asked for an address (the explorer, a menu, the agent)
  useEffect(() => {
    if (!request) return
    useBrowser.getState().clear()
    if (request.url) void go(request.url)
  }, [request, go])

  useEffect(() => {
    const wv = view.current
    if (!wv) return
    let id = 0
    const sync = (): void => setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
    const onReady = (): void => {
      ready.current = true
      id = wv.getWebContentsId()
      prism.preview.attach(id)
      const q = queued.current
      queued.current = null
      if (q) void wv.loadURL(q).catch(() => {})
    }
    const onNav = (e: Event): void => {
      const ev = e as unknown as { url: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      setCurrent(ev.url)
      setAddress(ev.url === 'about:blank' ? '' : ev.url)
      if (!(e as unknown as { type: string }).type.includes('in-page')) {
        setMarkup(false)
        setMarks([])
      }
      setFailed(null)
      if (ev.url !== 'about:blank') localStorage.setItem(lastKey(useApp.getState().workspace), ev.url)
      void prism.preview.base().then(setStaticBase).catch(() => {})
      sync()
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string }
      // -3 is a navigation that was replaced by another one
      if (ev.isMainFrame && ev.errorCode !== -3) setFailed(`${ev.validatedURL} could not be reached (${ev.errorDescription.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase()}).`)
    }
    const onConsole = (e: Event): void => {
      const ev = e as unknown as { level: number; message: string; line: number; sourceId: string }
      if (String(ev.message).startsWith('%cElectron Security Warning')) return
      setLogs((l) => [...l.slice(-499), { level: LEVELS[ev.level] ?? 'log', text: String(ev.message).slice(0, 4000), source: ev.sourceId ?? '', line: ev.line ?? 0, ts: Date.now() }])
    }
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('console-message', onConsole)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('console-message', onConsole)
      ready.current = false
      if (id) prism.preview.detach(id)
    }
  }, [])

  // files changed on disk: load the page again
  useEffect(() => {
    if (!autoOn) return
    let t: number | null = null
    const off = prism.fs.onChanged(() => {
      if (t) window.clearTimeout(t)
      t = window.setTimeout(() => ready.current && view.current?.reloadIgnoringCache(), 350)
    })
    return () => {
      off()
      if (t) window.clearTimeout(t)
    }
  }, [autoOn])

  const startDev = async (s: DevScript): Promise<void> => {
    try {
      // through the store, so the Terminal panel lists it
      const t = await useTerminals.getState().create({ title: 'dev server' })
      if (!t) return
      setDev({ id: t.id, command: s.command })
      let buf = ''
      let found = false
      const offData = prism.terminals.onData(t.id, (d) => {
        if (found) return
        buf = (buf + d).slice(-6000)
        const m = LOCAL_URL.exec(buf.replace(ANSI, ''))
        if (m) {
          found = true
          // the server prints its address a moment before it answers
          window.setTimeout(() => void go(m[0].replace('0.0.0.0', 'localhost').replace(/\[::1?\]/, 'localhost')), 500)
        }
      })
      const offExit = prism.terminals.onExit(t.id, () => {
        offData()
        offExit()
        setDev((d) => (d?.id === t.id ? null : d))
      })
      // give the shell a moment to show its prompt
      window.setTimeout(() => prism.terminals.write(t.id, `${s.command}\r`), 700)
      useUi.getState().toast('info', `Starting ${s.command}`, 'It runs in a terminal called "dev server". The page opens when it prints its address.')
    } catch (e) {
      toastError(e, 'Could not start it')
    }
  }

  const serveFolder = async (): Promise<void> => {
    try {
      const base = await prism.preview.serve()
      setStaticBase(base)
      await go(base)
    } catch (e) {
      toastError(e)
    }
  }

  const shot = async (rect?: { x: number; y: number; width: number; height: number }): Promise<Attachment[]> => {
    const wv = view.current
    if (!wv) return []
    // the page measures in its own pixels; the picture is cut in screen pixels, which differ when the page is zoomed
    const z = wv.getZoomFactor()
    const img = rect ? await wv.capturePage({ x: Math.max(0, Math.floor(rect.x * z)), y: Math.max(0, Math.floor(rect.y * z)), width: Math.max(1, Math.ceil(rect.width * z)), height: Math.max(1, Math.ceil(rect.height * z)) }) : await wv.capturePage()
    if (img.isEmpty()) return []
    const data = img.toDataURL()
    return [await prism.attachments.fromData(rect ? 'element.png' : 'page.png', 'image/png', data.slice(data.indexOf(',') + 1))]
  }

  const pick = async (): Promise<void> => {
    const wv = view.current
    if (!wv || !ready.current) return
    if (picking) {
      void wv.executeJavaScript('window.__prismPick && window.__prismPick.stop()').catch(() => {})
      return
    }
    setPicking(true)
    try {
      wv.focus()
      const r = (await wv.executeJavaScript(PICKER, true)) as Picked | null
      if (!r) return
      // the outline is gone by the next frame
      await new Promise((res) => setTimeout(res, 90))
      const pictures = await shot(r.rect).catch(() => [])
      const styles = Object.entries(r.styles)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
      handToAgent(
        `About this part of the page at ${wv.getURL()}:\n\n\`${r.selector}\`  (${r.tag}, ${Math.round(r.rect.width)} × ${Math.round(r.rect.height)} px)\n${r.text ? `Text: "${r.text.replace(/\s+/g, ' ').slice(0, 200)}"\n` : ''}Styles: ${styles}\n\`\`\`html\n${r.html}\n\`\`\`\n\n`,
        pictures
      )
    } catch (e) {
      toastError(e, 'Could not pick an element')
    } finally {
      setPicking(false)
    }
  }

  // the page's list of marks, read while marking up
  useEffect(() => {
    if (!markup) return
    const t = window.setInterval(() => {
      const wv = view.current
      if (!wv || !ready.current) return
      void wv
        .executeJavaScript('window.__prismMarkup ? { sel: window.__prismMarkup.selecting(), marks: window.__prismMarkup.list() } : null')
        .then((r: { sel: boolean; marks: Mark[] } | null) => {
          if (!r) return
          setSelecting(r.sel)
          setMarks((cur) => (JSON.stringify(cur) === JSON.stringify(r.marks) ? cur : r.marks))
        })
        .catch(() => {})
    }, 350)
    return () => window.clearInterval(t)
  }, [markup])

  const markupCall = (js: string): Promise<unknown> => view.current?.executeJavaScript(`window.__prismMarkup && window.__prismMarkup.${js}`) ?? Promise.resolve(null)
  const toggleMarkup = async (): Promise<void> => {
    const wv = view.current
    if (!wv || !ready.current) return
    if (markup) {
      await markupCall('stop()').catch(() => {})
      setMarkup(false)
      setMarks([])
      return
    }
    try {
      await wv.executeJavaScript(MARKUP_SCRIPT, true)
      setMarkup(true)
      setSelecting(true)
    } catch (e) {
      toastError(e, 'Could not mark up this page')
    }
  }
  const sendMarks = async (): Promise<void> => {
    const wv = view.current
    if (!wv) return
    try {
      await markupCall('select(false)')
      await new Promise((r) => setTimeout(r, 120))
      const pictures = await shot()
      const parts = marks.map((m) => {
        const note = notes[m.selector]?.trim()
        const tried = Object.entries(m.tried).map(([k, v]) => `${k}: ${v}`).join('; ')
        return [
          `${m.n}. \`${m.selector}\` (${m.tag}, ${Math.round(m.rect.width)} × ${Math.round(m.rect.height)} px)${m.text ? `, text "${m.text.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}`,
          note ? `   What I want: ${note}` : '',
          tried ? `   I tried these styles on the page and want them: ${tried}` : '',
          `   \`\`\`html\n   ${m.html.slice(0, 900).replace(/\n/g, '\n   ')}\n   \`\`\``
        ]
          .filter(Boolean)
          .join('\n')
      })
      handToAgent(`Changes I want on the page at ${wv.getURL()}. The numbers match the picture. Make them in the source files, then check the page.\n\n${parts.join('\n\n')}\n\n`, pictures)
      await markupCall('stop()')
      setMarkup(false)
      setMarks([])
      setNotes({})
    } catch (e) {
      toastError(e, 'Could not send it')
    }
  }

  const showAgent = async (): Promise<void> => {
    try {
      const wv = view.current
      if (!wv || !ready.current) return
      handToAgent(`Here is the page at ${wv.getURL()} as it looks now.\n\n`, await shot())
    } catch (e) {
      toastError(e, 'Could not take the picture')
    }
  }

  const problems = logs.filter((l) => l.level === 'error' || l.level === 'warn')
  const errors = logs.filter((l) => l.level === 'error').length
  const shown = onlyProblems ? problems : logs
  const fixProblems = (): void =>
    handToAgent(`The page at ${current} reports these in its console. Find the cause and fix it.\n\n\`\`\`\n${problems.slice(-25).map((l) => `[${l.level}] ${l.text}${l.source ? `  (${l.source.split('/').pop()}:${l.line})` : ''}`).join('\n')}\n\`\`\`\n`, [])

  const blank = current === 'about:blank' && !loading
  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn sm" disabled={!nav.back} title="Back" onClick={() => view.current?.goBack()}>
          <ArrowLeft size={14} />
        </button>
        <button className="icon-btn sm" disabled={!nav.forward} title="Forward" onClick={() => view.current?.goForward()}>
          <ArrowRight size={14} />
        </button>
        <button className="icon-btn sm" title={loading ? 'Stop loading' : 'Load the page again'} onClick={() => (loading ? view.current?.stop() : view.current?.reloadIgnoringCache())}>
          {loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <div className={cx('browser-url', loading && 'loading')}>
          <Globe size={12} className="faint" />
          <input
            value={address}
            spellCheck={false}
            placeholder="An address (localhost:5173), or a file in this project (index.html)"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void go(address)}
            onFocus={(e) => e.target.select()}
          />
        </div>
        {dev ? (
          <button className="btn sm" title={`Stop ${dev.command}`} onClick={() => void prism.terminals.kill(dev.id)}>
            <Square size={11} /> Stop server
          </button>
        ) : (
          scripts[0] && (
            <button className="btn sm" title={`Run ${scripts[0].command} in a terminal and open the page it serves`} onClick={() => void startDev(scripts[0]!)}>
              <Play size={11} /> Start server
            </button>
          )
        )}
        <span className="browser-sep" />
        <button className={cx('icon-btn sm', picking && 'on')} disabled={blank} title={picking ? 'Cancel picking (Esc)' : 'Pick something on the page and hand it to the agent'} onClick={() => void pick()}>
          <MousePointerClick size={14} />
        </button>
        <button className={cx('icon-btn sm', markup && 'on')} disabled={blank} title={markup ? 'Stop marking up' : 'Mark up the page: number several things, say what should change, try styles live'} onClick={() => void toggleMarkup()}>
          <PenLine size={14} />
        </button>
        <button className="icon-btn sm" disabled={blank} title="Show the agent this page (a picture goes into the message box)" onClick={() => void showAgent()}>
          <Camera size={14} />
        </button>
        <button className={cx('icon-btn sm', autoOn && 'on')} title={autoOn ? 'Reloading whenever a file changes. Click to stop.' : 'Reload the page whenever a file changes'} onClick={() => {
          const next = autoOn ? 'off' : 'on'
          localStorage.setItem('prism.browser.auto', next)
          setAuto(next)
        }}>
          <RefreshCw size={13} />
        </button>
        <button className={cx('icon-btn sm', a11yOpen && 'on')} disabled={blank} title="Check the page for accessibility problems: contrast, text size, labels for screen readers, sound" onClick={() => setA11yOpen((v) => !v)}>
          <Accessibility size={14} />
        </button>
        <button className={cx('icon-btn sm browser-console-btn', consoleOpen && 'on')} title="What the page printed (its console)" onClick={() => setConsoleOpen((v) => !v)}>
          <TerminalSquare size={14} />
          {errors > 0 && <span className="badge rose">{errors > 99 ? '99+' : errors}</span>}
        </button>
        <button className="icon-btn sm" disabled={blank} title="Open the page's developer tools" onClick={() => view.current?.openDevTools()}>
          <Bug size={13} />
        </button>
        <button className="icon-btn sm" disabled={blank} title="Open in your usual browser" onClick={() => window.open(current)}>
          <ExternalLink size={13} />
        </button>
      </div>
      <div className="browser-stage">
        <webview ref={view as unknown as React.Ref<HTMLElement>} src={initial} partition="persist:preview" className="browser-view" />
        {picking && <div className="browser-hint">Click something on the page. Esc cancels.</div>}
        {failed && (
          <div className="browser-cover">
            <Globe size={26} className="amber" />
            <div className="title">The page did not load</div>
            <div className="small faint">{failed}</div>
            <div className="small faint">If it is your dev server, it may not be running yet.</div>
            <button className="btn sm" onClick={() => void go(address)}>
              <RotateCw size={12} /> Try again
            </button>
          </div>
        )}
        {blank && !failed && (
          <div className="browser-cover">
            <Globe size={28} className="accent" />
            <div className="title">See your page here</div>
            <div className="small faint">Type an address above, or pick one of these.</div>
            <div className="browser-choices">
              {scripts.map((s) => (
                <button key={s.name} className="card choice" disabled={!!dev} onClick={() => void startDev(s)}>
                  <Play size={15} className="accent" />
                  <span className="t">Start the dev server</span>
                  <span className="d mono">{s.command}</span>
                </button>
              ))}
              <button className="card choice" onClick={() => void serveFolder()}>
                <FolderOpen size={15} className="accent" />
                <span className="t">Serve this folder</span>
                <span className="d">For plain HTML pages: opens index.html</span>
              </button>
            </div>
          </div>
        )}
      </div>
      {markup && (
        <MarkUpTray
          marks={marks}
          selecting={selecting}
          notes={notes}
          onNote={(selector, note) => setNotes((n) => ({ ...n, [selector]: note }))}
          onStyle={(n, prop, value) => void markupCall(`setStyle(${n}, ${JSON.stringify(prop)}, ${JSON.stringify(value)})`)}
          onRemove={(n) => void markupCall(`remove(${n})`)}
          onSelecting={(on) => void markupCall(`select(${on})`).then(() => setSelecting(on))}
          onSend={() => void sendMarks()}
          onClose={() => void toggleMarkup()}
        />
      )}
      {a11yOpen && !blank && (
        <A11yTray
          url={current}
          onClose={() => setA11yOpen(false)}
          onFix={(text, image) =>
            void (async () => {
              const pics = image ? [await prism.attachments.fromData('accessibility.jpg', image.mime, image.base64)] : []
              handToAgent(`The page at ${current} has these accessibility problems (numbers match the boxes in the picture). Fix them in the code, worst first, then check again with check_accessibility.

${text}
`, pics)
            })().catch((e) => toastError(e, 'Could not send it'))
          }
        />
      )}
      {consoleOpen && (
        <div className="browser-console">
          <div className="browser-console-bar">
            <span className="hud-label">Console</span>
            <span className="faint xs">
              {logs.length} line{logs.length === 1 ? '' : 's'}
              {problems.length ? ` · ${problems.length} warning${problems.length === 1 ? '' : 's'} or error${problems.length === 1 ? '' : 's'}` : ''}
            </span>
            <span className="grow" />
            <div className="seg">
              <button className={cx(!onlyProblems && 'on')} onClick={() => setOnlyProblems(false)}>
                all
              </button>
              <button className={cx(onlyProblems && 'on')} onClick={() => setOnlyProblems(true)}>
                problems
              </button>
            </div>
            <button className="btn sm primary" disabled={!problems.length} onClick={fixProblems} title="Put the warnings and errors in the message box">
              <Wrench size={12} /> Fix with Prism
            </button>
            <button className="icon-btn sm" title="Clear" onClick={() => setLogs([])}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="browser-console-body mono">
            {!shown.length && <div className="faint small" style={{ padding: '8px 12px' }}>Nothing printed yet.</div>}
            {shown.map((l, i) => (
              <div key={i} className={cx('console-line', l.level)}>
                <span className="txt">{l.text}</span>
                {l.source && (
                  <span className="src">
                    {l.source.split('/').pop()}:{l.line}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
