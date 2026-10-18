// The microphone beside the message box: press it to start a voice note. Everything
// after that belongs to VoiceBox, which takes the message box's place while the
// recording runs and holds the ways out of it.
import { Mic } from 'lucide-react'
import { startRecording, useVoice, voiceSettings, windowsDictation } from '@/lib/voice'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'

export function MicButton({ focusBox }: { focusBox: () => void }): React.JSX.Element {
  const state = useVoice((s) => s.state)

  const click = async (): Promise<void> => {
    try {
      if (state !== 'idle') return
      // Windows' own dictation types into the box itself; there is no recording here to show
      if (voiceSettings().engine === 'windows') {
        focusBox()
        await windowsDictation()
        return
      }
      await startRecording()
    } catch (e) {
      toastError(e, 'Voice input did not work')
    }
  }

  return (
    <button className={cx('icon-btn sm mic-btn', state)} title="Speak instead of typing" onClick={() => void click()}>
      <Mic size={16} />
    </button>
  )
}
