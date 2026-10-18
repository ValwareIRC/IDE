// The things you reach for now and then, kept out of the way. On a phone there is one
// row beside the message box and it belongs to speaking, calling and sending; the rest
// open upwards from here.
import { useEffect, useRef, useState } from 'react'
import { Brain, Image as ImageIcon, Plus, Split, Wand2 } from 'lucide-react'
import { cx } from '@/lib/format'

export function PlusMenu({
  canSharpen,
  canTryWays,
  reasoning,
  onImage,
  onReasoning,
  onSharpen,
  onTryWays
}: {
  canSharpen: boolean
  canTryWays: boolean
  reasoning: boolean
  onImage: () => void
  onReasoning: () => void
  onSharpen: () => void
  onTryWays: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const item = (icon: React.ReactNode, label: string, sub: string, go: () => void, disabled = false, on = false): React.JSX.Element => (
    <button
      className={cx('plus-item', on && 'on')}
      disabled={disabled}
      onClick={() => {
        setOpen(false)
        go()
      }}
    >
      {icon}
      <span className="grow">
        {label}
        <small>{sub}</small>
      </span>
    </button>
  )

  return (
    <span className="plus-wrap" ref={wrap}>
      <button className={cx('icon-btn sm', open && 'on')} title="More" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Plus size={16} />
      </button>
      {open && (
        <div className="plus-menu">
          {item(<ImageIcon size={14} />, 'Attach a picture', 'From this phone', onImage)}
          {item(<Brain size={14} />, reasoning ? 'Reasoning is on' : 'Reasoning is off', reasoning ? 'It thinks before acting' : 'Faster and cheaper', onReasoning, false, reasoning)}
          {item(<Wand2 size={14} />, 'Sharpen', 'Rewrite this so it says exactly what to do', onSharpen, !canSharpen)}
          {item(<Split size={14} />, 'Try it several ways', 'Different models, each in its own copy', onTryWays, !canTryWays)}
        </div>
      )}
    </span>
  )
}
