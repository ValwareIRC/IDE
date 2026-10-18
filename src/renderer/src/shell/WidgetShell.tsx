// The page as a widget sees it. A home screen widget cannot run a web page, so the
// Android side opens this in a WebView nobody looks at, lets the gadget draw itself,
// and takes a picture of the result (android/.../WidgetShot.java). What is shown here
// is the gadget and nothing else: no tabs, no bars, no room wasted.
//
// Everything is reported back through PrismWidgetHost, the one way in and out of that
// hidden WebView.
import { useEffect, useState } from 'react'
import { prism } from '@/lib/ipc'
import { GadgetPanel } from '@/panels/gadget/GadgetPanel'
import { useGadgets } from '@/state/gadgets'

interface Host {
  ready(title: string, actions: string): void
  failed(why: string): void
  gadgets(json: string): void
}

function host(): Partial<Host> {
  return (window as unknown as { PrismWidgetHost?: Partial<Host> }).PrismWidgetHost ?? {}
}

/** What this window was opened for: one gadget's picture, or the list of gadgets. */
export function widgetWanted(): string | null {
  const want = new URLSearchParams(window.location.search).get('widget')
  return want && want.trim() ? want.trim() : null
}

/** How long the gadget is given to fetch and draw before the picture is taken anyway. */
const SETTLE_MS = 1800

export function WidgetShell({ want }: { want: string }): React.JSX.Element {
  const list = useGadgets((s) => s.list)
  const [problem, setProblem] = useState('')

  // the list, for the screen that asks which gadget a new widget should show
  useEffect(() => {
    if (want !== 'list') return
    void prism.gadgets
      .list()
      .then((gadgets) => host().gadgets?.(JSON.stringify(gadgets.map((g) => ({ id: g.id, name: g.name })))))
      .catch((e: unknown) => host().failed?.(e instanceof Error ? e.message : String(e)))
  }, [want])

  // one gadget: let it settle, run the button that was pressed, then say it is ready
  useEffect(() => {
    if (want === 'list') return
    const params = new URLSearchParams(window.location.search)
    const call = params.get('do') ?? ''
    let gone = false
    const timer = setTimeout(async () => {
      if (gone) return
      try {
        if (call) {
          await prism.gadgets.call(want, call, {})
          // the gadget's own view of itself changes after that: give it a moment
          await new Promise((r) => setTimeout(r, 900))
        }
        const info = (await prism.gadgets.list()).find((g) => g.id === want)
        if (!info) {
          host().failed?.(`There is no gadget called ${want}`)
          return
        }
        const actions = info.widget?.actions ?? []
        host().ready?.(info.widget?.title ?? info.name, JSON.stringify(actions.map((a) => ({ label: a.label, call: a.call }))))
      } catch (e) {
        host().failed?.(e instanceof Error ? e.message : String(e))
      }
    }, SETTLE_MS)
    return () => {
      gone = true
      clearTimeout(timer)
    }
  }, [want])

  // nothing to draw is worth saying, rather than photographing an empty square
  useEffect(() => {
    if (want === 'list' || !list.length) return
    if (!list.some((g) => g.id === want)) setProblem(`There is no gadget called ${want}`)
  }, [want, list])

  if (want === 'list') return <div className="widget-wait">…</div>
  if (problem) return <div className="widget-wait">{problem}</div>

  return (
    <div className="widget-only">
      <GadgetPanel id={want} />
    </div>
  )
}
