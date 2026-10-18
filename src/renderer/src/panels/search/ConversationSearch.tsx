// Search every conversation in the project. Results are grouped by conversation, newest first; clicking one
// opens that conversation at the match, with the find bar showing the same words.
import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, TextSearch } from 'lucide-react'
import { EMPTY_QUERY, type ConvHit, type ConvPart, type ConvQuery } from '@shared/convSearch'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useFind } from '@/state/find'
import { clockStamp, cx } from '@/lib/format'
import { PARTS } from '@/panels/agent/FindBar'
import { toastError } from '@/state/ui'

const PART_LABEL: Record<ConvPart, string> = { you: 'you', answers: 'answer', steps: 'step', thinking: 'thinking', notes: 'note' }

function Snippet({ text, marks }: { text: string; marks: Array<[number, number]> }): React.JSX.Element {
  const out: React.ReactNode[] = []
  let at = 0
  for (const [s, l] of marks) {
    if (s < at) continue
    if (s > at) out.push(text.slice(at, s))
    out.push(<mark key={s}>{text.slice(s, s + l)}</mark>)
    at = s + l
  }
  out.push(text.slice(at))
  return <span className="cs-snippet">{out}</span>
}

export function ConversationSearch(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const models = useApp((s) => s.models)
  const preset = useFind((s) => s.preset)
  const [q, setQ] = useState<ConvQuery>(EMPTY_QUERY)
  const [result, setResult] = useState<{ hits: ConvHit[]; more: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!preset) return
    setQ({ ...EMPTY_QUERY, ...preset })
    input.current?.focus()
  }, [preset?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const mine = ++seq.current
    const t = setTimeout(() => {
      if (!q.text.trim() && !q.errorsOnly && !q.file.trim()) {
        setResult(null)
        return
      }
      setBusy(true)
      void prism.conversations
        .search(q)
        .then((r) => mine === seq.current && setResult(r))
        .catch((e: unknown) => toastError(e, 'Search failed'))
        .finally(() => mine === seq.current && setBusy(false))
    }, 220)
    return () => clearTimeout(t)
  }, [q, workspace])

  const groups = useMemo(() => {
    const m = new Map<string, { title: string; hits: ConvHit[] }>()
    for (const h of result?.hits ?? []) {
      const g = m.get(h.sessionId) ?? { title: h.sessionTitle, hits: [] }
      g.hits.push(h)
      m.set(h.sessionId, g)
    }
    return [...m.entries()]
  }, [result])

  const set = (p: Partial<ConvQuery>): void => setQ((x) => ({ ...x, ...p }))
  const toggle = (part: ConvPart): void => set({ where: q.where.includes(part) ? q.where.filter((x) => x !== part) : [...q.where, part] })
  const openHit = (h: ConvHit): void => {
    useLayout.getState().openAgent()
    void useSessions
      .getState()
      .select(h.sessionId)
      .then(() => useFind.getState().open(h.sessionId, h.itemId, q.text))
  }
  const modelNames = useMemo(() => [...new Set(models.map((m) => m.modelId))].sort(), [models])

  if (!workspace) return <div className="cs-panel empty faint">Open a project to search its conversations.</div>

  return (
    <div className="cs-panel">
      <div className="cs-head">
        <div className="cs-search">
          <TextSearch size={15} className="faint" />
          <input ref={input} className="cs-input" placeholder='Search every conversation in this project ("a phrase" works)' value={q.text} onChange={(e) => set({ text: e.target.value })} />
          {busy && <span className="spinner" />}
        </div>
        <div className="cs-filters">
          {PARTS.map(([part, label]) => (
            <button key={part} className={cx('find-chip', q.where.includes(part) && 'on')} onClick={() => toggle(part)}>
              {label}
            </button>
          ))}
          <button className={cx('find-chip warn', q.errorsOnly && 'on')} onClick={() => set({ errorsOnly: !q.errorsOnly })} title="Only failed steps, errors and failed checks">
            Errors only
          </button>
        </div>
        <div className="cs-filters">
          <label className="cs-field">
            <span>Changed a file</span>
            <input className="input sm" placeholder="part of a path" value={q.file} onChange={(e) => set({ file: e.target.value })} />
          </label>
          <label className="cs-field">
            <span>When</span>
            <select className="input sm" value={q.since} onChange={(e) => set({ since: e.target.value as ConvQuery['since'] })}>
              <option value="any">Any time</option>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
          </label>
          <label className="cs-field">
            <span>How it ended</span>
            <select className="input sm" value={q.outcome} onChange={(e) => set({ outcome: e.target.value as ConvQuery['outcome'] })}>
              <option value="any">Any way</option>
              <option value="proven">Proven</option>
              <option value="not-proven">Not proven</option>
            </select>
          </label>
          <label className="cs-field">
            <span>Model</span>
            <input className="input sm" list="cs-models" placeholder="any" value={q.model} onChange={(e) => set({ model: e.target.value })} />
            <datalist id="cs-models">
              {modelNames.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>
      </div>
      <div className="cs-results">
        {!result && <div className="cs-hint faint">Type some words, or pick "Errors only" or a file, to see where they came up. Clicking a result opens that conversation at that point.</div>}
        {result && !result.hits.length && <div className="cs-hint faint">Nothing matches.</div>}
        {result && result.hits.length > 0 && (
          <div className="cs-count faint">
            {result.hits.length}
            {result.more ? '+' : ''} match{result.hits.length === 1 ? '' : 'es'} in {groups.length} conversation{groups.length === 1 ? '' : 's'}
          </div>
        )}
        {groups.map(([id, g]) => (
          <div key={id} className="cs-group">
            <div className="cs-group-head">
              <MessagesSquare size={13} className="accent" />
              <b className="truncate">{g.title}</b>
              <span className="faint xs">
                {g.hits.length} · {clockStamp(g.hits[0]!.ts)}
              </span>
            </div>
            {g.hits.slice(0, 30).map((h) => (
              <button key={`${h.itemId}:${h.part}`} className="cs-hit" onClick={() => openHit(h)}>
                <span className={cx('cs-part', h.part)}>{PART_LABEL[h.part]}</span>
                <span className="cs-body">
                  <span className="cs-label truncate">{h.label}</span>
                  <Snippet text={h.snippet} marks={h.marks} />
                </span>
                <span className="cs-time faint">{clockStamp(h.ts)}</span>
              </button>
            ))}
            {g.hits.length > 30 && <div className="cs-more faint xs">and {g.hits.length - 30} more in this conversation</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
