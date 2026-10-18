// Try it N ways: one request run by several models (or with several instructions) at the same time,
// each in its own copy of the project, then compared side by side: what each changed, whether its own
// checks passed, what it cost, what it said. Keep the best one; the others are thrown away.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Award, CheckCircle2, ExternalLink, FileDiff, GitMerge, Loader2, Plus, Split, Trash2, X, XCircle } from 'lucide-react'
import type { ModelRef, PermissionMode, TranscriptItem } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, modelKey, modelName, refFromKey } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { Select } from '@/components/Select'
import { Markdown } from '@/components/Markdown'
import { cx, humanCost } from '@/lib/format'

export interface Variant {
  sessionId: string
  model: ModelRef
  note: string
}

export interface Universe {
  id: string
  prompt: string
  startedAt: number
  variants: Variant[]
  /** The one brought into the project. */
  chosen: string | null
}

const KEY = 'prism.multiverse'
const load = (): Universe[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Universe[]
  } catch {
    return []
  }
}

export const useMultiverse = create<{ runs: Universe[]; current: string | null; set(runs: Universe[]): void }>((set) => ({
  runs: load(),
  current: null,
  set(runs) {
    try {
      localStorage.setItem(KEY, JSON.stringify(runs.slice(-20)))
    } catch {
      /* storage full */
    }
    set({ runs })
  }
}))

/** Start the same request in N copies of the project, one per variant. */
export async function startUniverse(prompt: string, variants: Array<{ model: ModelRef; note: string }>, mode: PermissionMode): Promise<void> {
  const short = prompt.replace(/\s+/g, ' ').slice(0, 40)
  const made: Variant[] = []
  for (const v of variants) {
    const s = await prism.sessions.createInCopy(`${short} · ${v.model.modelId}`)
    made.push({ sessionId: s.id, model: v.model, note: v.note })
  }
  const u: Universe = { id: Math.random().toString(16).slice(2, 10), prompt, startedAt: Date.now(), variants: made, chosen: null }
  const st = useMultiverse.getState()
  st.set([...st.runs, u])
  useMultiverse.setState({ current: u.id })
  await useSessions.getState().refresh()
  for (const v of made) {
    useSessions.getState().watch(v.sessionId)
    void prism.agent.send(v.sessionId, v.note.trim() ? `${prompt}\n\n${v.note.trim()}` : prompt, { model: v.model, mode }).catch(toastError)
  }
  useLayout.getState().openMultiverse()
}

/** The dialog for choosing the variants. */
export function TryWaysDialog({ prompt, mode, onClose, onStarted }: { prompt: string; mode: PermissionMode; onClose: () => void; onStarted?: () => void }): React.JSX.Element {
  const models = useApp((s) => s.models).filter((m) => m.supportsTools)
  const lead = useApp((s) => s.settings?.roles.lead)
  const favs = models.filter((m) => m.favorite)
  const first = lead ? modelKey(lead) : (models[0]?.key ?? '')
  const second = (favs.find((m) => m.key !== first) ?? models.find((m) => m.key !== first))?.key ?? first
  const [rows, setRows] = useState<Array<{ key: string; note: string }>>([
    { key: first, note: '' },
    { key: second, note: '' }
  ])
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      await startUniverse(
        prompt,
        rows.filter((r) => r.key).map((r) => ({ model: refFromKey(r.key)!, note: r.note })),
        mode
      )
      onStarted?.()
      onClose()
    } catch (e) {
      toastError(e, 'Could not start')
      setBusy(false)
    }
  }
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 'min(640px, 92vw)' }}>
        <div className="modal-head">
          <Split size={15} /> <b>Try it {rows.length} ways</b>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="small faint" style={{ marginBottom: 10 }}>
            Each way runs at the same time in its own copy of the project, so none of them touches your files. Afterwards you see them side by side and bring in the one you like. Needs a git project with at least one commit.
          </div>
          <div className="tryways-prompt small">{prompt}</div>
          {rows.map((r, i) => (
            <div key={i} className="tryways-row">
              <span className="tryways-n">{i + 1}</span>
              <Select value={r.key} size="sm" searchable width={300} options={models.map((m) => ({ value: m.key, label: modelName(m), group: m.endpointName }))} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, key: v } : x)))} />
              <input className="input sm grow" placeholder="Extra instruction for this way (optional), e.g. keep it minimal" value={r.note} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
              {rows.length > 2 && (
                <button className="icon-btn sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          {rows.length < 4 && (
            <button className="btn sm ghost" onClick={() => setRows([...rows, { key: first, note: '' }])}>
              <Plus size={12} /> Another way
            </button>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || rows.some((r) => !r.key)} onClick={() => void go()}>
            {busy ? 'Starting…' : `Start ${rows.length} at once`}
          </button>
        </div>
      </div>
    </div>
  )
}

