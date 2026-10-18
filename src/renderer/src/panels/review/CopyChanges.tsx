import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, GitBranch, GitMerge, RefreshCw, Trash2 } from 'lucide-react'
import type { ReviewFile } from '@shared/types'
import { hunksOf } from '@shared/hunks'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { cx } from '@/lib/format'

/** Bring a session's copy into the project. A merge that stops on conflicts hands over to the conflict resolver. */
export async function bringIn(sessionId: string): Promise<void> {
  try {
    const r = await prism.sessions.copyIntegrate(sessionId)
    if (r.ok) {
      useUi.getState().toast('success', 'Brought into your project', r.output.split('\n').filter(Boolean).slice(-1)[0])
      return
    }
    if (/CONFLICT/.test(r.output)) {
      useUi.getState().setSide('git')
      useUi.getState().toast('info', 'Both you and the copy changed the same lines', 'The files to settle are listed under Source control.')
    } else useUi.getState().toast('error', 'Could not bring it in', r.output.slice(0, 500))
  } catch (e) {
    toastError(e)
  }
}

export async function discardCopy(sessionId: string): Promise<void> {
  if (!window.confirm('Delete this session’s copy of the project and its branch? Work in it that was not brought in is lost.')) return
  try {
    await prism.sessions.copyDiscard(sessionId)
    await useSessions.getState().loadCopy(sessionId)
    useUi.getState().toast('success', 'The copy was deleted', 'This session now works in your project folder.')
  } catch (e) {
    toastError(e)
  }
}

/** Everything a session's own copy changed compared with where it started, to read before bringing it in. */
export function CopyChanges({ sessionId }: { sessionId: string }): React.JSX.Element {
  const copy = useSessions((s) => s.copies[sessionId])
  const running = useSessions((s) => !!s.live[sessionId]?.running)
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    void prism.sessions
      .copyChanges(sessionId)
      .then(setFiles)
      .catch(toastError)
  }, [sessionId])

  // re-read when a turn ends: that is when the copy has changed
  useEffect(() => {
    if (!running) load()
  }, [load, running])

  const withHunks = useMemo(() => (files ?? []).map((f) => ({ file: f, hunks: hunksOf(f.before ?? '', f.after ?? '') })), [files])

  if (!copy) {
    return (
      <div className="empty">
        <GitBranch size={24} className="accent" />
        <div>This session works directly in your project</div>
        <div className="small faint">There is no separate copy to compare.</div>
      </div>
    )
  }

  return (
    <div className="review">
      <div className="review-bar">
        <GitBranch size={15} className="accent" />
        <span className="review-title">What the copy changed</span>
        <span className="faint xs">
          branch {copy.branch} · {files ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'reading…'} · your project is untouched
        </span>
        <span className="grow" />
        <button className="icon-btn sm" title="Read again" onClick={load}>
          <RefreshCw size={13} />
        </button>
        <button className="btn sm ghost" disabled={running} onClick={() => void discardCopy(sessionId)}>
          <Trash2 size={12} /> Discard the copy
        </button>
        <button className="btn sm solid" disabled={running || !files?.length} onClick={() => void bringIn(sessionId)} title="Merge the copy's branch into the branch your project is on">
          <GitMerge size={12} /> Bring into my project
        </button>
      </div>
      <div className="review-body">
        {files && files.length === 0 && <div className="empty">The copy has not changed anything yet.</div>}
        {withHunks.map(({ file, hunks }) => {
          const open = !closed.has(file.path)
          const add = hunks.reduce((n, h) => n + h.additions, 0)
          const del = hunks.reduce((n, h) => n + h.deletions, 0)
          return (
            <div key={file.path} className="review-file">
              <div className="review-file-head">
                <button
                  className="icon-btn sm"
                  onClick={() =>
                    setClosed((s) => {
                      const n = new Set(s)
                      if (n.has(file.path)) n.delete(file.path)
                      else n.add(file.path)
                      return n
                    })
                  }
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <FileIcon name={file.path} size={13} />
                <span className="truncate" title={file.path}>
                  {file.path}
                </span>
                {file.before === null && <span className="chip xs mint">new file</span>}
                {file.after === null && <span className="chip xs rose">deleted</span>}
                <span className="mint xs">+{add}</span>
                <span className="rose xs">−{del}</span>
                <span className="grow" />
                <button className="btn sm ghost" title="Side by side: your project's version and the copy's" onClick={() => useLayout.getState().openDiff(file.path, file.before ?? '', file.after ?? '', `copy · ${file.path.split('/').pop()}`)}>
                  Side by side
                </button>
              </div>
              {open &&
                hunks.map((h) => {
                  let a = h.oldStart
                  let b = h.newStart
                  return (
                    <div key={h.index} className="hunk">
                      <div className="diff-lines review-lines">
                        {h.lines.map((l, i) => {
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
