import { Fragment, useEffect, useState } from 'react'
import { FolderOpen, Plus, Puzzle, RefreshCw, Sparkles, Square, Trash2 } from 'lucide-react'
import { useGadgets } from '@/state/gadgets'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useApp } from '@/state/app'
import { prism } from '@/lib/ipc'
import { cx } from '@/lib/format'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { report } from '@/demo/bus'
import { copyText } from '@/lib/copy'
import { toastError, useUi } from '@/state/ui'

export function GadgetsView(): React.JSX.Element {
  const list = useGadgets((s) => s.list)
  const loaded = useGadgets((s) => s.loaded)
  const refresh = useGadgets((s) => s.refresh)
  const reload = useGadgets((s) => s.reload)
  const stop = useGadgets((s) => s.stop)
  const remove = useGadgets((s) => s.remove)
  const openGadget = useLayout((s) => s.openGadget)
  const openAgent = useLayout((s) => s.openAgent)
  const workspace = useApp((s) => s.workspace)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const ask = (): void => useUi.getState().setModal('new-gadget')

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  const menuFor = (id: string): MenuEntry[] => {
    const g = list.find((x) => x.id === id)
    if (!g) return []
    return [
      { label: 'Open', onClick: () => openGadget(id, g.name) },
      ...(window.__prismMobile ? [] : [{ label: 'Put on the desktop', onClick: () => void prism.float.open({ kind: 'gadget', key: `gadget:${id}`, title: g.name, params: { gadgetId: id } }) }]),
      { label: 'Restart', onClick: () => void reload(id) },
      ...(g.hasBackend && g.state === 'running' ? [{ label: 'Stop it', onClick: () => void stop(id) }] : []),
      { sep: true },
      { label: 'Ask the agent to improve it', onClick: () => { openAgent(); void useSessions.getState().send(`Read gadget "${id}" with gadget_read and improve it: `) } },
      // a folder on the computer is not something a phone can open
      ...(window.__prismMobile ? [] : [{ label: 'Open folder', onClick: () => void prism.gadgets.openDir(id) }]),
      { label: 'Copy id', onClick: () => void copyText(id) },
      // Prism's own cannot go; a changed copy of one can, which brings the original back
      ...(g.scope === 'builtin'
        ? []
        : [
            { sep: true as const },
            g.overrides
              ? { label: 'Put back the original', danger: true, onClick: () => { if (window.confirm(`Remove your changed copy of "${g.name}" and go back to the one that comes with Prism?`)) void remove(id) } }
              : { label: 'Delete', danger: true, onClick: () => { if (window.confirm(`Delete gadget "${g.name}" and its folder?`)) void remove(id) } }
          ])
    ]
  }

  return (
    <div className="side-view">
      <div className="side-head">
        <span className="hud-label">Gadgets</span>
        <span className="grow" />
        <button className="icon-btn sm" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-btn sm" title="New gadget" onClick={ask}>
          <Plus size={14} />
        </button>
      </div>
      <div className="side-body">
        {!list.some((g) => g.scope !== 'builtin') && loaded && (
          <div className="empty">
            <Puzzle size={24} className="accent" />
            <div>{list.length ? 'None of your own yet' : 'No gadgets yet'}</div>
            <div className="small faint">Mini-apps Prism builds for you: dashboards, control panels, fleets of anything. You watch them; the agent can operate them.</div>
            <button className="btn primary" onClick={ask}>
              <Sparkles size={13} /> Ask for one
            </button>
          </div>
        )}
        {[...list.filter((g) => g.scope !== 'builtin'), ...list.filter((g) => g.scope === 'builtin')].map((g, i, all) => (
          <Fragment key={g.id}>
          {g.scope === 'builtin' && all[i - 1]?.scope !== 'builtin' && <div className="hud-label gadget-group">Comes with Prism</div>}
          <div
            key={g.id}
            className="session-row"
            data-demo={`gadget:${g.id}`}
            onClick={() => {
              openGadget(g.id, g.name)
              report({ surface: 'gadget', what: 'opened', detail: g.id })
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: g.id })
            }}
          >
            <span className={cx('dot', g.state === 'running' && 'live', g.state === 'error' && 'rose', (g.state === 'starting' || g.state === 'installing') && 'amber')} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 500 }}>
                {g.name} <span className="faint xs">{g.scope === 'global' ? 'everywhere' : g.overrides ? 'changed' : ''}</span>
              </div>
              <div className="faint xs truncate" title={g.error ?? g.description}>
                {g.error ? <span className="rose">{g.error}</span> : g.intro?.tagline || g.description || g.id}
                {g.tools.length > 0 && <span className="accent"> · agent can use it</span>}
              </div>
            </div>
            {g.hasBackend && g.state === 'running' && (
              <button className="icon-btn sm session-del" title="Stop it" onClick={(e) => { e.stopPropagation(); void stop(g.id) }}>
                <Square size={11} />
              </button>
            )}
            {!window.__prismMobile && (
              <button className="icon-btn sm session-del" title="Open folder" onClick={(e) => { e.stopPropagation(); void prism.gadgets.openDir(g.id).catch(toastError) }}>
                <FolderOpen size={12} />
              </button>
            )}
            {g.scope !== 'builtin' && !g.overrides && (
              <button className="icon-btn sm session-del" title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete gadget "${g.name}"?`)) void remove(g.id) }}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
          </Fragment>
        ))}
        {!workspace && list.length > 0 && <div className="faint xs" style={{ padding: 10 }}>Open a folder to see project gadgets as well.</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuFor(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  )
}
