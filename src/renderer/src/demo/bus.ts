// The seam between a demo and the parts of Prism a person uses by hand.
//
// A demo may only do what you could have done with a mouse and keyboard, and it
// must go through the same code your click goes through: the file tree really
// expands, the Search box really runs its search. So each surface registers one
// driver while it is mounted, and the demo asks that driver to act.
//
// The same seam reports what was done (`report`), so a person's own session can
// be recorded as a demo later without touching these panels again.

export interface TreeSurface {
  /** Open a folder (and load it), as clicking its chevron does. */
  expand(path: string): void
  /** Open a file from the tree: one click looks, `keep` is the double click. */
  open(path: string, keep?: boolean): void
  /** Ring a row, so you can see where the pointer landed. */
  mark(path: string | null): void
}

export interface SearchSurface {
  /** Put text in the search box; the search runs as it does when you type. */
  setQuery(q: string): void
  /** The files found, in the order they are listed. */
  found(): string[]
  /** Open the nth result, as clicking it does. */
  open(index: number): void
  mark(index: number | null): void
}

export interface AgentSurface {
  /** Put words in the message box, as typing them does. */
  setText(text: string): void
  /** What is in the box now. Empty after a message has gone. */
  text(): string
  /** Send what is in the box, as Enter does. */
  send(): void
  /** Whether anything is still being worked on. */
  running(): boolean
}

interface Surfaces {
  tree: TreeSurface
  search: SearchSurface
  agent: AgentSurface
}

const live = new Map<keyof Surfaces, unknown>()

export function registerSurface<K extends keyof Surfaces>(name: K, driver: Surfaces[K]): () => void {
  live.set(name, driver)
  return () => {
    if (live.get(name) === driver) live.delete(name)
  }
}

export function surface<K extends keyof Surfaces>(name: K): Surfaces[K] | null {
  return (live.get(name) as Surfaces[K] | undefined) ?? null
}

/** A surface waits to be mounted: the demo opened the sidebar a moment ago. */
export async function awaitSurface<K extends keyof Surfaces>(name: K, ms = 3000): Promise<Surfaces[K] | null> {
  const until = Date.now() + ms
  for (;;) {
    const s = surface(name)
    if (s) return s
    if (Date.now() > until) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Something a person did on a surface. Recording a demo listens to these. */
export interface DoneAction {
  surface: keyof Surfaces | 'editor' | 'terminal' | 'rail' | 'gadget'
  what: string
  detail?: string
  /** A saved file as it was, and as it is now: the recorder works out what was typed from these. */
  before?: string
  after?: string
}

const watchers = new Set<(a: DoneAction) => void>()

export function report(a: DoneAction): void {
  for (const cb of watchers) cb(a)
}

export function onAction(cb: (a: DoneAction) => void): () => void {
  watchers.add(cb)
  return () => watchers.delete(cb)
}
