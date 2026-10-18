// Finding things in conversations: the request to open one conversation at one match (from the search across
// conversations), and the highlighting of matches on screen.
import { create } from 'zustand'
import type { ConvQuery } from '@shared/convSearch'

export interface FindRequest {
  sessionId: string
  itemId: string
  text: string
  nonce: number
}

export const useFind = create<{
  request: FindRequest | null
  /** Filters to start the search panel with (from "Conversations that changed this file"). */
  preset: (Partial<ConvQuery> & { nonce: number }) | null
  open(sessionId: string, itemId: string, text: string): void
  done(): void
  presetSearch(q: Partial<ConvQuery>): void
}>((set) => ({
  request: null,
  preset: null,
  open: (sessionId, itemId, text) => set({ request: { sessionId, itemId, text, nonce: Date.now() } }),
  done: () => set({ request: null }),
  presetSearch: (q) => set({ preset: { ...q, nonce: Date.now() } })
}))

interface HighlightRegistry {
  set(name: string, h: unknown): void
  delete(name: string): void
}
const registry = (): HighlightRegistry | null => (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight

/** Mark every place the terms appear inside `root` (and the ones inside `current` more strongly), without touching the page. */
export function highlightTerms(root: HTMLElement | null, terms: string[], current: Element | null): void {
  const reg = registry()
  if (!reg || !HighlightCtor) return
  reg.delete('prism-find')
  reg.delete('prism-find-now')
  if (!root || !terms.length) return
  const all: Range[] = []
  const now: Range[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest('.find-bar, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT))
  })
  for (let n = walk.nextNode(); n && all.length < 3000; n = walk.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase()
    if (!text.trim()) continue
    for (const t of terms) {
      for (let at = text.indexOf(t); at >= 0; at = text.indexOf(t, at + t.length)) {
        const r = document.createRange()
        r.setStart(n, at)
        r.setEnd(n, at + t.length)
        all.push(r)
        if (current && current.contains(n)) now.push(r)
      }
    }
  }
  reg.set('prism-find', new HighlightCtor(...all))
  if (now.length) reg.set('prism-find-now', new HighlightCtor(...now))
}

export function clearHighlights(): void {
  const reg = registry()
  reg?.delete('prism-find')
  reg?.delete('prism-find-now')
}
