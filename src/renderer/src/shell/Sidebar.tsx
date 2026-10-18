import { useCallback, useEffect, useRef, useState } from 'react'
import { useUi } from '@/state/ui'
import { ExplorerView } from '@/panels/side/ExplorerView'
import { SearchView } from '@/panels/side/SearchView'
import { GitView } from '@/panels/side/GitView'
import { SessionsView } from '@/panels/side/SessionsView'
import { GadgetsView } from '@/panels/side/GadgetsView'
import { OutlineView } from '@/panels/side/OutlineView'

const MIN = 200
const MAX = 560
const KEY = 'prism.sidebar.width'

export function Sidebar(): React.JSX.Element | null {
  const side = useUi((s) => s.side)
  const [width, setWidth] = useState(() => Number(localStorage.getItem(KEY)) || 268)
  const dragging = useRef(false)

  const onDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = width
    document.body.style.cursor = 'col-resize'
    const move = (ev: PointerEvent): void => {
      const w = Math.max(MIN, Math.min(MAX, startW + ev.clientX - startX))
      setWidth(w)
    }
    const up = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [width])

  useEffect(() => {
    localStorage.setItem(KEY, String(width))
  }, [width])

  if (!side) return null
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-inner">
        {side === 'explorer' && <ExplorerView />}
        {side === 'search' && <SearchView />}
        {side === 'outline' && <OutlineView />}
        {side === 'git' && <GitView />}
        {side === 'sessions' && <SessionsView />}
        {side === 'gadgets' && <GadgetsView />}
      </div>
      <div className="sidebar-sash" onPointerDown={onDown} />
    </aside>
  )
}
