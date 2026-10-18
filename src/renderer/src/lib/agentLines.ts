// In the editor's margin, a thin bar beside the lines the agent wrote, one colour per conversation. Hovering
// says which request wrote it and why (lib/monaco.ts); clicking the bar opens that conversation at that request.
import type { AgentLineRun } from '@shared/types'
import { prism } from './ipc'
import type { monaco as Monaco } from './monaco'
import { useApp } from '@/state/app'

const SLOTS = 6
const slots = new Map<string, number>()
const slotOf = (sessionId: string): number => {
  if (!slots.has(sessionId)) slots.set(sessionId, slots.size % SLOTS)
  return slots.get(sessionId)!
}

export function attachAgentLines(m: typeof Monaco, ed: Monaco.editor.IStandaloneCodeEditor, path: string): () => void {
  const decos = ed.createDecorationsCollection()
  let runs: AgentLineRun[] = []
  let timer = 0
  let alive = true
  const on = (): boolean => useApp.getState().settings?.editor.agentLines !== false

  const refresh = async (): Promise<void> => {
    const model = ed.getModel()
    if (!alive || !model) return
    if (!on()) {
      runs = []
      decos.clear()
      return
    }
    runs = await prism.history.lines(path, model.getValue()).catch(() => [])
    if (!alive) return
    decos.set(
      runs.map((r) => ({
        range: new m.Range(r.from, 1, r.to, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `agent-line s${slotOf(r.sessionId)}`,
          overviewRuler: { color: 'rgba(185,167,255,0.5)', position: m.editor.OverviewRulerLane.Left }
        }
      }))
    )
  }
  const later = (ms: number): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void refresh(), ms)
  }

  later(200)
  const typed = ed.onDidChangeModelContent(() => later(1500))
  const changed = prism.fs.onChanged((changes) => {
    if (changes.some((c) => c.path === path)) later(400)
  })
  const unsub = useApp.subscribe((s, prev) => {
    if (s.settings?.editor.agentLines !== prev.settings?.editor.agentLines) later(0)
  })
  // a click on the bar opens the conversation at the request that wrote those lines
  const click = ed.onMouseDown((e) => {
    if (e.target.type !== m.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return
    const line = e.target.position?.lineNumber ?? 0
    const run = runs.find((r) => line >= r.from && line <= r.to)
    if (!run) return
    void Promise.all([import('@/state/layout'), import('@/state/sessions'), import('@/state/find')]).then(async ([l, s, f]) => {
      l.useLayout.getState().openAgent()
      await s.useSessions.getState().select(run.sessionId)
      if (run.turnItemId) f.useFind.getState().open(run.sessionId, run.turnItemId, '')
    })
  })
  return () => {
    alive = false
    window.clearTimeout(timer)
    typed.dispose()
    click.dispose()
    changed()
    unsub()
    decos.clear()
  }
}
