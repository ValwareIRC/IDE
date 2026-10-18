// The task board: write down jobs, press Run, and come back to a report of each, proven or not.
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleDashed, CircleStop, ExternalLink, FileDiff, GitMerge, Loader2, Play, Plus, RotateCcw, Trash2, XCircle } from 'lucide-react'
import type { BoardTask, PermissionMode } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useApp, modelKey, modelName, refFromKey } from '@/state/app'
import { toastError, useUi } from '@/state/ui'
import { Select } from '@/components/Select'
import { Markdown } from '@/components/Markdown'
import { cx, timeAgo } from '@/lib/format'

type Draft = Partial<BoardTask> & { title: string; prompt: string }

const STATUS: Record<BoardTask['status'], string> = { todo: 'To do', queued: 'Waiting its turn', running: 'Working', done: 'Done', failed: 'Did not finish', stopped: 'Stopped' }

export function TasksPanel(): React.JSX.Element {
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [parallel, setParallel] = useState('1')
  const [editing, setEditing] = useState<string | null>(null)
  const models = useApp((s) => s.models)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void prism.tasks.list().then(setTasks).catch(() => {})
    return prism.tasks.onChanged(setTasks)
  }, [])

  const persist = (next: BoardTask[]): void => {
    setTasks(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void prism.tasks.save(next as Draft[]).catch(toastError), 400)
  }
  const change = (id: string, p: Partial<BoardTask>): void => persist(tasks.map((t) => (t.id === id ? { ...t, ...p } : t)))
  const add = (): void => {
    const id = Math.random().toString(16).slice(2, 10)
    const t: BoardTask = { id, title: 'New task', prompt: '', ownCopy: false, mode: 'auto', model: null, status: 'todo', sessionId: null, summary: '', verdict: null, changed: 0, startedAt: null, endedAt: null, error: null }
    // the id is the board's own once saved
    void prism.tasks
      .save([...tasks, t] as Draft[])
      .then((list) => {
        setTasks(list)
        setEditing(list[list.length - 1]?.id ?? null)
      })
      .catch(toastError)
  }
  const remove = (id: string): void => persist(tasks.filter((t) => t.id !== id))
  const runAll = (): void => void prism.tasks.run(null, Number(parallel)).then(setTasks).catch(toastError)
  const runOne = (id: string): void => void prism.tasks.run([id], Number(parallel)).then(setTasks).catch(toastError)
  const stop = (): void => void prism.tasks.stop().then(setTasks).catch(toastError)
  const again = (id: string): void => persist(tasks.map((t) => (t.id === id ? { ...t, status: 'todo' } : t)))
  const open = (sid: string | null): void => {
    if (!sid) return
    useLayout.getState().openAgent()
    void useSessions.getState().refresh().then(() => useSessions.getState().select(sid))
  }
  const bringIn = async (t: BoardTask): Promise<void> => {
    if (!t.sessionId) return
    try {
      const r = await prism.sessions.copyIntegrate(t.sessionId)
      if (r.ok) useUi.getState().toast('success', `Brought in "${t.title}"`, r.output.split('\n').slice(-2).join(' '))
      else toastError(new Error(r.output), 'Could not bring it in')
    } catch (e) {
      toastError(e)
    }
  }

  const finished = tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'stopped')
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  const todo = tasks.filter((t) => t.status === 'todo')
  const proven = finished.filter((t) => t.verdict === 'proven').length
  const modelOptions = [{ value: '', label: 'The default model' }, ...models.filter((m) => m.supportsTools).map((m) => ({ value: m.key, label: modelName(m), group: m.endpointName }))]

  return (
    <div className="tasks">
      <div className="tasks-head">
        <h2>Task board</h2>
        <span className="grow" />
        <span className="faint small">at a time</span>
        <Select value={parallel} size="sm" options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))} onChange={setParallel} />
        {running.length ? (
          <button className="btn sm danger" onClick={stop}>
            <CircleStop size={13} /> Stop
          </button>
        ) : (
          <button className="btn sm solid" disabled={!todo.length} onClick={runAll} title="Work through every task still to do">
            <Play size={13} /> Run {todo.length ? `all ${todo.length}` : ''}
          </button>
        )}
        <button className="btn sm" onClick={add}>
          <Plus size={13} /> Add a task
        </button>
      </div>
      <div className="lead">Write down jobs for the agent and press Run: it works through them by itself, each in its own session, for example overnight. Each one ends with a report, and with proof when it could check its work.</div>

      {finished.length > 0 && (
        <div className="tasks-digest">
          <b>Report:</b> {finished.filter((t) => t.status === 'done').length} done{proven ? ` (${proven} proven by their own checks)` : ''}
          {finished.some((t) => t.status !== 'done') ? `, ${finished.filter((t) => t.status !== 'done').length} did not finish` : ''}, {finished.reduce((n, t) => n + t.changed, 0)} files changed
          {running.length ? `; ${running.length} still going` : ''}.
        </div>
      )}

      {tasks.length === 0 && (
        <div className="tasks-empty">
          <div className="faint">No tasks yet. Add one: "Add tests for the parser", "Upgrade the date library and fix what breaks", "Write the README section on deploying"…</div>
        </div>
      )}

      <div className="tasks-list">
        {tasks.map((t) => {
          const isEditing = editing === t.id && (t.status === 'todo' || t.status === 'done' || t.status === 'failed' || t.status === 'stopped')
          return (
            <div key={t.id} className={cx('task-card', t.status)}>
              <div className="task-top">
                <span className="task-status" title={STATUS[t.status]}>
                  {t.status === 'running' ? <Loader2 size={14} className="spin" /> : t.status === 'done' ? <CheckCircle2 size={14} className="mint" /> : t.status === 'failed' ? <XCircle size={14} className="rose" /> : <CircleDashed size={14} className="faint" />}
                </span>
                {isEditing ? (
                  <input className="input sm task-title-input" value={t.title} onChange={(e) => change(t.id, { title: e.target.value })} placeholder="A short name" />
                ) : (
                  <button className="task-title" onClick={() => setEditing(t.id)}>
                    {t.title}
                  </button>
                )}
                <span className={cx('chip xs', t.status === 'done' && 'mint', t.status === 'failed' && 'rose', t.status === 'running' && 'accent')}>{STATUS[t.status]}</span>
                {t.verdict && <span className={cx('chip xs', t.verdict === 'proven' ? 'mint' : 'amber')}>{t.verdict === 'proven' ? 'proven' : 'checks failed'}</span>}
                {t.ownCopy && <span className="chip xs violet">own copy</span>}
                <span className="grow" />
                {t.endedAt && <span className="faint xs">{timeAgo(t.endedAt)}</span>}
                {t.status === 'todo' && (
                  <button className="icon-btn sm" title="Run just this one" onClick={() => runOne(t.id)} disabled={!t.prompt.trim()}>
                    <Play size={13} />
                  </button>
                )}
                {(t.status === 'done' || t.status === 'failed' || t.status === 'stopped') && (
                  <button className="icon-btn sm" title="Put it back on the list to run again" onClick={() => again(t.id)}>
                    <RotateCcw size={13} />
                  </button>
                )}
                {t.status !== 'running' && t.status !== 'queued' && (
                  <button className="icon-btn sm" title="Delete" onClick={() => remove(t.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {isEditing ? (
                <div className="task-edit">
                  <textarea className="input task-prompt" rows={4} value={t.prompt} placeholder="What should the agent do? Be as specific as you would be with a colleague: what, where, and how to tell it worked." onChange={(e) => change(t.id, { prompt: e.target.value })} />
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Select
                      value={t.mode}
                      size="sm"
                      options={[
                        { value: 'auto', label: 'Full auto', sub: 'Runs everything: needed when nobody is there to approve' },
                        { value: 'auto-edit', label: 'Edit freely', sub: 'Commands wait for you' },
                        { value: 'ask', label: 'Ask first', sub: 'Everything waits for you' }
                      ]}
                      onChange={(v) => change(t.id, { mode: v as PermissionMode })}
                    />
                    <Select value={t.model ? modelKey(t.model) : ''} size="sm" searchable width={300} options={modelOptions} onChange={(v) => change(t.id, { model: v ? refFromKey(v) : null })} />
                    <label className="row small" style={{ gap: 6 }} title="Work in a separate copy of the project (needs git), so tasks cannot trip over each other; bring the work in afterwards">
                      <input type="checkbox" checked={t.ownCopy} onChange={(e) => change(t.id, { ownCopy: e.target.checked })} /> In its own copy
                    </label>
                    <span className="grow" />
                    <button className="btn sm" onClick={() => setEditing(null)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {t.prompt && t.status === 'todo' && (
                    <div className="task-prompt-view faint small" onClick={() => setEditing(t.id)}>
                      {t.prompt.length > 220 ? `${t.prompt.slice(0, 220)}…` : t.prompt}
                    </div>
                  )}
                  {t.error && <div className="task-error small">{t.error}</div>}
                  {t.summary && (
                    <details className="task-summary" open={t.status !== 'running'}>
                      <summary className="small faint">Its report{t.changed ? ` · ${t.changed} file${t.changed === 1 ? '' : 's'} changed` : ''}</summary>
                      <div className="md-small">
                        <Markdown text={t.summary} />
                      </div>
                    </details>
                  )}
                  {t.sessionId && (
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      <button className="btn sm ghost" onClick={() => open(t.sessionId)}>
                        <ExternalLink size={12} /> Open the session
                      </button>
                      {t.status !== 'running' && t.changed > 0 && (
                        <button className="btn sm ghost" onClick={() => (t.ownCopy ? useLayout.getState().openCopyChanges(t.sessionId!) : useLayout.getState().openReview(t.sessionId!))}>
                          <FileDiff size={12} /> See the changes
                        </button>
                      )}
                      {t.ownCopy && t.status === 'done' && t.changed > 0 && (
                        <button className="btn sm" onClick={() => void bringIn(t)}>
                          <GitMerge size={12} /> Bring it in
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
