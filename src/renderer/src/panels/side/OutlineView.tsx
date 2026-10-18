import { useEffect, useMemo, useRef, useState } from 'react'
import { ListTree } from 'lucide-react'
import { useEditor } from '@/state/editor'
import { useLayout } from '@/state/layout'
import { useOutline, symbolsAt } from '@/state/outline'
import { cx } from '@/lib/format'

const KIND_LETTER: Record<string, string> = { function: 'ƒ', method: 'm', class: 'C', interface: 'I', type: 'T', enum: 'E', variable: 'v', property: 'p', heading: '#', section: '§' }

/** The shape of the file you are in: functions, classes, headings. Click to jump; it follows your cursor. */
export function OutlineView(): React.JSX.Element {
  const path = useEditor((s) => s.active)
  const symbols = useOutline((s) => (path ? s.symbols[path] : undefined))
  const cursor = useOutline((s) => (path ? s.cursor[path] : undefined))
  const openEditor = useLayout((s) => s.openEditor)
  const [q, setQ] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (path) useOutline.getState().refresh(path)
  }, [path])

  const current = useMemo(() => {
    const chain = symbols && cursor ? symbolsAt(symbols, cursor) : []
    return chain[chain.length - 1]
  }, [symbols, cursor])

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return ql ? (symbols ?? []).filter((s) => s.name.toLowerCase().includes(ql)) : (symbols ?? [])
  }, [symbols, q])

  useEffect(() => {
    listRef.current?.querySelector('.outline-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  return (
    <div className="side-view">
      <div className="side-head">
        <span className="hud-label">Outline</span>
        <span className="grow" />
        {path && <span className="faint xs truncate">{path.split('/').pop()}</span>}
      </div>
      {path && (symbols?.length ?? 0) > 8 && (
        <div style={{ padding: '0 10px 8px' }}>
          <input className="input sm" style={{ width: '100%' }} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="side-body" ref={listRef}>
        {!path && (
          <div className="empty">
            <ListTree size={24} className="accent" />
            <div>No file open</div>
            <div className="small faint">Open a file to see its functions, classes and headings here.</div>
          </div>
        )}
        {path && symbols && symbols.length === 0 && <div className="faint small" style={{ padding: 12 }}>Nothing to list in this file.</div>}
        {path &&
          shown.map((s) => (
            <button
              key={`${s.line}:${s.name}`}
              className={cx('outline-row', current === s && 'on')}
              style={{ paddingLeft: 10 + (q ? 0 : s.depth) * 13 }}
              onClick={() => openEditor(path, { line: s.line })}
              title={`${s.kind} · line ${s.line}`}
            >
              <span className={cx('sym-kind', `k-${s.kind}`)}>{KIND_LETTER[s.kind] ?? '·'}</span>
              <span className="truncate grow">{s.name}</span>
              <span className="faint xs">{s.line}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
