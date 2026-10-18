import { allCommands } from './menus'
import { isRebindable, keyFor } from './keybindings'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { allThemes } from '@/theme/apply'

/** One list of everything Prism can do: the palette, the shortcut handler and the shortcut editor all read it. */
export interface Command {
  id: string
  label: string
  /** Current shortcut (user's or default); for editor built-ins, the menu's own hint. */
  key?: string
  run: () => void
}

const RECENT_KEY = 'prism.recentCommands'

export function listCommands(includeDisabled = false): Command[] {
  const layout = useLayout.getState()
  const app = useApp.getState()
  const out: Command[] = []
  const seen = new Set<string>()
  for (const m of allCommands(includeDisabled)) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push({ id: m.id, label: m.label, key: isRebindable(m.id) ? keyFor(m.id) : m.hint, run: m.run })
  }
  const extra: Array<[string, string, () => void]> = [
    ['spec.open', 'Spec: open the project spec', () => layout.openSpec()],
    ['tours.open', 'Tours: guided walks through the code', () => layout.openTours()],
    ['lessons.open', 'Lessons: show them all', () => void import('@/demo/recorder').then((m) => m.useRecorder.setState({ listOpen: true }))],
    ['lessons.record', 'Lessons: record a new one by doing it', () => void import('@/demo/recorder').then((m) => m.startRecording())],
    ['demo.play', 'Demo: play the prototype lesson', () => void import('@/demo/firstDemo').then(async (m) => (await import('@/demo/player')).playDemo(m.firstDemo))],
    ['catchup.open', 'Catch up: what happened in the last hour', () => void import('@/panels/catchup/CatchUp').then(async (m) => { const { prism } = await import('@/lib/ipc'); m.useCatchUp.setState({ report: await prism.catchup.since(Date.now() - 3_600_000), offered: false }); layout.openCatchUp() })],
    ['settings.models', 'Settings: Providers', () => layout.openSettings('models')],
    ['settings.claude', 'Settings: Claude Agent', () => layout.openSettings('claude')],
    ['settings.roles', 'Settings: Model roles', () => layout.openSettings('roles')],
    ['settings.agent', 'Settings: Agent', () => layout.openSettings('agent')],
    ['settings.permissions', 'Settings: Permissions', () => layout.openSettings('permissions')],
    ['settings.editor', 'Settings: Editor & terminal', () => layout.openSettings('editor')],
    ['settings.appearance', 'Settings: Appearance', () => layout.openSettings('appearance')],
    ['settings.keyboard', 'Settings: Keyboard shortcuts', () => layout.openSettings('keyboard')],
    ['settings.mcp', 'Settings: MCP servers', () => layout.openSettings('mcp')]
  ]
  for (const [id, label, run] of extra) out.push({ id, label, key: keyFor(id), run })
  for (const t of allThemes(app.settings)) {
    out.push({ id: `theme:${t.id}`, label: `Theme: ${t.name}`, run: () => void app.updateSettings({ appearance: { theme: t.id, bg: t.colors.bg0 } }) })
  }
  for (const r of app.settings?.recipes ?? []) {
    out.push({ id: `recipe:${r.id}`, label: `Recipe: ${r.name}`, run: () => applyRecipe(r.text) })
  }
  for (const w of app.settings?.recentWorkspaces ?? []) {
    if (w === app.workspace) continue
    out.push({ id: `recent:${w}`, label: `Open recent: ${w.split(/[\\/]/).pop()}`, run: () => void app.setWorkspace(w) })
  }
  return out
}

export function findCommand(id: string): Command | undefined {
  return listCommands().find((c) => c.id === id)
}

export function recentCommandIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function runCommand(c: Command): void {
  if (!c.id.startsWith('recent:')) {
    localStorage.setItem(RECENT_KEY, JSON.stringify([c.id, ...recentCommandIds().filter((x) => x !== c.id)].slice(0, 8)))
  }
  c.run()
}

/**
 * Subsequence match with a score: consecutive letters and word starts count
 * for more, so "gts" finds "Go To Symbol" before "Agent: stop".
 */
export function fuzzy(query: string, text: string): { score: number; marks: number[] } | null {
  if (!query) return { score: 0, marks: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const exact = t.indexOf(q)
  if (exact >= 0) {
    const atWord = exact === 0 || /[\s/\\._:\-›]/.test(t[exact - 1] ?? '')
    return { score: 1000 - exact + (atWord ? 200 : 0) - t.length * 0.1, marks: Array.from({ length: q.length }, (_, i) => exact + i) }
  }
  const marks: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    const wordStart = at === 0 || /[\s/\\._:\-›]/.test(t[at - 1] ?? '') || (text[at] !== t[at] && text[at - 1] === t[at - 1])
    score += 10 + (at === prev + 1 ? 18 : 0) + (wordStart ? 25 : 0) - Math.min(8, at - ti)
    marks.push(at)
    prev = at
    ti = at + 1
  }
  return { score: score - t.length * 0.1, marks }
}

/** Put a saved request into the agent's message box, with its first {{blank}} selected to type over (Tab moves to the next). */
export function applyRecipe(text: string): void {
  void import('@/state/sessions').then(async ({ useSessions }) => {
    useLayout.getState().openAgent()
    const st = useSessions.getState()
    const id = st.active ?? (await st.create())?.id
    if (!id) return
    st.setDraft(id, text)
    setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
      if (!ta) return
      ta.focus()
      const m = /\{\{[^}]*\}\}/.exec(ta.value)
      if (m) ta.setSelectionRange(m.index, m.index + m[0].length)
    }, 120)
  })
}

/** Hand a request in plain words to the agent (it can change Prism's own settings and open panels too). */
export function askPrism(text: string): void {
  void import('@/state/sessions').then(async ({ useSessions }) => {
    useLayout.getState().openAgent()
    const st = useSessions.getState()
    const id = st.active ?? (await st.create())?.id
    if (id) await st.send(text, undefined, id)
  })
}
