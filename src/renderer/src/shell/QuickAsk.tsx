// Quick ask: a question about the code, answered in an overlay by a read-only agent, without starting a
// session or cluttering the list. Ctrl+Shift+A opens it; Esc closes it; recent answers stay until restart.
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { CircleStop, CornerDownLeft, MessageCircleQuestion, MessagesSquare, X } from 'lucide-react'
import type { AgentEvent } from '@shared/types'
import { prism } from '@/lib/ipc'
import { Markdown } from '@/components/Markdown'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError } from '@/state/ui'
import { describeCall } from '@/panels/agent/ToolRow'
import { cx } from '@/lib/format'

interface Asked {
  id: string
  question: string
  answer: string
  doing: string | null
  done: boolean
  error: string | null
}

export const useQuickAsk = create<{ open: boolean; asked: Asked[]; toggle(on?: boolean): void }>((set) => ({
  open: false,
  asked: [],
  toggle: (on) => set((s) => ({ open: on ?? !s.open }))
}))

function follow(id: string): void {
  const patch = (p: Partial<Asked>): void => useQuickAsk.setState((s) => ({ asked: s.asked.map((a) => (a.id === id ? { ...a, ...p } : a)) }))
  let text = ''
  const off = prism.agent.onEvent(id, (ev: AgentEvent) => {
    if (ev.type === 'text-delta') {
      text += ev.text
      patch({ answer: text, doing: null })
    } else if (ev.type === 'step-start') text = ''
    else if (ev.type === 'tool-start') {
      const d = describeCall(ev.call)
      patch({ doing: `${d.verb} ${d.target}`.trim() })
    } else if (ev.type === 'item' && ev.item.kind === 'assistant' && ev.item.text.trim()) patch({ answer: ev.item.text })
    else if (ev.type === 'run-end') {
      patch({ done: true, doing: null, ...(ev.reason === 'error' ? { error: ev.error ?? 'It could not answer.' } : {}) })
      off()
    }
  })
}

export function QuickAsk(): React.JSX.Element | null {
  const { open, asked, toggle } = useQuickAsk()
  const [q, setQ] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 30)
  }, [open])
  if (!open) return null
  const ask = async (): Promise<void> => {
    const question = q.trim()
    if (!question) return
    setQ('')
    try {
      const id = await prism.agent.quickAsk(question)
      useQuickAsk.setState((s) => ({ asked: [{ id, question, answer: '', doing: 'Reading…', done: false, error: null }, ...s.asked].slice(0, 12) }))
      follow(id)
    } catch (e) {
      toastError(e, 'Could not ask')
    }
  }
  // carry the question and its answer into a real session to keep working on it
  const continueIt = async (a: Asked): Promise<void> => {
    const s = await useSessions.getState().create()
    if (!s) return
    useSessions.getState().setDraft(s.id, `Earlier I asked: ${a.question}\n\nThe answer was:\n${a.answer}\n\nNow: `)
    useLayout.getState().openAgent()
    toggle(false)
  }
  return (
    <div className="quickask-overlay" onMouseDown={() => toggle(false)}>
      <div className="quickask" onMouseDown={(e) => e.stopPropagation()}>
        <div className="quickask-input">
          <MessageCircleQuestion size={16} className="accent" />
          <textarea
            ref={input}
            rows={1}
            value={q}
            placeholder="Ask about the code: where is…, how does…, why does…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggle(false)
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask()
              }
            }}
          />
          <kbd className="kbd">
            <CornerDownLeft size={11} />
          </kbd>
          <button className="icon-btn sm" onClick={() => toggle(false)} title="Close (Esc)">
            <X size={13} />
          </button>
        </div>
        <div className="quickask-list">
          {asked.length === 0 && <div className="faint small quickask-hint">Answers come from a read-only agent that looks at the project. Nothing is changed and no session is created.</div>}
          {asked.map((a) => (
            <div key={a.id} className={cx('quickask-item', !a.done && 'busy')}>
              <div className="quickask-q">{a.question}</div>
              {a.error ? (
                <div className="rose small">{a.error}</div>
              ) : a.answer ? (
                <div className="quickask-a">
                  <Markdown text={a.answer} />
                </div>
              ) : null}
              {!a.done && <div className="quickask-doing faint small">{a.doing ?? 'Thinking…'}</div>}
              <div className="quickask-actions">
                {!a.done ? (
                  <button className="btn sm ghost" onClick={() => void prism.agent.quickStop(a.id)}>
                    <CircleStop size={12} /> Stop
                  </button>
                ) : (
                  a.answer && (
                    <button className="btn sm ghost" onClick={() => void continueIt(a)}>
                      <MessagesSquare size={12} /> Continue in a session
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
