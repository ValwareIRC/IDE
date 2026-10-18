import { prism } from './ipc'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useUi } from '@/state/ui'
import { useGadgets } from '@/state/gadgets'
import { opensInPreview } from './languages'

/** Host-side requests coming from gadget backends and UIs. Imported once from App. */
export function installGadgetBridge(): () => void {
  const off = prism.gadgets.onUi((m) => {
    switch (m.kind) {
      case 'toast':
        useUi.getState().toast('info', m.title, m.detail)
        break
      case 'openFile':
        if (opensInPreview(m.path)) useLayout.getState().openPreview(m.path)
        else useLayout.getState().openEditor(m.path)
        break
      case 'openPreview':
        useLayout.getState().openPreview(m.path)
        break
      case 'openGadget':
        useLayout.getState().openGadget(m.id, m.title ?? useGadgets.getState().list.find((g) => g.id === m.id)?.name)
        break
      case 'openPanel': {
        // the agent opening part of Prism for the user (prism_open)
        const l = useLayout.getState()
        const panel = String(m.panel ?? '')
        const open: Record<string, () => void> = {
          settings: () => l.openSettings(m.section ? String(m.section) : undefined),
          terminal: () => l.openTerminal(),
          dashboard: () => l.openDashboard(),
          browser: () => l.openBrowser(),
          scratch: () => l.openScratch(),
          problems: () => l.openProblems(),
          history: () => l.openHistory(),
          usage: () => l.openUsage(),
          spec: () => l.openSpec(),
          tours: () => l.openTours(),
          catchup: () => l.openCatchUp(),
          automations: () => l.openAutomations(),
          context: () => l.openContext(),
          welcome: () => l.openWelcome(),
          mission: () => l.openMission(),
          work: () => l.openWork(),
          searchChats: () => l.openSearchChats(),
          prs: () => l.openPrs(),
          tasks: () => l.openTasks()
        }
        open[panel]?.()
        break
      }
      case 'focusSession':
        useLayout.getState().openAgent()
        void useSessions.getState().select(m.id)
        break
    }
  })
  // main asks where a gadget is on screen before taking a picture of it for the agent
  ;(window as unknown as { __prismGadgetRect?: (id: string) => unknown }).__prismGadgetRect = (id) => {
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-gadget="${CSS.escape(id)}"]`)
    if (!frame) return null
    const r = frame.getBoundingClientRect()
    if (r.width < 20 || r.height < 20 || frame.offsetParent === null) return null
    // a tab behind another is hidden, not removed: it counts only when it is really on screen and nothing covers it
    if (!frame.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null
    if (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== frame) return null
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  // A demo presses something inside a gadget. The panel is sandboxed, so nothing out
  // here can reach into it: it is asked, in its own words, where the thing is and then
  // to press it. Asked without `press` it only points, which is how the pointer knows
  // where to glide before it clicks.
  ;(window as unknown as { __prismGadgetPress?: (id: string, find: string, nth: number, press: boolean) => Promise<unknown> }).__prismGadgetPress = async (id, find, nth, press) => {
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-gadget="${CSS.escape(id)}"]`)
    const target = frame?.contentWindow
    if (!frame || !target) return null
    const inside = await new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
      const reqId = `p${Date.now()}${Math.random()}`
      const done = (v: { x: number; y: number; width: number; height: number } | null): void => {
        window.removeEventListener('message', onMsg)
        clearTimeout(timer)
        resolve(v)
      }
      const onMsg = (e: MessageEvent): void => {
        const m = e.data as { __prism?: boolean; type?: string; id?: string; found?: { x: number; y: number; width: number; height: number } | null } | null
        if (e.source === target && m?.__prism && m.type === 'press-result' && m.id === reqId) done(m.found ?? null)
      }
      const timer = setTimeout(() => done(null), 1500)
      window.addEventListener('message', onMsg)
      target.postMessage({ __prism: true, type: 'press', id: reqId, find, nth, press }, '*')
    })
    if (!inside) return null
    // the panel's own coordinates, moved into the window's
    const off = frame.getBoundingClientRect()
    return { x: off.left + inside.x, y: off.top + inside.y, width: inside.width, height: inside.height }
  }
  // main asks the gadget to measure its own layout, now and squeezed narrow, so a model that cannot see pictures still learns what overflows
  ;(window as unknown as { __prismGadgetInspect?: (id: string) => Promise<unknown> }).__prismGadgetInspect = async (id) => {
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-gadget="${CSS.escape(id)}"]`)
    const target = frame?.contentWindow
    if (!frame || !target) return null
    const ask = (): Promise<unknown> =>
      new Promise((resolve) => {
        const reqId = `i${Date.now()}${Math.random()}`
        const done = (v: unknown): void => {
          window.removeEventListener('message', onMsg)
          clearTimeout(timer)
          resolve(v)
        }
        const onMsg = (e: MessageEvent): void => {
          const m = e.data as { __prism?: boolean; type?: string; id?: string; report?: unknown } | null
          if (e.source === target && m?.__prism && m.type === 'inspect-result' && m.id === reqId) done(m.report)
        }
        const timer = setTimeout(() => done(null), 1500)
        window.addEventListener('message', onMsg)
        target.postMessage({ __prism: true, type: 'inspect', id: reqId }, '*')
      })
    const current = await ask()
    if (!current) return null
    let narrow: unknown = null
    if (frame.getBoundingClientRect().width > 400) {
      const prev = frame.style.width
      frame.style.width = '340px'
      await new Promise((r) => setTimeout(r, 450))
      narrow = await ask()
      frame.style.width = prev
    }
    return { current, narrow }
  }
  void useGadgets.getState().refresh()
  return off
}
