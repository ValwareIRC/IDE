import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Search, X } from 'lucide-react'
import { useApp } from '@/state/app'
import { useUi } from '@/state/ui'
import { listCommands } from '@/lib/commands'
import { DEFAULT_KEYS, EDITOR_KEYS, chordOf, isCustom, isRebindable, resetAllKeys, setKey, setRecording } from '@/lib/keybindings'
import { cx } from '@/lib/format'

/** Settings → Keyboard: every command with its shortcut; click one to press a new combination. */
export function KeyboardSection(): React.JSX.Element {
  // re-render when the stored shortcuts change
  const custom = useApp((s) => s.settings?.keybindings)
  const [q, setQ] = useState('')
  const [recording, setRec] = useState<string | null>(null)

  const commands = useMemo(() => {
    void custom
    return listCommands(true).filter((c) => !c.id.startsWith('recent:') && !c.id.startsWith('file.recent.'))
  }, [custom])

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return ql ? commands.filter((c) => (c.label + ' ' + (c.key ?? '')).toLowerCase().includes(ql)) : commands
  }, [commands, q])

  useEffect(() => {
    if (!recording) return
    setRecording(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRec(null)
        return
      }
      const chord = chordOf(e)
      if (!chord) return
      const id = recording
      setRec(null)
      void setKey(id, chord).then((lost) => {
        if (!lost) return
        const other = commands.find((c) => c.id === lost)
        useUi.getState().toast('info', `${chord} now belongs to this command`, other ? `It was removed from "${other.label}".` : undefined)
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      setRecording(false)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [recording, commands])

  return (
    <>
      <h2>Keyboard</h2>
      <div className="lead">Click a shortcut, then press the keys you want. Esc cancels.</div>
      <div className="row" style={{ gap: 8, margin: '12px 0' }}>
        <div className="input-icon grow">
          <Search size={13} className="faint" />
          <input className="input" placeholder="Find a command or a shortcut…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn ghost sm" disabled={!custom?.length} onClick={() => void resetAllKeys()} title="Put every shortcut back to how it came">
          <RotateCcw size={12} /> Reset all
        </button>
      </div>
      <div className="keys-list">
        {shown.map((c) => {
          const editable = isRebindable(c.id) || !c.key
          const changed = isCustom(c.id)
          return (
            <div key={c.id} className={cx('keys-row', recording === c.id && 'rec')}>
              <span className="grow truncate">{c.label}</span>
              {recording === c.id ? (
                <span className="kbd rec">Press keys…</span>
              ) : editable ? (
                <button className={cx('kbd key-btn', !c.key && 'none', changed && 'changed')} onClick={() => setRec(c.id)} title="Change this shortcut">
                  {c.key || 'Add'}
                </button>
              ) : (
                <span className="kbd fixed" title="Built into the editor">
                  {c.key}
                </span>
              )}
              {editable && c.key && recording !== c.id && (
                <button className="icon-btn sm" title="Remove this shortcut" onClick={() => void setKey(c.id, '')}>
                  <X size={12} />
                </button>
              )}
              {changed && recording !== c.id && (
                <button className="icon-btn sm" title={`Back to ${DEFAULT_KEYS[c.id] || 'no shortcut'}`} onClick={() => void setKey(c.id, null)}>
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          )
        })}
        {shown.length === 0 && <div className="faint small" style={{ padding: 12 }}>No command matches.</div>}
      </div>
      {!q && (
        <>
          <div className="hud-label" style={{ marginTop: 22 }}>While typing in the editor</div>
          <div className="faint small" style={{ margin: '4px 0 8px' }}>These come with the editor and stay as they are.</div>
          <div className="keys-list">
            {EDITOR_KEYS.map(([k, label]) => (
              <div key={k} className="keys-row">
                <span className="grow truncate">{label}</span>
                <span className="kbd fixed">{k}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