interface Facts {
  files: string[]
  verdict: 'proven' | 'not-proven' | null
  report: string
}

function VariantColumn({ v, chosen, onChoose, judged }: { v: Variant; chosen: string | null; onChoose: () => void; judged?: { best: boolean; note: string } }): React.JSX.Element {
  const live = useSessions((s) => s.live[v.sessionId])
  const session = useSessions((s) => s.sessions.find((x) => x.id === v.sessionId))
  const [facts, setFacts] = useState<Facts | null>(null)
  const running = live?.running ?? session?.status === 'running'
  useEffect(() => {
    useSessions.getState().watch(v.sessionId)
  }, [v.sessionId])
  useEffect(() => {
    if (running) return
    let gone = false
    void (async () => {
      const [files, items] = await Promise.all([prism.sessions.copyChanges(v.sessionId).catch(() => []), prism.sessions.items(v.sessionId).catch(() => [] as TranscriptItem[])])
      let verdict: Facts['verdict'] = null
      let report = ''
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (!report && it.kind === 'assistant' && it.text.trim()) report = it.text.trim()
        if (verdict === null && it.kind === 'system' && Array.isArray(it.meta?.['verdict'])) verdict = (it.meta!['verdict'] as Array<{ ok: boolean }>).every((c) => c.ok) ? 'proven' : 'not-proven'
      }
      if (!gone) setFacts({ files: files.map((f) => f.path), verdict, report })
    })()
    return () => {
      gone = true
    }
  }, [running, v.sessionId])
  const isChosen = chosen === v.sessionId
  return (
    <div className={cx('mv-col', isChosen && 'chosen', chosen && !isChosen && 'dropped', judged?.best && 'judged-best')}>
      {judged && (
        <div className={cx('mv-judged', judged.best && 'best')}>
          {judged.best && <Award size={12} />}
          <span>{judged.best ? 'The judge would keep this one. ' : ''}{judged.note}</span>
        </div>
      )}
      <div className="mv-head">
        {running ? <Loader2 size={13} className="spin accent" /> : live?.lastReason && live.lastReason !== 'completed' ? <XCircle size={13} className="rose" /> : <CheckCircle2 size={13} className="mint" />}
        <b className="truncate">{v.model.modelId}</b>
        <span className="grow" />
        <span className="faint xs">{humanCost(session?.cost ?? 0)}</span>
      </div>
      {v.note && <div className="mv-note faint xs">{v.note}</div>}
      <div className="mv-stats small">
        {running ? (
          <span className="faint">{live?.status ?? 'working'}…</span>
        ) : facts ? (
          <>
            <span>
              {facts.files.length} file{facts.files.length === 1 ? '' : 's'} changed
            </span>
            {facts.verdict && <span className={cx('chip xs', facts.verdict === 'proven' ? 'mint' : 'amber')}>{facts.verdict === 'proven' ? 'its checks pass' : 'its checks fail'}</span>}
          </>
        ) : (
          <span className="faint">…</span>
        )}
      </div>
      {facts && facts.files.length > 0 && (
        <div className="mv-files mono xs faint">
          {facts.files.slice(0, 8).map((f) => (
            <div key={f} className="truncate">
              {f}
            </div>
          ))}
          {facts.files.length > 8 && <div>…and {facts.files.length - 8} more</div>}
        </div>
      )}
      {facts?.report && (
        <div className="mv-report md-small">
          <Markdown text={facts.report.length > 1600 ? `${facts.report.slice(0, 1600)}…` : facts.report} />
        </div>
      )}
      <div className="mv-actions">
        <button
          className="btn sm ghost"
          onClick={() => {
            useLayout.getState().openAgent()
            void useSessions.getState().select(v.sessionId)
          }}
        >
          <ExternalLink size={12} /> Open
        </button>
        {!running && facts && facts.files.length > 0 && (
          <button className="btn sm ghost" onClick={() => useLayout.getState().openCopyChanges(v.sessionId)}>
            <FileDiff size={12} /> Changes
          </button>
        )}
        {!running && !chosen && facts && facts.files.length > 0 && (
          <button className="btn sm solid" onClick={onChoose}>
            <GitMerge size={12} /> Use this one
          </button>
        )}
        {isChosen && <span className="chip xs mint">brought in</span>}
      </div>
    </div>
  )
}

