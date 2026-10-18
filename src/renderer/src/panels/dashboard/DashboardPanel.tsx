import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, CheckCircle2, CircleAlert, Coins, FlaskConical, GitBranch, Globe, History, ListTodo, Loader2, MessageSquarePlus, Package, Play, RefreshCw, Sparkles, TerminalSquare, BookCheck, Compass } from 'lucide-react'
import type { OutdatedReport, ProjectOverview, SpendDay } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, modelLabel } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useProblems } from '@/state/problems'
import { useLayout } from '@/state/layout'
import { useUi, toastError } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { cx, humanCost, humanTokens, timeAgo } from '@/lib/format'

const TAG_CLASS: Record<string, string> = { TODO: 'accent', FIXME: 'rose', HACK: 'amber', XXX: 'violet' }
const STATUS_WORD: Record<string, string> = { M: 'changed', A: 'new', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new', '!': 'ignored' }

function Card({ icon, title, action, children, wide }: { icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <section className={cx('dash-card', wide && 'wide')}>
      <header>
        {icon}
        <span className="hud-label">{title}</span>
        <span className="grow" />
        {action}
      </header>
      <div className="dash-body">{children}</div>
    </section>
  )
}

/** The project's home: what has been happening in it and what state it is in. */
/** "^1.4.2" → "1" */
const major = (v: string): string => v.replace(/^[^\d]*/, '').split('.')[0] ?? v

/** Upgrade packages in a copy of the project: the agent reads what changed, upgrades, fixes what breaks and runs the checks. */
async function upgradeIn(pkgs: OutdatedReport['packages'], manager: string | null): Promise<void> {
  const notes = await prism.dashboard.releaseNotes(pkgs.map((p) => p.name)).catch(() => ({}) as Record<string, string | null>)
  const list = pkgs.map((p) => `- ${p.name}: ${p.current} → ${p.latest}${major(p.current) !== major(p.latest) ? ' (new major version)' : ''}${notes[p.name] ? `, release notes: ${notes[p.name]}` : ''}`).join('\n')
  const title = pkgs.length === 1 ? `Upgrade ${pkgs[0]!.name}` : `Upgrade ${pkgs.length} packages`
  const prompt = `Upgrade these packages, and only these:
${list}

For each one:
1. Read what changed between those versions (the release notes, or the CHANGELOG in its repository). List the changes that could affect this project, and search the code for every use of the things they mention.
2. Update package.json and install with ${manager ?? 'the project\'s package manager'}.
3. Run the build, the type checks and the tests.
4. Fix what broke, following the package's migration notes rather than working around it.
5. Report, per package: what changed that matters here, what you changed, anything to keep an eye on, and whether everything passes.`
  const st = useSessions.getState()
  // its own copy when the project is a git repository, so nothing changes here until the user brings it in
  const copy = await prism.sessions.createInCopy(title).catch(() => null)
  const s = copy ?? (await prism.sessions.create(title))
  await st.refresh()
  useLayout.getState().openAgent()
  await st.select(s.id)
  // in its own copy nothing reaches the user's files until they bring it in, so it can run without asking
  await st.send(prompt, { mode: copy ? 'auto' : 'auto-edit' }, s.id)
}

export function DashboardPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const models = useApp((s) => s.models)
  const sessions = useSessions((s) => s.sessions)
  const live = useSessions((s) => s.live)
  const checkers = useProblems((s) => s.checkers)
  const results = useProblems((s) => s.results)
  const running = useProblems((s) => s.running)
  const [info, setInfo] = useState<ProjectOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [spend, setSpend] = useState<SpendDay[]>([])
  const [byCost, setByCost] = useState(true)
  const [outdated, setOutdated] = useState<OutdatedReport | null>(null)
  const [upgrading, setUpgrading] = useState(false)
  const upgrade = async (pkgs: OutdatedReport['packages'], manager: string | null): Promise<void> => {
    setUpgrading(true)
    try {
      await upgradeIn(pkgs, manager)
    } catch (e) {
      toastError(e, 'Could not start the upgrade')
    } finally {
      setUpgrading(false)
    }
  }
  const [asking, setAsking] = useState(false)
  const layout = useLayout.getState()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [o, s] = await Promise.all([prism.dashboard.overview(), prism.dashboard.spend(14)])
      setInfo(o)
      setSpend(s)
      // a plan (Claude Agent, a local model) costs nothing per message: then tokens are the measure that says something
      setByCost(s.some((d) => d.cost > 0))
    } catch (e) {
      toastError(e, 'Could not read the project')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setInfo(null)
    setOutdated(null)
    if (!workspace) return
    void load()
    void useProblems.getState().refreshCheckers()
  }, [workspace, load])

  // the last 14 days, including the ones with nothing in them
  const days = useMemo(() => {
    const today = Math.floor(Date.now() / 86_400_000)
    const map = new Map(spend.map((d) => [d.day, d]))
    return Array.from({ length: 14 }, (_, i) => map.get(today - 13 + i) ?? { day: today - 13 + i, inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 })
  }, [spend])
  const value = (d: SpendDay): number => (byCost ? d.cost : d.inputTokens + d.outputTokens)
  const peak = Math.max(...days.map(value), 0.000001)
  const total = days.reduce((n, d) => n + value(d), 0)
  const anyCost = days.some((d) => d.cost > 0)

  if (!workspace) {
    return (
      <div className="empty">
        <Sparkles size={24} className="accent" />
        <div className="title">No project is open</div>
        <button className="btn" onClick={() => void useApp.getState().openWorkspace()}>
          Open a folder
        </button>
      </div>
    )
  }

  const openSession = (id: string): void => {
    void useSessions.getState().select(id)
    layout.openAgent()
  }
  const newSession = (): void => {
    layout.openAgent()
    void useSessions.getState().create()
  }
  const checkUpdates = async (): Promise<void> => {
    setAsking(true)
    try {
      setOutdated(await prism.dashboard.outdated())
    } catch (e) {
      toastError(e)
    } finally {
      setAsking(false)
    }
  }
  const handTodos = (): void => {
    if (!info?.todos.length) return
    const text = `These notes are in the code. Go through them, deal with the ones that are quick and safe, and tell me about the rest.\n\n${info.todos
      .slice(0, 40)
      .map((t) => `- ${t.path}:${t.line}  ${t.tag}: ${t.text}`)
      .join('\n')}\n`
    layout.openAgent()
    const st = useSessions.getState()
    if (st.active) st.hand(st.active, text)
    else void st.create().then((s) => s && useSessions.getState().hand(s.id, text))
  }

  const g = info?.git
  const tagCounts = (info?.todos ?? []).reduce<Record<string, number>>((m, t) => ({ ...m, [t.tag]: (m[t.tag] ?? 0) + 1 }), {})
  const code = (info?.files.languages ?? []).filter((l) => !l.data)
  const codeLines = code.reduce((n, l) => n + l.lines, 0) || 1
  const recent = [...sessions].filter((s) => !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6)

  return (
    <div className="dash">
      <div className="dash-hero">
        <div className="dash-title">
          <div className="name">{info?.name ?? workspace.split(/[\\/]/).pop()}</div>
          <div className="faint small truncate" title={workspace}>
            {info?.package?.description || workspace}
          </div>
          <div className="dash-chips">
            {g?.branch && (
              <span className="chip">
                <GitBranch size={11} /> {g.branch}
                {g.ahead > 0 && ` · ${g.ahead} to push`}
                {g.behind > 0 && ` · ${g.behind} to pull`}
              </span>
            )}
            {g && <span className={cx('chip', g.changed.length > 0 && 'amber')}>{g.changed.length ? `${g.changed.length} file${g.changed.length === 1 ? '' : 's'} changed` : 'nothing uncommitted'}</span>}
            {info?.package?.version && <span className="chip">version {info.package.version}</span>}
            {!g && info && <span className="chip">not a git repository</span>}
          </div>
        </div>
        <div className="dash-actions">
          <button className="btn solid" onClick={newSession}>
            <MessageSquarePlus size={13} /> New session
          </button>
          <button className="btn" onClick={() => layout.openTerminal()}>
            <TerminalSquare size={13} /> Terminal
          </button>
          <button className="btn" onClick={() => layout.openBrowser()}>
            <Globe size={13} /> Browser
          </button>
          <button className="btn" onClick={() => layout.openScratch()}>
            <FlaskConical size={13} /> Scratchpad
          </button>
          <button className="btn" onClick={() => layout.openSpec()}>
            <BookCheck size={13} /> Spec
          </button>
          <button className="btn" onClick={() => layout.openTours()}>
            <Compass size={13} /> Tours
          </button>
          <button className="icon-btn" title="Read the project again" onClick={() => void load()}>
            <RefreshCw size={14} className={cx(loading && 'spin-slow')} />
          </button>
        </div>
      </div>

      <div className="dash-grid">
        <Card icon={<Sparkles size={13} className="accent" />} title="Recent sessions">
          {recent.length ? (
            recent.map((s) => (
              <button key={s.id} className="dash-row" onClick={() => openSession(s.id)}>
                <span className={cx('dot', live[s.id]?.running && 'on')} />
                <span className="grow truncate">{s.title}</span>
                <span className="faint xs truncate">{modelLabel(models, s.model)}</span>
                <span className="faint xs">{timeAgo(s.updatedAt)}</span>
              </button>
            ))
          ) : (
            <div className="faint small">No sessions in this project yet.</div>
          )}
        </Card>

        <Card
          icon={<GitBranch size={13} />}
          title="Changed files"
          action={
            g &&
            g.changed.length > 0 && (
              <button className="btn sm ghost" onClick={() => useUi.getState().setSide('git')}>
                Source control
              </button>
            )
          }
        >
          {!g ? (
            <div className="faint small">This folder is not a git repository, so changes are not tracked.</div>
          ) : g.changed.length ? (
            <>
              {g.changed.slice(0, 9).map((f) => (
                <button key={f.path} className="dash-row" onClick={() => layout.openEditor(f.path)}>
                  <FileIcon name={f.path} size={13} />
                  <span className="grow truncate" title={f.path}>
                    {f.path}
                  </span>
                  <span className={cx('xs', f.status === 'D' ? 'rose' : f.status === '?' || f.status === 'A' ? 'mint' : 'amber')}>{STATUS_WORD[f.status] ?? f.status}</span>
                </button>
              ))}
              {g.changed.length > 9 && <div className="faint xs dash-more">and {g.changed.length - 9} more</div>}
            </>
          ) : (
            <div className="faint small">Everything is committed.</div>
          )}
        </Card>

        <Card
          icon={<BookOpenCheck size={13} />}
          title="Checks and tests"
          action={
            checkers.length > 0 && (
              <button className="btn sm ghost" onClick={() => void useProblems.getState().runAll(true)}>
                <Play size={11} /> Run all
              </button>
            )
          }
        >
          {checkers.length ? (
            checkers.map((c) => {
              const r = results[c.id]
              const busy = !!running[c.id]
              const n = r?.problems.length ?? 0
              const failed = r ? r.code !== 0 || n > 0 : false
              return (
                <div key={c.id} className="dash-row static">
                  {busy ? <Loader2 size={13} className="spin-slow faint" /> : !r ? <span className="dot" /> : failed ? <CircleAlert size={13} className="rose" /> : <CheckCircle2 size={13} className="mint" />}
                  <span className="grow truncate" title={c.command}>
                    {c.label}
                  </span>
                  <span className={cx('xs', !r ? 'faint' : failed ? 'rose' : 'mint')}>{busy ? 'running' : !r ? 'not run yet' : failed ? (n ? `${n} problem${n === 1 ? '' : 's'}` : 'failed') : 'all good'}</span>
                  <button className="icon-btn sm" disabled={busy} title={`Run: ${c.command}`} onClick={() => void useProblems.getState().run(c.id)}>
                    <Play size={11} />
                  </button>
                </div>
              )
            })
          ) : (
            <div className="faint small">No type checker, linter or tests were found in this project.</div>
          )}
          {checkers.length > 0 && (
            <button className="btn sm ghost dash-foot" onClick={() => layout.openProblems()}>
              Open Problems
            </button>
          )}
        </Card>

        <Card
          icon={<ListTodo size={13} />}
          title="Notes left in the code"
          action={
            (info?.todos.length ?? 0) > 0 && (
              <button className="btn sm ghost" onClick={handTodos} title="Put the list in the message box">
                Hand to the agent
              </button>
            )
          }
        >
          {info?.todos.length ? (
            <>
              <div className="dash-chips">
                {Object.entries(tagCounts).map(([t, n]) => (
                  <span key={t} className={cx('chip', TAG_CLASS[t])}>
                    {n} {t}
                  </span>
                ))}
              </div>
              {info.todos.slice(0, 7).map((t, i) => (
                <button key={i} className="dash-row" onClick={() => layout.openEditor(t.path, { line: t.line })}>
                  <span className={cx('xs mono', TAG_CLASS[t.tag])}>{t.tag}</span>
                  <span className="grow truncate">{t.text || '(no text)'}</span>
                  <span className="faint xs truncate">
                    {t.path.split('/').pop()}:{t.line}
                  </span>
                </button>
              ))}
              {info.todos.length > 7 && <div className="faint xs dash-more">and {info.todos.length - 7} more</div>}
            </>
          ) : (
            <div className="faint small">{info ? 'No TODO, FIXME or HACK notes anywhere.' : 'Reading…'}</div>
          )}
        </Card>

        <Card
          icon={<Package size={13} />}
          title="Dependencies"
          action={
            info?.package && (
              <button className="btn sm ghost" disabled={asking} onClick={() => void checkUpdates()} title="Asks the package registry; takes a few seconds">
                {asking ? <Loader2 size={11} className="spin-slow" /> : <RefreshCw size={11} />} {asking ? 'Looking…' : 'Look for newer versions'}
              </button>
            )
          }
        >
          {info?.package ? (
            <>
              <div className="small">
                {info.package.deps} package{info.package.deps === 1 ? '' : 's'} the project needs, {info.package.devDeps} more for working on it
                {info.package.manager ? ` (${info.package.manager})` : ''}.
              </div>
              {outdated &&
                (outdated.note ? (
                  <div className="amber small">{outdated.note}</div>
                ) : outdated.packages.length ? (
                  <div className="dash-table upgrades">
                    <div className="dash-tr head">
                      <span>Package</span>
                      <span>You have</span>
                      <span>Newest</span>
                      <span />
                    </div>
                    {outdated.packages.slice(0, 12).map((p) => (
                      <div key={p.name} className="dash-tr">
                        <span className="truncate" title={p.name}>
                          {p.name}
                          {major(p.current) !== major(p.latest) && <span className="chip xs amber" title="A new major version: expect changes to how it is used">major</span>}
                        </span>
                        <span className="mono faint">{p.current}</span>
                        <span className="mono mint">{p.latest}</span>
                        <button className="btn sm ghost" disabled={upgrading} onClick={() => void upgrade([p], outdated.manager)} title="In a copy of the project: read what changed, upgrade, fix what breaks, run the tests">
                          Upgrade
                        </button>
                      </div>
                    ))}
                    {outdated.packages.some((p) => major(p.current) === major(p.latest)) && (
                      <button className="btn sm" style={{ marginTop: 6 }} disabled={upgrading} onClick={() => void upgrade(outdated.packages.filter((p) => major(p.current) === major(p.latest)), outdated.manager)} title="Every package with a newer version in the same major version, together, in a copy of the project">
                        Upgrade the {outdated.packages.filter((p) => major(p.current) === major(p.latest)).length} safe ones
                      </button>
                    )}
                    {outdated.packages.length > 12 && <div className="faint xs dash-more">and {outdated.packages.length - 12} more</div>}
                  </div>
                ) : (
                  <div className="mint small">Everything is on its newest version.</div>
                ))}
            </>
          ) : (
            <div className="faint small">{info ? 'No package.json here.' : 'Reading…'}</div>
          )}
        </Card>

        <Card icon={<History size={13} />} title="The repository">
          {info ? (
            <>
              <div className="dash-stats">
                {g && (
                  <div>
                    <b>{g.commits.toLocaleString()}</b>
                    <span>commit{g.commits === 1 ? '' : 's'}</span>
                  </div>
                )}
                {g && (
                  <div>
                    <b>{g.contributors}</b>
                    <span>{g.contributors === 1 ? 'person' : 'people'}</span>
                  </div>
                )}
                <div>
                  <b>{info.files.tracked.toLocaleString()}</b>
                  <span>files</span>
                </div>
                <div>
                  <b>{info.files.lines.toLocaleString()}</b>
                  <span>lines of code</span>
                </div>
              </div>
              {code.length > 0 && (
                <>
                  <div className="lang-bar">
                    {code.slice(0, 6).map((l, i) => (
                      <i key={l.name} className={`lang-${i}`} style={{ width: `${(l.lines / codeLines) * 100}%` }} title={`${l.name}: ${l.lines.toLocaleString()} lines`} />
                    ))}
                  </div>
                  <div className="lang-key">
                    {code.slice(0, 6).map((l, i) => (
                      <span key={l.name}>
                        <i className={`lang-${i}`} /> {l.name} <span className="faint">{Math.round((l.lines / codeLines) * 100)}%</span>
                      </span>
                    ))}
                  </div>
                </>
              )}
              {g?.firstCommit && <div className="faint xs">Started {timeAgo(g.firstCommit)}.</div>}
              {g?.recent.slice(0, 3).map((c) => (
                <button key={c.hash} className="dash-row" onClick={() => layout.openHistory(c.hash)}>
                  <span className="mono xs faint">{c.hash}</span>
                  <span className="grow truncate">{c.subject}</span>
                  <span className="faint xs">{timeAgo(c.date)}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="faint small">Reading…</div>
          )}
        </Card>

        <Card
          icon={<Coins size={13} />}
          title="Use over two weeks"
          wide
          action={
            <div className="seg">
              <button className={cx(byCost && 'on')} disabled={!anyCost} onClick={() => setByCost(true)} title={anyCost ? 'What it cost' : 'Nothing was billed per message in this period'}>
                cost
              </button>
              <button className={cx(!byCost && 'on')} onClick={() => setByCost(false)}>
                tokens
              </button>
            </div>
          }
        >
          <div className="spend">
            {days.map((d) => (
              <div key={d.day} className="spend-day" title={`${new Date(d.day * 86_400_000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${humanCost(d.cost)}, ${humanTokens(d.inputTokens + d.outputTokens)} tokens, ${d.requests} request${d.requests === 1 ? '' : 's'}`}>
                <div className="bar" style={{ height: `${Math.max(value(d) > 0 ? 4 : 0, (value(d) / peak) * 100)}%` }} />
                <span>{new Date(d.day * 86_400_000).getDate()}</span>
              </div>
            ))}
          </div>
          <div className="faint small">
            {total > 0 ? `${byCost ? humanCost(total) : `${humanTokens(total)} tokens`} in this project over the last 14 days.` : 'Nothing was sent to a model from this project in the last 14 days.'}
          </div>
        </Card>
      </div>
    </div>
  )
}
