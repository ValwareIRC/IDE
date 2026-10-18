import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Info, Play, RefreshCw, ScrollText, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import type { Problem } from '@shared/types'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useProblems, allProblems } from '@/state/problems'
import { FileIcon } from '@/components/FileIcon'
import { cx } from '@/lib/format'

type Filter = 'all' | 'error' | 'warning'

let lastWorkspace: string | null = null

function line(p: Problem): string {
  return `${p.file}:${p.line}:${p.column}: ${p.severity}${p.code ? ` ${p.code}` : ''}: ${p.message} (${p.source})`
}

function askAgent(text: string): void {
  useLayout.getState().openAgent()
  void useSessions.getState().send(text)
}

/** Everything that is wrong in the project, in one list: what the editor underlines plus what the project's own checkers report. */
export function ProblemsPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const editor = useProblems((s) => s.editor)
  const results = useProblems((s) => s.results)
  const checkers = useProblems((s) => s.checkers)
  const running = useProblems((s) => s.running)
  const stale = useProblems((s) => s.stale)
  const auto = useProblems((s) => s.auto)
  const openEditor = useLayout((s) => s.openEditor)
  const [filter, setFilter] = useState<Filter>('all')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [output, setOutput] = useState<string | null>(null)

  useEffect(() => {
    // results belong to a project: start clean only when it changes, not each time the panel opens
    if (lastWorkspace !== workspace) {
      lastWorkspace = workspace
      useProblems.getState().reset()
    }
    if (workspace) void useProblems.getState().refreshCheckers()
  }, [workspace])

  const problems = useMemo(() => allProblems({ editor, results }), [editor, results])
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length
  const shown = filter === 'all' ? problems : problems.filter((p) => p.severity === filter)
  const groups = useMemo(() => {
    const m = new Map<string, Problem[]>()
    for (const p of shown) m.set(p.file, [...(m.get(p.file) ?? []), p])
    return [...m.entries()].map(([file, list]) => [file, list.sort((a, b) => a.line - b.line)] as const).sort((a, b) => b[1].filter((p) => p.severity === 'error').length - a[1].filter((p) => p.severity === 'error').length || a[0].localeCompare(b[0]))
  }, [shown])
  const anyRunning = Object.values(running).some(Boolean)
  const shownOutput = output ? results[output] : undefined

  const fixAll = (): void =>
    askAgent(
      `Fix these problems, then run check_project to confirm they are gone.\n\n${shown.slice(0, 60).map(line).join('\n')}${shown.length > 60 ? `\n… and ${shown.length - 60} more` : ''}`
    )

  return (
    <div className="problems">
      <div className="problems-bar">
        <span className={cx('problems-count', errors > 0 && 'rose')}>
          <CircleAlert size={13} /> {errors}
        </span>
        <span className={cx('problems-count', warnings > 0 && 'amber')}>
          <TriangleAlert size={13} /> {warnings}
        </span>
        <div className="seg">
          {(['all', 'error', 'warning'] as const).map((f) => (
            <button key={f} className={cx(filter === f && 'on')} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'error' ? 'Errors' : 'Warnings'}
            </button>
          ))}
        </div>
        <span className="problems-checkers">
          {checkers.map((c) => {
            const r = results[c.id]
            const busy = !!running[c.id]
            const state = busy ? 'busy' : !r ? 'idle' : r.note ? 'broken' : r.code === 0 && !r.problems.length ? 'ok' : 'bad'
            return (
              <span key={c.id} className={cx('checker', state, stale[c.id] && 'stale')} title={`${c.command}${stale[c.id] ? '\nFiles changed since this ran.' : ''}${r?.note ? `\n${r.note}` : ''}`}>
                <button className="checker-run" onClick={() => void useProblems.getState().run(c.id)} disabled={busy}>
                  {busy ? <span className="spinner" /> : state === 'ok' ? <CheckCircle2 size={12} /> : state === 'bad' || state === 'broken' ? <CircleAlert size={12} /> : <Play size={11} />}
                  {c.label}
                  {r && !busy && state === 'bad' && <b>{r.problems.length || '!'}</b>}
                </button>
                {r && (
                  <button className={cx('checker-out', output === c.id && 'on')} title="What it printed" onClick={() => setOutput(output === c.id ? null : c.id)}>
                    <ScrollText size={11} />
                  </button>
                )}
              </span>
            )
          })}
        </span>
        <span className="grow" />
        {checkers.length > 0 && (
          <>
            <button className={cx('chip xs clickable', auto && 'accent')} title="Run the type and lint checks again by themselves shortly after files change" onClick={() => useProblems.getState().setAuto(!auto)}>
              {auto ? 'keeps checking' : 'check on change: off'}
            </button>
            <button className="btn sm ghost" disabled={anyRunning} onClick={() => void useProblems.getState().runAll()} title="Run every type and lint check (tests run from their own button)">
              <RefreshCw size={12} /> Check all
            </button>
          </>
        )}
        <button className="btn sm primary" disabled={!shown.length} onClick={fixAll} title="Hand the list to the agent">
          <Sparkles size={12} /> Fix all with Prism
        </button>
      </div>
      <div className="problems-body">
        {shownOutput && (
          <pre className="problems-output mono">
            {shownOutput.note ? `${shownOutput.note}\n\n` : ''}
            {shownOutput.output?.trim() || '(nothing was printed)'}
          </pre>
        )}
        {!shownOutput && groups.length === 0 && (
          <div className="empty">
            <CheckCircle2 size={24} className="mint" />
            <div>{problems.length ? 'Nothing of that kind' : 'No problems found'}</div>
            <div className="small faint">
              {!workspace
                ? 'Open a folder to check a project.'
                : checkers.length
                  ? Object.keys(results).length
                    ? 'The checks that ran are clean.'
                    : 'Press Check all to run this project’s own checks. Editor errors appear here by themselves.'
                  : 'No checkers were found for this project. You can add your own in .prism/checks.json.'}
            </div>
          </div>
        )}
        {!shownOutput &&
          groups.map(([file, list]) => {
            const isClosed = closed.has(file)
            return (
              <div key={file} className="problem-group">
                <button
                  className="problem-file"
                  onClick={() =>
                    setClosed((s) => {
                      const n = new Set(s)
                      if (n.has(file)) n.delete(file)
                      else n.add(file)
                      return n
                    })
                  }
                >
                  {isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <FileIcon name={file} size={13} />
                  <span className="truncate">{file.split('/').pop()}</span>
                  <span className="faint xs truncate">{file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''}</span>
                  <span className="problem-n">{list.length}</span>
                </button>
                {!isClosed &&
                  list.map((p, i) => (
                    <div key={i} className="problem-row" onClick={() => openEditor(p.file, { line: p.line, column: p.column })}>
                      {p.severity === 'error' ? <CircleAlert size={13} className="rose" /> : p.severity === 'warning' ? <TriangleAlert size={13} className="amber" /> : <Info size={13} className="accent" />}
                      <span className="problem-msg">{p.message}</span>
                      {p.code && <span className="chip xs">{p.code}</span>}
                      <span className="faint xs problem-src">{p.source}</span>
                      <span className="faint xs mono">
                        {p.line}:{p.column}
                      </span>
                      <button
                        className="icon-btn sm problem-fix"
                        title="Fix this with Prism"
                        onClick={(e) => {
                          e.stopPropagation()
                          askAgent(`Fix this problem, then run check_project to confirm it is gone.\n\n${line(p)}`)
                        }}
                      >
                        <Wrench size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            )
          })}
      </div>
    </div>
  )
}
