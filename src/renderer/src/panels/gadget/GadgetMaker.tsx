import { useEffect, useRef, useState } from 'react'
import { Boxes, Database, Eye, KanbanSquare, Music, Puzzle, ScrollText, Send, Server, Sparkles } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { useUi } from '@/state/ui'
import { cx } from '@/lib/format'

const IDEAS: Array<{ icon: React.JSX.Element; title: string; wish: string }> = [
  { icon: <Server size={15} />, title: 'Machine fleet', wish: 'A fleet of local virtual machines. Show each screen, let me cycle between them, start and stop them, and let the agent drive any of them.' },
  { icon: <Boxes size={15} />, title: 'Containers', wish: 'My Docker containers with start and stop buttons and live logs for the one I pick.' },
  { icon: <Music size={15} />, title: 'Music player', wish: 'Play the music on this computer, with search, cover art and a visualiser.' },
  { icon: <Send size={15} />, title: 'Request tester', wish: 'Send web requests, keep the ones I save, and show responses nicely formatted.' },
  { icon: <Database size={15} />, title: 'Database browser', wish: 'Open a SQLite file from this project, browse its tables and run queries.' },
  { icon: <KanbanSquare size={15} />, title: 'Task board', wish: 'A board built from the TODO comments in this project, grouped by file, that I can tick off.' },
  { icon: <ScrollText size={15} />, title: 'Log watcher', wish: 'Follow a log file live with filters, highlights and a pause button.' },
  { icon: <Eye size={15} />, title: 'Page watcher', wish: 'Keep an eye on a few web pages and tell me when one changes.' }
]

function buildPrompt(wish: string, everywhere: boolean, agentUses: boolean): string {
  return [
    'Build me a gadget.',
    '',
    `What I want: ${wish.trim()}`,
    '',
    '- Read gadget_sdk first.',
    everywhere ? '- Save it for every project (scope "global").' : '- Save it for this project.',
    agentUses ? '- Give yourself tools so you can operate it too, not only me.' : '- I only need the panel; no tools for you.',
    '- Check what is installed on this computer before relying on a program. If something is missing, tell me plainly and ask before installing it.',
    '- When it is written, open it with gadget_open, look at it with gadget_look, and fix anything that looks off before you say it is done.'
  ].join('\n')
}

/** The "New gadget" dialog: describe it, the agent builds it in a fresh session. */
export function GadgetMaker({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [wish, setWish] = useState('')
  const [everywhere, setEverywhere] = useState(!workspace)
  const [agentUses, setAgentUses] = useState(true)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = setTimeout(() => box.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [])

  const build = async (): Promise<void> => {
    if (!wish.trim()) return
    const text = buildPrompt(wish, everywhere || !workspace, agentUses)
    onClose()
    useUi.getState().setSide('gadgets')
    useLayout.getState().openAgent()
    const sessions = useSessions.getState()
    const s = await sessions.create()
    if (s) await sessions.send(text, undefined, s.id)
  }

  return (
    <Modal
      title="New gadget"
      icon={<Puzzle size={16} />}
      onClose={onClose}
      width={660}
      footer={
        <>
          <span className="faint xs grow">Prism writes it, opens it and checks how it looks. You can keep changing it afterwards.</span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={!wish.trim()} onClick={() => void build()}>
            <Sparkles size={13} /> Build it
          </button>
        </>
      }
    >
      <div className="maker">
        <textarea
          ref={box}
          className="input maker-wish"
          rows={4}
          placeholder="Describe the mini-app you want inside Prism…"
          value={wish}
          onChange={(e) => setWish(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void build()
            }
          }}
        />
        <div className="hud-label">Ideas</div>
        <div className="maker-ideas">
          {IDEAS.map((i) => (
            <button key={i.title} className={cx('maker-idea', wish === i.wish && 'on')} onClick={() => setWish(i.wish)} title={i.wish}>
              <span className="maker-idea-icon">{i.icon}</span>
              <span className="maker-idea-text">
                <span className="maker-idea-title">{i.title}</span>
                <span className="faint xs">{i.wish}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="maker-opts">
          <div className="maker-opt">
            <span className="dim small">Keep it</span>
            <div className="seg">
              <button className={cx(!everywhere && 'on')} disabled={!workspace} onClick={() => setEverywhere(false)} title={workspace ? 'Saved with this project' : 'Open a folder first'}>
                In this project
              </button>
              <button className={cx(everywhere && 'on')} onClick={() => setEverywhere(true)}>
                Everywhere
              </button>
            </div>
          </div>
          <label className="maker-opt clickable">
            <input type="checkbox" checked={agentUses} onChange={(e) => setAgentUses(e.target.checked)} />
            <span className="small">Let the agent operate it too</span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
