// Mission control: every session in the project at a glance. What each is doing right now, what it is
// waiting on (you, a command, a timer, a helper), what it has cost, and the buttons to answer, stop or open it.
import { useEffect, useMemo, useState } from 'react'
import { AlarmClock, Bot, CircleStop, ExternalLink, Hand, Radio, SquareTerminal } from 'lucide-react'
import type { Session } from '@shared/types'
import { useSessions, type LiveRun } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { useApp, modelLabel } from '@/state/app'
import { ApprovalCard } from '@/panels/agent/Cards'
import { cx, humanCost, timeAgo } from '@/lib/format'
import { describeCall } from '@/panels/agent/ToolRow'

/** One line about what a session is doing at this moment. */
function activity(live: LiveRun | undefined, s: Session): string {
  if (!live) return s.status === 'idle' ? 'Idle' : 'Working'
  if (live.approvals.length) return `Waiting for you: ${live.approvals.length === 1 ? describeCall(live.approvals[0]!.call).verb + ' ' + describeCall(live.approvals[0]!.call).target : `${live.approvals.length} approvals`}`
  if (live.questions.length) return 'Waiting for you to answer a question'
  if (live.running) {
    const t = live.pendingTools[live.pendingTools.length - 1]
    if (t) {
      const d = describeCall(t.call)
      return `${t.agent ? `${t.agent}: ` : ''}${d.verb} ${d.target}`.trim()
    }
    if (live.status) return live.status
    if (live.text) return 'Writing its answer'
    if (live.reasoning) return 'Thinking'
    return 'Working'
  }
  if (live.lastReason && live.lastReason !== 'completed') return live.lastReason === 'budget' ? 'Paused: budget reached' : live.lastReason === 'stuck' ? 'Stopped: going round in circles' : live.lastReason === 'aborted' ? 'Stopped' : live.lastError ?? 'Ended with an error'
  return 'Idle'
}

export function MissionPanel(): React.JSX.Element {
  const sessions = useSessions((s) => s.sessions)
  const live = useSessions((s) => s.live)
  const models = useApp((s) => s.models)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])
  // follow every recent session's events (cheap: no transcripts are loaded)
  const watched = useMemo(() => sessions.slice(0, 40), [sessions])
  useEffect(() => {
    for (const s of watched) useSessions.getState().watch(s.id)
  }, [watched])

  const rank = (s: Session): number => {
    const l = live[s.id]
    if (l?.approvals.length || l?.questions.length || s.status === 'waiting') return 0
    if (l?.running || s.status === 'running') return 1
    const bg = l?.background
    if (bg && (bg.jobs.length || bg.timers.length || bg.helpers.some((h) => h.running))) return 2
    return 3
  }
  const ordered = [...watched].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
  const waiting = ordered.filter((s) => rank(s) === 0).length
  const working = ordered.filter((s) => rank(s) === 1).length
  const background = ordered.filter((s) => rank(s) === 2).length
  const spentToday = sessions.filter((s) => s.updatedAt > Date.now() - 86_400_000).reduce((n, s) => n + (s.cost ?? 0), 0)

  const open = (id: string): void => {
    useLayout.getState().openAgent()
    void useSessions.getState().select(id)
  }

  return (
    <div className="mission">
      <div className="mission-head">
        <h2>Mission control</h2>
        <div className="mission-stats">
          <span className={cx('mstat', waiting > 0 && 'hot')}>
            <Hand size={13} /> {waiting} waiting for you
          </span>
          <span className="mstat">
            <Radio size={13} /> {working} working
          </span>
          <span className="mstat">
            <AlarmClock size={13} /> {background} busy in the background
          </span>
          <span className="mstat faint">{humanCost(spentToday)} in the last day</span>
        </div>
      </div>
      {ordered.length === 0 && <div className="faint small" style={{ padding: 16 }}>No sessions in this project yet.</div>}
      <div className="mission-list">
        {ordered.map((s) => {
          const l = live[s.id]
          const r = rank(s)
          const bg = l?.background
          return (
            <div key={s.id} className={cx('mission-row', r === 0 && 'waiting', r === 1 && 'working', r === 2 && 'bg')}>
              <div className="mission-main">
                <span className={cx('dot', r === 1 && 'live', r === 0 && 'warn')} />
                <button className="mission-title" onClick={() => open(s.id)} title="Open this session">
                  {s.title}
                </button>
                <span className="faint xs">{modelLabel(models, s.model)}</span>
                <span className="grow" />
                <span className="faint xs">{humanCost(s.cost ?? 0)}</span>
                <span className="faint xs">{timeAgo(s.updatedAt)}</span>
                {l?.running && (
                  <button className="icon-btn sm" title="Stop" onClick={() => void useSessions.getState().abort(s.id)}>
                    <CircleStop size={13} />
                  </button>
                )}
                <button className="icon-btn sm" title="Open" onClick={() => open(s.id)}>
                  <ExternalLink size={13} />
                </button>
              </div>
              <div className="mission-activity">
                {activity(l, s)}
                {bg && bg.jobs.length > 0 && (
                  <span className="mchip">
                    <SquareTerminal size={11} /> {bg.jobs.length} running
                  </span>
                )}
                {bg && bg.helpers.some((h) => h.running) && (
                  <span className="mchip">
                    <Bot size={11} /> {bg.helpers.filter((h) => h.running).length} helpers
                  </span>
                )}
                {bg && bg.timers.length > 0 && (
                  <span className="mchip">
                    <AlarmClock size={11} /> {bg.timers.length} timers
                  </span>
                )}
              </div>
              {l?.approvals.map((a) => (
                <ApprovalCard key={a.approvalId} req={a} onDecide={(d) => void useSessions.getState().approve(a.approvalId, d, s.id)} />
              ))}
              {l && l.questions.length > 0 && (
                <button className="btn sm" onClick={() => open(s.id)}>
                  Answer its question
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
