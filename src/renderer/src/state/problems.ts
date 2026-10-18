import { create } from 'zustand'
import type { CheckResult, CheckerInfo, Problem } from '@shared/types'
import { prism } from '@/lib/ipc'
import { monaco } from '@/lib/monaco'
import { toastError } from './ui'

type Stored = Omit<CheckResult, 'output'> & { output?: string }

interface ProblemsState {
  /** What the editor itself underlines in open files. */
  editor: Problem[]
  checkers: CheckerInfo[]
  results: Record<string, Stored>
  running: Record<string, boolean>
  /** Files changed since a checker last ran: its list may be out of date. */
  stale: Record<string, boolean>
  /** Re-run type and lint checkers shortly after files change. */
  auto: boolean
  setAuto(on: boolean): void
  refreshCheckers(): Promise<void>
  run(id: string): Promise<void>
  runAll(withTests?: boolean): Promise<void>
  /** Results the agent got from check_project show up here too. */
  ingest(results: Stored[]): void
  reset(): void
}

const AUTO_KEY = 'prism.problems.auto'

export const useProblems = create<ProblemsState>((set, get) => ({
  editor: [],
  checkers: [],
  results: {},
  running: {},
  stale: {},
  auto: localStorage.getItem(AUTO_KEY) === '1',
  setAuto(on) {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0')
    set({ auto: on })
  },
  async refreshCheckers() {
    try {
      set({ checkers: await prism.checks.list() })
    } catch {
      set({ checkers: [] })
    }
  },
  async run(id) {
    if (get().running[id]) return
    set((s) => ({ running: { ...s.running, [id]: true } }))
    try {
      const r = await prism.checks.run(id)
      set((s) => ({ results: { ...s.results, [id]: r }, stale: { ...s.stale, [id]: false } }))
    } catch (e) {
      toastError(e, 'Could not run the check')
    } finally {
      set((s) => ({ running: { ...s.running, [id]: false } }))
    }
  },
  async runAll(withTests = false) {
    const list = get().checkers.filter((c) => withTests || c.kind !== 'test')
    await Promise.all(list.map((c) => get().run(c.id)))
  },
  ingest(results) {
    set((s) => {
      const next = { ...s.results }
      const stale = { ...s.stale }
      for (const r of results) {
        next[r.checker.id] = r
        stale[r.checker.id] = false
      }
      return { results: next, stale }
    })
  },
  reset() {
    set({ results: {}, running: {}, stale: {}, checkers: [] })
  }
}))

/** Everything known to be wrong, editor findings first, without repeats. */
export function allProblems(s: Pick<ProblemsState, 'editor' | 'results'>): Problem[] {
  const out: Problem[] = []
  const seen = new Set<string>()
  const push = (p: Problem): void => {
    const key = `${p.file}:${p.line}:${p.message.slice(0, 80)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  for (const r of Object.values(s.results)) r.problems.forEach(push)
  s.editor.forEach(push)
  return out
}

// editor markers → problems
let markerTimer: ReturnType<typeof setTimeout> | null = null
function readMarkers(): void {
  const list: Problem[] = []
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.severity < monaco.MarkerSeverity.Warning || m.resource.scheme !== 'file') continue
    list.push({
      file: m.resource.path.replace(/^\//, ''),
      line: m.startLineNumber,
      column: m.startColumn,
      severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
      message: m.message,
      source: m.source ? `Editor · ${m.source}` : 'Editor',
      ...(m.code ? { code: typeof m.code === 'string' ? m.code : m.code.value } : {})
    })
  }
  useProblems.setState({ editor: list })
}
monaco.editor.onDidChangeMarkers(() => {
  if (markerTimer) clearTimeout(markerTimer)
  markerTimer = setTimeout(readMarkers, 250)
})

// file changes make checker results stale, and re-run them when asked to
let autoTimer: ReturnType<typeof setTimeout> | null = null
prism.fs.onChanged((changes) => {
  if (!changes.some((c) => !/(^|\/)(\.git|node_modules|dist|out|target|\.prism)\//.test(c.path))) return
  const s = useProblems.getState()
  const ids = Object.keys(s.results)
  if (!ids.length) return
  useProblems.setState({ stale: Object.fromEntries(ids.map((id) => [id, true])) })
  if (!s.auto) return
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = setTimeout(() => {
    const st = useProblems.getState()
    for (const c of st.checkers) if (c.kind !== 'test' && st.results[c.id]) void st.run(c.id)
  }, 1800)
})
