import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ClaudePlanUsage, ClaudeUsageSpan, UsageSummary } from '@shared/types'
import { prism } from '@/lib/ipc'
import { cx, humanCost, humanTokens } from '@/lib/format'

/** What each kind of heavy use means, and what helps. Claude Code's own keys. */
const BEHAVIOURS: Record<string, { what: (pct: number) => string; why: string }> = {
  long_context: { what: (p) => `${p}% came from very long conversations`, why: 'Each message makes Claude read the whole conversation so far again, so long ones cost the most even though Claude keeps a copy of what it has read. A fresh session for a new task, or /compact, makes them cheaper.' },
  cron: { what: (p) => `${p}% came from sessions left running for 8 hours or more`, why: 'Sessions that loop or run in the background keep using the limit while you are away. Make sure each one is meant to be running.' },
  cache_miss: { what: (p) => `${p}% had to read the whole conversation from scratch`, why: 'After about five minutes with no message, Claude lets go of the copy it kept, and the next message reads everything again.' },
  subagent_heavy: { what: (p) => `${p}% came from helper agents`, why: 'Each helper is a conversation of its own, so several at once add up quickly.' },
  high_parallel: { what: (p) => `${p}% came from many sessions running at once`, why: 'Sessions running side by side each use the limit at the same time.' }
}

function until(ts: number | null): string {
  if (!ts) return ''
  const ms = ts - Date.now()
  if (ms <= 0) return 'resets any moment'
  const h = Math.floor(ms / 3_600_000)
  const d = Math.floor(h / 24)
  const day = new Date(ts).toLocaleDateString([], { weekday: 'long' })
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d >= 1) return `resets ${day} at ${time} (in ${d} day${d === 1 ? '' : 's'})`
  if (h >= 1) return `resets at ${time} (in ${h} hour${h === 1 ? '' : 's'})`
  return `resets at ${time} (in ${Math.max(1, Math.round(ms / 60_000))} minutes)`
}

function verdict(used: number, resets: number | null): string {
  if (used >= 95) return `Nearly all used. When it reaches 100%, Claude pauses until it ${until(resets).replace(/^resets/, 'resets')}; Prism carries on by itself then.`
  if (used >= 75) return 'Most of it used: worth keeping an eye on.'
  if (used >= 40) return 'About half used.'
  return 'Plenty left.'
}

