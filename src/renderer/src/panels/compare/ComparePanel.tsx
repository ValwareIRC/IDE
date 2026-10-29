import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, CornerDownRight, Play, Square } from 'lucide-react'
import type { CompareEvent } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, modelKey, refFromKey } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { Markdown } from '@/components/Markdown'
import { copyText } from '@/lib/copy'
import { cx, humanCost, humanDuration, humanTokens } from '@/lib/format'

interface Column {
  text: string
  state: 'running' | 'done' | 'error'
  error?: string
  ms?: number
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

const PICK_KEY = 'prism.compare.models'

/** One question, several models, answers side by side. Pick the one you like and carry on with it. */
export function ComparePanel(): React.JSX.Element {
  const models = useApp((s) => s.models)
  const sessionId = useSessions((s) => s.active)
  const session = useSessions((s) => s.sessions.find((x) => x.id === s.active))
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState('')
  const [useContext, setUseContext] = useState(true)
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      return (JSON.parse(localStorage.getItem(PICK_KEY) ?? '[]') as string[]).slice(0, 6)
    } catch {
      return []
    }
  })
  const [cols, setCols] = useState<Record<string, Column>>({})
  const runId = useRef<string | null>(null)
  const off = useRef<(() => void) | null>(null)

  const choices = useMemo(() => models.filter((m) => m.endpointId !== 'claude-agent').sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.modelId.localeCompare(b.modelId)), [models])
  const running = Object.values(cols).some((c) => c.state === 'running')

  useEffect(() => {
    localStorage.setItem(PICK_KEY, JSON.stringify(picked))
  }, [picked])

  useEffect(
    () => () => {
      off.current?.()
      if (runId.current) void prism.agent.compareStop(runId.current)
    },
    []
  )

  const toggle = (key: string): void => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= 6 ? p : [...p, key]))

  const ask = (): void => {
    const q = question.trim()
    const refs = picked.map(refFromKey).filter((r): r is NonNullable<typeof r> => !!r)
    if (!q || refs.length < 1 || running) return
    off.current?.()
    const id = `c${Date.now()}`
    runId.current = id
    setAsked(q)
    setCols(Object.fromEntries(picked.map((k) => [k, { text: '', state: 'running' as const }])))
    off.current = prism.agent.onCompare(id, (ev: CompareEvent) => {
      setCols((c) => {
        const cur = c[ev.key] ?? { text: '', state: 'running' as const }
        if (ev.type === 'delta') return { ...c, [ev.key]: { ...cur, text: cur.text + ev.text } }
        if (ev.type === 'done') return { ...c, [ev.key]: { text: ev.text || cur.text, state: 'done', ms: ev.ms, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cost: ev.cost } }
        return { ...c, [ev.key]: { ...cur, state: 'error', error: ev.message } }
      })
    })
    void prism.agent.compare(id, useContext ? sessionId : null, q, refs).catch(toastError)
  }

  const adopt = async (key: string): Promise<void> => {
    const ref = refFromKey(key)
    const col = cols[key]
    if (!ref || !col) return
    try {
      const st = useSessions.getState()
      const id = sessionId ?? (await st.create())?.id
      if (!id) return
      await prism.agent.adopt(id, asked, col.text, ref)
      await st.setModel(ref, id)
      useLayout.getState().openAgent()
      useUi.getState().toast('success', `Continuing with ${ref.modelId}`, 'Its answer is now part of the conversation.')
    } catch (e) {
      toastError(e)
    }
  }

  const shown = picked.filter((k) => cols[k])

  return (
    <div className="compare">
      <div className="compare-top">
        <div className="compare-ask">
          <textarea
            className="input"
            rows={2}
            placeholder="Ask every chosen model the same thing…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask()
              }
            }}
          />
          {running ? (
            <button className="btn danger" onClick={() => runId.current && void prism.agent.compareStop(runId.current)}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="btn solid" disabled={!question.trim() || picked.length < 1} onClick={ask}>
              <Play size={12} /> Ask {picked.length || ''}
            </button>
          )}
        </div>
        <div className="compare-models">
          {choices.map((m) => {
            const key = modelKey({ endpointId: m.endpointId, modelId: m.modelId })
            return (
              <button key={key} className={cx('chip clickable', picked.includes(key) && 'accent')} onClick={() => toggle(key)} title={m.endpointName}>
                {m.favorite ? '★ ' : ''}
                {m.modelId}
              </button>
            )
          })}
          <span className="grow" />
          {session && (
            <label className="compare-ctx small dim" title="Send the conversation so far along with the question">
              <input type="checkbox" checked={useContext} onChange={(e) => setUseContext(e.target.checked)} /> include “{session.title.slice(0, 28)}”
            </label>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          <Columns3 size={24} className="accent" />
          <div>Compare models</div>
          <div className="small faint">Choose two or more models above, ask a question, and read the answers side by side. Then carry on the conversation with the one you prefer.</div>
        </div>
      ) : (
        <div className="compare-cols" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(260px, 1fr))` }}>
          {shown.map((key) => {
            const c = cols[key]!
            const ref = refFromKey(key)
            return (
              <div key={key} className="compare-col">
                <div className="compare-head">
                  <span className={cx('dot', c.state === 'running' && 'live', c.state === 'error' && 'rose')} />
                  <span className="truncate" style={{ fontWeight: 600 }}>
                    {ref?.modelId}
                  </span>
                  <span className="grow" />
                  {c.state === 'done' && (
                    <span className="faint xs mono">
                      {humanDuration(c.ms ?? 0)} · {humanTokens(c.outputTokens ?? 0)}↓ · {humanCost(c.cost ?? 0)}
                    </span>
                  )}
                </div>
                <div className="compare-body selectable">
                  {c.state === 'error' ? <div className="rose small">{c.error}</div> : c.text ? <Markdown text={c.text} onOpenFile={(p) => useLayout.getState().openEditor(p)} /> : <span className="spinner" />}
                </div>
                {c.state === 'done' && (
                  <div className="compare-foot">
                    <button className="btn sm primary" onClick={() => void adopt(key)} title="Add this question and answer to the conversation and switch the session to this model">
                      <CornerDownRight size={12} /> Continue with this one
                    </button>
                    <button className="btn sm ghost" onClick={() => void copyText(c.text)}>
                      Copy
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
