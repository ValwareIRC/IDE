// News the agent received (a finished command, a timer, a helper's report, another session's message),
// and the bar above the message box listing what the session is still waiting on.
import { useEffect, useState } from 'react'
import { AlarmClock, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Eye, Lightbulb, MessagesSquare, RefreshCcw, SquareTerminal, Users, Wallet, ClipboardCheck, X, XCircle } from 'lucide-react'
import type { BackgroundState, SystemItem } from '@shared/types'
import { prism } from '@/lib/ipc'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'
import { useSessions } from '@/state/sessions'

const KINDS: Record<string, { icon: React.JSX.Element; title: (ok: boolean) => string }> = {
  job: { icon: <SquareTerminal size={13} />, title: (ok) => (ok ? 'A background command finished' : 'A background command failed') },
  watch: { icon: <Eye size={13} />, title: () => 'Something turned up in a running command' },
  timer: { icon: <AlarmClock size={13} />, title: () => 'A timer went off' },
  helper: { icon: <Bot size={13} />, title: (ok) => (ok ? 'A helper reported back' : 'A helper stopped early') },
  team: { icon: <Users size={13} />, title: () => 'The team finished' },
  session: { icon: <MessagesSquare size={13} />, title: () => 'A message from another session' },
  'session-reply': { icon: <MessagesSquare size={13} />, title: () => 'Another session replied' },
  lead: { icon: <MessagesSquare size={13} />, title: () => 'A message from the lead agent' },
  stuck: { icon: <RefreshCcw size={13} />, title: () => 'Going round in circles' },
  budget: { icon: <Wallet size={13} />, title: () => 'Budget running low' },
  checks: { icon: <ClipboardCheck size={13} />, title: () => 'Its checks failed' }
}

export function NoticeCard({ item }: { item: SystemItem }): React.JSX.Element {
  const source = String(item.meta?.['source'] ?? '')
  const exit = item.meta?.['exitCode']
  const ok = source === 'job' ? exit === 0 : item.meta?.['ok'] !== false
  const kind = KINDS[source] ?? { icon: <MessagesSquare size={13} />, title: () => 'News for the agent' }
  const [first, ...rest] = item.text.split('\n')
  const long = rest.join('\n').trim()
  const [open, setOpen] = useState(long.length < 400)
  return (
    <div className={cx('notice-card', source, !ok && 'bad')}>
      <button className="notice-head" onClick={() => long && setOpen((o) => !o)}>
        <span className="notice-icon">{kind.icon}</span>
        <b>{kind.title(ok)}</b>
        <span className="faint truncate">{first}</span>
        <span className="grow" />
        {long && (open ? <ChevronDown size={12} className="faint" /> : <ChevronRight size={12} className="faint" />)}
      </button>
      {open && long && <pre className="notice-body selectable">{long}</pre>}
    </div>
  )
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

const until = (ms: number): string => {
  const m = Math.round((ms - Date.now()) / 60_000)
  return m < 1 ? 'any moment' : m < 120 ? `in ${m} min` : new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Everything the session is waiting on, each with a way to cancel it. */
export function BackgroundBar({ sessionId, state }: { sessionId: string; state: BackgroundState }): React.JSX.Element | null {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])
  const working = state.helpers.filter((h) => h.running)
  const copies = state.helpers.filter((h) => !h.running && h.isolated)
  if (!state.jobs.length && !state.timers.length && !working.length && !copies.length) return null
  const cancel = (kind: 'job' | 'timer' | 'helper', id: string) => () => void prism.agent.cancelBackground(sessionId, kind, id).catch(toastError)
  return (
    <div className="bg-bar">
      <span className="bg-label">Waiting on</span>
      {state.jobs.map((j) => (
        <span key={j.id} className="bg-chip job" title={`${j.command}${j.watching.length ? `\nwatching for ${j.watching.join(', ')}` : ''}`}>
          <SquareTerminal size={12} />
          <span className="truncate">{j.command.split('\n')[0]}</span>
          <span className="faint">{ago(j.startedAt)}</span>
          {j.watching.length > 0 && <Eye size={11} className="faint" />}
          <button className="bg-x" title="Stop this command" onClick={cancel('job', j.id)}>
            <X size={11} />
          </button>
        </span>
      ))}
      {working.map((h) => (
        <span key={h.name} className="bg-chip helper" title={h.task}>
          <Bot size={12} />
          <span className="truncate">
            {h.name}
            {h.isolated ? ' (own copy)' : ''}
          </span>
          <span className="faint">{ago(h.startedAt)}</span>
          <button className="bg-x" title="Stop this helper" onClick={cancel('helper', h.name)}>
            <X size={11} />
          </button>
        </span>
      ))}
      {state.timers.map((t) => (
        <span key={t.id} className="bg-chip timer" title={t.note}>
          <AlarmClock size={12} />
          <span className="truncate">{t.note.split('\n')[0]}</span>
          <span className="faint">
            {until(t.dueAt)}
            {t.every ? `, every ${t.every}` : ''}
          </span>
          <button className="bg-x" title="Cancel this timer" onClick={cancel('timer', t.id)}>
            <X size={11} />
          </button>
        </span>
      ))}
      {copies.map((h) => (
        <span key={h.name} className="bg-chip copy" title="This helper worked in its own copy of the project. Ask Prism to bring its work in, or to throw the copy away.">
          <Bot size={12} />
          <span className="truncate">{h.name}'s copy, not brought in yet</span>
        </span>
      ))}
      {state.wakes > 0 && (
        <span className="bg-wakes faint" title="How many times the agent has woken itself since you last wrote. It stops at the limit in Settings, Agent.">
          woken {state.wakes} of {state.wakeLimit}
        </span>
      )}
    </div>
  )
}

