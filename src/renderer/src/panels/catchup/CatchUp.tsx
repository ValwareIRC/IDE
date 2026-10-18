import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Coffee, Hourglass, Footprints, Workflow, X } from 'lucide-react'
import type { CatchUp } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { DiffPanel } from '@/panels/editor/DiffPanel'
import { cx, timeAgo } from '@/lib/format'

const AWAY_MS = 10 * 60_000
const SEEN_KEY = 'prism.lastSeen'

export const useCatchUp = create<{ report: CatchUp | null; offered: boolean }>(() => ({ report: null, offered: false }))

const worth = (r: CatchUp): boolean => r.sessions.length > 0 || r.runs.length > 0 || r.files.length > 0

/** Notes when the user is here; when they come back after a while, works out what happened meanwhile. */
export function watchPresence(): () => void {
  const read = (): number => {
    try {
      return Number(localStorage.getItem(SEEN_KEY)) || Date.now()
    } catch {
      return Date.now()
    }
  }
  let last = read()
  const check = async (): Promise<void> => {
    const away = Date.now() - last
    const since = last
    const after = useApp.getState().settings?.assist?.catchUpAfterMin ?? AWAY_MS / 60_000
    if (after > 0 && away >= after * 60_000 && useApp.getState().workspace) {
      const r = await prism.catchup.since(since).catch(() => null)
      if (r && worth(r)) useCatchUp.setState({ report: r, offered: true })
    }
  }
  const seen = (): void => {
    last = Date.now()
    try {
      localStorage.setItem(SEEN_KEY, String(last))
    } catch {
      /* private storage */
    }
  }
  // coming back to the window, or starting Prism after a while
  const onFocus = (): void => void check().finally(seen)
  let t = 0
  const onActivity = (): void => {
    if (Date.now() - t < 15_000) return
    t = Date.now()
    if (document.hasFocus()) seen()
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('keydown', onActivity)
  window.addEventListener('pointerdown', onActivity)
  const first = window.setTimeout(() => void check().finally(seen), 2500)
  return () => {
    window.clearTimeout(first)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onActivity)
    window.removeEventListener('pointerdown', onActivity)
  }
}

/** The small "while you were away" banner. */
export function CatchUpBar(): React.JSX.Element | null {
  const { report, offered } = useCatchUp()
  if (!report || !offered) return null
  const waiting = report.sessions.filter((s) => s.status === 'waiting').length
  const failed = report.sessions.filter((s) => s.error).length
  const parts = [
    report.sessions.length ? `${report.sessions.length} session${report.sessions.length === 1 ? '' : 's'} worked` : '',
    waiting ? `${waiting} waiting for you` : '',
    failed ? `${failed} stopped with a problem` : '',
    report.files.length ? `${report.files.length} file${report.files.length === 1 ? '' : 's'} changed` : '',
    report.runs.length ? `${report.runs.length} automation run${report.runs.length === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  return (
    <div className="catchup-bar">
      <Coffee size={14} className="accent" />
      <span className="small">
        <b>While you were away</b> ({timeAgo(report.since)}): {parts.join(', ')}.
      </span>
      <button
        className="btn sm solid"
        onClick={() => {
          useCatchUp.setState({ offered: false })
          useLayout.getState().openCatchUp()
        }}
      >
        Catch up
      </button>
      <button className="icon-btn sm" title="Not now" onClick={() => useCatchUp.setState({ offered: false })}>
        <X size={13} />
      </button>
    </div>
  )
}

/** What happened, and a walk through every change in the order it was made. */
export function CatchUpPanel(): React.JSX.Element {
  const report = useCatchUp((s) => s.report)
  const [walk, setWalk] = useState<number | null>(null)
  const [now, setNow] = useState<string | null>(null)
  const file = walk !== null ? report?.files[walk] : undefined
  useEffect(() => {
    if (!file) return
    setNow(null)
    void prism.fs
      .read(file.path)
      .then((f) => setNow(f.content))
      .catch(() => setNow(''))
  }, [file])

  if (!report) return <div className="empty">Nothing to catch up on.</div>
  const open = (id: string): void => {
    useLayout.getState().openAgent()
    void useSessions.getState().select(id)
  }

  if (file) {
    return (
      <div className="catchup">
        <div className="review-bar">
          <Footprints size={15} className="accent" />
          <span className="review-title truncate">
            {walk! + 1} of {report.files.length}: {file.path}
          </span>
          <span className="faint xs truncate">{file.request ? `for “${file.request}”` : file.sessions.join(', ')}</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => setWalk(null)}>
            Back to the summary
          </button>
          <button className="btn sm" disabled={walk === 0} onClick={() => setWalk(walk! - 1)}>
            <ChevronLeft size={12} /> Before
          </button>
          <button className="btn sm solid" disabled={walk === report.files.length - 1} onClick={() => setWalk(walk! + 1)}>
            Next <ChevronRight size={12} />
          </button>
        </div>
        <div className="catchup-diff">{now === null ? <div className="empty">Reading…</div> : <DiffPanel key={file.path} path={file.path} before={file.before ?? ''} after={now} />}</div>
      </div>
    )
  }

  return (
    <div className="catchup">
      <div className="review-bar">
        <Coffee size={15} className="accent" />
        <span className="review-title">While you were away</span>
        <span className="faint xs">since {new Date(report.since).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <span className="grow" />
        {report.files.length > 0 && (
          <button className="btn sm solid" onClick={() => setWalk(0)} title="Every changed file in the order it was changed, as it was when you left and as it is now">
            <Footprints size={12} /> Walk me through the changes
          </button>
        )}
      </div>
      <div className="catchup-body">
        {report.sessions.map((s) => (
          <button key={s.id} className={cx('card catchup-row', s.status === 'waiting' && 'waiting', s.error && 'failed')} onClick={() => open(s.id)}>
            {s.status === 'waiting' ? <Hourglass size={15} className="amber" /> : s.error ? <AlertTriangle size={15} className="rose" /> : <CheckCircle2 size={15} className="mint" />}
            <div className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
              <div className="ep-name">
                {s.title} <span className="faint small">{s.status === 'waiting' ? 'waiting for your answer' : s.status === 'running' ? 'still working' : timeAgo(s.updatedAt)}</span>
              </div>
              {s.error ? <div className="rose small">{s.error}</div> : s.lastText ? <div className="small faint catchup-text">{s.lastText}</div> : null}
            </div>
            <span className="faint xs">{s.steps} steps</span>
          </button>
        ))}
        {report.runs.length > 0 && (
          <div className="catchup-runs">
            <div className="hud-label">
              <Workflow size={11} /> Automations
            </div>
            {report.runs.map((r) => (
              <div key={r.id} className="small">
                <span className={r.ok ? 'mint' : 'rose'}>{r.ok ? '✓' : '✗'}</span> {r.name} <span className="faint xs">{timeAgo(r.startedAt)}</span>
              </div>
            ))}
          </div>
        )}
        {report.files.length > 0 && (
          <div className="catchup-runs">
            <div className="hud-label">Changed, in order</div>
            {report.files.map((f, i) => (
              <button key={f.path} className="impact-use" onClick={() => setWalk(i)}>
                <span className="mono xs">{f.path}</span>
                <span className="faint xs truncate">{f.sessions.join(', ')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
