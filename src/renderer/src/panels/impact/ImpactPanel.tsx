import { useState } from 'react'
import { create } from 'zustand'
import { FlaskConical, Play, Radar, Send } from 'lucide-react'
import type { ImpactReport, ReviewFile } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useTerminals } from '@/state/terminals'
import { toastError, useUi } from '@/state/ui'
import { FileIcon } from '@/components/FileIcon'
import { cx } from '@/lib/format'

interface Entry {
  title: string
  report: ImpactReport
  sessionId: string | null
}

const useImpact = create<{ reports: Record<string, Entry> }>(() => ({ reports: {} }))
let seq = 0
// ids stay unique across restarts, so a tab kept in the saved layout is never mistaken for a new one
const RUN = Date.now().toString(36)

function show(title: string, report: ImpactReport, sessionId: string | null): void {
  const id = `i${RUN}${++seq}`
  useImpact.setState((s) => ({ reports: { ...s.reports, [id]: { title, report, sessionId } } }))
  useLayout.getState().openImpact(id)
}

/** What changes not yet written could break (from the review panel). */
export async function impactOfFiles(files: ReviewFile[], sessionId: string | null): Promise<void> {
  try {
    useUi.getState().toast('info', 'Checking what this could break…')
    show('Before writing these changes', await prism.impact.files(files), sessionId)
  } catch (e) {
    toastError(e, 'Could not check the impact')
  }
}

/** What a session's latest changes could break. */
export async function impactOfSession(sessionId: string): Promise<void> {
  try {
    useUi.getState().toast('info', 'Checking what this could break…')
    show('The latest changes', await prism.impact.session(sessionId), sessionId)
  } catch (e) {
    toastError(e, 'Could not check the impact')
  }
}

/** Runs a command in a terminal of its own, in the project folder. */
async function runInTerminal(title: string, command: string): Promise<void> {
  // through the store, so the Terminal panel lists it and shows it in front
  const t = await useTerminals.getState().create({ title })
  if (!t) return
  useLayout.getState().openTerminal()
  // the shell needs a moment before it reads input
  window.setTimeout(() => prism.terminals.write(t.id, `${command}\r`), 700)
}

export function ImpactPanel({ id }: { id: string }): React.JSX.Element {
  const entry = useImpact((s) => s.reports[id])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!entry) return <div className="empty">This check is no longer here. Run it again from the changes.</div>
  const r = entry.report
  const changed = r.symbols.filter((s) => s.change !== 'added')
  const added = r.symbols.filter((s) => s.change === 'added')
  const bySymbol = new Map<string, ImpactReport['callers']>()
  for (const c of r.callers) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c])

  const askAgent = (): void => {
    if (!entry.sessionId) return
    const uses = r.callers.slice(0, 40).map((c) => `- ${c.path}:${c.line} (${c.symbol}): ${c.text}`)
    void useSessions
      .getState()
      .send(`Check that your changes did not break anything that uses what you changed. These places use it:\n${uses.join('\n')}${r.testCommand ? `\n\nThen run the affected tests: ${r.testCommand}` : ''}\n\nFix anything that no longer fits, and tell me what you found.`, undefined, entry.sessionId)
    useLayout.getState().openAgent()
  }

  return (
    <div className="impact">
      <div className="review-bar">
        <Radar size={15} className="accent" />
        <span className="review-title truncate">What could break · {entry.title}</span>
        <span className="faint xs">
          {r.files.length} file{r.files.length === 1 ? '' : 's'} changed
        </span>
        <span className="grow" />
        {entry.sessionId && r.callers.length > 0 && (
          <button className="btn sm" onClick={askAgent} title="Ask the agent to go through these uses and the tests">
            <Send size={12} /> Ask the agent to check
          </button>
        )}
        {r.testCommand && (
          <button className="btn sm solid" onClick={() => void runInTerminal('affected tests', r.testCommand!)} title={r.testCommand}>
            <Play size={12} /> Run the {r.tests.length} affected test file{r.tests.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <div className="impact-body">
        <section className="impact-col">
          <div className="hud-label">What changed</div>
          {!changed.length && <div className="faint small">No existing function, class or value changed its definition{added.length ? `; ${added.length} new.` : '.'}</div>}
          {changed.map((s) => {
            const uses = bySymbol.get(s.name) ?? []
            const key = `${s.path}:${s.name}`
            return (
              <div key={key} className="impact-sym">
                <button className="impact-sym-head" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                  <span className={cx('chip xs', s.change === 'removed' ? 'rose' : 'amber')}>{s.change === 'removed' ? 'removed' : 'changed'}</span>
                  <span className="mono small">{s.name}</span>
                  <span className="faint xs truncate">{s.path}</span>
                  <span className="grow" />
                  <span className={cx('xs', uses.length ? 'amber' : 'faint')}>{uses.length ? `used in ${uses.length} place${uses.length === 1 ? '' : 's'}` : 'not used elsewhere'}</span>
                </button>
                {(open[key] ?? uses.length <= 8) &&
                  uses.map((c, i) => (
                    <button key={i} className="impact-use" onClick={() => useLayout.getState().openEditor(c.path, { line: c.line })}>
                      <FileIcon name={c.path} size={12} />
                      <span className="mono xs">
                        {c.path}:{c.line}
                      </span>
                      {c.inTest && <span className="chip xs violet">test</span>}
                      <span className="faint xs truncate">{c.text}</span>
                    </button>
                  ))}
              </div>
            )
          })}
          {added.length > 0 && (
            <div className="faint xs" style={{ marginTop: 8 }}>
              New: {added.map((s) => s.name).join(', ')}
            </div>
          )}
          {!r.byMeaning && <div className="faint xs" style={{ marginTop: 8 }}>Some uses were found by name, so a few may be something else with the same name.</div>}
        </section>
        <section className="impact-col">
          <div className="hud-label">
            <FlaskConical size={11} /> Tests that reach this code
          </div>
          {r.tests.length ? (
            r.tests.map((t) => (
              <button key={t} className="impact-use" onClick={() => useLayout.getState().openEditor(t)}>
                <FileIcon name={t} size={12} />
                <span className="mono xs">{t}</span>
              </button>
            ))
          ) : (
            <div className="faint small">No test file reaches the changed code. This change is untested.</div>
          )}
          {r.tests.length > 0 && !r.testCommand && <div className="faint xs">Prism could not tell how this project runs its tests, so run them your usual way.</div>}
          <div className="hud-label" style={{ marginTop: 14 }}>
            Files that depend on it
          </div>
          {r.importedBy.length ? (
            r.importedBy.slice(0, 40).map((p) => (
              <button key={p} className="impact-use" onClick={() => useLayout.getState().openEditor(p)}>
                <FileIcon name={p} size={12} />
                <span className="mono xs">{p}</span>
              </button>
            ))
          ) : (
            <div className="faint small">Nothing imports the changed files.</div>
          )}
        </section>
      </div>
    </div>
  )
}
