// While a voice note is being recorded, this takes the message box's place: what the
// microphone is hearing, drawn as it arrives, and the three things you might want to do
// with it. The bars are the real input level — nothing here is decorative.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { cancelRecording, stopRecording, useVoice } from '@/lib/voice'
import { toastError } from '@/state/ui'

/** How many bars of history; at the level store's pace this is a few seconds. */
const BARS = 28

export function VoiceBox({ onDone }: { onDone: (text: string, send: boolean) => void }): React.JSX.Element {
  const state = useVoice((s) => s.state)
  const level = useVoice((s) => s.level)
  const note = useVoice((s) => s.note)
  const startedAt = useVoice((s) => s.startedAt)
  const [bars, setBars] = useState<number[]>(() => Array<number>(BARS).fill(0))
  const [secs, setSecs] = useState(0)
  const busy = useRef(false)

  // the trace of what has been heard, oldest first
  useEffect(() => {
    if (state !== 'recording') return
    setBars((old) => [...old.slice(1), Math.min(1, level)])
  }, [level, state])

  useEffect(() => {
    if (state !== 'recording') return
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 250)
    return () => clearInterval(t)
  }, [state, startedAt])

  const finish = async (send: boolean): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      const text = await stopRecording()
      onDone(text ?? '', send)
    } catch (e) {
      cancelRecording()
      toastError(e, 'Voice input did not work')
      onDone('', false)
    } finally {
      busy.current = false
    }
  }

  const working = state === 'working'

  return (
    <div className="voice-box">
      <button className="voice-drop" title="Throw this recording away" onClick={() => { cancelRecording(); onDone('', false) }}>
        <X size={14} />
      </button>
      <div className="voice-wave" aria-hidden>
        {bars.map((v, i) => (
          <span key={i} className="voice-bar" style={{ height: `${Math.max(3, Math.round(v * 100))}%` }} />
        ))}
      </div>
      <span className="voice-time">
        {working ? note || 'Turning it into text…' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
      </span>
      <button className="voice-btn" title="Stop: the words go in the box for you to read over" disabled={working} onClick={() => void finish(false)}>
        <Square size={12} fill="currentColor" />
      </button>
      <button className="voice-btn send" title="Send it: no review" disabled={working} onClick={() => void finish(true)}>
        <ArrowUp size={15} strokeWidth={2.5} />
      </button>
    </div>
  )
}
