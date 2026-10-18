import { create } from 'zustand'

/** Requests for the Browser panel from elsewhere in the app. The page itself lives in the panel. */
interface BrowserState {
  /** An address the panel should load; `at` makes a repeat of the same address count as new. */
  request: { url: string | null; at: number } | null
  /** The next panel to open starts empty (the agent is about to load its own address). */
  blank: boolean
  ask(url: string | null, blank?: boolean): void
  clear(): void
}

export const useBrowser = create<BrowserState>((set) => ({
  request: null,
  blank: false,
  ask: (url, blank = false) => set({ request: { url, at: Date.now() }, blank }),
  clear: () => set({ request: null, blank: false })
}))
