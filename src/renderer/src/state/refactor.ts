import { create } from 'zustand'
import type { RefHit, RefactorPlan, ReviewDecision } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useEditor } from './editor'
import { useLayout } from './layout'
import { toastError, useUi } from './ui'

/** Where a name sits: the file, and the 1-based line and column of the cursor on it. */
export interface Spot {
  path: string
  line: number
  column: number
  word: string
}

interface Pending extends RefactorPlan {
  /** Set once it has been applied or cancelled; the panel then shows the outcome. */
  done?: 'applied' | 'cancelled' | 'undone'
  written?: string[]
}

interface RefactorState {
  plans: Record<string, Pending>
  refs: (Spot & { hits: RefHit[]; byMeaning: boolean }) | null
  /** The "rename to…" dialog is open for this name. */
  asking: Spot | null
  askRename(spot: Spot): void
  closeAsk(): void
  rename(newName: string): Promise<void>
  references(spot: Spot): Promise<void>
  /** A file or folder is being moved. True when a change set was opened; false when nothing mentions it, so the caller can simply move it. */
  move(from: string, to: string): Promise<boolean>
  /** Open a change set worked out elsewhere (undo a request, the same edit elsewhere…). */
  show(plan: RefactorPlan): string
  apply(id: string, files: ReviewDecision['files']): Promise<void>
  cancel(id: string): void
  undo(id: string): Promise<void>
}

let seq = 0
// ids stay unique across restarts, so a tab kept in the saved layout is never mistaken for a new one
const RUN = Date.now().toString(36)

// what is on disk is what gets read, so unsaved edits are saved first
const saveAll = (): Promise<void> => useEditor.getState().saveAll()

export const useRefactor = create<RefactorState>((set, get) => ({
  plans: {},
  refs: null,
  asking: null,

  askRename: (spot) => {
    if (!spot.word) return useUi.getState().toast('info', 'Put the cursor on a name first')
    set({ asking: spot })
  },
  closeAsk: () => set({ asking: null }),

  async rename(newName) {
    const spot = get().asking
    if (!spot) return
    set({ asking: null })
    try {
      await saveAll()
      const plan = await prism.refactor.rename(spot.path, spot.line, spot.column, spot.word, newName)
      if (!plan.files.length) return useUi.getState().toast('info', 'Nothing to rename', `No use of ${spot.word} was found.`)
      const id = `r${RUN}${++seq}`
      set((s) => ({ plans: { ...s.plans, [id]: plan } }))
      useLayout.getState().openRefactor(id, plan.title)
    } catch (e) {
      toastError(e, 'Could not work out the rename')
    }
  },

  async references(spot) {
    if (!spot.word) return useUi.getState().toast('info', 'Put the cursor on a name first')
    try {
      await saveAll()
      const r = await prism.refactor.references(spot.path, spot.line, spot.column, spot.word)
      set({ refs: { ...spot, ...r } })
      useLayout.getState().openReferences()
    } catch (e) {
      toastError(e, 'Could not look for uses')
    }
  },

  async move(from, to) {
    await saveAll()
    const plan = await prism.refactor.move(from, to)
    if (!plan.files.length) return false
    const id = `r${RUN}${++seq}`
    set((s) => ({ plans: { ...s.plans, [id]: plan } }))
    useLayout.getState().openRefactor(id, plan.title)
    return true
  },

  show(plan) {
    const id = `r${RUN}${++seq}`
    set((s) => ({ plans: { ...s.plans, [id]: plan } }))
    useLayout.getState().openRefactor(id, plan.title)
    return id
  },

  async apply(id, files) {
    const plan = get().plans[id]
    if (!plan || plan.done) return
    try {
      const r = await prism.refactor.apply(files, plan.then)
      if (plan.then) useEditor.getState().rename(plan.then.from, plan.then.to)
      set((s) => ({ plans: { ...s.plans, [id]: { ...plan, done: 'applied', written: r.written } } }))
    } catch (e) {
      toastError(e, 'Could not write the changes')
    }
  },

  cancel: (id) => set((s) => (s.plans[id] ? { plans: { ...s.plans, [id]: { ...s.plans[id]!, done: 'cancelled' } } } : s)),

  async undo(id) {
    const plan = get().plans[id]
    if (!plan || plan.done !== 'applied') return
    try {
      const back = await prism.refactor.undo()
      if (!back) return useUi.getState().toast('info', 'Nothing to undo', 'Something else was changed after this.')
      if (plan.then) useEditor.getState().rename(plan.then.to, plan.then.from)
      set((s) => ({ plans: { ...s.plans, [id]: { ...plan, done: 'undone' } } }))
    } catch (e) {
      toastError(e, 'Could not undo')
    }
  }
}))

/** Work out how to take one request's changes back out, and show it as a change set to review. */
export async function undoRequest(sessionId: string, turnItemId: string): Promise<void> {
  try {
    const plan = await prism.history.undoRequest(sessionId, turnItemId)
    if (!plan.files.length) return useUi.getState().toast('info', 'Nothing to undo', plan.note ?? undefined)
    useRefactor.getState().show(plan)
  } catch (e) {
    toastError(e, 'Could not work out the undo')
  }
}
