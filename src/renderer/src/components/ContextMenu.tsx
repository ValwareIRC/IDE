import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type MenuEntry = { sep: true } | { sep?: false; label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }

export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos.y, left: pos.x, minWidth: 180 }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((e, i) =>
        e.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${e.danger ? 'danger' : ''}`}
            disabled={e.disabled}
            onClick={() => {
              onClose()
              e.onClick()
            }}
          >
            {e.icon}
            <span className="grow">{e.label}</span>
            {e.hint && <span className="hint">{e.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
