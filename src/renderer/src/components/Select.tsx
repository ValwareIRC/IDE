import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cx } from '@/lib/format'

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  sub?: ReactNode
  group?: string
  disabled?: boolean
}

interface Props<T extends string> {
  value: T | ''
  options: Array<SelectOption<T>>
  onChange: (v: T) => void
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  icon?: ReactNode
  searchable?: boolean
  width?: number
  align?: 'left' | 'right'
}

/** A proper listbox. No native <select> anywhere in Prism. */
export function Select<T extends string>({ value, options, onChange, placeholder, className, size, icon, searchable, width, align }: Props<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; max: number }>({ top: 0, left: 0, width: 0, up: false, max: 400 })
  const current = options.find((o) => o.value === value)

  const filtered = q.trim() ? options.filter((o) => (textOf(o.label) + ' ' + textOf(o.sub) + ' ' + (o.group ?? '')).toLowerCase().includes(q.toLowerCase())) : options

  // the list fits in the window: it opens on the roomier side and scrolls within what is there
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const place = (): void => {
      const r = btnRef.current!.getBoundingClientRect()
      const w = Math.max(width ?? 0, r.width, 180)
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const want = Math.min(window.innerHeight * 0.7, (popRef.current?.scrollHeight ?? 400) + 2)
      const up = below < want && above > below
      const left = align === 'right' ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8)
      setPos({ top: up ? r.top - 4 : r.bottom + 4, left, width: w, up, max: Math.max(120, Math.min(window.innerHeight * 0.7, up ? above : below)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, width, align])

  useEffect(() => {
    if (open) popRef.current?.querySelector('.menu-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [open, sel, q])

  useEffect(() => {
    if (!open) return
    setQ('')
    setSel(Math.max(0, options.findIndex((o) => o.value === value)))
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    const onDown = (e: MouseEvent): void => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, options, value])

  const choose = (o: SelectOption<T>): void => {
    if (o.disabled) return
    onChange(o.value)
    setOpen(false)
    btnRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(filtered.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = filtered[sel]
      if (o) choose(o)
    }
  }

  let lastGroup: string | undefined
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cx('select', size === 'sm' && 'sm', className)}
        style={size === 'sm' ? { height: 24, fontSize: 'var(--fs-sm)' } : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {icon}
        <span className={cx('select-label', !current && 'faint')}>{current ? current.label : (placeholder ?? 'Choose…')}</span>
        <ChevronDown size={13} className="chev" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="popover"
            style={{ top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, left: pos.left, width: pos.width, maxHeight: pos.max }}
            onKeyDown={onKeyDown}
          >
            {searchable && (
              <input
                ref={inputRef}
                className="input sm"
                placeholder="Filter…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setSel(0)
                }}
                style={{ marginBottom: 4, position: 'sticky', top: -5, zIndex: 1, background: 'var(--bg-2)' }}
              />
            )}
            {!searchable && <input ref={inputRef} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} readOnly />}
            {filtered.length === 0 && <div className="menu-item faint">No matches</div>}
            {filtered.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? <div className="menu-head hud-label">{o.group}</div> : null
              lastGroup = o.group
              return (
                <div key={o.value}>
                  {head}
                  <button
                    type="button"
                    className={cx('menu-item', i === sel && 'sel', o.disabled && 'faint')}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => choose(o)}
                  >
                    <span className="grow truncate">
                      {o.label}
                      {o.sub && <div className="sub truncate">{o.sub}</div>}
                    </span>
                    {o.value === value && <Check size={13} className="accent" />}
                  </button>
                </div>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

function textOf(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join(' ')
  if (n && typeof n === 'object' && 'props' in n) return textOf((n as { props: { children?: ReactNode } }).props.children)
  return ''
}
