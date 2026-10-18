// Start a call with the agent: talk instead of typing, and keep watching it work.
import { Phone, PhoneOff } from 'lucide-react'
import { endCall, startCall, useCall } from '@/lib/call'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'

export function CallButton({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const on = useCall((s) => s.on)
  if (!sessionId) return null
  const mine = on === sessionId
  return (
    <button
      className={cx('icon-btn sm', mine && 'on')}
      title={mine ? 'End the call' : 'Call: talk to it instead of typing. It listens until you stop, answers out loud, and you can talk over it.'}
      onClick={() => {
        if (mine) return endCall()
        startCall(sessionId).catch((e: unknown) => toastError(e, 'The call could not start'))
      }}
    >
      {mine ? <PhoneOff size={14} /> : <Phone size={14} />}
    </button>
  )
}
