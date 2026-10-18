import { useState } from 'react'
import { BookOpen, ShieldBan } from 'lucide-react'
import type { LearnOffer } from '@shared/types'
import { prism } from '@/lib/ipc'
import { toastError, useUi } from '@/state/ui'
import { useLayout } from '@/state/layout'

/** Something Prism noticed in your corrections: keep it as a skill or a rule, or not. */
export function OfferCard({ offer }: { offer: LearnOffer }): React.JSX.Element {
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const accept = async (scope: 'project' | 'personal'): Promise<void> => {
    setBusy(true)
    try {
      const r = await prism.learn.accept(offer, scope)
      if (r.rule) {
        const reach = [...r.rule.paths, ...(r.rule.command ? [`commands like /${r.rule.command}/`] : [])].join(', ')
        setDone(`Rule made: ${r.rule.text}`)
        useUi.getState().toast('success', 'Rule made', `It stops: ${reach}. Change or remove it in Settings, Skills & tools.`)
      } else {
        setDone('Saved as a skill.')
        if (r.path) useUi.getState().toast('success', 'Skill saved', 'It joins the conversation when your message mentions it.')
      }
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  const later = (): void => {
    void prism.learn.dismiss(offer).catch(() => {})
    setDone('Not kept.')
  }

  return (
    <div className="offer-card">
      <div className="offer-head">
        {offer.kind === 'skill' ? <BookOpen size={13} className="accent" /> : <ShieldBan size={13} className="amber" />}
        <b>{offer.kind === 'skill' ? 'You have said this before' : 'That sounds like a rule'}</b>
      </div>
      <div className="small">{offer.kind === 'skill' ? offer.instruction : offer.sentence}</div>
      {offer.kind === 'skill' && offer.when.length > 0 && <div className="faint xs">It would join conversations that mention: {offer.when.join(', ')}</div>}
      {offer.kind === 'rule' && <div className="faint xs">As a rule, Prism would block any step that breaks it, in every session.</div>}
      {done ? (
        <div className="faint xs" style={{ marginTop: 6 }}>
          {done}{' '}
          {done.startsWith('Rule') || done.startsWith('Saved') ? (
            <button className="linkish xs" onClick={() => useLayout.getState().openSettings('extend')}>
              See it in Settings
            </button>
          ) : null}
        </div>
      ) : (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm solid" disabled={busy} onClick={() => void accept('project')}>
            {offer.kind === 'skill' ? 'Keep as a skill for this project' : 'Make it a rule for this project'}
          </button>
          <button className="btn sm" disabled={busy} onClick={() => void accept('personal')}>
            For all my projects
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={later}>
            Not now
          </button>
        </div>
      )}
    </div>
  )
}
