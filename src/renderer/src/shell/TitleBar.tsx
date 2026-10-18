import { useEffect, useState } from 'react'
import { ChevronDown, Copy, FolderOpen, Minus, Search, Server, Square, X } from 'lucide-react'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { toastError, useUi } from '@/state/ui'
import { placeLabel } from '@shared/place'
import { basename } from '@/lib/format'
import { Logo } from '@/components/Logo'
import { MenuBar } from './MenuBar'

export function TitleBar(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const settings = useApp((s) => s.settings)
  const openWorkspace = useApp((s) => s.openWorkspace)
  const setWorkspace = useApp((s) => s.setWorkspace)
  const setPalette = useUi((s) => s.setPalette)
  const [max, setMax] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    void prism.win.isMaximized().then(setMax)
    return prism.win.onMaximizedChanged(setMax)
  }, [])

  useEffect(() => {
    if (!menu) return
    const off = (): void => setMenu(false)
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [menu])

  const recent = (settings?.recentWorkspaces ?? []).filter((p) => p !== workspace).slice(0, 8)

  return (
    <header className="titlebar">
      <div className="tb-left">
        <span className="wordmark">
          <Logo size={16} />
          PRISM
        </span>
        <MenuBar />
        <div style={{ position: 'relative' }} onMouseDown={(e) => e.stopPropagation()}>
          <button className="tb-project no-drag" onClick={() => setMenu((v) => !v)} title={workspace ?? 'Open a folder'}>
            <FolderOpen size={13} className="faint" />
            <span className="truncate">{workspace ? basename(workspace) : 'Open folder'}</span>
            {placeLabel(workspace) && <span className="chip xs violet">{placeLabel(workspace)}</span>}
            <ChevronDown size={12} className="faint" />
          </button>
          {menu && (
            <div className="popover" style={{ position: 'absolute', top: 30, left: 0, minWidth: 280 }}>
              <button className="menu-item" onClick={() => void openWorkspace().then(() => setMenu(false))}>
                <FolderOpen size={14} /> Open folder…
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setMenu(false)
                  useUi.getState().setModal('remote')
                }}
              >
                <Server size={14} /> Open a remote folder (WSL or SSH)…
              </button>
              {recent.length > 0 && <div className="menu-sep" />}
              {recent.length > 0 && <div className="menu-head hud-label">Recent</div>}
              {recent.map((p) => (
                <button key={p} className="menu-item" onClick={() => void setWorkspace(p).then(() => setMenu(false)).catch(toastError)}>
                  <span className="grow truncate">
                    {basename(p)}
                    {placeLabel(p) && <span className="chip xs violet" style={{ marginLeft: 6 }}>{placeLabel(p)}</span>}
                    <div className="sub truncate mono">{p}</div>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="tb-center">
        <button className="tb-search no-drag" data-demo="titlebar:search" onClick={() => setPalette('files')} title="Go to file (Ctrl+P) · Commands (Ctrl+Shift+P)">
          <Search size={13} />
          <span>{workspace ? `Search ${basename(workspace)}` : 'Search'}</span>
          <span className="kbd">Ctrl P</span>
        </button>
      </div>
      <div className="tb-right">
        <div className="win-controls no-drag">
          <button onClick={() => prism.win.minimize()} title="Minimize">
            <Minus size={14} />
          </button>
          <button onClick={() => prism.win.maximize()} title={max ? 'Restore' : 'Maximize'}>
            {max ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button className="close" onClick={() => prism.win.close()} title="Close">
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  )
}
