import { useCallback, useEffect, useState } from 'react'
import { Plus, ShieldBan, Trash2 } from 'lucide-react'
import type { UserRule } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'

const reach = (r: UserRule): string[] => [...(r.block !== 'commands' ? r.paths : []), ...(r.block !== 'files' && r.command ? [`commands matching ${r.command}`] : []), ...(r.block !== 'files' && r.paths.length ? ['commands that name those paths'] : [])]

/** Things the agent must never do, checked before every step it takes. */
export function RulesSection(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [rules, setRules] = useState<UserRule[]>([])
  const [sentence, setSentence] = useState<string | null>(null)
  const [draft, setDraft] = useState<UserRule | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => void prism.rules.list().then(setRules).catch(toastError), [])
  useEffect(reload, [reload, workspace])
  useEffect(() => prism.extend.onChanged(reload), [reload])

  const work = async (): Promise<void> => {
    if (!sentence?.trim()) return
    setBusy(true)
    try {
      setDraft({ ...(await prism.rules.preview(sentence)), scope: workspace ? 'project' : 'personal' })
    } catch (e) {
      toastError(e, 'Could not work out that rule')
    } finally {
      setBusy(false)
    }
  }
  const save = async (r: UserRule): Promise<void> => {
    try {
      await prism.rules.save(r)
      setDraft(null)
      setSentence(null)
      reload()
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="settings-section">
      <div className="theme-bar">
        <h3>Rules</h3>
        <span className="grow" />
        <button className="btn sm" onClick={() => setSentence('')}>
          <Plus size={12} /> New rule
        </button>
      </div>
      <div className="extend-note">A rule is something the agent must never do, like “never touch the migrations” or “never push”. Prism checks every step against your rules and blocks the ones that break them, whatever the model. Prism also offers rules when you tell the agent off for something.</div>
      {sentence !== null && (
        <div className="card" style={{ padding: 12, marginBottom: 8 }}>
          {!draft ? (
            <>
              <label className="field">
                <span>The rule, in your words</span>
                <input className="input" autoFocus value={sentence} placeholder="Never change anything in the database migrations" onChange={(e) => setSentence(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void work()} />
              </label>
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end', gap: 6 }}>
                <button className="btn ghost sm" onClick={() => setSentence(null)}>
                  Cancel
                </button>
                <button className="btn solid sm" disabled={busy || !sentence.trim()} onClick={() => void work()}>
                  {busy ? 'Working it out…' : 'Next'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="small">
                <b>{draft.text}</b>
              </div>
              <div className="faint xs" style={{ margin: '4px 0 8px' }}>
                It will stop: {reach(draft).join('; ') || 'nothing (try saying it differently)'}
              </div>
              <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button className="btn ghost sm" onClick={() => setDraft(null)}>
                  Back
                </button>
                <button className="btn sm" onClick={() => void save({ ...draft, scope: 'personal' })}>
                  For all my projects
                </button>
                <button className="btn solid sm" disabled={!workspace} onClick={() => void save({ ...draft, scope: 'project' })}>
                  For this project
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {rules.map((r) => (
        <div key={r.id} className={cx('card ep-card', !r.enabled && 'faint')}>
          <ShieldBan size={16} className="extend-icon" style={{ color: 'var(--amber)' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ep-name">
              {r.text} <span className="faint small">{r.scope === 'personal' ? 'All my projects' : 'This project'}</span>
            </div>
            <div className="extend-chips">
              {reach(r).map((x) => (
                <span key={x} className="chip mono">
                  {x}
                </span>
              ))}
            </div>
          </div>
          <button className={cx('switch', r.enabled && 'on')} role="switch" aria-checked={r.enabled} title={r.enabled ? 'On' : 'Off'} onClick={() => void save({ ...r, enabled: !r.enabled })} />
          <button className="icon-btn" title="Delete" onClick={() => window.confirm(`Delete the rule "${r.text}"?`) && void prism.rules.remove(r.id).then(reload).catch(toastError)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!rules.length && sentence === null && <div className="faint small">No rules yet.</div>}
    </div>
  )
}
