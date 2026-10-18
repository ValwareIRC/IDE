import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, WholeWord } from 'lucide-react'
import type { SearchMatch, SearchResult } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { cx } from '@/lib/format'
import { FileIcon } from '@/components/FileIcon'
import { registerSurface, report } from '@/demo/bus'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRegex(q: string, regex: boolean, cs: boolean, word: boolean): RegExp | null {
  try {
    let src = regex ? q : escapeRe(q)
    if (word) src = `\\b(?:${src})\\b`
    return new RegExp(src, cs ? 'g' : 'gi')
  } catch {
    return null
  }
}

export function SearchView(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const openEditor = useLayout((s) => s.openEditor)
  const [q, setQ] = useState('')
  const [regex, setRegex] = useState(false)
  const [cs, setCs] = useState(false)
  const [word, setWord] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  /** A result a demo is pointing at. */
  const [marked, setMarked] = useState<number | null>(null)
  const seq = useRef(0)

  const replaceIn = async (paths: string[]): Promise<void> => {
    const re = buildRegex(q, regex, cs, word)
    if (!re) {
      useUi.getState().toast('error', 'Invalid regular expression')
      return
    }
    let files = 0
    let count = 0
    setBusy(true)
    try {
      for (const p of paths) {
        const f = await prism.fs.read(p)
        if (f.binary || f.truncated) continue
        let n = 0
        const next = f.content.replace(re, (...m) => {
          n++
          // $1 style groups work in regex mode; literal mode inserts the replacement as-is.
          return regex ? String(m[0]).replace(re, replacement) : replacement
        })
        if (n > 0 && next !== f.content) {
          await prism.fs.write(p, next)
          void useEditor.getState().reload(p)
          files++
          count += n
        }
      }
      useUi.getState().toast('success', `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`)
      seq.current++
      setQ((v) => v) // re-run the search
      const r = await prism.fs.search({ query: q, regex, caseSensitive: cs, wholeWord: word, include: include || undefined, exclude: exclude || undefined, maxResults: 1500 })
      setResult(r)
    } catch (e) {
      toastError(e, 'Replace failed')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!workspace || !q.trim()) {
      setResult(null)
      return
    }
    const id = ++seq.current
    setBusy(true)
    const t = setTimeout(() => {
      void prism.fs
        .search({ query: q, regex, caseSensitive: cs, wholeWord: word, include: include || undefined, exclude: exclude || undefined, maxResults: 1500 })
        .then((r) => {
          if (id === seq.current) setResult(r)
        })
        .catch(() => {})
        .finally(() => id === seq.current && setBusy(false))
    }, 220)
    return () => clearTimeout(t)
  }, [q, regex, cs, word, include, exclude, workspace])

  const groups = useMemo(() => {
    const m = new Map<string, SearchMatch[]>()
    for (const x of result?.matches ?? []) {
      const l = m.get(x.path) ?? []
      l.push(x)
      m.set(x.path, l)
    }
    return [...m.entries()]
  }, [result])

  // a demo types in this box and clicks these results, rather than searching behind your back
  const drive = useRef<{ open(i: number): void; found(): string[] }>({ open: () => {}, found: () => [] })
  useEffect(() => {
    drive.current = {
      found: () => groups.map(([path]) => path),
      open: (i) => {
        const g = groups[i]
        const first = g?.[1][0]
        if (!g || !first) return
        openEditor(g[0], { line: first.line, column: first.column })
        report({ surface: 'search', what: 'opened', detail: g[0] })
      }
    }
  })
  useEffect(
    () =>
      registerSurface('search', {
        setQuery: setQ,
        found: () => drive.current.found(),
        open: (i) => drive.current.open(i),
        mark: setMarked
      }),
    []
  )

  return (
    <div className="side-view">
      <div className="side-head">
        <span className="hud-label">Search</span>
        <span className="grow" />
        {busy && <span className="spinner" />}
      </div>
      <div className="search-form">
        <div className="row">
          <input className="input sm grow" data-demo="search:input" placeholder="Search in files" value={q} onChange={(e) => {
            setQ(e.target.value)
            report({ surface: 'search', what: 'typed', detail: e.target.value })
          }} autoFocus />
          <button className={cx('icon-btn sm', cs && 'on')} title="Match case" onClick={() => setCs((v) => !v)}>
            <CaseSensitive size={14} />
          </button>
          <button className={cx('icon-btn sm', word && 'on')} title="Whole word" onClick={() => setWord((v) => !v)}>
            <WholeWord size={14} />
          </button>
          <button className={cx('icon-btn sm', regex && 'on')} title="Regular expression" onClick={() => setRegex((v) => !v)}>
            <Regex size={14} />
          </button>
          <button className={cx('icon-btn sm', showReplace && 'on')} title="Replace" onClick={() => setShowReplace((v) => !v)}>
            <Replace size={14} />
          </button>
        </div>
        {showReplace && (
          <div className="row">
            <input className="input sm grow" placeholder={regex ? 'Replace ($1 for groups)' : 'Replace with'} value={replacement} onChange={(e) => setReplacement(e.target.value)} />
            <button className="btn sm" title="Replace in every matching file" disabled={!result || !result.matches.length || busy} onClick={() => void replaceIn([...new Set(result!.matches.map((m) => m.path))])}>
              <ReplaceAll size={13} /> All
            </button>
          </div>
        )}
        <div className="row">
          <input className="input sm grow" placeholder="include: src/**, *.ts" value={include} onChange={(e) => setInclude(e.target.value)} />
          <input className="input sm grow" placeholder="exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} />
        </div>
        {result && (
          <div className="faint xs">
            {result.matches.length} result{result.matches.length === 1 ? '' : 's'} in {result.files} file{result.files === 1 ? '' : 's'}
            {result.truncated ? ' (truncated)' : ''} · {result.durationMs}ms
          </div>
        )}
      </div>
      <div className="side-body tree">
        {groups.map(([path, matches], gi) => {
          const open = !collapsed.has(path)
          return (
            <div key={path}>
              <div
                className={cx('tree-row', marked === gi && 'demo-mark')}
                data-demo={`search:result:${gi}`}
                style={{ paddingLeft: 6 }}
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c)
                    if (n.has(path)) n.delete(path)
                    else n.add(path)
                    return n
                  })
                }
              >
                <span className="chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                <span className="ficon">
                  <FileIcon name={path} />
                </span>
                <span className="name" title={path}>
                  {path.split('/').pop()}
                  <span className="faint"> {path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</span>
                </span>
                {showReplace && (
                  <button
                    className="icon-btn sm"
                    title="Replace in this file"
                    onClick={(e) => {
                      e.stopPropagation()
                      void replaceIn([path])
                    }}
                  >
                    <Replace size={12} />
                  </button>
                )}
                <span className="meta">{matches.length}</span>
              </div>
              {open &&
                matches.map((m, i) => (
                  <div key={i} className="tree-row search-hit" style={{ paddingLeft: 30 }} onClick={() => {
                      openEditor(path, { line: m.line, column: m.column })
                      report({ surface: 'search', what: 'opened', detail: path })
                    }} title={`${path}:${m.line}`}>
                    <span className="meta" style={{ marginLeft: 0, marginRight: 6 }}>
                      {m.line}
                    </span>
                    <span className="name mono small">
                      {m.text.slice(Math.max(0, m.matchStart - 40), m.matchStart)}
                      <mark>{m.text.slice(m.matchStart, m.matchEnd)}</mark>
                      {m.text.slice(m.matchEnd, m.matchEnd + 80)}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
        {q && result && result.matches.length === 0 && !busy && <div className="faint small" style={{ padding: 12 }}>No results</div>}
      </div>
    </div>
  )
}
