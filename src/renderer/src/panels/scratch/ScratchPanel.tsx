import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eraser, Loader2, Play, Plus, RotateCcw, Send, Square, Trash2 } from 'lucide-react'
import type { ScratchLang, ScratchOutput, ScratchStatus } from '@shared/types'
import { prism } from '@/lib/ipc'
import { setupMonaco, monaco } from '@/lib/monaco'
import { currentTheme, fontStack } from '@/theme/apply'
import { useApp } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { cx } from '@/lib/format'

const FILE = '.prism/scratch.json'
const LANGS: Array<{ id: ScratchLang; label: string; monaco: string }> = [
  { id: 'js', label: 'JavaScript', monaco: 'javascript' },
  { id: 'ts', label: 'TypeScript', monaco: 'typescript' },
  { id: 'python', label: 'Python', monaco: 'python' }
]

interface Cell {
  id: string
  lang: ScratchLang
  code: string
}

interface Result {
  outputs: ScratchOutput[]
  running: boolean
  ok: boolean | null
  ms: number | null
}

const newId = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const blank = (lang: ScratchLang): Cell => ({ id: newId(), lang, code: '' })

let modelSeq = 0
const EXT: Record<ScratchLang, string> = { js: 'js', ts: 'ts', python: 'py' }
function modelFor(id: string, lang: ScratchLang, code: string): monaco.editor.ITextModel {
  return monaco.editor.createModel(code, LANGS.find((l) => l.id === lang)!.monaco, monaco.Uri.parse(`inmemory://scratch/${id}-${++modelSeq}.${EXT[lang]}`))
}

