import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Expand, RotateCcw } from 'lucide-react'
import * as Diff from 'diff'
import type { FileDiff } from '@shared/types'
import { useLayout } from '@/state/layout'
import { cx } from '@/lib/format'

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'skip'
  a?: number
  b?: number
  text: string
}

function buildLines(before: string, after: string, context = 3): Line[] {
  const parts = Diff.diffLines(before, after)
  const raw: Line[] = []
  let a = 1
  let b = 1
  for (const p of parts) {
    const ls = p.value.replace(/\n$/, '').split('\n')
    for (const t of ls) {
      if (p.added) raw.push({ kind: 'add', b: b++, text: t })
      else if (p.removed) raw.push({ kind: 'del', a: a++, text: t })
      else raw.push({ kind: 'ctx', a: a++, b: b++, text: t })
    }
  }
  // collapse long context runs
  const out: Line[] = []
  let run: Line[] = []
  const flush = (isEnd: boolean): void => {
    if (run.length <= context * 2 + 1) out.push(...run)
    else {
      const head = out.length === 0 ? [] : run.slice(0, context)
      const tail = isEnd ? [] : run.slice(-context)
      const hidden = run.length - head.length - tail.length
      out.push(...head)
      if (hidden > 0) out.push({ kind: 'skip', text: `… ${hidden} unchanged lines` })
      out.push(...tail)
    }
    run = []
  }
  for (const l of raw) {
    if (l.kind === 'ctx') run.push(l)
    else {
      flush(false)
      out.push(l)
    }
  }
  flush(true)
  return out
}

export function DiffCard({ diff, restored, onRestore }: { diff: FileDiff; restored?: boolean; onRestore?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const openDiff = useLayout((s) => s.openDiff)
  const lines = useMemo(() => (open ? buildLines(diff.before ?? '', diff.after ?? '') : []), [diff, open])
  const created = diff.before === null
  const deleted = diff.after === null
  return (
    <div className="diff-card">
      <div className="diff-head">
        <button className="icon-btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="truncate" style={{ color: 'var(--text)' }}>
          {diff.path}
        </span>
        {created && <span className="chip mint">new</span>}
        {deleted && <span className="chip rose">deleted</span>}
        <span className="grow" />
        <span className="mint">+{diff.additions}</span>
        <span className="rose">−{diff.deletions}</span>
        {onRestore && (
          <button className={cx('icon-btn sm', restored && 'on')} title={restored ? 'Restored' : 'Revert this change'} onClick={onRestore} disabled={restored}>
            <RotateCcw size={12} />
          </button>
        )}
        <button className="icon-btn sm" title="Open side-by-side diff" onClick={() => openDiff(diff.path, diff.before ?? '', diff.after ?? '')}>
          <Expand size={12} />
        </button>
      </div>
      {open && (
        <div className="diff-lines">
          {lines.slice(0, 400).map((l, i) => (
            <div key={i} className={cx('diff-line', l.kind)}>
              {l.kind === 'skip' ? (
                <span className="txt">{l.text}</span>
              ) : (
                <>
                  <span className="ln">{l.kind === 'add' ? l.b : l.a}</span>
                  <span className="txt">{l.text || ' '}</span>
                </>
              )}
            </div>
          ))}
          {lines.length > 400 && <div className="diff-line skip"><span className="txt">… {lines.length - 400} more lines. Open the full diff.</span></div>}
        </div>
      )}
    </div>
  )
}