export function UsagePanel(): React.JSX.Element {
  const [u, setU] = useState<UsageSummary | null>(null)
  const [plan, setPlan] = useState<ClaudePlanUsage | null>(null)
  const [asking, setAsking] = useState(false)
  const [span, setSpan] = useState<'day' | 'week'>('day')

  const askPlan = (fresh: boolean): void => {
    setAsking(true)
    void prism.usage
      .claude(fresh)
      .then(setPlan)
      .catch((e: unknown) => setPlan({ at: Date.now(), available: false, plan: null, email: null, organization: null, windows: [], extra: null, behaviors: null, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setAsking(false))
  }

  useEffect(() => {
    const tick = (): void => void prism.usage.summary().then(setU).catch(() => {})
    tick()
    askPlan(false)
    const t = setInterval(tick, 5000)
    const p = setInterval(() => askPlan(false), 120_000)
    return () => {
      clearInterval(t)
      clearInterval(p)
    }
  }, [])

  const s: ClaudeUsageSpan | null = plan?.behaviors?.[span] ?? null
  return (
    <div className="settings-body selectable usage-page">
      <div className="usage-head">
        <h2>Usage</h2>
        <button className="btn sm ghost" disabled={asking} onClick={() => askPlan(true)} title="Ask again">
          <RefreshCw size={12} className={cx(asking && 'spin')} /> {asking ? 'Asking…' : 'Check again'}
        </button>
      </div>

      <section className="usage-card">
        <div className="usage-card-head">
          <h3>Your Claude plan</h3>
          {plan?.plan && <span className="usage-pill">{plan.plan === 'max' ? 'Claude Max' : plan.plan === 'pro' ? 'Claude Pro' : `Claude ${plan.plan}`}</span>}
        </div>
        {plan?.email && <div className="faint small">{plan.email}</div>}
        {!plan && <div className="faint small">Asking Claude Code…</div>}
        {plan && !plan.available && <div className="faint small">{plan.error ? `Claude Code could not say: ${plan.error}` : 'There are no plan limits to show (Claude is used with an API key, or not signed in).'}</div>}
        {plan?.windows.map((w) => (
          <div key={w.key} className="usage-limit">
            <div className="usage-limit-top">
              <span>{w.label}</span>
              <b>{Math.round(w.used)}% used</b>
            </div>
            <div className="usage-bar">
              <i className={cx(w.used >= 90 ? 'bad' : w.used >= 70 ? 'warn' : 'ok')} style={{ width: `${Math.min(100, w.used)}%` }} />
            </div>
            <div className="faint xs">
              {verdict(w.used, w.resetsAt)} {w.used < 95 && until(w.resetsAt) ? `It ${until(w.resetsAt)}.` : ''}
            </div>
          </div>
        ))}
        {plan?.extra && (
          <div className="faint small">
            Extra usage is on{plan.extra.used != null ? `: ${plan.extra.used} used` : ''}
            {plan.extra.limit != null ? ` of ${plan.extra.limit}` : ''}
            {plan.extra.currency ? ` ${plan.extra.currency}` : ''} this month.
          </div>
        )}
        {plan?.available && <div className="faint xs">From Claude Code, as of {new Date(plan.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It counts Claude used anywhere with this account, not just in Prism.</div>}
      </section>

      {plan?.behaviors && (
        <section className="usage-card">
          <div className="usage-card-head">
            <h3>What is using it</h3>
            <div className="seg">
              <button className={cx(span === 'day' && 'on')} onClick={() => setSpan('day')}>
                Last day
              </button>
              <button className={cx(span === 'week' && 'on')} onClick={() => setSpan('week')}>
                Last week
              </button>
            </div>
          </div>
          {s ? (
            <>
              <div className="faint small">
                {s.requests.toLocaleString()} messages to Claude in {s.sessions} session{s.sessions === 1 ? '' : 's'} on this computer. These overlap, so they do not add up to 100%.
              </div>
              {s.behaviors.map((b) => (
                <div key={b.key} className="usage-why">
                  <b>{BEHAVIOURS[b.key]?.what(Math.round(b.pct)) ?? `${Math.round(b.pct)}%: ${b.key}`}</b>
                  {BEHAVIOURS[b.key] && <div className="faint small">{BEHAVIOURS[b.key]!.why}</div>}
                </div>
              ))}
              {!s.behaviors.length && <div className="faint small">Nothing stands out.</div>}
              {[['Skills', s.skills], ['Helper agents', s.agents], ['Plugins', s.plugins], ['Tool servers', s.mcpServers]].map(([title, list]) =>
                (list as Array<{ name: string; pct: number }>).length ? (
                  <div key={title as string} className="usage-share">
                    <div className="faint xs">{title as string}</div>
                    {(list as Array<{ name: string; pct: number }>).map((x) => (
                      <div key={x.name} className="usage-share-row">
                        <span className="truncate">{x.name}</span>
                        <div className="usage-bar thin">
                          <i className="ok" style={{ width: `${Math.min(100, x.pct)}%` }} />
                        </div>
                        <span className="num">{Math.round(x.pct)}%</span>
                      </div>
                    ))}
                  </div>
                ) : null
              )}
            </>
          ) : (
            <div className="faint small">Nothing recorded for this time.</div>
          )}
        </section>
      )}

      <section className="usage-card">
        <h3>Everything Prism has asked any model</h3>
        <div className="faint small">From Prism's own record, for every model and provider (GLM, OpenAI, Claude…). Costs use the prices Prism knows and are estimates; a plan like Claude Max is not charged per message.</div>
        {u ? (
          <>
            <div className="usage-grid">
              <div className="stat"><div className="v">{u.last24h.requests}</div><div className="k">messages, last day</div></div>
              <div className="stat"><div className="v">{humanCost(u.last24h.cost)}</div><div className="k">estimated, last day</div></div>
              <div className="stat"><div className="v">{u.totals.requests}</div><div className="k">messages, ever</div></div>
              <div className="stat"><div className="v">{humanCost(u.totals.cost)}</div><div className="k">estimated, ever</div></div>
            </div>
            <table className="usage-table">
              <thead>
                <tr><th>Model</th><th style={{ textAlign: 'right' }}>Messages</th><th style={{ textAlign: 'right' }}>Read</th><th style={{ textAlign: 'right' }}>Written</th><th style={{ textAlign: 'right' }}>Estimated</th></tr>
              </thead>
              <tbody>
                {u.byModel.map((m) => (
                  <tr key={m.label}>
                    <td>{m.label}</td>
                    <td className="num">{m.requests}</td>
                    <td className="num">{humanTokens(m.inputTokens)}</td>
                    <td className="num">{humanTokens(m.outputTokens)}</td>
                    <td className="num">{humanCost(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="faint xs">Read and written are counted in word pieces (a word is one or two).</div>
          </>
        ) : (
          <div className="faint small">Loading…</div>
        )}
      </section>
    </div>
  )
}
