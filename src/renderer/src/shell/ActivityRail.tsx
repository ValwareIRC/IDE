import { Files, GitBranch, ListTree, MessagesSquare, Puzzle, Search, Settings, Sparkles, TerminalSquare } from 'lucide-react'
import { useUi, type SideView } from '@/state/ui'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { report } from '@/demo/bus'
import { cx } from '@/lib/format'

const ITEMS: Array<{ id: Exclude<SideView, null>; icon: React.ReactNode; title: string; key: string }> = [
  { id: 'explorer', icon: <Files size={18} />, title: 'Explorer', key: 'Ctrl+Shift+E' },
  { id: 'search', icon: <Search size={18} />, title: 'Search', key: 'Ctrl+Shift+F' },
  { id: 'outline', icon: <ListTree size={18} />, title: 'Outline', key: 'Ctrl+Shift+U' },
  { id: 'git', icon: <GitBranch size={18} />, title: 'Source control', key: 'Ctrl+Shift+G' },
  { id: 'sessions', icon: <MessagesSquare size={18} />, title: 'Sessions', key: 'Ctrl+Shift+S' },
  { id: 'gadgets', icon: <Puzzle size={18} />, title: 'Gadgets', key: 'Ctrl+Shift+D' }
]

export function ActivityRail(): React.JSX.Element {
  const side = useUi((s) => s.side)
  const toggle = useUi((s) => s.toggleSide)
  const openAgent = useLayout((s) => s.openAgent)
  const openTerminal = useLayout((s) => s.openTerminal)
  const openSettings = useLayout((s) => s.openSettings)
  const running = useSessions((s) => Object.values(s.live).some((l) => l.running))
  const waiting = useSessions((s) => Object.values(s.live).some((l) => l.approvals.length || l.questions.length))

  return (
    <nav className="rail">
      {ITEMS.map((it) => (
        <button key={it.id} className={cx('rail-btn', side === it.id && 'on')} data-demo={`rail:${it.id}`} title={`${it.title}  ${it.key}`} onClick={() => {
            toggle(it.id)
            if (useUi.getState().side === it.id) report({ surface: 'rail', what: 'opened', detail: it.id })
          }}>
          {it.icon}
        </button>
      ))}
      <div style={{ height: 8 }} />
      <button className="rail-btn" data-demo="rail:agent" title="Agent  Ctrl+L" onClick={openAgent}>
        <Sparkles size={18} />
        {waiting ? <span className="rail-dot" style={{ background: 'var(--amber)', boxShadow: '0 0 8px var(--amber)' }} /> : running ? <span className="rail-dot" /> : null}
      </button>
      <button className="rail-btn" data-demo="rail:terminal" title="Terminal  Ctrl+`" onClick={openTerminal}>
        <TerminalSquare size={18} />
      </button>
      <div className="rail-spacer" />
      <button className="rail-btn" data-demo="rail:settings" title="Settings  Ctrl+," onClick={() => openSettings()}>
        <Settings size={18} />
      </button>
    </nav>
  )
}
