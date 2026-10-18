import { useCallback, useEffect, useState } from 'react'
import { BookCheck, CheckCircle2, CircleDashed, FilePlus2, Pencil, RefreshCw, TriangleAlert, Wand2 } from 'lucide-react'
import type { SpecState } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { Markdown } from '@/components/Markdown'
import { cx, timeAgo } from '@/lib/format'

/** Send a spec request and show the session it went to. */
async function go(run: () => Promise<string | null>): Promise<void> {
  try {
    const id = await run()
    if (!id) return
    useLayout.getState().openAgent()
    await useSessions.getState().select(id)
  } catch (e) {
    toastError(e)
  }
}

export const resolveDrift = (title: string, how: 'spec' | 'code' | 'ignore', sessionId: string | null): Promise<void> => go(() => prism.spec.resolve(title, how, sessionId))

/** The project's spec, section by section: what the code follows, what drifted, what you changed. */
export function SpecPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [st, setSt] = useState<SpecState | null | undefined>(undefined)
  const load = useCallback(() => {
    void prism.spec.state().then(setSt).catch(toastError)
  }, [])
  useEffect(() => {
    load()
    return prism.spec.onChanged(load)
  }, [load, workspace])

  if (st === undefined) return <div className="empty">Reading…</div>
  if (st === null) {
    return (
      <div className="empty">
        <BookCheck size={26} className="accent" />
        <div className="title">No spec yet</div>
        <div className="small faint" style={{ maxWidth: 460, textAlign: 'center' }}>
          A spec is a plain-English description of what the project should do, in SPEC.md. Prism checks the agent’s changes against it and tells you where they disagree, and when you edit it, Prism can change the code to match.
        </div>
        <button
          className="btn solid"
          onClick={() =>
            void prism.spec
              .create()
              .then((p) => useLayout.getState().openEditor(p))
              .catch(toastError)
          }
        >
          <FilePlus2 size={13} /> Start a spec
        </button>
      </div>
    )
  }

  const drifted = st.sections.filter((s) => s.status === 'drift')
  return (
    <div className="spec">
      <div className="review-bar">
        <BookCheck size={15} className="accent" />
        <span className="review-title">The spec</span>
        <span className="faint xs mono">{st.path}</span>
        <span className="grow" />
        {drifted.length > 0 && <span className="chip amber">{drifted.length} out of step</span>}
        <button className="btn sm" onClick={() => useLayout.getState().openEditor(st.path)}>
          <Pencil size={12} /> Edit
        </button>
        <button className="icon-btn" title="Read it again" onClick={load}>
          <RefreshCw size={13} />
        </button>
      </div>
      {st.pendingEdits && (
        <div className="spec-banner">
          <Wand2 size={15} className="accent" />
          <div className="grow">
            <b>You changed the spec.</b> {st.sections.filter((s) => s.edited).length} section{st.sections.filter((s) => s.edited).length === 1 ? '' : 's'} changed{st.removed.length ? `, ${st.removed.length} removed` : ''} since the code last matched it.
          </div>
          <button className="btn sm solid" onClick={() => void go(() => prism.spec.makeCodeMatch())} title="The agent plans the code changes first, for you to approve">
            Make the code match
          </button>
        </div>
      )}
      <div className="spec-body">
        {st.sections.map((s) => (
          <section key={s.title} className={cx('spec-sec', s.status === 'drift' && 'drift', s.edited && 'edited')}>
            <div className="spec-sec-head">
              {s.status === 'drift' ? <TriangleAlert size={14} className="amber" /> : s.status === 'ok' ? <CheckCircle2 size={14} className="mint" /> : <CircleDashed size={14} className="faint" />}
              <h3>{s.title}</h3>
              {s.edited && <span className="chip xs accent">{s.edited === 'added' ? 'new' : 'you changed this'}</span>}
              <span className="grow" />
              {s.checkedAt && <span className="faint xs">checked {timeAgo(s.checkedAt)}</span>}
            </div>
            {s.status === 'drift' && (
              <div className="spec-drift">
                <div className="small">{s.note}</div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn sm" onClick={() => void resolveDrift(s.title, 'spec', null)} title="The code is right: rewrite this section to describe it">
                    Update the spec
                  </button>
                  <button className="btn sm" onClick={() => void resolveDrift(s.title, 'code', null)} title="The spec is right: change the code back">
                    Fix the code
                  </button>
                  <button className="btn sm ghost" onClick={() => void resolveDrift(s.title, 'ignore', null)}>
                    It is fine
                  </button>
                </div>
              </div>
            )}
            <div className="spec-text md">
              <Markdown text={s.body || '_(empty)_'} />
            </div>
          </section>
        ))}
        {st.removed.length > 0 && <div className="faint small">Removed since the code last matched: {st.removed.join(', ')}</div>}
        {!st.sections.some((s) => s.status) && (
          <div className="faint xs" style={{ padding: '6px 2px' }}>
            Sections are checked after each turn in which the agent changes code{useApp.getState().settings?.roles.fast ? '' : ', using your quick model (Settings, Model roles, if you have set one; otherwise your main model)'}.
          </div>
        )}
      </div>
    </div>
  )
}

/** Shown once when the user saves the spec with changes the code does not follow. */
export function watchSpecEdits(): () => void {
  let told = ''
  return prism.spec.onChanged(() => {
    void prism.spec.state().then((st) => {
      if (!st?.pendingEdits) return
      const key = st.sections
        .filter((s) => s.edited)
        .map((s) => s.title)
        .join('|')
      if (key === told) return
      told = key
      useUi.getState().toast('info', 'You changed the spec', 'Open the spec (Ctrl+P, "spec") to have the code changed to match.')
    })
  })
}
