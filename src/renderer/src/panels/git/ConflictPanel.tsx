import { useEffect, useMemo, useState } from 'react'
import { Check, GitMerge, Sparkles } from 'lucide-react'
import type { GitConflict } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { cx } from '@/lib/format'

type Choice = 'ours' | 'theirs' | 'both'

/** A file both sides changed: for each place they differ, keep yours, theirs, or both. */
export function ConflictPanel({ path }: { path: string }): React.JSX.Element {
  const [data, setData] = useState<GitConflict | null>(null)
  const [choice, setChoice] = useState<Record<number, Choice>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setChoice({})
    void prism.git
      .conflict(path)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [path])

  const conflicts = useMemo(() => (data?.parts ?? []).map((p, i) => ({ p, i })).filter((x) => x.p.kind === 'conflict'), [data])
  const settled = conflicts.filter((c) => choice[c.i]).length

  if (error) return <div className="empty rose">{error}</div>
  if (!data) return <div className="empty">Loading…</div>
  if (conflicts.length === 0) {
    return (
      <div className="empty">
        <Check size={24} className="mint" />
        <div>Nothing left to settle in this file</div>
        <button className="btn sm" onClick={() => void prism.git.resolveConflict(path, data.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n')).then(() => useLayout.getState().closePanel(`conflict:${path}`))}>
          Mark as settled
        </button>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    const text = data.parts
      .map((p, i) => {
        if (p.kind === 'text') return p.text
        const c = choice[i]
        return c === 'ours' ? p.ours : c === 'theirs' ? p.theirs : [p.ours, p.theirs].filter(Boolean).join('\n')
      })
      .join('\n')
    try {
      const r = await prism.git.resolveConflict(path, text)
      if (!r.ok) return useUi.getState().toast('error', 'Could not save', r.output)
      useUi.getState().toast('success', 'Settled', path)
      useLayout.getState().closePanel(`conflict:${path}`)
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="conflict">
      <div className="conflict-bar">
        <GitMerge size={15} className="amber" />
        <span className="mono small truncate">{path}</span>
        <span className="faint xs">
          {settled} of {conflicts.length} settled
        </span>
        <span className="grow" />
        <button
          className="btn sm ghost"
          onClick={() => {
            useLayout.getState().openAgent()
            void useSessions.getState().send(`The file ${path} has merge conflicts. Read it, settle each conflict keeping the intent of both sides, remove every conflict marker, stage the file, and tell me what you chose and why. Do not commit.`)
          }}
        >
          <Sparkles size={12} /> Settle with Prism
        </button>
        <button className="btn sm ghost" onClick={() => setChoice(Object.fromEntries(conflicts.map((c) => [c.i, 'ours' as Choice])))}>
          All mine
        </button>
        <button className="btn sm ghost" onClick={() => setChoice(Object.fromEntries(conflicts.map((c) => [c.i, 'theirs' as Choice])))}>
          All theirs
        </button>
        <button className="btn sm solid" disabled={settled < conflicts.length} onClick={() => void save()}>
          <Check size={12} /> Save
        </button>
      </div>
      <div className="conflict-body">
        {data.parts.map((p, i) => {
          if (p.kind === 'text') {
            const lines = p.text.split('\n')
            return (
              <pre key={i} className="conflict-ctx mono">
                {lines.length > 8 ? [...lines.slice(0, 3), `   ⋯ ${lines.length - 6} lines both sides agree on ⋯`, ...lines.slice(-3)].join('\n') : p.text}
              </pre>
            )
          }
          const c = choice[i]
          return (
            <div key={i} className={cx('conflict-block', c && 'done')}>
              <div className={cx('conflict-side mine', c && c !== 'ours' && c !== 'both' && 'off')}>
                <div className="conflict-head">
                  <span className="grow">Yours · {p.oursLabel || 'current branch'}</span>
                  <button className={cx('btn sm', c === 'ours' ? 'solid' : 'ghost')} onClick={() => setChoice((s) => ({ ...s, [i]: 'ours' }))}>
                    Keep this
                  </button>
                </div>
                <pre className="mono">{p.ours || '(nothing)'}</pre>
              </div>
              <div className={cx('conflict-side theirs', c && c !== 'theirs' && c !== 'both' && 'off')}>
                <div className="conflict-head">
                  <span className="grow">Theirs · {p.theirsLabel || 'incoming'}</span>
                  <button className={cx('btn sm', c === 'both' ? 'solid' : 'ghost')} onClick={() => setChoice((s) => ({ ...s, [i]: 'both' }))}>
                    Keep both
                  </button>
                  <button className={cx('btn sm', c === 'theirs' ? 'solid' : 'ghost')} onClick={() => setChoice((s) => ({ ...s, [i]: 'theirs' }))}>
                    Keep this
                  </button>
                </div>
                <pre className="mono">{p.theirs || '(nothing)'}</pre>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