/** One piece of what a cell produced. */
function Output({ o }: { o: ScratchOutput }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  if (o.kind === 'table') {
    return (
      <div className="out-table">
        <table>
          <thead>
            <tr>
              {o.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {o.rows.slice(0, 200).map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'num' : undefined}>
                    {v === null ? <span className="faint">–</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {o.total > Math.min(200, o.rows.length) && <div className="faint xs out-more">Showing the first {Math.min(200, o.rows.length)} of {o.total} rows.</div>}
      </div>
    )
  }
  if (o.kind === 'image') return <img className="out-image" src={o.src} alt="output" />
  if (o.kind === 'html') {
    const css = getComputedStyle(document.documentElement)
    const doc = `<style>body{margin:8px;font:13px system-ui,sans-serif;color:${css.getPropertyValue('--text')};background:transparent}table{border-collapse:collapse}td,th{border:1px solid ${css.getPropertyValue('--text-4')};padding:3px 8px;text-align:left}th{font-weight:600}a{color:${css.getPropertyValue('--accent')}}</style>${o.html}`
    // scripts in the output do not run: it is shown, not executed
    return (
      <iframe
        ref={frame}
        className="out-html"
        title="output"
        sandbox="allow-same-origin"
        srcDoc={doc}
        onLoad={() => {
          const f = frame.current
          const h = f?.contentDocument?.documentElement.scrollHeight
          if (f && h) f.style.height = `${Math.min(520, h + 4)}px`
        }}
      />
    )
  }
  return <pre className={cx('out-text mono', o.kind)}>{o.text}</pre>
}

function CellEditor({ cell, onChange, onRun, onRunNext, focusKey }: { cell: Cell; onChange: (code: string) => void; onRun: () => void; onRunNext: () => void; focusKey: number }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // the editor is created once; the handlers it calls must always be the latest
  const handlers = useRef({ onChange, onRun, onRunNext })
  handlers.current = { onChange, onRun, onRunNext }

  useEffect(() => {
    if (!host.current) return
    const m = setupMonaco()
    const model = modelFor(cell.id, cell.lang, cell.code)
    const e = m.editor.create(host.current, {
      model,
      theme: 'prism',
      automaticLayout: true,
      fontFamily: fontStack(currentTheme().look.fontMono, true),
      fontSize: useApp.getState().settings?.editor.fontSize ?? 13,
      lineHeight: 20,
      minimap: { enabled: false },
      lineNumbers: 'on',
      lineNumbersMinChars: 2,
      glyphMargin: false,
      folding: false,
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      padding: { top: 8, bottom: 8 },
      tabSize: cell.lang === 'python' ? 4 : 2,
      wordWrap: 'on',
      // the notebook scrolls, not each cell
      scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false, horizontalScrollbarSize: 8 }
    })
    ed.current = e
    const fit = (): void => {
      if (host.current) host.current.style.height = `${Math.max(36, Math.min(600, e.getContentHeight()))}px`
    }
    e.onDidContentSizeChange(fit)
    fit()
    e.onDidChangeModelContent(() => handlers.current.onChange(e.getValue()))
    e.addCommand(m.KeyMod.Shift | m.KeyCode.Enter, () => handlers.current.onRunNext())
    e.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => handlers.current.onRun())
    return () => {
      ed.current = null
      const last = e.getModel()
      e.dispose()
      last?.dispose()
    }
    // the cell's text is the editor's own from here on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.id])

  // a different language means a different kind of file: the text moves into a fresh one
  useEffect(() => {
    const e = ed.current
    const old = e?.getModel()
    if (!e || !old || old.getLanguageId() === LANGS.find((l) => l.id === cell.lang)!.monaco) return
    e.setModel(modelFor(cell.id, cell.lang, old.getValue()))
    old.dispose()
  }, [cell.id, cell.lang])

  useEffect(() => {
    if (focusKey) ed.current?.focus()
  }, [focusKey])

  return <div className="cell-code" ref={host} />
}

/** A notebook for trying things against the project: cells of JavaScript, TypeScript or Python, run in a session that remembers. */
export function ScratchPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [cells, setCells] = useState<Cell[] | null>(null)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [status, setStatus] = useState<ScratchStatus | null>(null)
  const [focus, setFocus] = useState<{ id: string; n: number }>({ id: '', n: 0 })
  const saveTimer = useRef<number | null>(null)
  const latest = useRef<Cell[]>([])

  // the notebook is a file in the project, so it is there next time
  useEffect(() => {
    let alive = true
    setCells(null)
    setResults({})
    void prism.fs
      .read(FILE)
      .then((f) => {
        const list = (JSON.parse(f.content) as { cells?: Cell[] }).cells?.filter((c) => typeof c.code === 'string' && LANGS.some((l) => l.id === c.lang))
        if (alive) setCells(list?.length ? list.map((c) => ({ id: c.id || newId(), lang: c.lang, code: c.code })) : [blank('js')])
      })
      .catch(() => alive && setCells([blank('js')]))
    void prism.scratch.status().then((s) => alive && setStatus(s)).catch(() => {})
    return () => {
      alive = false
    }
  }, [workspace])

  useEffect(() => {
    if (!cells) return
    latest.current = cells
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      // an untouched, empty notebook is not worth a file
      if (cells.length === 1 && !cells[0]!.code.trim()) return
      void prism.fs.write(FILE, `${JSON.stringify({ cells }, null, 2)}\n`).catch(() => {})
    }, 700)
  }, [cells])

  useEffect(() => {
    return prism.scratch.onEvent((ev) => {
      setResults((r) => {
        const cur = r[ev.cell] ?? { outputs: [], running: true, ok: null, ms: null }
        if (ev.type === 'done') return { ...r, [ev.cell]: { ...cur, running: false, ok: ev.ok, ms: ev.ms } }
        const last = cur.outputs[cur.outputs.length - 1]
        const o = ev.output
        // printed text arrives in pieces; pieces of the same sort belong together
        const joinable = (o.kind === 'text' || o.kind === 'stderr') && last && last.kind === o.kind
        const outputs = joinable ? [...cur.outputs.slice(0, -1), { ...last, text: (last.text + o.text).slice(-200_000) }] : [...cur.outputs, o].slice(-200)
        return { ...r, [ev.cell]: { ...cur, outputs } }
      })
    })
  }, [])

  const run = useCallback(async (id: string): Promise<void> => {
    const cell = latest.current.find((c) => c.id === id)
    if (!cell || !cell.code.trim()) return
    setResults((r) => ({ ...r, [id]: { outputs: [], running: true, ok: null, ms: null } }))
    try {
      await prism.scratch.run(id, cell.lang, cell.code)
      if (cell.lang === 'python') void prism.scratch.status().then(setStatus).catch(() => {})
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { outputs: [{ kind: 'error', text: e instanceof Error ? e.message : String(e) }], running: false, ok: false, ms: null } }))
    }
  }, [])

  if (!cells) return <div className="empty">Opening the scratchpad…</div>
  if (!workspace) return <div className="empty">Open a folder first: the scratchpad runs code against a project.</div>

  const patch = (id: string, p: Partial<Cell>): void => setCells((list) => (list ?? []).map((c) => (c.id === id ? { ...c, ...p } : c)))
  const addAfter = (id: string | null, lang: ScratchLang): void => {
    const c = blank(lang)
    setCells((list) => {
      const l = list ?? []
      const i = id ? l.findIndex((x) => x.id === id) : l.length - 1
      return [...l.slice(0, i + 1), c, ...l.slice(i + 1)]
    })
    setFocus({ id: c.id, n: Date.now() })
  }
  const move = (id: string, by: number): void =>
    setCells((list) => {
      const l = [...(list ?? [])]
      const i = l.findIndex((c) => c.id === id)
      const j = i + by
      if (i < 0 || j < 0 || j >= l.length) return l
      ;[l[i], l[j]] = [l[j]!, l[i]!]
      return l
    })
  const runNext = (id: string): void => {
    void run(id)
    const i = cells.findIndex((c) => c.id === id)
    const next = cells[i + 1]
    if (next) setFocus({ id: next.id, n: Date.now() })
    else addAfter(id, cells[i]?.lang ?? 'js')
  }
  const runAll = async (): Promise<void> => {
    for (const c of latest.current) await run(c.id)
  }
  const restart = async (): Promise<void> => {
    await prism.scratch.stop().catch(toastError)
    useUi.getState().toast('info', 'Started afresh', 'Everything the cells had defined is forgotten. Results stay until you run again.')
  }
  const toAgent = (c: Cell): void => {
    const res = results[c.id]
    const out = (res?.outputs ?? [])
      .map((o) => (o.kind === 'table' ? `${o.columns.join(' | ')}\n${o.rows.slice(0, 20).map((r) => r.join(' | ')).join('\n')}` : o.kind === 'image' ? '(a picture)' : o.kind === 'html' ? '(formatted output)' : o.text))
      .join('\n')
      .slice(0, 4000)
    const fence = '```'
    const text = `From my scratchpad (${LANGS.find((l) => l.id === c.lang)!.label}):\n${fence}${c.lang === 'python' ? 'python' : c.lang}\n${c.code}\n${fence}\n${out ? `It gave:\n${fence}\n${out}\n${fence}\n` : ''}\n`
    useLayout.getState().openAgent()
    const st = useSessions.getState()
    if (st.active) st.hand(st.active, text)
    else void st.create().then((s) => s && useSessions.getState().hand(s.id, text))
  }

  const anyRunning = Object.values(results).some((r) => r.running)
  return (
    <div className="scratch">
      <div className="scratch-bar">
        <button className="btn sm solid" disabled={anyRunning} onClick={() => void runAll()} title="Run every cell from the top">
          <Play size={12} /> Run all
        </button>
        <button className="btn sm ghost" onClick={() => void restart()} title="Stop whatever is running and forget what the cells defined">
          <RotateCcw size={12} /> Start afresh
        </button>
        <button className="btn sm ghost" onClick={() => setResults({})} title="Remove the results from view">
          <Eraser size={12} /> Clear results
        </button>
        <span className="grow" />
        <span className="faint small">
          Shift+Enter runs a cell and moves on · JavaScript {status ? `(Node ${status.node})` : ''} · {status?.python ? `Python${status.python.version ? ` ${status.python.version}` : ''}` : 'Python not found'}
        </span>
      </div>
      <div className="scratch-cells">
        {cells.map((c, i) => {
          const res = results[c.id]
          return (
            <div key={c.id} className={cx('cell', res?.running && 'running', res?.ok === false && 'failed')}>
              <div className="cell-head">
                {res?.running ? (
                  <button className="icon-btn sm" title="Stop (this also forgets what the cells defined)" onClick={() => void prism.scratch.stop()}>
                    <Square size={12} />
                  </button>
                ) : (
                  <button className="icon-btn sm run" title="Run this cell (Ctrl+Enter)" onClick={() => void run(c.id)}>
                    <Play size={13} />
                  </button>
                )}
                <div className="seg">
                  {LANGS.map((l) => (
                    <button key={l.id} className={cx(c.lang === l.id && 'on')} onClick={() => patch(c.id, { lang: l.id })}>
                      {l.label}
                    </button>
                  ))}
                </div>
                {res?.running && (
                  <span className="faint xs">
                    <Loader2 size={11} className="spin-slow" /> running
                  </span>
                )}
                {res && !res.running && res.ms !== null && <span className={cx('xs mono', res.ok ? 'faint' : 'rose')}>{res.ok ? `${res.ms} ms` : 'failed'}</span>}
                <span className="grow" />
                <button className="icon-btn sm" title="Hand this cell and its result to the agent" onClick={() => toAgent(c)}>
                  <Send size={12} />
                </button>
                <button className="icon-btn sm" disabled={i === 0} title="Move up" onClick={() => move(c.id, -1)}>
                  <ArrowUp size={12} />
                </button>
                <button className="icon-btn sm" disabled={i === cells.length - 1} title="Move down" onClick={() => move(c.id, 1)}>
                  <ArrowDown size={12} />
                </button>
                <button
                  className="icon-btn sm"
                  title="Delete this cell"
                  onClick={() => setCells((list) => ((list ?? []).length > 1 ? (list ?? []).filter((x) => x.id !== c.id) : [blank(c.lang)]))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <CellEditor cell={c} onChange={(code) => patch(c.id, { code })} onRun={() => void run(c.id)} onRunNext={() => runNext(c.id)} focusKey={focus.id === c.id ? focus.n : 0} />
              {res && res.outputs.length > 0 && (
                <div className="cell-out">
                  {res.outputs.map((o, k) => (
                    <Output key={k} o={o} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div className="cell-add">
          <Plus size={12} className="faint" />
          {LANGS.map((l) => (
            <button key={l.id} className="btn sm ghost" onClick={() => addAfter(null, l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
