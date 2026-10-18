// Split my changes: the uncommitted work grouped into commits by a model; the user edits the messages and
// moves pieces between commits, then Prism makes them in order. Files on disk are never touched.
import { useEffect, useState } from 'react'
import { Loader2, RotateCw, Scissors } from 'lucide-react'
import type { SplitCommit, SplitPiece } from '@shared/types'
import { prism } from '@/lib/ipc'
import { Modal } from '@/components/Modal'
import { toastError, useUi } from '@/state/ui'
import { cx } from '@/lib/format'

export function SplitDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [pieces, setPieces] = useState<SplitPiece[]>([])
  const [commits, setCommits] = useState<SplitCommit[]>([])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState<'plan' | 'apply' | null>('plan')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const plan = (): void => {
    setBusy('plan')
    setError(null)
    void prism.split
      .plan()
      .then((r) => {
        setPieces(r.pieces)
        setCommits(r.commits)
        setModel(r.model)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(null))
  }
  useEffect(plan, [])

  const byId = new Map(pieces.map((p) => [p.id, p]))
  const move = (pid: string, to: number): void =>
    setCommits((cs) => {
      const next = cs.map((c) => ({ ...c, pieces: c.pieces.filter((x) => x !== pid) }))
      if (to === next.length) next.push({ message: 'More changes', why: '', pieces: [pid] })
      else next[to]!.pieces.push(pid)
      return next.filter((c) => c.pieces.length)
    })
  const apply = async (): Promise<void> => {
    setBusy('apply')
    try {
      const r = await prism.split.apply(commits)
      if (!r.ok) {
        setError(`${r.made ? `Made ${r.made} of ${commits.length} commits, then: ` : ''}${r.output}`)
        return
      }
      useUi.getState().toast('success', `Made ${r.made} commit${r.made === 1 ? '' : 's'}`, r.output)
      onDone()
      onClose()
    } catch (e) {
      toastError(e, 'Could not make the commits')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title="Split my changes into commits"
      icon={<Scissors size={15} />}
      width={760}
      onClose={onClose}
      footer={
        <>
          <span className="faint xs grow">{model ? `Grouped by ${model}. Your files stay as they are; only the commits are made.` : ''}</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={plan}>
            <RotateCw size={12} /> Group again
          </button>
          <button className="btn sm solid" disabled={!!busy || !commits.length} onClick={() => void apply()}>
            {busy === 'apply' ? <Loader2 size={12} className="spin" /> : null} Make {commits.length} commit{commits.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      {busy === 'plan' && (
        <div className="split-wait">
          <Loader2 size={14} className="spin accent" /> Reading the changes and grouping them…
        </div>
      )}
      {error && <div className="split-error">{error}</div>}
      {busy !== 'plan' &&
        commits.map((c, i) => (
          <div key={i} className="split-commit">
            <div className="split-head">
              <span className="split-n">{i + 1}</span>
              <textarea
                className="input split-msg"
                rows={Math.min(4, c.message.split('\n').length)}
                value={c.message}
                onChange={(e) => setCommits((cs) => cs.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))}
              />
            </div>
            {c.why && <div className="split-why faint xs">{c.why}</div>}
            <div className="split-pieces">
              {c.pieces.map((pid) => {
                const p = byId.get(pid)
                if (!p) return null
                return (
                  <div key={pid} className="split-piece">
                    <button className={cx('split-piece-row', open === pid && 'open')} onClick={() => setOpen(open === pid ? null : pid)}>
                      <span className="mono truncate">{p.path}</span>
                      <span className="faint truncate">{p.title}</span>
                      <span className="grow" />
                      {p.added + p.removed > 0 && (
                        <span className="xs">
                          <span className="mint">+{p.added}</span> <span className="rose">−{p.removed}</span>
                        </span>
                      )}
                    </button>
                    <select className="input sm split-move" value={i} onChange={(e) => move(pid, Number(e.target.value))} title="Move to another commit">
                      {commits.map((_, j) => (
                        <option key={j} value={j}>
                          commit {j + 1}
                        </option>
                      ))}
                      <option value={commits.length}>a new commit</option>
                    </select>
                    {open === pid && p.text && <pre className="split-diff">{p.text}</pre>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
    </Modal>
  )
}
