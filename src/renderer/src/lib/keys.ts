import { useEffect } from 'react'
import { useUi } from '@/state/ui'
import { chordOf, commandForChord, isRecording } from './keybindings'
import { findCommand, runCommand } from './commands'

/**
 * App-wide shortcuts. Listens in the capture phase so a shortcut the user
 * assigned wins over the editor's own use of the same keys.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isRecording()) return
      const ui = useUi.getState()
      if (e.key === 'Escape' && ui.palette) {
        ui.setPalette(null)
        return
      }
      const chord = chordOf(e)
      if (!chord) return
      const id = commandForChord(chord)
      if (!id) return
      // an editor with focus saves itself (format on save, etc.)
      if (id === 'file.save' && (e.target as HTMLElement | null)?.closest?.('.monaco-editor')) return
      const cmd = findCommand(id)
      if (!cmd) return
      e.preventDefault()
      e.stopPropagation()
      runCommand(cmd)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
