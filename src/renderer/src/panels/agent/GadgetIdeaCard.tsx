// Prism noticed that this work would be easier to see in a panel, and offers to build
// one. Three answers, because "no" means two different things: not this time, and not
// this sort of thing ever (see core/gadgets/scout.ts).
import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { GadgetIdea } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'

export function GadgetIdeaCard({ idea }: { idea: GadgetIdea }): React.JSX.Element {
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const decide = async (answer: 'build' | 'later' | 'never'): Promise<void> => {
    setBusy(true)
    try {
      await prism.gadgets.decideIdea(idea, answer, useSessions.getState().active)
      setDone(answer === 'build' ? 'Building it…' : answer === 'later' ? 'Not now.' : 'It will not suggest this sort again here.')
      if (answer === 'never') useUi.getState().toast('info', 'Noted', `Nothing of the "${idea.kind}" sort will be offered in this project. Settings, Assistance has the list.`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="offer-card">
      <div className="offer-head">
        <Puzzle size={13} className="accent" />
        <b>This might be worth a gadget</b>
      </div>
      <div className="small">{idea.title}</div>
      {idea.what && <div className="faint xs">{idea.what}</div>}
      {idea.why && <div className="faint xs">{idea.why}</div>}
      {done ? (
        <div className="faint xs" style={{ marginTop: 6 }}>
          {done}
        </div>
      ) : (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm solid" disabled={busy} onClick={() => void decide('build')}>
            Build it
          </button>
          <button className="btn sm" disabled={busy} onClick={() => void decide('later')}>
            Not now
          </button>
          <button className="btn sm ghost" disabled={busy} title={`Nothing of the "${idea.kind}" sort will be offered in this project again`} onClick={() => void decide('never')}>
            Never this kind
          </button>
        </div>
      )}
    </div>
  )
}
