// What the user is looking at in the editor, so a message like "fix this" knows what "this" is. Only ever
// reports a file that is open right now: a panel that closes forgets its own entry at once, so the message box
// can never offer a selection from a tab that is gone.
import { create } from 'zustand'

export interface Look {
  path: string
  /** First and last line of the selection, or the cursor's line when nothing is selected. */
  line: number
  endLine: number
  /** The selected code; empty when nothing is selected. */
  text: string
  /** When it last changed, so the editor used most recently wins. */
  at: number
}

/** Identifies one look, so dismissing it does not also dismiss the next one. */
export function lookKey(l: Look): string {
  return l.text ? `${l.path}:${l.line}-${l.endLine}` : l.path
}

interface LookingState {
  looks: Record<string, Look>
  /** The look the user took off this message. */
  dismissed: string | null
  see(l: Look): void
  /** An editor closed: whatever it showed is no longer in front of anyone. */
  forget(path: string): void
  dismiss(key: string | null): void
}

export const useLooking = create<LookingState>((set) => ({
  looks: {},
  dismissed: null,
  see: (l) =>
    set((s) => {
      // a demo moves around the editor by itself; none of that is you looking at anything
      if (document.body.classList.contains('demo-playing')) return s
      const was = s.looks[l.path]
      if (was && was.line === l.line && was.endLine === l.endLine && was.text === l.text) return s
      return { looks: { ...s.looks, [l.path]: l } }
    }),
  forget: (path) =>
    set((s) => {
      if (!s.looks[path]) return s
      const looks = { ...s.looks }
      delete looks[path]
      return { looks }
    }),
  dismiss: (key) => set({ dismissed: key })
}))

/** The newest look among the editors still open, or null. */
export function currentLook(s: { looks: Record<string, Look> }): Look | null {
  let best: Look | null = null
  for (const l of Object.values(s.looks)) if (!best || l.at > best.at) best = l
  return best
}