export function MultiversePanel(): React.JSX.Element {
  const { runs, current } = useMultiverse()
  const u = runs.find((r) => r.id === current) ?? runs[runs.length - 1]
  const [judging, setJudging] = useState(false)
  const [verdict, setVerdict] = useState<{ id: string; best: number; why: string; notes: string[]; model: string } | null>(null)
  const anyRunning = useSessions((s) => (u ? u.variants.some((v) => s.live[v.sessionId]?.running) : false))
  if (!u) {
    return (
      <div className="multiverse empty-mv">
        <Split size={22} className="faint" />
        <div className="faint">Nothing tried yet. Write a request in the agent's message box and press the split button to try it several ways at once.</div>
      </div>
    )
  }
  const judge = async (): Promise<void> => {
    setJudging(true)
    try {
      const r = await prism.conversations.judge(
        u.prompt,
        u.variants.map((v) => ({ sessionId: v.sessionId, label: `${v.model.modelId}${v.note ? `, told: ${v.note}` : ''}` }))
      )
      setVerdict({ id: u.id, ...r })
    } catch (e) {
      toastError(e, 'The judge could not decide')
    } finally {
      setJudging(false)
    }
  }
  const choose = async (sid: string): Promise<void> => {
    try {
      const r = await prism.sessions.copyIntegrate(sid)
      if (!r.ok) {
        toastError(new Error(r.output), 'Could not bring it in')
        return
      }
      // the others are not needed any more
      for (const v of u.variants) if (v.sessionId !== sid) await prism.sessions.copyDiscard(v.sessionId).catch(() => null)
      const st = useMultiverse.getState()
      st.set(st.runs.map((x) => (x.id === u.id ? { ...x, chosen: sid } : x)))
      useUi.getState().toast('success', 'Brought in', 'The other ways were thrown away.')
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <div className="multiverse">
      <div className="mv-top">
        <Split size={15} className="accent" />
        <b>Tried {u.variants.length} ways</b>
        <span className="faint small truncate grow">{u.prompt}</span>
        {!u.chosen && (
          <button className="btn sm" disabled={judging || anyRunning} onClick={() => void judge()} title="The Review model compares the ways (changes, checks, answers, cost) and says which to keep">
            {judging ? <Loader2 size={12} className="spin" /> : <Award size={12} />} {judging ? 'Judging…' : 'Which is best?'}
          </button>
        )}
        {runs.length > 1 && (
          <Select
            value={u.id}
            size="sm"
            width={320}
            align="right"
            options={[...runs].reverse().map((r) => ({ value: r.id, label: r.prompt.slice(0, 60), sub: new Date(r.startedAt).toLocaleString() }))}
            onChange={(v) => useMultiverse.setState({ current: v })}
          />
        )}
      </div>
      {verdict && verdict.id === u.id && (
        <div className="mv-verdict">
          <Award size={14} className="amber" />
          <span>
            <b>Keep way {verdict.best + 1}</b> ({u.variants[verdict.best]?.model.modelId}): {verdict.why} <span className="faint">· judged by {verdict.model}</span>
          </span>
        </div>
      )}
      <div className="mv-cols" style={{ gridTemplateColumns: `repeat(${u.variants.length}, minmax(240px, 1fr))` }}>
        {u.variants.map((v, i) => (
          <VariantColumn key={v.sessionId} v={v} chosen={u.chosen} onChoose={() => void choose(v.sessionId)} judged={verdict && verdict.id === u.id ? { best: verdict.best === i, note: verdict.notes[i] ?? '' } : undefined} />
        ))}
      </div>
    </div>
  )
}