/** The checks the agent promised would prove its work, and how each went. */
export function VerdictCard({ item }: { item: SystemItem }): React.JSX.Element {
  const checks = (item.meta?.['verdict'] ?? []) as Array<{ name: string; command: string; ok: boolean; code: number | null; output: string; ms: number }>
  const failed = checks.filter((c) => !c.ok).length
  const [open, setOpen] = useState<string | null>(failed ? (checks.find((c) => !c.ok)?.command ?? null) : null)
  return (
    <div className={cx('verdict-card', failed ? 'bad' : 'good')}>
      <div className="verdict-head">
        {failed ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
        <b>{failed ? (checks.length === 1 ? 'Not proven: the check failed' : `Not proven: ${failed} of ${checks.length} checks failed`) : checks.length === 1 ? 'Proven: the check passed' : `Proven: all ${checks.length} checks passed`}</b>
      </div>
      {checks.map((c) => (
        <div key={c.command} className={cx('verdict-row', !c.ok && 'bad')}>
          <button className="verdict-line" onClick={() => setOpen((o) => (o === c.command ? null : c.command))}>
            {c.ok ? <Check size={12} className="mint" /> : <X size={12} className="rose" />}
            <span>{c.name}</span>
            <code className="faint truncate">{c.command}</code>
            <span className="grow" />
            <span className="faint">{c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}</span>
          </button>
          {open === c.command && <pre className="notice-body selectable">{c.output || '(no output)'}</pre>}
        </div>
      ))}
    </div>
  )
}

/** An assumption the agent made instead of asking, with a way to correct it at once. */
export function AssumptionCard({ text, sessionId }: { text: string; sessionId: string | null }): React.JSX.Element {
  const [fixing, setFixing] = useState(false)
  const [reply, setReply] = useState('')
  const [sent, setSent] = useState(false)
  const send = async (): Promise<void> => {
    const msg = `About your assumption "${text}": that is wrong. ${reply.trim()}`
    setSent(true)
    setFixing(false)
    if (!sessionId) return
    // while it works the correction reaches it before its next step; otherwise it starts a turn
    const took = await prism.agent.steer(sessionId, msg).catch(() => false)
    if (!took) await useSessions.getState().send(msg, undefined, sessionId)
  }
  return (
    <div className={cx('assumption', sent && 'corrected')}>
      <Lightbulb size={12} />
      <span className="grow">
        <span className="faint">Assumed: </span>
        {text}
      </span>
      {sent ? (
        <span className="faint xs">corrected</span>
      ) : fixing ? (
        <span className="row" style={{ gap: 4 }}>
          <input className="input sm" autoFocus placeholder="What is right instead?" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply.trim() && void send()} style={{ width: 220 }} />
          <button className="btn sm solid" disabled={!reply.trim()} onClick={() => void send()}>
            Tell it
          </button>
        </span>
      ) : (
        <button className="btn sm ghost" onClick={() => setFixing(true)}>
          That's wrong
        </button>
      )}
    </div>
  )
}

/** How much one request in this session may cost or take; Prism pauses the agent when it is reached. */
/** open/setOpen: when the button lives in a menu (the phone), the menu opens the popover. */
export function BudgetButton({ sessionId, open: shown, setOpen: setShown }: { sessionId: string; open?: boolean; setOpen?: (open: boolean) => void }): React.JSX.Element {
  const [budget, setBudget] = useState<{ cost: number | null; minutes: number | null } | null>(null)
  const [own, setOwn] = useState(false)
  const open = shown ?? own
  const setOpen = (v: boolean | ((o: boolean) => boolean)): void => {
    const next = typeof v === 'function' ? v(open) : v
    if (setShown) setShown(next)
    else setOwn(next)
  }
  const [cost, setCost] = useState('')
  const [minutes, setMinutes] = useState('')
  useEffect(() => {
    void prism.sessions.extras(sessionId).then((x) => {
      const b = x.budget ? { cost: x.budget.cost ?? null, minutes: x.budget.minutes ?? null } : null
      setBudget(b)
      setCost(b?.cost ? String(b.cost) : '')
      setMinutes(b?.minutes ? String(b.minutes) : '')
    })
  }, [sessionId])
  const save = (): void => {
    const c = Number(cost)
    const m = Number(minutes)
    const next = { cost: c > 0 ? c : null, minutes: m > 0 ? m : null }
    void prism.sessions
      .setExtras(sessionId, { budget: next.cost || next.minutes ? next : null })
      .then(() => setBudget(next.cost || next.minutes ? next : null))
      .catch(toastError)
    setOpen(false)
  }
  const label = budget ? [budget.cost ? `$${budget.cost}` : '', budget.minutes ? `${budget.minutes} min` : ''].filter(Boolean).join(' · ') : ''
  return (
    <span className="budget-wrap">
      <button className={cx('icon-btn', budget && 'on')} title={budget ? `Budget per request: ${label}` : 'Set a budget per request'} onClick={() => setOpen((o) => !o)}>
        <Wallet size={14} />
      </button>
      {open && (
        <div className="popover budget-pop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="small" style={{ marginBottom: 8 }}>
            The most one request in this session may cost or take. The agent is told, and Prism pauses it when either runs out. Blank means no limit.
          </div>
          <label className="budget-field">
            <span>Cost, in dollars</span>
            <input className="input sm" type="number" min={0} step={0.05} placeholder="no limit" value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
          <label className="budget-field">
            <span>Time, in minutes</span>
            <input className="input sm" type="number" min={0} step={1} placeholder="no limit" value={minutes} onChange={(e) => setMinutes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 6 }}>
            <button className="btn sm ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn sm solid" onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
