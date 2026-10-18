// Carry on a conversation Claude Code had outside Prism (terminal, VS Code).
import { useEffect, useMemo, useState } from 'react'
import { MessagesSquare, X } from 'lucide-react'
import type { ClaudeConversation } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { cx, timeAgo } from '@/lib/format'

function size(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(n > 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}

export function ClaudeImportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<ClaudeConversation[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const root = useApp((s) => s.workspace)

  useEffect(() => {
    void prism.claude.conversations().then(setList).catch((e) => {
      toastError(e, 'Could not look for Claude Code conversations')
      setList([])
    })
  }, [])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (list ?? []).filter((c) => !t || `${c.title} ${c.cwd}`.toLowerCase().includes(t))
  }, [list, q])

  const bring = async (c: ClaudeConversation): Promise<void> => {
    setBusy(c.file)
    try {
      const r = await prism.claude.bringIn(c.file)
      await useSessions.getState().refresh()
      useLayout.getState().openAgent()
      await useSessions.getState().select(r.sessionId)
      useUi.getState().toast('success', 'Conversation brought in', 'Claude carries on from where it left off, remembering all of it.')
      onClose()
    } catch (e) {
      toastError(e, 'Could not bring it in')
      setBusy(null)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 'min(720px, 94vw)' }}>
        <div className="modal-head">
          <MessagesSquare size={15} /> <b>Carry on a Claude Code conversation</b>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} disabled={!!busy}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="small faint" style={{ marginBottom: 10 }}>
            Conversations you had with Claude Code in a terminal or in VS Code. The one you pick comes into {root ? <b>{root.split(/[\\/]/).pop()}</b> : 'this project'} and Claude picks it up exactly where it stopped. Close it in the other place first, so the two do not carry on separately.
          </div>
          <input className="input" autoFocus placeholder="Filter by title or folder…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <div className="cc-list">
            {!list && <div className="faint small">Looking…</div>}
            {list && !shown.length && <div className="faint small">{list.length ? 'Nothing matches.' : 'No Claude Code conversations found on this computer.'}</div>}
            {shown.map((c) => (
              <button key={c.file} className={cx('cc-row', busy === c.file && 'on')} disabled={!!busy} onClick={() => void bring(c)}>
                <span className="cc-title">{c.title || 'Untitled'}</span>
                <span className="cc-sub">
                  {c.cwd || 'unknown folder'} · {timeAgo(c.updatedAt)} · {size(c.bytes)}
                </span>
                {busy === c.file && <span className="cc-busy">Bringing it in… a long conversation takes a moment</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
