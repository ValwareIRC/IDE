// The moving bar in the call strip. Nothing here is invented: while you talk it is your
// microphone, and while the agent talks it beats on the real word boundaries its voice
// reports (see lib/speech.ts — the computer's own voice is spoken by the system, so its
// loudness is not something this page can measure; a voice we render ourselves will
// hand back audio and this picks it up without changing).
//
// While it is thinking there is no sound at all, so the bar sweeps side to side instead:
// that stands for work being done, which is honest, rather than pretending to be sound.
import { useEffect, useRef, useState } from 'react'
import { speechBeat } from '@/lib/speech'
import { useCall } from '@/lib/call'
import { cx } from '@/lib/format'

const CELLS = 11
/** How long a word's beat takes to fall away. */
const DECAY_MS = 260

export function CallMeter(): React.JSX.Element {
  const stage = useCall((s) => s.stage)
  const [cells, setCells] = useState<number[]>(() => Array<number>(CELLS).fill(0))
  const sweep = useRef(0)

  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      const now = Date.now()
      const st = useCall.getState().stage
      let next: number[]
      if (st === 'working') {
        // the sweep: one lit cell running across and back
        sweep.current += 0.055
        const pos = (Math.sin(sweep.current) * 0.5 + 0.5) * (CELLS - 1)
        next = Array.from({ length: CELLS }, (_, i) => Math.max(0, 1 - Math.abs(i - pos) / 1.7))
      } else if (st === 'speaking') {
        const since = now - speechBeat.at
        const beat = since < DECAY_MS ? speechBeat.level * (1 - since / DECAY_MS) : 0
        // loudest in the middle, as a voice is
        next = Array.from({ length: CELLS }, (_, i) => {
          const fromMiddle = Math.abs(i - (CELLS - 1) / 2) / ((CELLS - 1) / 2)
          return Math.max(0, beat * (1 - fromMiddle * 0.75))
        })
      } else {
        const lvl = useCall.getState().level
        next = Array.from({ length: CELLS }, (_, i) => {
          const fromMiddle = Math.abs(i - (CELLS - 1) / 2) / ((CELLS - 1) / 2)
          return Math.max(0, Math.min(1, lvl * 1.6) * (1 - fromMiddle * 0.8))
        })
      }
      setCells(next)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <span className={cx('call-meter', stage)} aria-hidden title={stage === 'working' ? 'Thinking' : stage === 'speaking' ? 'Talking' : 'Listening'}>
      {cells.map((v, i) => (
        <span key={i} className="call-cell" style={{ opacity: 0.18 + v * 0.82, transform: `scaleY(${0.25 + v * 0.75})` }} />
      ))}
    </span>
  )
}
