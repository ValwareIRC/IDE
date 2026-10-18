import { useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, ChevronRight, Cpu, Hash, Lock, Map as MapIcon, MessagesSquare, Search, ShieldCheck, Unlock } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useUi } from '@/state/ui'
import { useLayout } from '@/state/layout'
import { useApp, modelKey } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useEditor } from '@/state/editor'
import { opensInPreview } from '@/lib/languages'
import { cx, timeAgo } from '@/lib/format'
import { FileIcon } from '@/components/FileIcon'
import { askPrism, fuzzy, listCommands, recentCommandIds, runCommand } from '@/lib/commands'
import { symbolsFor, type SymbolEntry } from '@/lib/symbols'

type Mode = NonNullable<ReturnType<typeof useUi.getState>['palette']>

interface Row {
  key: string
  icon?: React.ReactNode
  label: string
  marks?: number[]
  /** Dim text right after the label (a folder, a model's provider…). */
  detail?: string
  hint?: string
  group?: string
  indent?: number
  run: () => void
}

const PREFIX: Record<string, Mode> = { '>': 'commands', '@': 'symbols', ':': 'line', '#': 'sessions' }
const PREFIX_OF: Partial<Record<Mode, string>> = { commands: '>', symbols: '@', line: ':', sessions: '#' }

const KIND_LETTER: Record<string, string> = { function: 'ƒ', method: 'm', class: 'C', interface: 'I', type: 'T', enum: 'E', variable: 'v', property: 'p', heading: '#', section: '§' }

const MODES: Array<{ id: PermissionMode; label: string; detail: string; icon: React.ReactNode }> = [
  { id: 'plan', label: 'Plan first', detail: 'Prism only reads, then shows you a plan to approve', icon: <MapIcon size={14} /> },
  { id: 'ask', label: 'Ask first', detail: 'Prism asks before it changes or runs anything', icon: <Lock size={14} /> },
  { id: 'auto-edit', label: 'Edit freely', detail: 'File edits go ahead; commands still ask', icon: <ShieldCheck size={14} /> },
  { id: 'auto', label: 'Full auto', detail: 'Nothing asks, except what your rules block', icon: <Unlock size={14} /> }
]

function Marked({ text, marks }: { text: string; marks?: number[] }): React.JSX.Element {
  if (!marks?.length) return <>{text}</>
  const set = new Set(marks)
  const out: React.ReactNode[] = []
  let run = ''
  let on = false
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== on && run) {
      out.push(on ? <mark key={i}>{run}</mark> : run)
      run = ''
    }
    on = m
    run += text[i]
  }
  if (run) out.push(on ? <mark key="end">{run}</mark> : run)
  return <>{out}</>
}

