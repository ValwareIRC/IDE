import { useState } from 'react'
import { GitBranch, PanelRightOpen, Pin, Plus, Trash2 } from 'lucide-react'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { useApp, modelLabel } from '@/state/app'
import { cx, humanTokens, timeAgo } from '@/lib/format'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { prism } from '@/lib/ipc'
import { toastError, useUi } from '@/state/ui'
import { exportSession } from '@/lib/menus'

export function SessionsView(): React.JSX.Element {
  const sessions = useSessions((s) => s.sessions)
  const active = useSessions((s) => s.active)
  const live = useSessions((s) => s.live)
  const select = useSessions((s) => s.select)
  const create = useSessions((s) => s.create)
  const remove = useSessions((s) => s.remove)
  const rename = useSessions((s) => s.rename)
  const models = useApp((s) => s.models)
  const workspace = useApp((s) => s.workspace)
  const openAgent = useLayout((s) => s.openAgent)
  const openAgentSession = useLayout((s) => s.openAgentSession)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // pinned conversations stay at the top (kept per project in this window's storage)
  const pinKey = `prism.pinned:${workspace ?? ''}`
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(pinKey) ?? '[]') as string[]
    } catch {
      return []
    }
  })
  const togglePin = (id: string): void => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned]
    setPinned(next)
    try {
      localStorage.setItem(pinKey, JSON.stringify(next))
    } catch {
      /* a convenience only */
    }
  }
  const ordered = [...sessions.filter((s) => pinned.includes(s.id)), ...sessions.filter((s) => !pinned.includes(s.id))]

  const menuFor = (id: string): MenuEntry[] => {
    const s = sessions.find((x) => x.id === id)
    if (!s) return []
    return [
      { label: 'Open', onClick: () => { void select(id); openAgent() } },
      { label: 'Open in its own panel', onClick: () => openAgentSession(id, s.title) },
      { label: pinned.includes(id) ? 'Unpin' : 'Pin to the top', onClick: () => togglePin(id) },
      { sep: true },
      { label: 'Rename', hint: 'dbl-click', onClick: () => { setEditing(id); setDraft(s.title) } },
      {
        label: 'Duplicate',
        onClick: () => void prism.sessions.duplicate(id).then((c) => { void select(c.id); openAgent() }).catch(toastError)
      },
      {
        label: 'Copy as markdown',
        onClick: () => void select(id).then(() => exportSession())
      },
      { sep: true },
      { label: 'Delete', danger: true, onClick: () => { if (window.confirm(`Delete "${s.title}"?`)) void remove(id) } }
    ]
  }

  if (!workspace) return <div className="side-view"><div className="empty">No folder open</div></div>

  return (
    <div className="side-view">
      <div className="side-head">
        <span className="hud-label">Sessions</span>
        <span className="grow" />
        <button className="icon-btn sm" data-demo="sessions:copy" title="New session in its own copy of the project: it works on a separate branch and your files stay untouched until you bring its work in" onClick={() => void useSessions.getState().createInCopy().then((s) => s && openAgent())}>
          <GitBranch size={13} />
        </button>
        <button className="icon-btn sm" data-demo="sessions:new" title="New session" onClick={() => void create().then(() => openAgent())}>
          <Plus size={14} />
        </button>
      </div>
      <div className="side-body">
        {sessions.length === 0 && (
          <div className="empty">
            <div>No sessions yet</div>
            <button className="btn primary" onClick={() => void create().then(() => openAgent())}>
              <Plus size={13} /> Start a session
            </button>
          </div>
        )}
        {ordered.map((s) => {
          const l = live[s.id]
          const running = l?.running || s.status !== 'idle'
          const waiting = s.status === 'waiting' || (l && (l.approvals.length > 0 || l.questions.length > 0))
          return (
            <div
              key={s.id}
              className={cx('session-row', s.id === active && 'sel')}
              onClick={() => {
                void select(s.id)
                openAgent()
              }}
              onDoubleClick={() => {
                setEditing(s.id)
                setDraft(s.title)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id: s.id })
              }}
            >
              {pinned.includes(s.id) ? <Pin size={10} className="accent session-pin" /> : <span className={cx('dot', waiting ? 'amber' : running ? 'live' : '')} />}
              <div className="grow" style={{ minWidth: 0 }}>
                {editing === s.id ? (
                  <input
                    className="input sm"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      setEditing(null)
                      if (draft.trim() && draft !== s.title) void rename(s.id, draft.trim())
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="truncate" style={{ fontWeight: s.id === active ? 600 : 500 }}>{s.title}</div>
                )}
                <div className="faint xs truncate">
                  {modelLabel(models, s.model)} · {humanTokens(s.inputTokens + s.outputTokens)} tok · {timeAgo(s.updatedAt)}
                </div>
              </div>
              <button
                className="icon-btn sm session-del"
                title="Open in its own panel, next to the others"
                onClick={(e) => {
                  e.stopPropagation()
                  openAgentSession(s.id, s.title)
                }}
              >
                <PanelRightOpen size={12} />
              </button>
              <button
                className="icon-btn sm session-del"
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Delete "${s.title}"?`)) void remove(s.id)
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuFor(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  )
}

void useUi
