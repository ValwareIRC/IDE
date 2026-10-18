// Ctrl+F inside a conversation: words or "a phrase", which parts to look in, errors only; Enter goes to the
// next match (Shift+Enter the one before), opening the step it is in.
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, TextSearch, X } from 'lucide-react'
import type { ConvPart } from '@shared/convSearch'
import { cx } from '@/lib/format'

export const PARTS: Array<[ConvPart, string]> = [
  ['you', 'You'],
  ['answers', 'Answers'],
  ['steps', 'Steps'],
  ['thinking', 'Thinking'],
  ['notes', 'Checks & news']
]

export function FindBar(p: {
  query: string
  onQuery: (q: string) => void
  where: ConvPart[]
  onWhere: (w: ConvPart[]) => void
  errorsOnly: boolean
  onErrorsOnly: (v: boolean) => void
  count: number
  index: number
  onMove: (d: 1 | -1) => void
  onClose: () => void
  onSearchAll: () => void
  focusKey: number
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [p.focusKey])
  const toggle = (part: ConvPart): void => p.onWhere(p.where.includes(part) ? p.where.filter((x) => x !== part) : [...p.where, part])
  const empty = !p.query.trim() && !p.errorsOnly
  return (
    <div className="find-bar" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), p.onClose())}>
      <div className="find-row">
        <Search size={13} className="faint" />
        <input
          ref={input}
          className="find-input"
          placeholder='Find in this conversation ("a phrase" works)'
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              p.onMove(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <span className={cx('find-count', !empty && !p.count && 'none')}>{empty ? '' : p.count ? `${p.index + 1} of ${p.count}` : 'no matches'}</span>
        <button className="icon-btn sm" title="Previous (Shift+Enter)" disabled={!p.count} onClick={() => p.onMove(-1)}>
          <ChevronUp size={13} />
        </button>
        <button className="icon-btn sm" title="Next (Enter)" disabled={!p.count} onClick={() => p.onMove(1)}>
          <ChevronDown size={13} />
        </button>
        <button className="icon-btn sm" title="Search every conversation in this project" onClick={p.onSearchAll}>
          <TextSearch size={13} />
        </button>
        <button className="icon-btn sm" title="Close (Esc)" onClick={p.onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="find-filters">
        {PARTS.map(([part, label]) => (
          <button key={part} className={cx('find-chip', p.where.includes(part) && 'on')} onClick={() => toggle(part)} title={p.where.length ? undefined : 'Looking everywhere; pick some to narrow it'}>
            {label}
          </button>
        ))}
        <span className="find-sep" />
        <button className={cx('find-chip', 'warn', p.errorsOnly && 'on')} onClick={() => p.onErrorsOnly(!p.errorsOnly)} title="Only failed steps, errors and failed checks">
          Errors only
        </button>
      </div>
    </div>
  )
}
