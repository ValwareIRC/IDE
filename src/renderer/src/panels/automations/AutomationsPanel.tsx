import { useEffect, useState } from 'react'
import { Copy, Webhook, Anchor, CalendarClock, ChevronDown, ChevronRight, Eye, FileCog, Play, Plus, Square, Trash2, Workflow } from 'lucide-react'
import type { AutomationTrigger, AutomationHook, AutomationSchedule, AutomationWatcher, AutomationsConfig, AutomationsState, JobInfo, PermissionMode } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError } from '@/state/ui'
import { Select } from '@/components/Select'
import { cx, timeAgo } from '@/lib/format'

const EVENTS: Array<{ value: AutomationHook['event']; label: string; sub: string; match: string }> = [
  { value: 'after-edit', label: 'After Prism edits a file', sub: 'e.g. format it, lint it', match: 'Which files (e.g. *.ts, src/*). Empty = all' },
  { value: 'turn-end', label: 'When a turn ends', sub: 'e.g. run the tests; a failure goes back to Prism to fix', match: 'Only if these files changed. Empty = always' },
  { value: 'before-tool', label: 'Before Prism uses a tool', sub: 'a failing command stops the tool', match: 'Which tools (e.g. shell, write_file). Empty = all' },
  { value: 'after-tool', label: 'After Prism uses a tool', sub: 'e.g. log it', match: 'Which tools. Empty = all' }
]

const MODE_OPTIONS: Array<{ value: PermissionMode; label: string; sub: string }> = [
  { value: 'plan', label: 'Plan first', sub: 'It only reads and shows you a plan' },
  { value: 'ask', label: 'Ask first', sub: 'It waits for you to approve each change' },
  { value: 'auto-edit', label: 'Edit freely', sub: 'Edits run; commands wait for you' },
  { value: 'auto', label: 'Full auto', sub: 'Runs unattended' }
]

const TRIGGERS: Array<{ value: AutomationTrigger['on']; label: string; sub: string }> = [
  { value: 'webhook', label: 'Its web address is called', sub: 'by a script, a git hook or a tool on this computer' },
  { value: 'github-pr-opened', label: 'A pull request is opened on GitHub', sub: 'checked every 3 minutes' },
  { value: 'github-mention', label: 'Someone writes @prism in a GitHub comment', sub: 'on an issue or a pull request' },
  { value: 'github-ci-failed', label: 'A CI run fails on GitHub', sub: 'GitHub Actions' }
]

const STARTERS: Array<{ label: string; add: (c: AutomationsConfig) => AutomationsConfig }> = [
  { label: 'Review every new pull request', add: (c) => ({ ...c, triggers: [...(c.triggers ?? []), { id: `trigger-${Date.now()}`, name: 'Review new pull requests', on: 'github-pr-opened', prompt: 'A new pull request was opened. Read its change and tell me about real problems in it. Do not edit anything.', mode: 'plan', enabled: true }] }) },
  { label: 'Look into failed CI runs', add: (c) => ({ ...c, triggers: [...(c.triggers ?? []), { id: `trigger-${Date.now()}`, name: 'Failed CI', on: 'github-ci-failed', prompt: 'A CI run failed. Find out why from the project and its tests, and propose a fix. Do not push anything.', mode: 'ask', enabled: true }] }) },
  { label: 'Format files after Prism edits them', add: (c) => ({ ...c, hooks: [...c.hooks, { id: `hook-${Date.now()}`, name: 'Format after edits', event: 'after-edit', match: '*.ts, *.tsx, *.js, *.json, *.css, *.md', command: 'npx --no-install prettier --write "{file}"', feedback: false, enabled: true }] }) },
  { label: 'Run the tests when a turn ends', add: (c) => ({ ...c, hooks: [...c.hooks, { id: `hook-${Date.now()}`, name: 'Tests after each turn', event: 'turn-end', match: '', command: 'npm test', feedback: true, enabled: true }] }) },
  { label: 'Review my own changes when I save', add: (c) => ({ ...c, watchers: [...c.watchers, { id: `watch-${Date.now()}`, name: 'Review what I changed', glob: 'src/*', prompt: 'I just changed these files myself. Read the changes (git diff) and tell me about bugs or risks. Do not edit anything.', mode: 'plan', debounceMs: 8000, enabled: true }] }) },
  { label: 'A morning summary of the project', add: (c) => ({ ...c, schedules: [...c.schedules, { id: `schedule-${Date.now()}`, name: 'Morning summary', every: 'daily 09:00', prompt: 'Summarise what changed in this project since yesterday (git log, open TODOs) in a few bullet points. Do not edit anything.', mode: 'plan', enabled: true }] }) }
]

