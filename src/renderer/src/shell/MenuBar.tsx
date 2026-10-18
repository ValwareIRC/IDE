import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight } from 'lucide-react'
import { MENUS, type MenuItem } from '@/lib/menus'
import { cx } from '@/lib/format'
import { isRebindable, keyFor } from '@/lib/keybindings'

/** The shortcut to show: the user's current one where Prism owns it, else the editor's built-in. */
function hintOf(id: string, fixed: string | undefined): string | undefined {
  return isRebindable(id) ? keyFor(id) : fixed
}

/** Custom HUD menu bar: no native menus, so it matches the rest of the window. */
export function MenuBar(): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const openMenu = (id: string, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setRect({ left: r.left, top: r.bottom + 2 })
    setOpen(id)
  }

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menu-dropdown')) setOpen(null)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', () => setOpen(null))
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  const group = MENUS.find((g) => g.id === open)

  return (
    <div className="menubar no-drag" ref={barRef}>
      {MENUS.map((g) => (
        <button
          key={g.id}
          className={cx('menubar-item', open === g.id && 'on')}
          onMouseDown={(e) => {
            e.preventDefault()
            if (open === g.id) setOpen(null)
            else openMenu(g.id, e.currentTarget)
          }}
          onMouseEnter={(e) => {
            if (open && open !== g.id) openMenu(g.id, e.currentTarget)
          }}
        >
          {g.label}
        </button>
      ))}
      {open && group && rect && <Dropdown items={group.items()} left={rect.left} top={rect.top} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Dropdown({ items, left, top, onClose, nested }: { items: MenuItem[]; left: number; top: number; onClose: () => void; nested?: boolean }): React.JSX.Element {
  const [sub, setSub] = useState<{ id: string; left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left, top })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(left, window.innerWidth - r.width - 8), top: Math.min(top, window.innerHeight - r.height - 8) })
  }, [left, top])

  return createPortal(
    <div ref={ref} className={cx('popover menu-dropdown', nested && 'nested')} style={{ left: pos.left, top: pos.top, minWidth: 220 }}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={it.id}
            className={cx('menu-item', it.danger && 'danger', sub?.id === it.id && 'sel')}
            disabled={it.disabled}
            onMouseEnter={(e) => {
              if (it.submenu) {
                const r = e.currentTarget.getBoundingClientRect()
                setSub({ id: it.id, left: r.right + 2, top: r.top - 5 })
              } else setSub(null)
            }}
            onClick={() => {
              if (it.submenu) return
              onClose()
              it.run?.()
            }}
          >
            <span className="menu-check">{it.checked ? <Check size={12} /> : null}</span>
            <span className="grow">{it.label}</span>
            {hintOf(it.id, it.hint) && <span className="hint">{hintOf(it.id, it.hint)}</span>}
            {it.submenu && <ChevronRight size={12} className="faint" />}
          </button>
        )
      )}
      {sub &&
        (() => {
          const it = items.find((x) => !x.sep && x.id === sub.id)
          return it && !it.sep && it.submenu ? <Dropdown items={it.submenu} left={sub.left} top={sub.top} onClose={onClose} nested /> : null
        })()}
    </div>,
    document.body
  )
}
