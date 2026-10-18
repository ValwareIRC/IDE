import { create } from 'zustand'
import type { RefactorPlan } from '@shared/types'
import { prism } from '@/lib/ipc'
import { toastError } from './ui'
import { report } from '@/demo/bus'
import { useApp } from './app'

export interface OpenDoc {
  path: string
  content: string
  savedContent: string
  mtime: number
  language: string
  binary: boolean
  truncated: boolean
  /** Position to reveal when the editor mounts or is re-shown. */
  reveal?: { line: number; column?: number; quiet?: boolean } | null
  viewState?: unknown
}

interface EditorState {
  docs: Record<string, OpenDoc>
  active: string | null
  /** Files the agent touched during the current turn (for the explorer glow). */
  touched: Record<string, 'read' | 'write' | 'edit' | 'delete'>
  /** When the agent last touched each file, for the explorer's trailing glow. */
  touchedAt: Record<string, number>
  open(path: string, reveal?: OpenDoc['reveal']): Promise<OpenDoc | null>
  reload(path: string): Promise<void>
  setContent(path: string, content: string): void
  /** quiet: saved on the way to something else (a refactor), not by the user, so nothing is suggested. */
  save(path: string, quiet?: boolean): Promise<void>
  /** The same change, found elsewhere after a save; shown in the status bar. */
  suggestion: { path: string; plan: RefactorPlan } | null
  /** Pair mode: what the quick model noticed in a change the user saved. */
  pairNote: { path: string; text: string } | null
  dismissPairNote(): void
  takeSuggestion(): RefactorPlan | null
  saveAll(): Promise<void>
  close(path: string): void
  setActive(path: string | null): void
  rename(from: string, to: string): void
  touch(path: string, op: 'read' | 'write' | 'edit' | 'delete'): void
  clearTouched(): void
  setViewState(path: string, vs: unknown): void
}

export const useEditor = create<EditorState>((set, get) => ({
  docs: {},
  active: null,
  touched: {},
  touchedAt: {},

  async open(path, reveal) {
    const existing = get().docs[path]
    if (existing) {
      set((s) => ({ active: reveal?.quiet ? s.active : path, docs: { ...s.docs, [path]: { ...existing, reveal: reveal ?? null } } }))
      return existing
    }
    try {
      const f = await prism.fs.read(path)
      const { languageFor } = await import('@/lib/languages')
      const doc: OpenDoc = {
        path,
        content: f.content,
        savedContent: f.content,
        mtime: f.mtime,
        language: languageFor(path),
        binary: f.binary,
        truncated: f.truncated,
        reveal: reveal ?? null
      }
      set((s) => ({ docs: { ...s.docs, [path]: doc }, active: reveal?.quiet ? s.active : path }))
      return doc
    } catch (e) {
      toastError(e, `Could not open ${path}`)
      return null
    }
  },

  async reload(path) {
    const doc = get().docs[path]
    if (!doc) return
    try {
      const f = await prism.fs.read(path)
      if (f.mtime === doc.mtime && f.content === doc.savedContent) return
      const dirty = doc.content !== doc.savedContent
      set((s) => ({
        docs: {
          ...s.docs,
          [path]: { ...doc, savedContent: f.content, mtime: f.mtime, content: dirty ? doc.content : f.content, truncated: f.truncated }
        }
      }))
    } catch {
      /* file vanished: keep the buffer */
    }
  },

  setContent(path, content) {
    const doc = get().docs[path]
    if (!doc || doc.content === content) return
    set((s) => ({ docs: { ...s.docs, [path]: { ...doc, content } } }))
  },

  async save(path, quiet) {
    const doc = get().docs[path]
    if (!doc || doc.binary) return
    try {
      const before = doc.savedContent
      await prism.fs.write(path, doc.content)
      set((s) => ({ docs: { ...s.docs, [path]: { ...s.docs[path]!, savedContent: doc.content, mtime: Date.now() } } }))
      report({ surface: 'editor', what: 'saved', detail: path, before, after: doc.content })
      if (!quiet && before !== doc.content && useApp.getState().settings?.editor.nextEdit !== false) {
        const after = doc.content
        void prism.nextEdit
          .suggest(path, before, after)
          .then((plan) => {
            // only if nothing was saved since: an older suggestion would be about an older change
            if (!plan || get().docs[path]?.savedContent !== after) return
            set({ suggestion: { path, plan } })
          })
          .catch(() => {})
      }
      // pair mode: a quick look at what was just saved, speaking up only about a likely bug
      if (!quiet && before !== doc.content && useApp.getState().settings?.assist?.pair) {
        const after = doc.content
        void prism.agent
          .pairGlance(path, before, after)
          .then((text) => {
            if (text && get().docs[path]?.savedContent === after) set({ pairNote: { path, text } })
          })
          .catch(() => {})
      }
    } catch (e) {
      toastError(e, `Could not save ${path}`)
    }
  },

  async saveAll() {
    for (const d of Object.values(get().docs)) if (d.content !== d.savedContent) await get().save(d.path, true)
  },

  suggestion: null,
  pairNote: null,
  dismissPairNote() {
    set({ pairNote: null })
  },
  takeSuggestion() {
    const s = get().suggestion
    set({ suggestion: null })
    return s?.plan ?? null
  },

  close(path) {
    set((s) => {
      const docs = { ...s.docs }
      delete docs[path]
      return { docs, active: s.active === path ? null : s.active }
    })
  },

  setActive: (path) => set({ active: path }),

  rename(from, to) {
    set((s) => {
      const doc = s.docs[from]
      if (!doc) return s
      const docs = { ...s.docs }
      delete docs[from]
      docs[to] = { ...doc, path: to }
      return { docs, active: s.active === from ? to : s.active }
    })
  },

  touch: (path, op) => set((s) => ({ touched: { ...s.touched, [path]: op }, touchedAt: { ...s.touchedAt, [path]: Date.now() } })),
  clearTouched: () => set({ touched: {} }),
  setViewState: (path, vs) =>
    set((s) => (s.docs[path] ? { docs: { ...s.docs, [path]: { ...s.docs[path]!, viewState: vs } } } : s))
}))

export function isDirty(doc: OpenDoc | undefined): boolean {
  return !!doc && doc.content !== doc.savedContent
}
