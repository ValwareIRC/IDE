import { useCallback, useEffect, useRef, useState } from 'react'
import { BookMarked, Layers, MessageSquare, Minimize2, Pin, Plus, RefreshCw, Trash2, User, Wrench, X } from 'lucide-react'
import type { ContextReport, SessionExtras } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { useEditor } from '@/state/editor'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { cx, humanTokens } from '@/lib/format'

const PART_HELP: Record<string, string> = {
  base: 'The standing instructions that make Prism behave like Prism.',
  tools: 'The descriptions of everything Prism can do (grows with gadgets and MCP servers).',
  notes: 'PRISM.md and similar files in the project, read every turn.',
  pins: 'Files you pinned for this session, sent in full every turn.',
  skills: 'The skills this session is using, and the short list of the others.',
  extra: 'What you wrote under "Instructions for this session".',
  summary: 'The summary that replaced older turns when the conversation was compacted.',
  conversation: 'Your messages and Prism’s replies.',
  results: 'What tools returned: file contents, command output, search results.'
}

/** What the model is holding for a session, and the levers to change it: pin files, add instructions, drop bulky results, compact, remember. */
export function ContextPanel(): React.JSX.Element {
  const sessionId = useSessions((s) => s.active)
  const session = useSessions((s) => s.sessions.find((x) => x.id === s.active))
  const running = useSessions((s) => (s.active ? !!s.live[s.active]?.running : false))
  const activeFile = useEditor((s) => s.active)
  const [report, setReport] = useState<ContextReport | null>(null)
  const [extras, setExtras] = useState<SessionExtras>({ pins: [], instructions: '' })
  const [instructions, setInstructions] = useState('')
  const [pinQuery, setPinQuery] = useState('')
  const [suggest, setSuggest] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setReport(null)
      return
    }
    setBusy(true)
    try {
      const [r, e] = await Promise.all([prism.agent.context(sessionId), prism.sessions.extras(sessionId)])
      setReport(r)
      setExtras(e)
      setInstructions(e.instructions)
    } catch (e) {
      toastError(e, 'Could not measure the context')
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  // measure on open, when the session changes, and each time a turn ends
  useEffect(() => {
    if (!running) void refresh()
  }, [refresh, running])

  // a skill or tool was added, changed or removed
  useEffect(() => prism.extend.onChanged(() => void refresh()), [refresh])

  useEffect(() => {
    const q = pinQuery.trim()
    if (!q) {
      setSuggest([])
      return
    }
    let alive = true
    void prism.fs.quickOpen(q, 6).then((f) => alive && setSuggest(f))
    return () => {
      alive = false
    }
  }, [pinQuery])

  const setSkill = async (name: string, on: boolean): Promise<void> => {
    if (!sessionId) return
    const now = report?.skills.filter((k) => k.loaded).map((k) => k.name) ?? []
    await prism.sessions.setExtras(sessionId, { skills: on ? [...now, name] : now.filter((n) => n !== name) }).catch(toastError)
    await refresh()
  }

  const setPins = async (pins: string[]): Promise<void> => {
    if (!sessionId) return
    await prism.sessions.setExtras(sessionId, { pins }).catch(toastError)
    setPinQuery('')
    void refresh()
  }

  if (!sessionId || !session) {
    return (
      <div className="empty">
        <Layers size={24} className="accent" />
        <div>No session yet</div>
        <div className="small faint">Start a conversation and this panel shows what the model is holding and how much room is left.</div>
      </div>
    )
  }

  const window = report?.window ?? null
  const total = report?.total ?? 0
  const pct = window ? Math.min(100, Math.round((total / window) * 100)) : null
  const biggest = report?.items[0]?.tokens ?? 1

  return (
    <div className="ctx-panel">
      <div className="ctx-bar">
        <Layers size={15} className="accent" />
        <span className="ctx-title truncate">What the model is holding</span>
        <span className="faint xs truncate">{session.title}</span>
        <span className="grow" />
        <span className={cx('mono small', pct !== null && pct > 85 && 'rose', pct !== null && pct > 65 && pct <= 85 && 'amber')}>
          ~{humanTokens(total)}
          {window ? ` of ${humanTokens(window)} · ${pct}%` : ''}
        </span>
        <button className="btn sm ghost" disabled={running} onClick={() => void useSessions.getState().compact(sessionId).then(refresh)} title="Replace the older turns with a summary">
          <Minimize2 size={12} /> Compact
        </button>
        <button className="icon-btn sm" title="Measure again" onClick={() => void refresh()}>
          <RefreshCw size={13} className={busy ? 'spin-slow' : undefined} />
        </button>
      </div>
      <div className="ctx-body">
        {report && (
          <>
            <div className="ctx-stack" title="How the room is shared out">
              {report.parts
                .filter((p) => p.tokens > 0)
                .map((p) => (
                  <i key={p.id} className={`p-${p.id}`} style={{ flexGrow: p.tokens }} title={`${p.label}: ~${humanTokens(p.tokens)}`} />
                ))}
              {window && window > total && <i className="p-free" style={{ flexGrow: window - total }} title={`Free: ~${humanTokens(window - total)}`} />}
            </div>
            <div className="ctx-legend">
              {report.parts
                .filter((p) => p.tokens > 0)
                .map((p) => (
                  <span key={p.id} className="ctx-key" title={PART_HELP[p.id]}>
                    <i className={`p-${p.id}`} />
                    {p.label} <b>{humanTokens(p.tokens)}</b>
                  </span>
                ))}
            </div>
          </>
        )}
        <div className="ctx-cols">
          <section className="ctx-card">
            <div className="hud-label">Biggest things in the conversation</div>
            {report && report.items.length === 0 && <div className="faint small">Nothing yet.</div>}
            {report?.items.slice(0, 30).map((it) => (
              <div key={it.id} className="ctx-row">
                {it.kind === 'user' ? <User size={12} className="accent" /> : it.kind === 'tool' ? <Wrench size={12} className="amber" /> : it.kind === 'system' ? <BookMarked size={12} className="violet" /> : <MessageSquare size={12} className="faint" />}
                <span className="ctx-label truncate" title={it.label}>
                  {it.label}
                </span>
                <span className="ctx-meter">
                  <i style={{ width: `${Math.max(3, (it.tokens / biggest) * 100)}%` }} />
                </span>
                <span className="mono xs faint ctx-n">{humanTokens(it.tokens)}</span>
                {it.removable ? (
                  <button
                    className="icon-btn sm"
                    disabled={running}
                    title="Take this result out of the conversation. Prism can run the tool again if it needs it."
                    onClick={() =>
                      void prism.sessions
                        .prune(sessionId, it.id)
                        .then(() => {
                          useUi.getState().toast('success', 'Removed from the conversation', `~${humanTokens(it.tokens)} freed`)
                          void useSessions.getState().select(sessionId)
                          return refresh()
                        })
                        .catch(toastError)
                    }
                  >
                    <Trash2 size={11} />
                  </button>
                ) : (
                  <span style={{ width: 22 }} />
                )}
              </div>
            ))}
          </section>
          <div className="ctx-side">
            <section className="ctx-card">
              <div className="hud-label">Pinned files</div>
              <div className="faint xs">Sent in full on every turn of this session, always up to date.</div>
              {report?.pins.map((p) => (
                <div key={p.path} className="ctx-row">
                  <Pin size={11} className="accent" />
                  <FileIcon name={p.path} size={12} />
                  <button className="ctx-label truncate linkish" title={p.path} onClick={() => useLayout.getState().openEditor(p.path)}>
                    {p.path}
                  </button>
                  {p.truncated && <span className="chip xs amber">start only</span>}
                  <span className="mono xs faint ctx-n">{humanTokens(p.tokens)}</span>
                  <button className="icon-btn sm" title="Unpin" onClick={() => void setPins(extras.pins.filter((x) => x !== p.path))}>
                    <X size={11} />
                  </button>
                </div>
              ))}
              <div className="ctx-add">
                <input className="input sm grow" placeholder="Pin a file… type its name" value={pinQuery} onChange={(e) => setPinQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && suggest[0] && void setPins([...extras.pins, suggest[0]])} />
                {activeFile && !extras.pins.includes(activeFile) && (
                  <button className="btn sm ghost" onClick={() => void setPins([...extras.pins, activeFile])} title={`Pin ${activeFile}`}>
                    <Plus size={11} /> open file
                  </button>
                )}
              </div>
              {suggest.length > 0 && (
                <div className="ctx-suggest">
                  {suggest
                    .filter((f) => !extras.pins.includes(f))
                    .map((f) => (
                      <button key={f} onClick={() => void setPins([...extras.pins, f])}>
                        <FileIcon name={f} size={12} /> {f}
                      </button>
                    ))}
                </div>
              )}
            </section>
            {report && report.skills.length > 0 && (
              <section className="ctx-card">
                <div className="hud-label">Skills</div>
                <div className="faint xs">Instructions that join when your message calls for them. One in use stays for the rest of the session.</div>
                {[...report.skills]
                  .sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name))
                  .map((k) => (
                    <div key={k.name} className="ctx-row" title={k.description}>
                      <BookMarked size={11} className={k.loaded ? 'accent' : 'faint'} />
                      <span className={cx('ctx-label truncate', !k.loaded && 'faint')}>{k.name}</span>
                      {k.loaded && <span className="mono xs faint ctx-n">{humanTokens(k.tokens)}</span>}
                      {k.always ? (
                        <span className="chip xs" title="Its file says always: true">always</span>
                      ) : (
                        <button className="icon-btn sm" disabled={running} title={k.loaded ? 'Stop using this skill in this session' : 'Use this skill in this session'} onClick={() => void setSkill(k.name, !k.loaded)}>
                          {k.loaded ? <X size={11} /> : <Plus size={11} />}
                        </button>
                      )}
                    </div>
                  ))}
              </section>
            )}
            <section className="ctx-card">
              <div className="hud-label">Instructions for this session</div>
              <textarea
                className="input"
                rows={4}
                placeholder="Only for this conversation. e.g. “Answer in British English. Never touch the migrations folder.”"
                value={instructions}
                onChange={(e) => {
                  const v = e.target.value
                  setInstructions(v)
                  if (saveTimer.current) clearTimeout(saveTimer.current)
                  saveTimer.current = setTimeout(() => void prism.sessions.setExtras(sessionId, { instructions: v }).then(refresh).catch(toastError), 700)
                }}
              />
            </section>
            <section className="ctx-card">
              <div className="hud-label">Project notes</div>
              <div className="faint xs">Read at the start of every session in this project.</div>
              {report?.notes.map((n) => (
                <div key={n.path} className="ctx-row">
                  <BookMarked size={11} className="mint" />
                  <button className="ctx-label truncate linkish" onClick={() => useLayout.getState().openEditor(n.path)}>
                    {n.path}
                  </button>
                  <span className="mono xs faint ctx-n">{humanTokens(n.tokens)}</span>
                </div>
              ))}
              <div className="ctx-add">
                <input
                  className="input sm grow"
                  placeholder="Remember… e.g. “Tests run with pnpm test:unit”"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !note.trim()) return
                    void prism.agent
                      .remember(note.trim())
                      .then(() => {
                        setNote('')
                        useUi.getState().toast('success', 'Saved to PRISM.md')
                        return refresh()
                      })
                      .catch(toastError)
                  }}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
