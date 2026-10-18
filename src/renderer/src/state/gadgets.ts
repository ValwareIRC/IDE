import { create } from 'zustand'
import type { GadgetInfo } from '@shared/ipc'
import { prism } from '@/lib/ipc'
import { toastError } from './ui'

interface GadgetsState {
  list: GadgetInfo[]
  loaded: boolean
  refresh(): Promise<void>
  reload(id: string): Promise<void>
  stop(id: string): Promise<void>
  remove(id: string): Promise<void>
}

export const useGadgets = create<GadgetsState>((set) => ({
  list: [],
  loaded: false,
  async refresh() {
    try {
      set({ list: await prism.gadgets.list(), loaded: true })
    } catch (e) {
      toastError(e)
    }
  },
  async reload(id) {
    try {
      await prism.gadgets.reload(id)
    } catch (e) {
      toastError(e, 'Reload failed')
    }
  },
  async stop(id) {
    await prism.gadgets.stop(id).catch(toastError)
  },
  async remove(id) {
    await prism.gadgets.remove(id).catch(toastError)
  }
}))

prism.gadgets.onChanged((list) => useGadgets.setState({ list, loaded: true }))
