import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, ExternalLink, ListChecks, Undo2, X, Radar } from 'lucide-react'
import type { ReviewFile } from '@shared/types'
import { applyHunks, hunksOf, type Hunk } from '@shared/hunks'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { impactOfFiles, impactOfSession } from '@/panels/impact/ImpactPanel'
import { cx } from '@/lib/format'

const NO_REVIEWS: never[] = []
// stable empties: a fresh object per render here would re-run the loading effect forever
const NO_CHANGED: Record<string, never> = {}

/**
 * A change set, piece by piece. Two uses:
 *  - reviewId set: the agent proposed changes and waits; you choose what gets written.
 *  - reviewId unset: what the agent already changed this turn; you can undo any piece.
 */
export function ReviewPanel({ sessionId, reviewId }: { sessionId: string; reviewId?: string }): React.JSX.Element {
  return reviewId ? <Proposal sessionId={sessionId} reviewId={reviewId} /> : <TurnChanges sessionId={sessionId} />
}

// ---------------------------------------------------------------- shared pieces

export function HunkLines({ hunk }: { hunk: Hunk }): React.JSX.Element {
  let a = hunk.oldStart
  let b = hunk.newStart
  return (
    <div className="diff-lines review-lines">
      {hunk.lines.map((l, i) => {
        const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
        const n = kind === 'add' ? b++ : kind === 'del' ? a++ : (b++, a++)
        return (
          <div key={i} className={cx('diff-line', kind)}>
            <span className="ln">{n}</span>
            <span className="txt">{l.slice(1) || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

function counts(hunks: Hunk[]): { add: number; del: number } {
  return { add: hunks.reduce((n, h) => n + h.additions, 0), del: hunks.reduce((n, h) => n + h.deletions, 0) }
}

export function FileHead({ file, hunks, open, onToggle, children }: { file: ReviewFile; hunks: Hunk[]; open: boolean; onToggle: () => void; children?: React.ReactNode }): React.JSX.Element {
  const c = counts(hunks)
  return (
    <div className="review-file-head">
      <button className="icon-btn sm" onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <FileIcon name={file.path} size={13} />
      <span className="truncate" title={file.path}>
        {file.path}
      </span>
      {file.before === null && <span className="chip xs mint">new file</span>}
      {file.after === null && <span className="chip xs rose">deleted</span>}
      <span className="mint xs">+{c.add}</span>
      <span className="rose xs">−{c.del}</span>
      <span className="grow" />
      {children}
      {file.after !== null && (
        <button className="icon-btn sm" title="Open the file" onClick={() => useLayout.getState().openEditor(file.path)}>
          <ExternalLink size={12} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- proposal (before writing)

function Proposal({ sessionId, reviewId }: { sessionId: string; reviewId: string }): React.JSX.Element {
  const req = useSessions((s) => (s.live[sessionId]?.reviews ?? NO_REVIEWS).find((r) => r.reviewId === reviewId))
  const [rejected, setRejected] = useState<Record<string, Set<number>>>({})
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [comment, setComment] = useState('')
  const [sent, setSent] = useState(false)

  const files = useMemo(() => (req?.files ?? []).map((f) => ({ file: f, hunks: hunksOf(f.before ?? '', f.after ?? '') })), [req])
  const total = files.reduce((n, f) => n + f.hunks.length, 0)
  const dropped = files.reduce((n, f) => n + (rejected[f.file.path]?.size ?? 0), 0)

  if (!req) {
    return (
      <div className="empty">
        <ListChecks size={24} className="accent" />
        <div>{sent ? 'Sent. Prism is carrying on.' : 'This review is finished.'}</div>
        <button className="btn sm ghost" onClick={() => useLayout.getState().closePanel(`review:${reviewId}`)}>
          Close
        </button>
      </div>
    )
  }

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

  const answer = (acceptNothing: boolean): void => {
    try {
      const out: Array<{ path: string; content: string | null; partial: boolean }> = []
      if (!acceptNothing) {
        for (const { file, hunks } of files) {
          const no = rejected[file.path] ?? new Set<number>()
          if (no.size >= hunks.length && hunks.length > 0) continue
          // a deletion is all or nothing
          if (file.after === null) {
            if (no.size === 0) out.push({ path: file.path, content: null, partial: false })
            continue
          }
          out.push({ path: file.path, content: applyHunks(file.before ?? '', file.after, (i) => !no.has(i)), partial: no.size > 0 })
        }
      }
      setSent(true)
      void useSessions.getState().review(reviewId, { files: out, ...(comment.trim() ? { comment: comment.trim() } : {}) }, sessionId)
    } catch (e) {
      toastError(e, 'Could not apply that selection')
    }
  }

  return (
    <div className="review">
      <div className="review-bar">
        <ListChecks size={15} className="accent" />
        <span className="review-title truncate">{req.title}</span>
        <span className="faint xs">
          {files.length} file{files.length === 1 ? '' : 's'} · {total} piece{total === 1 ? '' : 's'} · nothing is written yet
        </span>
        <span className="grow" />
        <input className="input sm review-note" placeholder="A note for Prism (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className="btn sm" onClick={() => void impactOfFiles(files.map((f) => f.file), sessionId)} title="Before writing: which uses of the changed code could break, and which tests reach it">
          <Radar size={12} /> What could break
        </button>
        <button className="btn sm ghost" onClick={() => answer(true)}>
          <X size={12} /> Reject all
        </button>
        <button className="btn sm solid" disabled={dropped >= total} onClick={() => answer(false)}>
          <Check size={12} /> {dropped ? `Write ${total - dropped} of ${total}` : 'Write all'}
        </button>
      </div>
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
                        {file.after !== null && hunks.length > 1 && (
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
                        )}
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

export function flip(s: Set<string>, key: string): Set<string> {
  const n = new Set(s)
  if (n.has(key)) n.delete(key)
  else n.add(key)
  return n
}

// ---------------------------------------------------------------- this turn's changes (already written)

function TurnChanges({ sessionId }: { sessionId: string }): React.JSX.Element {
  const changedMap = useSessions((s) => s.live[sessionId]?.changed) ?? NO_CHANGED
  const running = useSessions((s) => !!s.live[sessionId]?.running)
  const changed = useMemo(() => Object.values(changedMap), [changedMap])
  const [files, setFiles] = useState<ReviewFile[]>([])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const out: ReviewFile[] = []
      for (const c of changed) {
        if (!c.checkpointId) continue
        const snap = await prism.agent.checkpointFile(c.checkpointId, c.path).catch(() => null)
        if (!snap) continue
        let after: string | null = null
        try {
          const f = await prism.fs.read(c.path)
          if (f.binary) continue
          after = f.content
        } catch {
          after = null
        }
        const before = snap.existed ? snap.content : null
        if (before !== after) out.push({ path: c.path, before, after })
      }
      if (alive) setFiles((prev) => (prev.length === 0 && out.length === 0 ? prev : out))
    })()
    return () => {
      alive = false
    }
  }, [changed, tick])

  useEffect(() => prism.fs.onChanged((ch) => ch.some((c) => changed.some((f) => f.path === c.path)) && setTick((n) => n + 1)), [changed])

  const withHunks = useMemo(() => files.map((f) => ({ file: f, hunks: hunksOf(f.before ?? '', f.after ?? '') })), [files])
  const cpOf = (path: string): string | null => changed.find((c) => c.path === path)?.checkpointId ?? null

  const undoHunk = async (file: ReviewFile, index: number): Promise<void> => {
    try {
      if (file.after === null || file.before === null) return
      await prism.fs.write(file.path, applyHunks(file.before, file.after, (i) => i !== index))
      setTick((n) => n + 1)
    } catch (e) {
      toastError(e, 'Could not undo that piece')
    }
  }
  const undoFile = async (file: ReviewFile): Promise<void> => {
    const cp = cpOf(file.path)
    if (cp) await useSessions.getState().restoreFile(cp, file.path)
    setTick((n) => n + 1)
  }
  const undoAll = async (): Promise<void> => {
    if (!window.confirm(`Undo every change Prism made to ${files.length} file${files.length === 1 ? '' : 's'} this turn?`)) return
    for (const f of files) await undoFile(f)
    useUi.getState().toast('success', 'Changes undone')
  }

  if (!files.length) {
    return (
      <div className="empty">
        <ListChecks size={24} className="accent" />
        <div>Nothing to review</div>
        <div className="small faint">Files Prism changes in a turn show up here, piece by piece, so you can undo exactly what you do not want.</div>
      </div>
    )
  }

  return (
    <div className="review">
      <div className="review-bar">
        <ListChecks size={15} className="accent" />
        <span className="review-title">Changes this turn</span>
        <span className="faint xs">
          {files.length} file{files.length === 1 ? '' : 's'} · already written · undo what you do not want
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => void impactOfSession(sessionId)} disabled={running} title="Which uses of the changed code could break, and which tests reach it">
          <Radar size={12} /> What could break
        </button>
        <button className="btn sm ghost" onClick={() => void undoAll()} disabled={running}>
          <Undo2 size={12} /> Undo everything
        </button>
      </div>
      <div className="review-body">
        {withHunks.map(({ file, hunks }) => {
          const open = !closed.has(file.path)
          return (
            <div key={file.path} className="review-file">
              <FileHead file={file} hunks={hunks} open={open} onToggle={() => setClosed((s) => flip(s, file.path))}>
                <button className="btn sm ghost" onClick={() => void undoFile(file)} disabled={running} title="Put this file back as it was before the turn">
                  <Undo2 size={11} /> Undo file
                </button>
              </FileHead>
              {open &&
                hunks.map((h) => (
                  <div key={h.index} className="hunk">
                    <div className="hunk-head">
                      <span className="faint xs mono">line {h.newStart}</span>
                      <span className="grow" />
                      {file.before !== null && file.after !== null && hunks.length > 1 && (
                        <button className="btn sm ghost" onClick={() => void undoHunk(file, h.index)} disabled={running}>
                          <Undo2 size={11} /> Undo this
                        </button>
                      )}
                    </div>
                    <HunkLines hunk={h} />
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