/** One box for everything: files, commands (>), symbols (@), lines (:), sessions (#), and quick switches. */
export function CommandPalette(): React.JSX.Element | null {
  const opened = useUi((s) => s.palette)
  const setPalette = useUi((s) => s.setPalette)
  const workspace = useApp((s) => s.workspace)
  const models = useApp((s) => s.models)
  const endpoints = useApp((s) => s.endpoints)
  const sessions = useSessions((s) => s.sessions)
  const activeSession = useSessions((s) => s.active)
  const activeFile = useEditor((s) => s.active)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [symbols, setSymbols] = useState<SymbolEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const fixed = opened === 'models' || opened === 'modes'
  const mode: Mode = fixed ? opened : (PREFIX[q[0] ?? ''] ?? 'files')
  const query = (fixed || !PREFIX[q[0] ?? ''] ? q : q.slice(1)).trim()

  useEffect(() => {
    if (!opened) return
    setQ(PREFIX_OF[opened] ?? '')
    setSel(0)
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [opened])

  useEffect(() => {
    if (!opened || mode !== 'files' || !workspace) return
    let alive = true
    void prism.fs
      .quickOpen(query, 50)
      .then((f) => alive && setFiles(f))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [query, opened, mode, workspace])

  useEffect(() => {
    if (!opened || mode !== 'symbols' || !activeFile) return
    let alive = true
    void symbolsFor(activeFile).then((s) => alive && setSymbols(s))
    return () => {
      alive = false
    }
  }, [opened, mode, activeFile])

  const rows = useMemo<Row[]>(() => {
    if (!opened) return []
    const layout = useLayout.getState()
    const openFile = (f: string): void => (opensInPreview(f) ? layout.openPreview(f) : layout.openEditor(f))

    if (mode === 'commands') {
      const all = listCommands()
      const row = (c: (typeof all)[number], group?: string, marks?: number[]): Row => ({ key: `${group ?? ''}${c.id}`, label: c.label, marks, hint: c.key, group, run: () => runCommand(c) })
      if (!query) {
        const recent = recentCommandIds()
          .map((id) => all.find((c) => c.id === id))
          .filter((c): c is (typeof all)[number] => !!c)
        return [...recent.map((c) => row(c, 'Recently used')), ...all.map((c) => row(c, recent.length ? 'Everything' : undefined))]
      }
      const found = all
        .map((c) => ({ c, m: fuzzy(query, c.label) }))
        .filter((x): x is { c: (typeof all)[number]; m: NonNullable<ReturnType<typeof fuzzy>> } => !!x.m)
        .sort((a, b) => b.m.score - a.m.score)
        .map((x) => row(x.c, undefined, x.m.marks))
      // a sentence rather than a command name: let the agent do it ("turn off the minimap", "open the task board")
      const ask: Row[] = query.trim().split(/\s+/).length >= 2 ? [{ key: 'ask-prism', label: `Ask Prism to do this: ${query.trim()}`, group: found.length ? 'Or' : undefined, run: () => askPrism(query.trim()) }] : []
      return [...found.slice(0, 60), ...ask]
    }

    if (mode === 'symbols') {
      if (!activeFile) return []
      const found = query
        ? symbols
            .map((s) => ({ s, m: fuzzy(query, s.name) }))
            .filter((x): x is { s: SymbolEntry; m: NonNullable<ReturnType<typeof fuzzy>> } => !!x.m)
            .sort((a, b) => b.m.score - a.m.score)
        : symbols.map((s) => ({ s, m: { score: 0, marks: [] as number[] } }))
      return found.map(({ s, m }) => ({
        key: `${s.line}:${s.name}`,
        icon: <span className={cx('sym-kind', `k-${s.kind}`)}>{KIND_LETTER[s.kind] ?? '·'}</span>,
        label: s.name,
        marks: m.marks,
        hint: `line ${s.line}`,
        indent: query ? 0 : s.depth,
        run: () => layout.openEditor(activeFile, { line: s.line })
      }))
    }

    if (mode === 'line') {
      if (!activeFile) return []
      const m = /^(\d+)(?:[:,](\d+))?$/.exec(query)
      const total = useEditor.getState().docs[activeFile]?.content.split('\n').length ?? 0
      if (!m) return [{ key: 'hint', label: `Type a line number between 1 and ${total}`, run: () => {} }]
      const line = Math.max(1, Math.min(total || 1, Number(m[1])))
      const column = m[2] ? Number(m[2]) : undefined
      return [{ key: 'go', label: `Go to line ${line}${column ? `, column ${column}` : ''}`, detail: activeFile, run: () => layout.openEditor(activeFile, { line, column }) }]
    }

    if (mode === 'sessions') {
      const pick = (id: string): void => {
        layout.openAgent()
        void useSessions.getState().select(id)
      }
      return sessions
        .map((s) => ({ s, m: fuzzy(query, s.title) }))
        .filter((x): x is { s: (typeof sessions)[number]; m: NonNullable<ReturnType<typeof fuzzy>> } => !!x.m)
        .sort((a, b) => (query ? b.m.score - a.m.score : b.s.updatedAt - a.s.updatedAt))
        .map(({ s, m }) => ({
          key: s.id,
          icon: <span className={cx('dot', s.status === 'running' && 'live', s.status === 'waiting' && 'amber')} />,
          label: s.title,
          marks: m.marks,
          detail: s.id === activeSession ? 'current' : undefined,
          hint: timeAgo(s.updatedAt),
          run: () => pick(s.id)
        }))
    }

    if (mode === 'models') {
      const current = sessions.find((s) => s.id === activeSession)?.model ?? useApp.getState().settings?.roles.lead ?? null
      const curKey = current ? modelKey(current) : ''
      return models
        .map((mdl) => ({ mdl, m: fuzzy(query, mdl.label ?? mdl.modelId) }))
        .filter((x): x is { mdl: (typeof models)[number]; m: NonNullable<ReturnType<typeof fuzzy>> } => !!x.m)
        .sort((a, b) => (query ? b.m.score - a.m.score : Number(b.mdl.favorite) - Number(a.mdl.favorite)))
        .map(({ mdl, m }) => {
          const ref = { endpointId: mdl.endpointId, modelId: mdl.modelId }
          return {
            key: modelKey(ref),
            icon: <Cpu size={14} className={modelKey(ref) === curKey ? 'accent' : 'faint'} />,
            label: mdl.label ?? mdl.modelId,
            marks: m.marks,
            detail: endpoints.find((e) => e.id === mdl.endpointId)?.name ?? mdl.endpointName,
            hint: modelKey(ref) === curKey ? 'in use' : undefined,
            run: () => void useSessions.getState().setModel(ref)
          }
        })
    }

    if (mode === 'modes') {
      const cur = sessions.find((s) => s.id === activeSession)?.mode ?? useApp.getState().settings?.permissions.mode
      return MODES.filter((x) => !query || fuzzy(query, x.label)).map((x) => ({
        key: x.id,
        icon: x.icon,
        label: x.label,
        detail: x.detail,
        hint: cur === x.id ? 'in use' : undefined,
        run: () => void useSessions.getState().setMode(x.id)
      }))
    }

    // files
    const fileRow = (f: string, group?: string): Row => {
      const name = f.split('/').pop() ?? f
      const m = query ? fuzzy(query, name) : null
      return { key: `${group ?? ''}${f}`, icon: <FileIcon name={f} />, label: name, marks: m?.marks, detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', group, run: () => openFile(f) }
    }
    if (!query) {
      const open = Object.keys(useEditor.getState().docs)
      return [...open.map((f) => fileRow(f, 'Open now')), ...files.filter((f) => !open.includes(f)).map((f) => fileRow(f, open.length ? 'In this project' : undefined))]
    }
    return files.map((f) => fileRow(f))
  }, [opened, mode, query, files, symbols, sessions, activeSession, activeFile, models, endpoints])

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!opened) return null

  const run = (r: Row | undefined): void => {
    if (!r) return
    setPalette(null)
    r.run()
  }

  const icon =
    mode === 'commands' ? <ChevronRight size={16} className="accent" /> : mode === 'symbols' ? <AtSign size={16} className="accent" /> : mode === 'line' ? <Hash size={16} className="accent" /> : mode === 'sessions' ? <MessagesSquare size={16} className="accent" /> : mode === 'models' ? <Cpu size={16} className="accent" /> : mode === 'modes' ? <ShieldCheck size={16} className="accent" /> : <Search size={16} className="faint" />
  const placeholder = mode === 'models' ? 'Switch model for this session' : mode === 'modes' ? 'How much may Prism do without asking?' : 'Go to file'
  const empty =
    mode === 'files' && !workspace
      ? 'Open a folder first'
      : (mode === 'symbols' || mode === 'line') && !activeFile
        ? 'Open a file first'
        : mode === 'symbols' && !symbols.length
          ? 'Nothing to jump to in this file'
          : 'Nothing matches'

  let lastGroup: string | undefined
  return (
    <>
      <div className="modal-overlay soft" onMouseDown={() => setPalette(null)} />
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          {icon}
          <input
            ref={inputRef}
            value={q}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => (rows.length ? (s + 1) % rows.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(rows[sel])
              } else if (e.key === 'Escape') setPalette(null)
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.map((r, i) => {
            const head = r.group && r.group !== lastGroup ? r.group : null
            lastGroup = r.group
            return (
              <div key={r.key}>
                {head && <div className="palette-group">{head}</div>}
                <button className={cx('palette-item', i === sel && 'sel')} style={r.indent ? { paddingLeft: 10 + r.indent * 14 } : undefined} onMouseMove={() => i !== sel && setSel(i)} onClick={() => run(r)}>
                  {r.icon}
                  <span className="palette-label">
                    <Marked text={r.label} marks={r.marks} />
                  </span>
                  {r.detail && <span className="path truncate">{r.detail}</span>}
                  {r.hint && <span className="hint">{r.hint}</span>}
                </button>
              </div>
            )
          })}
          {rows.length === 0 && <div className="palette-empty">{empty}</div>}
        </div>
        {!fixed && (
          <div className="palette-foot">
            <span>
              <b>&gt;</b> commands
            </span>
            <span>
              <b>@</b> jump to a function
            </span>
            <span>
              <b>:</b> line
            </span>
            <span>
              <b>#</b> sessions
            </span>
            <span className="grow" />
            <span>↑↓ move · Enter open</span>
          </div>
        )}
      </div>
    </>
  )
}
