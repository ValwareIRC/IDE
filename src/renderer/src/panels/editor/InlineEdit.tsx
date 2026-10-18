import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { hunksOf } from '@shared/hunks'
import { prism } from '@/lib/ipc'
import { cx } from '@/lib/format'

export interface InlineContext {
  path: string
  language: string
  /** The text being rewritten; empty means "write new code at the cursor". */
  selection: string
  before: string
  after: string
}

/**
 * Inline chat in the editor (Ctrl+I / Ctrl+K): describe a change, see it as a
 * diff, keep refining with follow-ups, and only then accept it. Nothing in the
 * file changes until Accept.
 */
export function InlineEditWidget({ top, context, onAccept, onClose }: { top: number | null; context: InlineContext; onAccept: (text: string) => void; onClose: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [rounds, setRounds] = useState<Array<{ instruction: string; result: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const result = rounds.length ? rounds[rounds.length - 1]!.result : null

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const hunks = useMemo(() => (result === null ? [] : hunksOf(context.selection, result)), [result, context.selection])

  const ask = async (): Promise<void> => {
    const instruction = text.trim()
    if (!instruction || busy) return
    setBusy(true)
    setError(null)
    try {
      const out = await prism.completions.edit({ ...context, instruction, history: rounds })
      setRounds((r) => [...r, { instruction, result: out }])
      setText('')
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
      setTimeout(() => ref.current?.focus(), 0)
    }
  }

  const accept = (): void => {
    if (result === null) return
    onAccept(result)
    onClose()
  }

  return (
    <div className="inline-chat" style={top === null ? { bottom: 10 } : { top }}>
      <div className="inline-edit-bar">
        <Sparkles size={14} className="accent" />
        <input
          ref={ref}
          placeholder={result === null ? (context.selection ? 'Describe the change…' : 'Describe what to write here…') : 'Refine it (e.g. "shorter", "handle null")… or press Enter to accept'}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (text.trim()) void ask()
              else accept()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        {busy && <span className="spinner" />}
        {result !== null && !busy && (
          <button className="btn sm solid" onClick={accept} title="Put this into the file (Enter)">
            <Check size={12} /> Accept
          </button>
        )}
        <button className="icon-btn sm" onClick={onClose} title="Discard (Esc)">
          <X size={13} />
        </button>
      </div>
      {rounds.length > 0 && (
        <div className="inline-chat-rounds">
          {rounds.map((r, i) => (
            <span key={i} className={cx('chip xs', i === rounds.length - 1 && 'accent')} title={r.instruction}>
              {i + 1}. {r.instruction.length > 40 ? r.instruction.slice(0, 40) + '…' : r.instruction}
            </span>
          ))}
          {rounds.length > 1 && (
            <button className="chip xs clickable" onClick={() => setRounds((r) => r.slice(0, -1))} title="Go back to the previous version">
              undo last
            </button>
          )}
        </div>
      )}
      {error && <div className="inline-chat-error">{error}</div>}
      {result !== null && (
        <div className="inline-chat-diff diff-lines">
          {hunks.length === 0 && <div className="faint small" style={{ padding: 8 }}>No change: the result is identical to what is there.</div>}
          {hunks.map((h) =>
            h.lines.map((l, i) => (
              <div key={`${h.index}:${i}`} className={cx('diff-line', l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx')}>
                <span className="txt">{l.slice(1) || ' '}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
