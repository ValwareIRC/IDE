import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, GitBranch, History, RefreshCw, Sparkles } from 'lucide-react'
import type { GitCommitFile, GitGraphCommit } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { copyText } from '@/lib/copy'
import { cx, timeAgo } from '@/lib/format'

const ROW = 26
const LANE = 14
const COLORS = ['#8ad8ff', '#b9a7ff', '#7ee8c3', '#ffc46b', '#ff8fab', '#f2d27a', '#7aa2ff', '#ff9f6b']

interface Row {
  c: GitGraphCommit
  col: number
  /** Lanes entering this row from above and leaving it below: the commit each lane is waiting for. */
  before: Array<string | null>
  after: Array<string | null>
}

/** Give every commit a column so branches run as parallel lines. */
function layout(commits: GitGraphCommit[]): Row[] {
  const rows: Row[] = []
  let lanes: Array<string | null> = []
  for (const c of commits) {
    const before = [...lanes]
    let col = lanes.indexOf(c.sha)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
    }
    const after = [...lanes]
    while (after.length <= col) after.push(null)
    // every lane that was waiting for this commit ends here
    for (let i = 0; i < after.length; i++) if (after[i] === c.sha) after[i] = null
    c.parents.forEach((p, k) => {
      if (after.includes(p)) return
      if (k === 0) after[col] = p
      else {
        const free = after.indexOf(null)
        if (free >= 0) after[free] = p
        else after.push(p)
      }
    })
    while (after.length && after[after.length - 1] === null) after.pop()
    rows.push({ c, col, before, after })
    lanes = after
  }
  return rows
}

function Graph({ row, width }: { row: Row; width: number }): React.JSX.Element {
  const x = (i: number): number => i * LANE + LANE / 2 + 2
  const mid = ROW / 2
  const paths: React.JSX.Element[] = []
  row.before.forEach((sha, i) => {
    if (!sha) return
    if (sha === row.c.sha) {
      // a lane arriving at this commit
      paths.push(<path key={`in${i}`} d={i === row.col ? `M${x(i)} 0 V${mid}` : `M${x(i)} 0 C${x(i)} ${mid} ${x(row.col)} 0 ${x(row.col)} ${mid}`} stroke={COLORS[i % COLORS.length]} />)
    } else if (row.after[i] === sha) {
      paths.push(<path key={`pass${i}`} d={`M${x(i)} 0 V${ROW}`} stroke={COLORS[i % COLORS.length]} />)
    }
  })
  row.c.parents.forEach((p, k) => {
    const to = row.after.indexOf(p)
    if (to < 0) return
    paths.push(<path key={`out${k}`} d={to === row.col ? `M${x(to)} ${mid} V${ROW}` : `M${x(row.col)} ${mid} C${x(row.col)} ${ROW} ${x(to)} ${mid} ${x(to)} ${ROW}`} stroke={COLORS[to % COLORS.length]} />)
  })
  return (
    <svg width={width} height={ROW} className="graph-svg">
      <g fill="none" strokeWidth="1.6">
        {paths}
      </g>
      <circle cx={x(row.col)} cy={mid} r={row.c.parents.length > 1 ? 3.2 : 4} fill={row.c.parents.length > 1 ? 'var(--bg-1)' : COLORS[row.col % COLORS.length]} stroke={COLORS[row.col % COLORS.length]} strokeWidth="1.6" />
    </svg>
  )
}

