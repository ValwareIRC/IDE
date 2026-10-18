import { useEffect, useState } from 'react'
import { Check, Eye, Map as MapIcon, MessageSquareReply, Pencil, X } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { Markdown } from '@/components/Markdown'
import { Select } from '@/components/Select'
import { cx } from '@/lib/format'

const NO_PLANS: never[] = []

/** The plan the agent wants approved. Edit it, send it back with a note, or approve it and pick how freely the work may run. */
export function PlanPanel({ sessionId, planId }: { sessionId: string; planId: string }): React.JSX.Element {
  const req = useSessions((s) => (s.live[sessionId]?.plans ?? NO_PLANS).find((p) => p.planId === planId))
  const [text, setText] = useState(req?.plan ?? '')
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<PermissionMode>('auto-edit')
  const [feedback, setFeedback] = useState('')
  const [asking, setAsking] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    if (req) setText(req.plan)
  }, [req?.planId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!req) {
    return (
      <div className="empty">
        <MapIcon size={24} className="accent" />
        <div>{sent ?? 'This plan has been answered.'}</div>
        <button className="btn sm ghost" onClick={() => useLayout.getState().closePanel(`plan:${planId}`)}>
          Close
        </button>
      </div>
    )
  }

  const answer = (action: 'approve' | 'revise' | 'discard'): void => {
    setSent(action === 'approve' ? 'Approved. Prism is starting the work.' : action === 'revise' ? 'Sent back. Prism is revising the plan.' : 'Plan discarded.')
    void useSessions.getState().plan(planId, { action, plan: text, ...(action === 'approve' ? { mode } : {}), ...(action === 'revise' ? { feedback: feedback.trim() } : {}) }, sessionId)
  }
  const edited = text.trim() !== req.plan.trim()

  return (
    <div className="plan">
      <div className="plan-bar">
        <MapIcon size={15} className="accent" />
        <span className="plan-title truncate">{req.title}</span>
        <span className="faint xs">{edited ? 'edited by you · ' : ''}nothing has been changed yet</span>
        <span className="grow" />
        <div className="seg">
          <button className={cx(!editing && 'on')} onClick={() => setEditing(false)}>
            <Eye size={11} /> Read
          </button>
          <button className={cx(editing && 'on')} onClick={() => setEditing(true)}>
            <Pencil size={11} /> Edit
          </button>
        </div>
      </div>
      <div className="plan-body">
        {editing ? (
          <textarea className="plan-edit mono" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
        ) : (
          <div className="plan-doc selectable">
            <Markdown text={text} onOpenFile={(p) => useLayout.getState().openEditor(p)} />
          </div>
        )}
      </div>
      {asking && (
        <div className="plan-ask">
          <textarea className="input" rows={2} autoFocus placeholder="What should be different? Prism will revise the plan and show it again." value={feedback} onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && feedback.trim() && answer('revise')} />
          <button className="btn sm solid" disabled={!feedback.trim()} onClick={() => answer('revise')}>
            Send back
          </button>
        </div>
      )}
      <div className="plan-foot">
        <button className="btn ghost" onClick={() => answer('discard')}>
          <X size={13} /> Discard
        </button>
        <button className={cx('btn', asking ? 'primary' : 'ghost')} onClick={() => setAsking((v) => !v)}>
          <MessageSquareReply size={13} /> Ask for changes
        </button>
        <span className="grow" />
        <span className="dim small">Then work in</span>
        <Select
          value={mode}
          size="sm"
          options={[
            { value: 'ask', label: 'Ask first', sub: 'Approve each edit and command' },
            { value: 'auto-edit', label: 'Edit freely', sub: 'Edits run; commands ask' },
            { value: 'auto', label: 'Full auto', sub: 'Everything runs, only your block rules apply' }
          ]}
          onChange={(m) => setMode(m as PermissionMode)}
          align="right"
          width={270}
        />
        <button className="btn solid" disabled={!text.trim()} onClick={() => answer('approve')}>
          <Check size={13} /> Approve and start
        </button>
      </div>
    </div>
  )
}
