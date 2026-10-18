// The face in a call: a small circle in the call bar, or a large tile above it. Tapping
// either switches to the other. Both show the same face — there is only ever one, and
// it moves between them.
import { useEffect, useRef } from 'react'
import { useCall } from '@/lib/call'
import { faceView, useFace } from '@/lib/face'
import { speechBeat } from '@/lib/speech'
import { cx } from '@/lib/format'

export function CallFace({ big }: { big: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const state = useFace((s) => s.state)
  const progress = useFace((s) => s.progress)
  const stage = useCall((s) => s.stage)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let alive = true
    let shown: Awaited<ReturnType<typeof faceView>> = null
    void faceView().then((v) => {
      if (!alive || !v) return
      v.mount(el, big ? 'shoulders' : 'head')
      shown = v
    })
    return () => {
      alive = false
      shown?.unmount(el)
    }
  }, [big])

  // The ring round the small face glows with whoever is talking, as the meter's bars did.
  useEffect(() => {
    const el = host.current
    if (big || !el) return
    let raf = 0
    const tick = (): void => {
      const c = useCall.getState()
      const glow = c.stage === 'speaking' ? (Date.now() - speechBeat.at < 260 ? speechBeat.level : 0) : c.stage === 'heard' ? Math.min(1, c.level * 1.6) : 0
      el.style.setProperty('--glow', glow.toFixed(2))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [big])

  return (
    <div
      ref={host}
      className={cx('call-face', big ? 'big' : 'small', stage, state)}
      title={big ? 'Make the face small again' : 'Make the face bigger'}
      onClick={() => useFace.setState({ big: !big })}
    >
      {big && state === 'loading' && <span className="call-face-note">{progress > 0 && progress < 1 ? `Fetching the face… ${Math.round(progress * 100)}%` : 'Getting the face ready…'}</span>}
    </div>
  )
}