/** The project's history as a graph: every branch, who did what and when, and what each commit changed. */
export function HistoryPanel({ focus }: { focus?: string }): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [commits, setCommits] = useState<GitGraphCommit[]>([])
  const [sel, setSel] = useState<string | null>(focus ?? null)
  const [files, setFiles] = useState<GitCommitFile[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setBusy(true)
    void prism.git
      .graph(400)
      .then(setCommits)
      .catch(toastError)
      .finally(() => setBusy(false))
  }, [])

  useEffect(load, [load, workspace])
  useEffect(() => {
    if (focus) setSel(focus)
  }, [focus])
  useEffect(() => {
    if (!sel) return setFiles([])
    let alive = true
    void prism.git.commitFiles(sel).then((f) => alive && setFiles(f))
    return () => {
      alive = false
    }
  }, [sel])
  useEffect(() => {
    if (sel) document.querySelector(`[data-sha="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel, commits.length])

  const rows = useMemo(() => layout(commits), [commits])
  const lanes = Math.min(12, rows.reduce((n, r) => Math.max(n, r.before.length, r.after.length, r.col + 1), 1))
  const width = lanes * LANE + 8
  const ql = q.trim().toLowerCase()
  const selected = commits.find((c) => c.sha === sel)

  const openFile = async (f: GitCommitFile): Promise<void> => {
    if (!sel) return
    try {
      const d = await prism.git.commitFileDiff(sel, f.path, f.oldPath)
      useLayout.getState().openDiff(f.path, f.status === 'A' ? '' : d.before, f.status === 'D' ? '' : d.after, `${sel.slice(0, 7)} · ${f.path.split('/').pop()}`)
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="history">
      <div className="history-bar">
        <History size={15} className="accent" />
        <span style={{ fontWeight: 600 }}>History</span>
        <span className="faint xs">{commits.length} commits, every branch</span>
        <span className="grow" />
        <input className="input sm" style={{ width: 220 }} placeholder="Find a commit…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn sm" title="Reload" onClick={load}>
          <RefreshCw size={13} className={busy ? 'spin-slow' : undefined} />
        </button>
      </div>
      <div className="history-split">
        <div className="history-list">
          {rows.map((r) => {
            const dim = ql && !`${r.c.subject} ${r.c.author} ${r.c.sha} ${r.c.refs.join(' ')}`.toLowerCase().includes(ql)
            return (
              <div key={r.c.sha} data-sha={r.c.sha} className={cx('history-row', sel === r.c.sha && 'on', dim && 'dim')} onClick={() => setSel(r.c.sha)}>
                <Graph row={r} width={width} />
                {r.c.refs.map((ref) => (
                  <span key={ref} className={cx('chip xs', /HEAD/.test(ref) ? 'accent' : ref.startsWith('tag:') ? 'amber' : /\//.test(ref) ? '' : 'mint')}>
                    {ref.replace('HEAD -> ', '').replace('tag: ', '')}
                  </span>
                ))}
                <span className="history-subject truncate">{r.c.subject}</span>
                <span className="faint xs history-author truncate">{r.c.author}</span>
                <span className="faint xs history-date">{timeAgo(r.c.date)}</span>
              </div>
            )
          })}
          {!busy && rows.length === 0 && <div className="empty">No commits yet</div>}
        </div>
        {selected && (
          <div className="history-detail">
            <div className="history-msg selectable">{selected.subject}</div>
            <div className="faint xs">
              {selected.author} · {new Date(selected.date).toLocaleString()} · <span className="mono">{selected.sha.slice(0, 10)}</span>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
              <button className="btn sm ghost" onClick={() => void copyText(selected.sha).then(() => useUi.getState().toast('success', 'Copied the commit id'))}>
                <Copy size={11} /> Copy id
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  const name = window.prompt('Name of the new branch starting at this commit:')
                  if (name?.trim()) void prism.git.createBranch(name.trim().replace(/\s+/g, '-'), selected.sha).then((r) => (useUi.getState().toast(r.ok ? 'success' : 'error', r.ok ? `Created ${name.trim()}` : 'Could not create the branch', r.ok ? undefined : r.output), load()))
                }}
              >
                <GitBranch size={11} /> Branch from here
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  useLayout.getState().openAgent()
                  void useSessions.getState().send(`Explain what commit ${selected.sha.slice(0, 10)} ("${selected.subject}") changed and why it might have been made. Use git show to read it.`)
                }}
              >
                <Sparkles size={11} /> Explain
              </button>
            </div>
            <div className="hud-label">Changed files · {files.length}</div>
            <div className="history-files">
              {files.map((f) => (
                <button key={f.path} className="history-file" onClick={() => void openFile(f)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className={cx('meta', f.status === 'A' ? 'git-a' : f.status === 'D' ? 'git-d' : 'git-m')}>{f.status}</span>
                  <FileIcon name={f.path} size={12} />
                  <span className="truncate">{f.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
