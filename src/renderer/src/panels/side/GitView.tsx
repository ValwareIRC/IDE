import { useCallback, useEffect, useState } from 'react'
import { Scissors, Archive, ArrowDown, ArrowUp, Check, ChevronDown, GitBranch, GitCommitHorizontal, GitMerge, History, Minus, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import type { GitBranch as Branch, GitFile, GitLogEntry, GitOpResult, GitStash, GitStatus } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { cx, timeAgo } from '@/lib/format'
import { FileIcon } from '@/components/FileIcon'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { SplitDialog } from './SplitDialog'

export function GitView(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const openDiff = useLayout((s) => s.openDiff)
  const openAgent = useLayout((s) => s.openAgent)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [operation, setOperation] = useState<'merge' | 'rebase' | 'cherry-pick' | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [naming, setNaming] = useState<null | 'branch' | 'stash'>(null)
  const [splitting, setSplitting] = useState(false)
  const [name, setName] = useState('')

  const refresh = useCallback(() => {
    if (!workspace) return
    void prism.git.status().then(setStatus).catch(() => setStatus(null))
    void prism.git.log(12).then(setLog).catch(() => setLog([]))
    void prism.git.branches().then(setBranches).catch(() => setBranches([]))
    void prism.git.stashList().then(setStashes).catch(() => setStashes([]))
    void prism.git.operation().then(setOperation).catch(() => setOperation(null))
  }, [workspace])

  useEffect(() => {
    refresh()
    const off = prism.fs.onChanged(() => refresh())
    const t = setInterval(refresh, 8000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  /** Run a git operation and say plainly how it went. */
  const op = (what: string, fn: () => Promise<GitOpResult>): Promise<void> =>
    act(async () => {
      const r = await fn()
      const line = r.output.split('\n').filter(Boolean).slice(-1)[0] ?? ''
      useUi.getState().toast(r.ok ? 'success' : 'error', r.ok ? what : `${what} did not work`, r.ok ? line : r.output.slice(0, 400))
    })

  const showDiff = async (f: GitFile, staged: boolean): Promise<void> => {
    try {
      const d = await prism.git.diff(f.path, staged)
      openDiff(f.path, d.before, d.after, `${staged ? 'staged' : 'changes'} · ${f.path.split('/').pop()}`)
    } catch (e) {
      toastError(e)
    }
  }

  const commit = async (): Promise<void> => {
    if (!message.trim()) return
    await act(async () => {
      const r = await prism.git.commit(message.trim())
      if (r.ok) {
        useUi.getState().toast('success', 'Committed', r.output.split('\n')[0])
        setMessage('')
      } else useUi.getState().toast('error', 'Commit failed', r.output)
    })
  }

  if (!workspace) return <div className="side-view"><div className="empty">No folder open</div></div>
  if (status && !status.isRepo) {
    return (
      <div className="side-view">
        <div className="side-head"><span className="hud-label">Source control</span></div>
        <div className="empty">
          <div>Not a git repository</div>
          <button className="btn" onClick={() => void act(() => useSessions.getState().send('Initialise a git repository here with a sensible .gitignore for this project, then make an initial commit.'))}>
            <Sparkles size={13} /> Ask the agent to set one up
          </button>
        </div>
      </div>
    )
  }

  const conflicted = status?.files.filter((f) => f.status === 'U') ?? []
  const staged = status?.files.filter((f) => f.staged && f.status !== 'U') ?? []
  const unstaged = status?.files.filter((f) => f.unstaged && f.status !== 'U') ?? []
  const current = branches.find((b) => b.current)

  const branchMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const local = branches.filter((b) => !b.remote)
    const remote = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`)))
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      entries: [
        { label: 'New branch from here…', icon: <Plus size={13} />, onClick: () => { setNaming('branch'); setName('') } },
        { sep: true },
        ...local.map((b) => ({ label: `${b.current ? '● ' : ''}${b.name}`, hint: b.current ? 'current' : timeAgo(b.date), disabled: b.current, onClick: () => void op(`Switched to ${b.name}`, () => prism.git.checkout(b.name)) })),
        ...(remote.length ? [{ sep: true as const }, ...remote.slice(0, 12).map((b) => ({ label: b.name, hint: 'on the server', onClick: () => void op(`Switched to ${b.name.replace(/^[^/]+\//, '')}`, () => prism.git.checkout(b.name)) }))] : [])
      ]
    })
  }

  const branchActions = (b: Branch, e: React.MouseEvent): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: `Switch to ${b.name}`, disabled: b.current, onClick: () => void op(`Switched to ${b.name}`, () => prism.git.checkout(b.name)) },
        { label: `Merge ${b.name} into ${current?.name ?? 'this branch'}`, icon: <GitMerge size={13} />, disabled: b.current, onClick: () => void op(`Merged ${b.name}`, () => prism.git.merge(b.name)) },
        { sep: true },
        { label: 'Delete branch', danger: true, disabled: b.current || b.remote, onClick: () => window.confirm(`Delete the branch ${b.name}?`) && void op(`Deleted ${b.name}`, async () => { const r = await prism.git.deleteBranch(b.name, false); return !r.ok && /not fully merged/.test(r.output) && window.confirm(`${b.name} has work that is not merged anywhere. Delete it anyway?`) ? prism.git.deleteBranch(b.name, true) : r }) }
      ]
    })
  }

  const submitName = (): void => {
    const v = name.trim()
    const kind = naming
    setNaming(null)
    if (kind === 'branch' && v) void op(`Created ${v}`, () => prism.git.createBranch(v.replace(/\s+/g, '-')))
    if (kind === 'stash') void op('Changes set aside', () => prism.git.stashSave(v))
  }

  const row = (f: GitFile, isStaged: boolean): React.JSX.Element => (
    <div key={`${isStaged ? 's' : 'u'}:${f.path}`} className="tree-row" style={{ paddingLeft: 8 }} onClick={() => void showDiff(f, isStaged)} title={f.path}>
      <span className="ficon"><FileIcon name={f.path} /></span>
      <span className="name">
        {f.path.split('/').pop()}
        <span className="faint"> {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
      </span>
      <span className="git-actions">
        {isStaged ? (
          <button className="icon-btn sm" title="Unstage" onClick={(e) => { e.stopPropagation(); void act(() => prism.git.unstage([f.path])) }}><Minus size={12} /></button>
        ) : (
          <>
            <button className="icon-btn sm" title="Discard changes" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Discard changes to ${f.path}?`)) void act(() => prism.git.discard([f.path])) }}><RotateCcw size={12} /></button>
            <button className="icon-btn sm" title="Stage" onClick={(e) => { e.stopPropagation(); void act(() => prism.git.stage([f.path])) }}><Plus size={12} /></button>
          </>
        )}
      </span>
      <span className={cx('meta', f.status === '?' || f.status === 'A' ? 'git-a' : f.status === 'D' ? 'git-d' : 'git-m')}>{f.status === '?' ? 'U' : f.status}</span>
    </div>
  )

  return (
    <div className="side-view">
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
      <div className="side-head">
        <button className="git-branch" onClick={branchMenu} title="Switch or create a branch">
          <GitBranch size={13} />
          <span className="truncate">{status?.branch ?? 'git'}</span>
          <ChevronDown size={11} />
        </button>
        <span className="grow" />
        {busy && <span className="spinner" />}
        <button className="icon-btn sm" title={`Get the latest from the server${status?.behind ? ` (${status.behind} new)` : ''}`} onClick={() => void op('Up to date', () => prism.git.pull())}>
          <ArrowDown size={13} />
          {!!status?.behind && <span className="git-n">{status.behind}</span>}
        </button>
        <button className="icon-btn sm" title={`Send your commits to the server${status?.ahead ? ` (${status.ahead} to send)` : ''}`} onClick={() => void op('Sent', () => prism.git.push())}>
          <ArrowUp size={13} />
          {!!status?.ahead && <span className="git-n">{status.ahead}</span>}
        </button>
        <button className="icon-btn sm" title="Check the server for changes" onClick={() => void op('Checked the server', () => prism.git.fetch())}><RefreshCw size={13} /></button>
        <button className="icon-btn sm" title="History" onClick={() => useLayout.getState().openHistory()}><History size={13} /></button>
      </div>
      {naming && (
        <div className="git-name">
          <input className="input sm grow" autoFocus placeholder={naming === 'branch' ? 'Name of the new branch' : 'A note for these changes (optional)'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') setNaming(null) }} />
          <button className="btn sm solid" onClick={submitName}>{naming === 'branch' ? 'Create' : 'Set aside'}</button>
        </div>
      )}
      {operation && (
        <div className="git-banner">
          <TriangleAlert size={13} className="amber" />
          <span className="grow">A {operation} is in progress{conflicted.length ? ` · ${conflicted.length} file${conflicted.length === 1 ? '' : 's'} to settle` : ''}</span>
          <button className="btn sm ghost" onClick={() => window.confirm(`Give up this ${operation} and go back to how things were?`) && void op(`The ${operation} was abandoned`, () => prism.git.abortOperation())}>Abandon</button>
        </div>
      )}
      <div className="git-commit">
        <textarea
          className="input"
          rows={2}
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit()
          }}
        />
        <div className="row">
          <button className="btn sm primary" disabled={!message.trim() || staged.length === 0 || busy || conflicted.length > 0} onClick={() => void commit()} title={conflicted.length ? 'Settle the conflicts first' : staged.length ? 'Commit staged changes' : 'Stage something first'}>
            <GitCommitHorizontal size={13} /> Commit {staged.length ? `(${staged.length})` : ''}
          </button>
          <button className="btn sm ghost" title="Let the agent stage and commit with a good message" onClick={() => { openAgent(); void useSessions.getState().send('/commit') }}>
            <Sparkles size={13} /> Agent commit
          </button>
          <button className="btn sm ghost" title="Group the uncommitted changes into a few commits by topic, with messages; you check them before anything is committed" disabled={!status?.files.length} onClick={() => setSplitting(true)}>
            <Scissors size={13} /> Split…
          </button>
          {splitting && <SplitDialog onClose={() => setSplitting(false)} onDone={refresh} />}
        </div>
      </div>
      <div className="side-body tree">
        {conflicted.length > 0 && (
          <>
            <div className="side-section">
              <span className="hud-label rose">Conflicts · {conflicted.length}</span>
              <span className="grow" />
              <button className="btn sm ghost" title="Let the agent settle them" onClick={() => { openAgent(); void useSessions.getState().send(`These files have merge conflicts: ${conflicted.map((f) => f.path).join(', ')}. Read each one, settle the conflicts keeping the intent of both sides, remove every conflict marker, stage the files, and tell me what you chose and why. Do not commit.`) }}>
                <Sparkles size={12} /> Settle with Prism
              </button>
            </div>
            {conflicted.map((f) => (
              <div key={`c:${f.path}`} className="tree-row" style={{ paddingLeft: 8 }} onClick={() => useLayout.getState().openConflict(f.path)} title="Both sides changed this file. Click to choose.">
                <span className="ficon"><FileIcon name={f.path} /></span>
                <span className="name">{f.path.split('/').pop()}<span className="faint"> {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span></span>
                <span className="meta git-d">!</span>
              </div>
            ))}
          </>
        )}
        <div className="side-section">
          <span className="hud-label">Staged · {staged.length}</span>
          <span className="grow" />
          {staged.length > 0 && <button className="icon-btn sm" title="Unstage all" onClick={() => void act(() => prism.git.unstage(staged.map((f) => f.path)))}><Minus size={12} /></button>}
        </div>
        {staged.map((f) => row(f, true))}
        <div className="side-section">
          <span className="hud-label">Changes · {unstaged.length}</span>
          <span className="grow" />
          {unstaged.length > 0 && <button className="icon-btn sm" title="Set these changes aside for later (stash)" onClick={() => { setNaming('stash'); setName('') }}><Archive size={12} /></button>}
          {unstaged.length > 0 && <button className="icon-btn sm" title="Stage all" onClick={() => void act(() => prism.git.stage(unstaged.map((f) => f.path)))}><Plus size={12} /></button>}
        </div>
        {unstaged.map((f) => row(f, false))}
        {status && status.files.length === 0 && <div className="faint small" style={{ padding: '6px 12px' }}><Check size={12} /> Working tree clean</div>}
        {stashes.length > 0 && (
          <>
            <div className="side-section"><span className="hud-label">Set aside · {stashes.length}</span></div>
            {stashes.map((s) => (
              <div key={s.ref} className="tree-row" style={{ paddingLeft: 10 }} title={s.ref}>
                <Archive size={12} className="faint" />
                <span className="name">{s.message || 'changes'}</span>
                <span className="git-actions">
                  <button className="icon-btn sm" title="Bring these changes back" onClick={() => void op('Changes brought back', () => prism.git.stashApply(s.ref, true))}><RotateCcw size={12} /></button>
                  <button className="icon-btn sm" title="Throw them away" onClick={() => window.confirm('Throw away these set-aside changes for good?') && void op('Thrown away', () => prism.git.stashDrop(s.ref))}><Trash2 size={12} /></button>
                </span>
                <span className="meta">{timeAgo(s.date)}</span>
              </div>
            ))}
          </>
        )}
        <div className="side-section">
          <span className="hud-label">Branches</span>
        </div>
        {branches.filter((b) => !b.remote).map((b) => (
          <div key={b.name} className="tree-row" style={{ paddingLeft: 10 }} onContextMenu={(e) => branchActions(b, e)} onDoubleClick={() => !b.current && void op(`Switched to ${b.name}`, () => prism.git.checkout(b.name))} title={`${b.subject}\nRight-click for more`}>
            <GitBranch size={12} className={b.current ? 'accent' : 'faint'} />
            <span className={cx('name', b.current && 'accent')}>{b.name}</span>
            {(b.ahead > 0 || b.behind > 0) && <span className="faint xs">{b.ahead ? `↑${b.ahead}` : ''}{b.behind ? `↓${b.behind}` : ''}</span>}
            <span className="meta">{timeAgo(b.date)}</span>
          </div>
        ))}
        <div className="side-section">
          <span className="hud-label">Recent commits</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => useLayout.getState().openHistory()}>All history</button>
        </div>
        {log.map((c) => (
          <div key={c.sha} className="tree-row" style={{ paddingLeft: 10 }} title={`${c.sha}\n${c.author}`} onClick={() => useLayout.getState().openHistory(c.sha)}>
            <span className="mono faint xs">{c.short}</span>
            <span className="name">{c.message}</span>
            <span className="meta">{timeAgo(c.date)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
