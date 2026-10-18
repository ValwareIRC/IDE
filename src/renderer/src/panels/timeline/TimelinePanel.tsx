import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, FilePlus2, FileMinus2, FileDiff, History as HistoryIcon, RotateCcw, TerminalSquare, Undo2 } from 'lucide-react'
import type { HistoryStep, HistoryTimeline } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { useRefactor } from '@/state/refactor'
import { toastError, useUi } from '@/state/ui'
import { DiffPanel } from '@/panels/editor/DiffPanel'
import { FileIcon } from '@/components/FileIcon'
import { cx, timeAgo } from '@/lib/format'

type Compare = 'step' | 'now'

/** Drag through a session step by step and see the project as it was at each one. */
export function TimelinePanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId))
  const running = useSessions((s) => !!s.live[sessionId]?.running)
  const [tl, setTl] = useState<HistoryTimeline | null>(null)
  const [at, setAt] = useState(0)
  const [file, setFile] = useState<string | null>(null)
  const [compare, setCompare] = useState<Compare>('step')
  const [pair, setPair] = useState<{ before: string; after: string; note: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const t = await prism.history.timeline(sessionId)
      setTl(t)
      setAt((a) => (a >= t.steps.length || a === 0 ? Math.max(0, t.steps.length - 1) : a))
    } catch (e) {
      toastError(e, 'Could not read the session history')
    }
  }, [sessionId])
  useEffect(() => {
    if (!running) void load()
  }, [load, running])

  const steps = tl?.steps ?? []
  const step: HistoryStep | undefined = steps[at]
  const touched = useMemo(() => {
    const out: Array<{ path: string; first: number; last: number }> = []
    for (const s of steps) {
      for (const c of s.changes) {
        const e = out.find((x) => x.path === c.path)
        if (e) e.last = s.index
        else out.push({ path: c.path, first: s.index, last: s.index })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }, [steps])
  const turn = tl?.turns.find((t) => t.id === step?.turnItemId)

  // the file to show: the one picked, else the first this step changed
  useEffect(() => {
    if (!step) return
    if (!file || !touched.some((t) => t.path === file)) setFile(step.changes[0]?.path ?? touched[0]?.path ?? null)
  }, [step, file, touched])

  useEffect(() => {
    if (!file || !step) return setPair(null)
    let gone = false
    void (async () => {
      const [then] = await prism.history.state(sessionId, at, file)
      const after = then?.content ?? ''
      let before = ''
      let note = ''
      if (compare === 'now') {
        before = after
        try {
          const cur = await prism.fs.read(file)
          if (gone) return
          setPair({ before: after, after: cur.content, note: 'Left: at this step. Right: the file now.' })
          return
        } catch {
          note = 'The file does not exist now.'
          setPair({ before, after: '', note })
          return
        }
      }
      const [prev] = await prism.history.state(sessionId, at - 1, file)
      before = prev?.content ?? ''
      note = step.changes.some((c) => c.path === file) ? 'What this step changed in the file.' : 'This step did not change this file; it is shown as it was then.'
      if (!gone) setPair({ before, after, note })
    })().catch((e) => toastError(e))
    return () => {
      gone = true
    }
  }, [sessionId, at, file, compare, step])

  const undoRequest = async (): Promise<void> => {
    if (!step?.turnItemId) return
    try {
      const plan = await prism.history.undoRequest(sessionId, step.turnItemId)
      if (!plan.files.length) return useUi.getState().toast('info', 'Nothing to undo', plan.note ?? undefined)
      useRefactor.getState().show(plan)
    } catch (e) {
      toastError(e, 'Could not work out the undo')
    }
  }

  const goBack = async (): Promise<void> => {
    if (!window.confirm(`Put every file this session changed back the way it was right after step ${at + 1}? What is there now is kept as a checkpoint, so you can undo this.`)) return
    try {
      const written = await prism.history.restore(sessionId, at)
      useUi.getState().toast('success', written.length ? `${written.length} file${written.length === 1 ? '' : 's'} put back` : 'Already like that', 'Undo it from the session’s checkpoints.')
      void load()
    } catch (e) {
      toastError(e, 'Could not go back')
    }
  }

  if (!tl) return <div className="empty">Reading…</div>
  if (!steps.length) {
    return (
      <div className="empty">
        <HistoryIcon size={24} className="faint" />
        <div className="title">Nothing to travel through yet</div>
        <div className="small faint">Once the agent works in “{session?.title ?? 'this session'}”, every step it takes appears here.</div>
      </div>
    )
  }

  return (
    <div className="tl-panel">
      <div className="tl-head">
        <HistoryIcon size={15} className="accent" />
        <span className="tl-title truncate">{session?.title ?? 'Session'}</span>
        <span className="faint small">
          step {at + 1} of {steps.length}
        </span>
        <span className="grow" />
        <button className="icon-btn" title="Step back" disabled={at <= 0} onClick={() => setAt(at - 1)}>
          <ChevronLeft size={15} />
        </button>
        <button className="icon-btn" title="Step forward" disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="tl-track">
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          value={at}
          onChange={(e) => setAt(Number(e.target.value))}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Step"
        />
        <div className="tl-ticks">
          {steps.map((s) => (
            <i key={s.index} className={cx(s.changes.length > 0 && 'chg', s.isError && 'err', s.index === at && 'on', steps[s.index - 1]?.turnItemId !== s.turnItemId && 'turn')} style={{ left: `${steps.length > 1 ? (s.index / (steps.length - 1)) * 100 : 0}%` }} title={s.summary} onClick={() => setAt(s.index)} />
          ))}
        </div>
      </div>

      {step && (
        <div className="tl-step">
          {turn && (
            <div className="tl-request">
              <span className="faint xs">Request</span> {turn.text}
            </div>
          )}
          <div className="tl-what">
            {step.tool === 'shell' ? <TerminalSquare size={13} /> : <FileDiff size={13} />}
            <span className="mono small truncate">{step.summary}</span>
            <span className="faint xs">{timeAgo(step.ts)}</span>
            {step.isError && <span className="chip rose xs">failed</span>}
            <span className="grow" />
            {turn?.changed && (
              <button className="btn sm" disabled={running} onClick={() => void undoRequest()} title="Take out what this request changed, keeping everything done since">
                <Undo2 size={12} /> Undo this request
              </button>
            )}
            <button className="btn sm" disabled={running} onClick={() => void goBack()} title="Put the files back the way they were right after this step">
              <RotateCcw size={12} /> Go back to here
            </button>
          </div>
          {step.output && <pre className="tl-output">{step.output}</pre>}
        </div>
      )}

      <div className="tl-body">
        <div className="tl-files">
          <div className="hud-label">Files at this step</div>
          {touched.map((t) => {
            const change = step?.changes.find((c) => c.path === t.path)
            const notYet = at < t.first
            return (
              <button key={t.path} className={cx('tl-file', file === t.path && 'on', notYet && 'faint', change && 'hit')} onClick={() => setFile(t.path)} title={t.path}>
                {change?.op === 'created' ? <FilePlus2 size={12} className="mint" /> : change?.op === 'deleted' ? <FileMinus2 size={12} className="rose" /> : <FileIcon name={t.path} size={12} />}
                <span className="truncate">{t.path}</span>
                {change && (
                  <span className="mono xs">
                    <span className="mint">+{change.added}</span> <span className="rose">−{change.removed}</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="tl-diff">
          <div className="tl-diff-bar">
            <span className="faint xs grow">{pair?.note}</span>
            <div className="seg">
              <button className={compare === 'step' ? 'on' : ''} onClick={() => setCompare('step')}>
                This step
              </button>
              <button className={compare === 'now' ? 'on' : ''} onClick={() => setCompare('now')}>
                Then vs now
              </button>
            </div>
          </div>
          {file && pair ? <DiffPanel key={`${file}:${at}:${compare}`} path={file} before={pair.before} after={pair.after} /> : <div className="empty small faint">Pick a file.</div>}
        </div>
      </div>
    </div>
  )
}
