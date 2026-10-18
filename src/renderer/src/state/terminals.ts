import { create } from 'zustand'
import type { TerminalInfo } from '@shared/types'
import { prism } from '@/lib/ipc'
import { toastError } from './ui'
import { useApp } from './app'

interface TerminalsState {
  list: TerminalInfo[]
  active: string | null
  refresh(): Promise<void>
  create(opts?: { cwd?: string; title?: string }): Promise<TerminalInfo | null>
  kill(id: string): Promise<void>
  setActive(id: string | null): void
}

export const useTerminals = create<TerminalsState>((set) => ({
  list: [],
  active: null,
  async refresh() {
    const list = await prism.terminals.list()
    set((s) => ({ list, active: s.active && list.some((t) => t.id === s.active) ? s.active : (list[0]?.id ?? null) }))
  },
  async create(opts) {
    try {
      const info = await prism.terminals.create({ ...opts, kind: 'user' })
      set((s) => ({ list: [...s.list, info], active: info.id }))
      return info
    } catch (e) {
      toastError(e, 'Could not open a terminal')
      return null
    }
  },
  async kill(id) {
    await prism.terminals.kill(id)
    set((s) => {
      const list = s.list.filter((t) => t.id !== id)
      return { list, active: s.active === id ? (list[list.length - 1]?.id ?? null) : s.active }
    })
  },
  setActive: (id) => set({ active: id })
}))

// the project changed: idle terminals elsewhere were closed; open one in the new project if it has none
prism.terminals.onChanged(() => {
  void useTerminals
    .getState()
    .refresh()
    .then(() => {
      const norm = (p: string): string => p.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
      const here = norm(useApp.getState().workspace ?? '')
      if (!useTerminals.getState().list.some((t) => t.kind === 'user' && norm(t.cwd) === here)) void useTerminals.getState().create()
    })
})