/** Things that happen by themselves in this project: hooks around the agent's work, prompts on file changes, prompts on a timer. */
export function AutomationsPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [state, setState] = useState<AutomationsState | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)

  useEffect(() => {
    void prism.automations.get().then(setState).catch(toastError)
    return prism.automations.onChanged(setState)
  }, [workspace])

  useEffect(() => {
    const tick = (): void => void prism.automations.jobs().then(setJobs).catch(() => {})
    tick()
    const t = setInterval(tick, 3000)
    return () => clearInterval(t)
  }, [])

  if (!workspace) {
    return (
      <div className="empty">
        <Workflow size={24} className="accent" />
        <div>Open a folder first</div>
        <div className="small faint">Automations belong to a project.</div>
      </div>
    )
  }
  if (!state) return <div className="empty">Loading…</div>

  const cfg = state.config
  const save = (next: AutomationsConfig): void => {
    setState({ ...state, config: next })
    void prism.automations.save(next).catch(toastError)
  }
  const patchHook = (id: string, p: Partial<AutomationHook>): void => save({ ...cfg, hooks: cfg.hooks.map((h) => (h.id === id ? { ...h, ...p } : h)) })
  const patchWatcher = (id: string, p: Partial<AutomationWatcher>): void => save({ ...cfg, watchers: cfg.watchers.map((w) => (w.id === id ? { ...w, ...p } : w)) })
  const patchSchedule = (id: string, p: Partial<AutomationSchedule>): void => save({ ...cfg, schedules: cfg.schedules.map((s) => (s.id === id ? { ...s, ...p } : s)) })
  const triggers = cfg.triggers ?? []
  const patchTrigger = (id: string, p: Partial<AutomationTrigger>): void => save({ ...cfg, triggers: triggers.map((t) => (t.id === id ? { ...t, ...p } : t)) })
  const empty = !cfg.hooks.length && !cfg.watchers.length && !cfg.schedules.length && !triggers.length
  const runningJobs = jobs.filter((j) => j.running)

  const head = (id: string, enabled: boolean, onToggle: (v: boolean) => void, name: string, summary: string, onRun: (() => void) | null, onDelete: () => void): React.JSX.Element => (
    <div className="auto-head">
      <button className="icon-btn sm" onClick={() => setOpen(open === id ? null : id)}>
        {open === id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <button className={cx('switch sm', enabled && 'on')} onClick={() => onToggle(!enabled)} title={enabled ? 'On' : 'Off'} />
      <span className="auto-name truncate" onClick={() => setOpen(open === id ? null : id)}>
        {name}
      </span>
      <span className="faint xs truncate grow">{summary}</span>
      {onRun && (
        <button className="icon-btn sm" title="Run it now" onClick={onRun}>
          <Play size={11} />
        </button>
      )}
      <button className="icon-btn sm" title="Delete" onClick={onDelete}>
        <Trash2 size={11} />
      </button>
    </div>
  )

  return (
    <div className="auto">
      <div className="auto-bar">
        <Workflow size={15} className="accent" />
        <span style={{ fontWeight: 600 }}>Automations</span>
        <span className="faint xs">kept with the project in {state.file}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => useLayout.getState().openEditor(state.file)} title="Edit the file directly">
          <FileCog size={12} /> Open file
        </button>
      </div>
      <div className="auto-body">
        {state.error && <div className="rose small">{state.error}</div>}
        {empty && (
          <div className="auto-card">
            <div className="hud-label">Start with one of these</div>
            <div className="auto-starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="chip clickable" onClick={() => save(s.add(cfg))}>
                  <Plus size={11} /> {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <section className="auto-card">
          <div className="auto-title">
            <Anchor size={13} className="accent" />
            <span className="hud-label grow">Hooks · a command around Prism’s work</span>
            <button className="btn sm ghost" onClick={() => { const id = `hook-${Date.now()}`; save({ ...cfg, hooks: [...cfg.hooks, { id, name: 'New hook', event: 'after-edit', match: '', command: 'echo changed "{file}"', feedback: true, enabled: false }] }); setOpen(id) }}>
              <Plus size={11} /> Add
            </button>
          </div>
          {cfg.hooks.length === 0 && <div className="faint small">None. A hook runs a command after an edit, before a tool, or when a turn ends.</div>}
          {cfg.hooks.map((h) => (
            <div key={h.id} className="auto-item">
              {head(h.id, h.enabled, (v) => patchHook(h.id, { enabled: v }), h.name, `${EVENTS.find((e) => e.value === h.event)?.label ?? h.event} → ${h.command}`, null, () => save({ ...cfg, hooks: cfg.hooks.filter((x) => x.id !== h.id) }))}
              {open === h.id && (
                <div className="auto-form">
                  <label>
                    <span>Name</span>
                    <input className="input sm" value={h.name} onChange={(e) => patchHook(h.id, { name: e.target.value })} />
                  </label>
                  <label>
                    <span>When</span>
                    <Select value={h.event} size="sm" width={340} options={EVENTS.map((e) => ({ value: e.value, label: e.label, sub: e.sub }))} onChange={(v) => patchHook(h.id, { event: v as AutomationHook['event'] })} />
                  </label>
                  <label>
                    <span>Only for</span>
                    <input className="input sm mono" placeholder={EVENTS.find((e) => e.value === h.event)?.match} value={h.match} onChange={(e) => patchHook(h.id, { match: e.target.value })} />
                  </label>
                  <label>
                    <span>Run</span>
                    <input className="input sm mono" placeholder='a command; {file} is the file, {tool} the tool' value={h.command} onChange={(e) => patchHook(h.id, { command: e.target.value })} />
                  </label>
                  <label className="auto-check">
                    <input type="checkbox" checked={h.feedback} onChange={(e) => patchHook(h.id, { feedback: e.target.checked })} />
                    <span>{h.event === 'turn-end' ? 'If it fails, send the output back to Prism to fix (at most twice in a row)' : 'Tell Prism what the command printed'}</span>
                  </label>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="auto-card">
          <div className="auto-title">
            <Eye size={13} className="accent" />
            <span className="hud-label grow">Watchers · ask Prism when files change</span>
            <button className="btn sm ghost" onClick={() => { const id = `watch-${Date.now()}`; save({ ...cfg, watchers: [...cfg.watchers, { id, name: 'New watcher', glob: 'src/*', prompt: 'These files changed. …', mode: 'plan', debounceMs: 5000, enabled: false }] }); setOpen(id) }}>
              <Plus size={11} /> Add
            </button>
          </div>
          {cfg.watchers.length === 0 && <div className="faint small">None. A watcher sends Prism a message when files you change match a pattern. Prism’s own edits never trigger it.</div>}
          {cfg.watchers.map((w) => (
            <div key={w.id} className="auto-item">
              {head(w.id, w.enabled, (v) => patchWatcher(w.id, { enabled: v }), w.name, `${w.glob} → ${w.prompt}`, () => void prism.automations.run(w.id).catch(toastError), () => save({ ...cfg, watchers: cfg.watchers.filter((x) => x.id !== w.id) }))}
              {open === w.id && (
                <div className="auto-form">
                  <label>
                    <span>Name</span>
                    <input className="input sm" value={w.name} onChange={(e) => patchWatcher(w.id, { name: e.target.value })} />
                  </label>
                  <label>
                    <span>Files</span>
                    <input className="input sm mono" placeholder="src/*, *.md" value={w.glob} onChange={(e) => patchWatcher(w.id, { glob: e.target.value })} />
                  </label>
                  <label>
                    <span>Ask Prism</span>
                    <textarea className="input" rows={3} value={w.prompt} onChange={(e) => patchWatcher(w.id, { prompt: e.target.value })} />
                  </label>
                  <label>
                    <span>It may</span>
                    <Select value={w.mode} size="sm" width={300} options={MODE_OPTIONS} onChange={(v) => patchWatcher(w.id, { mode: v as PermissionMode })} />
                  </label>
                  <label>
                    <span>Wait</span>
                    <input className="input sm" type="number" min={1} max={600} style={{ width: 90 }} value={Math.round(w.debounceMs / 1000)} onChange={(e) => patchWatcher(w.id, { debounceMs: Math.max(1, Number(e.target.value) || 5) * 1000 })} />
                    <span className="faint xs">seconds after the last change</span>
                  </label>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="auto-card">
          <div className="auto-title">
            <CalendarClock size={13} className="accent" />
            <span className="hud-label grow">Schedules · ask Prism on a timer</span>
            <button className="btn sm ghost" onClick={() => { const id = `schedule-${Date.now()}`; save({ ...cfg, schedules: [...cfg.schedules, { id, name: 'New schedule', every: '1h', prompt: 'Check … and tell me.', mode: 'plan', enabled: false }] }); setOpen(id) }}>
              <Plus size={11} /> Add
            </button>
          </div>
          {cfg.schedules.length === 0 && <div className="faint small">None. A schedule sends Prism a message every so often while Prism is open.</div>}
          {cfg.schedules.map((s) => (
            <div key={s.id} className="auto-item">
              {head(s.id, s.enabled, (v) => patchSchedule(s.id, { enabled: v }), s.name, `${s.every} → ${s.prompt}`, () => void prism.automations.run(s.id).catch(toastError), () => save({ ...cfg, schedules: cfg.schedules.filter((x) => x.id !== s.id) }))}
              {open === s.id && (
                <div className="auto-form">
                  <label>
                    <span>Name</span>
                    <input className="input sm" value={s.name} onChange={(e) => patchSchedule(s.id, { name: e.target.value })} />
                  </label>
                  <label>
                    <span>Every</span>
                    <input className="input sm mono" style={{ width: 150 }} placeholder="30m, 2h, daily 09:00" value={s.every} onChange={(e) => patchSchedule(s.id, { every: e.target.value })} />
                    <span className="faint xs">30m · 2h · daily 09:00</span>
                  </label>
                  <label>
                    <span>Ask Prism</span>
                    <textarea className="input" rows={3} value={s.prompt} onChange={(e) => patchSchedule(s.id, { prompt: e.target.value })} />
                  </label>
                  <label>
                    <span>It may</span>
                    <Select value={s.mode} size="sm" width={300} options={MODE_OPTIONS} onChange={(v) => patchSchedule(s.id, { mode: v as PermissionMode })} />
                  </label>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="auto-card">
          <div className="auto-title">
            <Webhook size={13} className="accent" />
            <span className="hud-label grow">Triggers · ask Prism when something happens elsewhere</span>
            <button className="btn sm ghost" onClick={() => { const id = `trigger-${Date.now()}`; save({ ...cfg, triggers: [...triggers, { id, name: 'New trigger', on: 'webhook', prompt: 'Something happened: …', mode: 'plan', enabled: false }] }); setOpen(id) }}>
              <Plus size={11} /> Add
            </button>
          </div>
          {triggers.length === 0 && <div className="faint small">None. A trigger sends Prism a message when its web address is called, or when something happens on GitHub.</div>}
          {state.githubError && triggers.some((t) => t.enabled && t.on !== 'webhook') && <div className="amber small">{state.githubError}</div>}
          {triggers.map((t) => (
            <div key={t.id} className="auto-item">
              {head(t.id, t.enabled, (v) => patchTrigger(t.id, { enabled: v }), t.name, `${TRIGGERS.find((x) => x.value === t.on)?.label ?? t.on} → ${t.prompt}`, () => void prism.automations.run(t.id).catch(toastError), () => save({ ...cfg, triggers: triggers.filter((x) => x.id !== t.id) }))}
              {open === t.id && (
                <div className="auto-form">
                  <label>
                    <span>Name</span>
                    <input className="input sm" value={t.name} onChange={(e) => patchTrigger(t.id, { name: e.target.value })} />
                  </label>
                  <label>
                    <span>When</span>
                    <Select value={t.on} size="sm" width={360} options={TRIGGERS} onChange={(v) => patchTrigger(t.id, { on: v as AutomationTrigger['on'] })} />
                  </label>
                  {t.on === 'webhook' && (
                    <label>
                      <span>Its address</span>
                      <code className="auto-url truncate">{state.webhooks?.[t.id] || 'saving…'}</code>
                      <button className="icon-btn sm" title="Copy the address" disabled={!state.webhooks?.[t.id]} onClick={() => void navigator.clipboard.writeText(state.webhooks?.[t.id] ?? '')}>
                        <Copy size={11} />
                      </button>
                    </label>
                  )}
                  {t.on === 'webhook' && <div className="faint xs" style={{ marginLeft: 92 }}>Call it with POST or GET from this computer; whatever is sent is added to the message. For example: curl -d "the build broke" {state.webhooks?.[t.id] ?? '…'}</div>}
                  {t.on !== 'webhook' && <div className="faint xs" style={{ marginLeft: 92 }}>Needs the project's origin on GitHub and a GitHub token (add one in the Pull requests panel). Only what happens after Prism starts counts. What happened is added to the message.</div>}
                  <label>
                    <span>Ask Prism</span>
                    <textarea className="input" rows={3} value={t.prompt} onChange={(e) => patchTrigger(t.id, { prompt: e.target.value })} />
                  </label>
                  <label>
                    <span>It may</span>
                    <Select value={t.mode} size="sm" width={300} options={MODE_OPTIONS} onChange={(v) => patchTrigger(t.id, { mode: v as PermissionMode })} />
                  </label>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="auto-card">
          <div className="auto-title">
            <span className="hud-label grow">Running in the background</span>
          </div>
          {runningJobs.length === 0 && <div className="faint small">Nothing. Commands Prism leaves running (dev servers, watchers) are listed here.</div>}
          {runningJobs.map((j) => (
            <div key={j.id} className="auto-head">
              <span className="dot live" />
              <span className="mono small truncate grow" title={j.tail}>
                {j.command}
              </span>
              <span className="faint xs">{timeAgo(j.startedAt)}</span>
              <button className="icon-btn sm" title="Stop it" onClick={() => void prism.automations.killJob(j.id).then(() => prism.automations.jobs().then(setJobs))}>
                <Square size={11} />
              </button>
            </div>
          ))}
        </section>

        <section className="auto-card">
          <div className="auto-title">
            <span className="hud-label grow">What happened</span>
          </div>
          {state.runs.length === 0 && <div className="faint small">Nothing has run yet.</div>}
          {state.runs.slice(0, 40).map((r) => (
            <div key={r.id} className="auto-item">
              <div className="auto-head" onClick={() => setOpenRun(openRun === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                <span className={cx('dot', r.ok ? 'live' : 'rose')} />
                <span className="auto-name truncate">{r.name}</span>
                <span className="faint xs truncate grow">{r.detail ?? r.kind}</span>
                {r.sessionId && (
                  <button
                    className="btn sm ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      useLayout.getState().openAgent()
                      void useSessions.getState().select(r.sessionId!)
                    }}
                  >
                    Open session
                  </button>
                )}
                <span className="faint xs">{timeAgo(r.endedAt)}</span>
              </div>
              {openRun === r.id && <pre className="auto-out mono">{r.output || '(it printed nothing)'}</pre>}
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
