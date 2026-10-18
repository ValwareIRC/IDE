import { useEffect, useState } from 'react'
import { Laptop, Server } from 'lucide-react'
import { sshRoot } from '@shared/place'
import { Modal } from '@/components/Modal'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { toastError } from '@/state/ui'

/** Open a folder that is not on this computer's own disk: inside WSL, or on another computer over SSH. */
export function RemoteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [distros, setDistros] = useState<Array<{ distro: string; home: string }> | null>(null)
  const [hosts, setHosts] = useState<string[]>([])
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void prism.workspace.wsl().then(setDistros).catch(() => setDistros([]))
    void prism.workspace.sshHosts().then(setHosts).catch(() => {})
  }, [])

  const openWsl = async (home: string): Promise<void> => {
    try {
      const p = await prism.workspace.open(home)
      if (p) {
        useApp.setState({ workspace: p })
        onClose()
      }
    } catch (e) {
      toastError(e)
    }
  }

  const openSsh = async (): Promise<void> => {
    if (!host.trim() || !path.trim().startsWith('/')) return
    setBusy(true)
    try {
      await useApp.getState().setWorkspace(sshRoot(host.trim(), path.trim()))
      onClose()
    } catch (e) {
      toastError(e, 'Could not open that folder')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Open a remote folder" icon={<Server size={16} />} onClose={onClose} width={560}>
      <div className="remote-section">
        <div className="hud-label">In WSL (Linux on this computer)</div>
        {distros === null ? (
          <div className="faint small">Looking…</div>
        ) : distros.length ? (
          <div className="remote-row">
            {distros.map((d) => (
              <button key={d.distro} className="btn" onClick={() => void openWsl(d.home)} title={`Choose a folder inside ${d.distro}`}>
                <Laptop size={13} /> {d.distro}
              </button>
            ))}
          </div>
        ) : (
          <div className="faint small">No Linux is installed in WSL on this computer.</div>
        )}
        <div className="faint small">Files are read straight from WSL; git, the terminal, checks and the agent's commands run inside it.</div>
      </div>

      <div className="remote-section">
        <div className="hud-label">On another computer (SSH)</div>
        <label className="field">
          <span>Computer</span>
          <input className="input mono" list="ssh-hosts" placeholder="me@server.example   or a name from your SSH config" value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
          <datalist id="ssh-hosts">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Folder there</span>
          <input className="input mono" placeholder="/home/me/project" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void openSsh()} />
        </label>
        <div className="faint small">
          Prism signs in with your SSH key, the same way <span className="mono">ssh</span> does in a terminal, and cannot type a password for you. If <span className="mono">ssh {host.trim() || 'that-computer'}</span> works in a terminal without asking for one, it will work here.
        </div>
        <div className="faint small">Files, search, git, the terminal and the agent's commands all run on that computer. The scratchpad, gadgets saved in the project, renaming across files and sessions in their own copy are not available there yet.</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !host.trim() || !path.trim().startsWith('/')} onClick={() => void openSsh()}>
            {busy ? 'Connecting…' : 'Open'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
