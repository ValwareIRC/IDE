// The list under the page while marking it up: each numbered thing, a note for the agent, and styles to try
// live before asking for them.
import { useState } from 'react'
import { ChevronDown, ChevronRight, MousePointerClick, Send, Trash2, X } from 'lucide-react'
import { cx } from '@/lib/format'
import { STYLE_KEYS, type Mark } from './markup'

export function MarkUpTray(p: {
  marks: Mark[]
  selecting: boolean
  notes: Record<string, string>
  onNote: (selector: string, note: string) => void
  onStyle: (n: number, prop: string, value: string) => void
  onRemove: (n: number) => void
  onSelecting: (on: boolean) => void
  onSend: () => void
  onClose: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="markup-tray">
      <div className="markup-bar">
        <span className="hud-label">Mark up</span>
        <span className="faint xs">{p.marks.length ? `${p.marks.length} marked` : 'Click things on the page to number them; click again to take one off.'}</span>
        <span className="grow" />
        <button className={cx('btn sm', p.selecting && 'primary')} onClick={() => p.onSelecting(!p.selecting)} title={p.selecting ? 'Stop picking, so the page works normally (Esc)' : 'Pick more things on the page'}>
          <MousePointerClick size={12} /> {p.selecting ? 'Picking' : 'Pick more'}
        </button>
        <button className="btn sm solid" disabled={!p.marks.length} onClick={p.onSend} title="A picture of the page with the numbers, and what you wrote, go into the message box">
          <Send size={12} /> Send to the agent
        </button>
        <button className="icon-btn sm" title="Stop marking up (marks and tried styles are removed from the page)" onClick={p.onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="markup-list">
        {p.marks.map((m) => {
          const tried = Object.keys(m.tried).length
          const isOpen = open === m.selector
          return (
            <div key={m.selector} className="markup-item">
              <div className="markup-row">
                <span className="markup-n">{m.n}</span>
                <span className="markup-what truncate" title={m.selector}>
                  <b>{m.tag}</b> {m.text ? `"${m.text.replace(/\s+/g, ' ').slice(0, 60)}"` : <span className="faint">{m.selector}</span>}
                </span>
                <input className="input sm markup-note" placeholder="What should change here?" value={p.notes[m.selector] ?? ''} onChange={(e) => p.onNote(m.selector, e.target.value)} />
                <button className={cx('btn sm ghost', tried > 0 && 'accent')} onClick={() => setOpen(isOpen ? null : m.selector)} title="Try style changes on the page">
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} styles{tried ? ` (${tried})` : ''}
                </button>
                <button className="icon-btn sm" title="Take this one off" onClick={() => p.onRemove(m.n)}>
                  <Trash2 size={12} />
                </button>
              </div>
              {isOpen && (
                <div className="markup-styles">
                  {STYLE_KEYS.map((k) => (
                    <label key={k} className={cx('markup-style', m.tried[k] && 'changed')}>
                      <span>{k}</span>
                      <input
                        className="input sm mono"
                        defaultValue={m.tried[k] ?? ''}
                        placeholder={m.styles[k] ?? ''}
                        onKeyDown={(e) => e.key === 'Enter' && p.onStyle(m.n, k, e.currentTarget.value.trim())}
                        onBlur={(e) => (e.currentTarget.value.trim() !== (m.tried[k] ?? '') ? p.onStyle(m.n, k, e.currentTarget.value.trim()) : undefined)}
                      />
                    </label>
                  ))}
                  <div className="faint xs markup-hint">Type a value and press Enter to see it on the page. Empty puts it back.</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
