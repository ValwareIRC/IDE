import { create } from 'zustand'
import { symbolsFor, type SymbolEntry } from '@/lib/symbols'
import { onEditorView } from '@/lib/editorBus'

interface OutlineState {
  /** Functions, classes, headings per open file. */
  symbols: Record<string, SymbolEntry[]>
  /** Cursor line per open file. */
  cursor: Record<string, number>
  refresh(path: string): void
  forget(path: string): void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Shared by the breadcrumb bar and the Outline side view, so both show the same thing. */
export const useOutline = create<OutlineState>((set) => ({
  symbols: {},
  cursor: {},
  refresh(path) {
    const t = timers.get(path)
    if (t) clearTimeout(t)
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path)
        void symbolsFor(path).then((list) => set((s) => ({ symbols: { ...s.symbols, [path]: list } })))
      }, 350)
    )
  },
  forget(path) {
    set((s) => {
      const symbols = { ...s.symbols }
      const cursor = { ...s.cursor }
      delete symbols[path]
      delete cursor[path]
      return { symbols, cursor }
    })
  }
}))

onEditorView((v) => {
  if (useOutline.getState().cursor[v.path] !== v.cursorLine) useOutline.setState((s) => ({ cursor: { ...s.cursor, [v.path]: v.cursorLine } }))
})

/** The chain of symbols that contain a line, outermost first. */
export function symbolsAt(list: SymbolEntry[], line: number): SymbolEntry[] {
  const chain: SymbolEntry[] = []
  for (const s of list) {
    if (s.line > line) break
    while (chain.length && chain[chain.length - 1]!.depth >= s.depth) chain.pop()
    chain.push(s)
  }
  return chain
}
