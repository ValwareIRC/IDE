// The call, as a strip above the message box: who is talking, and the way out.
// Deliberately small — the conversation behind it is the point, and the steps the
// agent takes stay on screen while you talk.
import { useEffect, useRef } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { blipInCall, endCall, gestureInCall, sayOutLoud, setMuted, useCall } from '@/lib/call'
import { prism } from '@/lib/ipc'
import { useSessions } from '@/state/sessions'
import { cx } from '@/lib/format'
import { CallMeter } from './CallMeter'
import { CallFace } from './CallFace'
import { dropFace, useFace } from '@/lib/face'
import { useApp } from '@/state/app'

const WORD: Record<string, string> = {
  listening: 'Listening',
  heard: 'I can hear you',
  working: 'Thinking…',
  speaking: 'Speaking'
}

export function CallBar(): React.JSX.Element | null {
  const on = useCall((s) => s.on)
  const stage = useCall((s) => s.stage)
  const muted = useCall((s) => s.muted)
  const said = useCall((s) => s.said)
  const items = useSessions((s) => (on ? s.items[on] : undefined))
  // what has already been heard, so nothing is said twice
  const spoken = useRef<Set<string>>(new Set())
  const faceOn = useApp((s) => s.settings?.face?.enabled ?? true)
  const faceState = useFace((s) => s.state)
  const big = useFace((s) => s.big)

  // the face only lives as long as the call
  useEffect(() => {
    if (!on) dropFace()
  }, [on])

  // The agent is told it is on a call, and whether its face can be seen; said again
  // every half minute so a call whose phone vanished stops counting by itself.
  useEffect(() => {
    if (!on) return
    const tell = (): void => void prism.voice.inCall(on, true, faceOn).catch(() => {})
    tell()
    const again = setInterval(tell, 30_000)
    return () => {
      clearInterval(again)
      void prism.voice.inCall(on, false, false).catch(() => {})
    }
  }, [on, faceOn])

  // Everything already said before the call started counts as heard, or answering
  // the phone would read the whole conversation back at you.
  useEffect(() => {
    spoken.current = new Set(on ? (useSessions.getState().items[on] ?? []).map((i) => i.id) : [])
  }, [on])

  useEffect(() => {
    if (!on || !items?.length) return
    for (const it of items) {
      if (spoken.current.has(it.id)) continue
      spoken.current.add(it.id)
      // everything already in the conversation when the call started is old news
      if (!useCall.getState().on) return
      // What it says before reaching for a tool is still said to you — on a call that
      // is the half that explains what is about to happen, and skipping it left long
      // silences broken only by the very last thing it said.
      if (it.kind === 'tool' && typeof it.meta?.['gesture'] === 'string') gestureInCall(it.meta['gesture'] as string)
      else if (it.kind === 'tool') blipInCall()
      else if (it.kind === 'assistant' && it.text.trim()) void sayOutLoud(it.text)
    }
  }, [items, on])

  if (!on) return null
  const face = faceOn && faceState !== 'failed'
  return (
    <>
      {face && big && <CallFace big />}
      <div className={cx('call-bar', stage)}>
      {face && !big ? <CallFace big={false} /> : <CallMeter />}
      <span className="call-stage">{WORD[stage] ?? ''}</span>
      {said && stage === 'speaking' && <span className="call-said truncate">{said}</span>}
      <span className="grow" />
      <button className={cx('icon-btn sm', muted && 'on')} title={muted ? 'Listen again' : 'Stop listening for a moment'} onClick={() => setMuted(!muted)}>
        {muted ? <MicOff size={13} /> : <Mic size={13} />}
      </button>
      <button className="btn sm" title="End the call" onClick={endCall}>
        <PhoneOff size={12} /> Hang up
      </button>
      </div>
    </>
  )
}
