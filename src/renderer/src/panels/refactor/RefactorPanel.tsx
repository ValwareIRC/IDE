import { useMemo, useState } from 'react'
import { Check, CheckCircle2, Replace, Undo2, X } from 'lucide-react'
import { applyHunks, hunksOf } from '@shared/hunks'
import { useRefactor } from '@/state/refactor'
import { useLayout } from '@/state/layout'
import { toastError } from '@/state/ui'
import { FileHead, HunkLines, flip } from '@/panels/review/ReviewPanel'
import { cx } from '@/lib/format'

/** A rename or a move, worked out but not written: choose the pieces, then apply. */
export function RefactorPanel({ id }: { id: string }): React.JSX.Element {
  const plan = useRefactor((s) => s.plans[id])
  const [rejected, setRejected] = useState<Record<string, Set<number>>>({})
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const files = useMemo(() => (plan?.files ?? []).map((f) => ({ file: f, hunks: hunksOf(f.before ?? '', f.after ?? '') })), [plan])
  const close = (): void => useLayout.getState().closePanel(`refactor:${id}`)

  if (!plan) {
    return (
      <div className="empty">
        <Replace size={24} className="faint" />
        <div>This change set is no longer here.</div>
        <button className="btn sm ghost" onClick={close}>
          Close
        </button>
      </div>
    )
  }
  if (plan.done) {
    const n = plan.written?.length ?? 0
    return (
      <div className="empty">
        <CheckCircle2 size={24} className={plan.done === 'applied' ? 'mint' : 'faint'} />
        <div className="title">{plan.done === 'applied' ? 'Done' : plan.done === 'undone' ? 'Put back' : 'Cancelled'}</div>
        <div className="small faint">
          {plan.done === 'applied'
            ? `${n ? `${n} file${n === 1 ? '' : 's'} changed` : 'No file needed changing'}${plan.then ? `, and ${plan.then.from} is now ${plan.then.to}` : ''}.`
            : plan.done === 'undone'
              ? 'Everything is as it was before.'
              : 'Nothing was changed.'}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {plan.done === 'applied' && (
            <button className="btn sm" onClick={() => void useRefactor.getState().undo(id)}>
              <Undo2 size={12} /> Undo
            </button>
          )}
          <button className="btn sm ghost" onClick={close}>
            Close
          </button>
        </div>
      </div>
    )
  }

  const total = files.reduce((n, f) => n + f.hunks.length, 0)
  const dropped = files.reduce((n, f) => n + (rejected[f.file.path]?.size ?? 0), 0)
  const toggle = (path: string, index: number, whole?: { all: number[]; on: boolean }): void =>
    setRejected((r) => {
      const set = new Set(r[path] ?? [])
      if (whole) {
        set.clear()
        if (!whole.on) whole.all.forEach((i) => set.add(i))
      } else if (set.has(index)) set.delete(index)
      else set.add(index)
      return { ...r, [path]: set }
    })

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const out: Array<{ path: string; content: string | null; partial: boolean }> = []
      for (const { file, hunks } of files) {
        const no = rejected[file.path] ?? new Set<number>()
        if (no.size >= hunks.length) continue
        // a file the set removes is removed whole, or not at all
        if (file.after === null) {
          if (no.size === 0) out.push({ path: file.path, content: null, partial: false })
          continue
        }
        out.push({ path: file.path, content: applyHunks(file.before ?? '', file.after, (i) => !no.has(i)), partial: no.size > 0 })
      }
      await useRefactor.getState().apply(id, out)
    } catch (e) {
      toastError(e, 'Could not apply that selection')
    } finally {
      setBusy(false)
    }
  }

  const left = total - dropped
  return (
    <div className="review">
      <div className="review-bar">
        <Replace size={15} className="accent" />
        <span className="review-title truncate">{plan.title}</span>
        <span className="faint xs">
          {files.length} file{files.length === 1 ? '' : 's'} · {total} place{total === 1 ? '' : 's'} · nothing is written yet
        </span>
        <span className="grow" />
        <button className="btn sm ghost" disabled={busy} onClick={() => useRefactor.getState().cancel(id)}>
          <X size={12} /> Cancel
        </button>
        <button className="btn sm solid" disabled={busy || (!plan.then && left <= 0)} onClick={() => void apply()}>
          <Check size={12} /> {left <= 0 ? 'Move without changing files' : dropped ? `Apply ${left} of ${total}` : plan.then ? 'Apply and move' : 'Apply all'}
        </button>
      </div>
      {plan.note && <div className={cx('refactor-note', !plan.byMeaning && 'warn')}>{plan.note}</div>}
      <div className="review-body">
        {files.map(({ file, hunks }) => {
          const no = rejected[file.path] ?? new Set<number>()
          const open = !closed.has(file.path)
          const allOn = no.size === 0
          return (
            <div key={file.path} className={cx('review-file', no.size >= hunks.length && 'off')}>
              <FileHead file={file} hunks={hunks} open={open} onToggle={() => setClosed((s) => flip(s, file.path))}>
                <button className={cx('chip xs clickable', allOn ? 'mint' : no.size >= hunks.length ? 'rose' : 'amber')} onClick={() => toggle(file.path, 0, { all: hunks.map((h) => h.index), on: !allOn })} title="Accept or reject this whole file">
                  {allOn ? 'accepted' : no.size >= hunks.length ? 'rejected' : `${hunks.length - no.size} of ${hunks.length}`}
                </button>
              </FileHead>
              {open &&
                hunks.map((h) => {
                  const off = no.has(h.index)
                  return (
                    <div key={h.index} className={cx('hunk', off && 'off')}>
                      <div className="hunk-head">
                        <span className="faint xs mono">line {h.newStart}</span>
                        <span className="grow" />
                        <button className={cx('btn sm', off ? 'ghost' : 'primary')} onClick={() => toggle(file.path, h.index)}>
                          {off ? (
                            <>
                              <X size={11} /> rejected
                            </>
                          ) : (
                            <>
                              <Check size={11} /> accepted
                            </>
                          )}
                        </button>
                      </div>
                      <HunkLines hunk={h} />
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
