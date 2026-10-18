import { create } from 'zustand'

export type Toast = { id: number; kind: 'info' | 'success' | 'error'; title: string; detail?: string }

export type SideView = 'explorer' | 'search' | 'outline' | 'git' | 'sessions' | 'gadgets' | 'settings' | null

interface UiState {
  palette: 'commands' | 'files' | 'symbols' | 'line' | 'sessions' | 'models' | 'modes' | null
  side: SideView
  toasts: Toast[]
  /** Follow the agent: open and reveal files as it edits them. */
  follow: boolean
  /** Zen: only the panel you are working in, no side bars. */
  zen: boolean
  setZen(on: boolean): void
  modal: 'shortcuts' | 'about' | 'new-file' | 'new-gadget' | 'remote' | 'claude-import' | null
  setModal(m: UiState['modal']): void
  setPalette(p: UiState['palette']): void
  setSide(s: SideView): void
  toggleSide(s: Exclude<SideView, null>): void
  setFollow(on: boolean): void
  toast(kind: Toast['kind'], title: string, detail?: string): void
  dismiss(id: number): void
}

let toastSeq = 0

export const useUi = create<UiState>((set, get) => ({
  palette: null,
  side: 'explorer',
  toasts: [],
  follow: localStorage.getItem('prism.follow') !== '0',
  zen: false,
  setZen: (zen) => set({ zen }),
  modal: null,
  setModal: (modal) => set({ modal }),
  setFollow: (on) => {
    localStorage.setItem('prism.follow', on ? '1' : '0')
    set({ follow: on })
  },
  setPalette: (palette) => set({ palette }),
  setSide: (side) => set({ side }),
  toggleSide: (s) => set({ side: get().side === s ? null : s }),
  toast: (kind, title, detail) => {
    const id = ++toastSeq
    set((st) => ({ toasts: [...st.toasts, { id, kind, title, detail }].slice(-5) }))
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 4500)
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
}))

export function toastError(e: unknown, title = 'Something went wrong'): void {
  const msg = e instanceof Error ? e.message : String(e)
  useUi.getState().toast('error', title, msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}
