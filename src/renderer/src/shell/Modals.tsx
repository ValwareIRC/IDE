import { useEffect, useState } from 'react'
import { FilePlus, Info, Keyboard, Pencil } from 'lucide-react'
import { useRefactor } from '@/state/refactor'
import { Modal } from '@/components/Modal'
import { Logo } from '@/components/Logo'
import { useUi } from '@/state/ui'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { prism } from '@/lib/ipc'
import { toastError } from '@/state/ui'
import { GadgetMaker } from '@/panels/gadget/GadgetMaker'
import { RemoteModal } from './RemoteModal'
import { ClaudeImportModal } from './ClaudeImportModal'
import { listCommands } from '@/lib/commands'
import { EDITOR_KEYS, isRebindable } from '@/lib/keybindings'

function RenameModal(): React.JSX.Element | null {
  const spot = useRefactor((s) => s.asking)
  const [name, setName] = useState('')
  useEffect(() => {
    if (!spot) return
    setName(spot.word)
    const t = setTimeout(() => {
      const el = document.getElementById('rename-symbol-name') as HTMLInputElement | null
      el?.focus()
      el?.select()
    }, 30)
    return () => clearTimeout(t)
  }, [spot])
  if (!spot) return null
  const close = (): void => useRefactor.getState().closeAsk()
  const go = (): void => {
    if (name.trim() && name.trim() !== spot.word) void useRefactor.getState().rename(name.trim())
  }
  return (
    <Modal
      title={`Rename ${spot.word} everywhere`}
      icon={<Pencil size={16} />}
      onClose={close}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn solid" disabled={!name.trim() || name.trim() === spot.word} onClick={go}>Show what changes</button>
        </>
      }
    >
      <label className="field">
        <span>New name</span>
        <input id="rename-symbol-name" className="input mono" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      </label>
      <div className="faint small" style={{ marginTop: 8 }}>Every file that uses it is listed first. Nothing is written until you apply.</div>
    </Modal>
  )
}

export function Modals(): React.JSX.Element | null {
  const modal = useUi((s) => s.modal)
  const renaming = useRefactor((s) => !!s.asking)
  const setModal = useUi((s) => s.setModal)
  const info = useApp((s) => s.info)
  if (renaming) return <RenameModal />
  if (modal === 'shortcuts') {
    return (
      <Modal
        title="Keyboard shortcuts"
        icon={<Keyboard size={16} />}
        onClose={() => setModal(null)}
        width={640}
        footer={
          <button
            className="btn ghost"
            onClick={() => {
              setModal(null)
              useLayout.getState().openSettings('keyboard')
            }}
          >
            Change shortcuts…
          </button>
        }
      >
        <div className="shortcut-grid">
          {[...listCommands(true).filter((c) => c.key && isRebindable(c.id)).map((c) => [c.key!, c.label.replace(/^[^:]+: /, '')] as [string, string]), ...EDITOR_KEYS].map(([k, d]) => (
            <div key={k + d} className="shortcut-row">
              <span className="kbd">{k}</span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </Modal>
    )
  }
  if (modal === 'about') {
    return (
      <Modal title="About Prism" icon={<Info size={16} />} onClose={() => setModal(null)} width={440}>
        <div className="row" style={{ gap: 14 }}>
          <Logo size={42} />
          <div>
            <div style={{ fontWeight: 650, fontSize: 'var(--fs-lg)' }}>Prism {info?.version}</div>
            <div className="dim small">An agentic IDE for any model.</div>
            <div className="faint xs" style={{ marginTop: 6 }}>
              {info?.platform} · data in {info?.userData}
            </div>
            <div className="faint xs">MIT © Valerie Liu</div>
          </div>
        </div>
      </Modal>
    )
  }
  if (modal === 'new-file') return <NewFileModal onClose={() => setModal(null)} />
  if (modal === 'new-gadget') return <GadgetMaker onClose={() => setModal(null)} />
  if (modal === 'remote') return <RemoteModal onClose={() => setModal(null)} />
  if (modal === 'claude-import') return <ClaudeImportModal onClose={() => setModal(null)} />
  return null
}

function NewFileModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const openEditor = useLayout((s) => s.openEditor)
  useEffect(() => {
    const t = setTimeout(() => document.getElementById('new-file-name')?.focus(), 30)
    return () => clearTimeout(t)
  }, [])
  const create = async (): Promise<void> => {
    const p = name.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!p) return
    try {
      await prism.fs.create(p, 'file')
      openEditor(p)
      onClose()
    } catch (e) {
      toastError(e, 'Could not create the file')
    }
  }
  return (
    <Modal
      title="New file"
      icon={<FilePlus size={16} />}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn solid" disabled={!name.trim()} onClick={() => void create()}>Create</button>
        </>
      }
    >
      <label className="field">
        <span>Path inside the workspace</span>
        <input id="new-file-name" className="input mono" placeholder="src/new-file.ts" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
    </Modal>
  )
}
