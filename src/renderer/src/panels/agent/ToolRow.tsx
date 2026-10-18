import { useEffect, useState } from 'react'
import {
  Accessibility,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  Paperclip,
  Smile,
  FilePen,
  FilePlus2,
  FileSearch,
  FolderTree,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  Move,
  Search,
  Terminal,
  Trash2,
  Wrench,
  FileText,
  Lightbulb,
  ShieldCheck,
  Bug
} from 'lucide-react'
import type { ToolCall, ToolItem } from '@shared/types'
import { CodeBlock } from '@/components/CodeBlock'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { DiffCard } from './DiffCard'
import { useLayout } from '@/state/layout'
import { useTerminals } from '@/state/terminals'
import { prism } from '@/lib/ipc'
import { languageFor, opensInPreview } from '@/lib/languages'
import { cx, humanDuration } from '@/lib/format'
import { playTour } from '@/panels/tour/Tour'
import { useSessions } from '@/state/sessions'
import { AssumptionCard } from './Background'

export function describeCall(call: ToolCall): { icon: React.ReactNode; verb: string; target: string } {
  const a = call.args
  const s = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (call.name) {
    case 'read_file':
      return { icon: <FileText size={13} />, verb: 'read', target: s('path') + (a['offset'] ? ` :${a['offset']}` : '') }
    case 'write_file':
      return { icon: <FilePlus2 size={13} />, verb: 'wrote', target: s('path') }
    case 'edit_file':
      return { icon: <FilePen size={13} />, verb: 'edited', target: s('path') }
    case 'list_dir':
      return { icon: <FolderTree size={13} />, verb: 'listed', target: s('path') || '.' }
    case 'glob':
      return { icon: <FileSearch size={13} />, verb: 'found files', target: s('pattern') }
    case 'grep':
      return { icon: <Search size={13} />, verb: 'searched', target: s('pattern') + (s('include') ? ` in ${s('include')}` : '') }
    case 'shell': {
      // A command of several lines shown by its first alone looked like one short command
      // taking far too long. It says how many lines it is, up front where the row's end
      // being cut off cannot hide it, and what it is for when the agent said so.
      const lines = s('command').trim().split('\n')
      if (lines.length > 1) return { icon: <Terminal size={13} />, verb: `$ ${lines.length} lines:`, target: s('description') || lines[0] || '' }
      return { icon: <Terminal size={13} />, verb: '$', target: lines[0] ?? '' }
    }
    case 'job_output':
      return { icon: <Terminal size={13} />, verb: 'job output', target: s('id') }
    case 'job_kill':
      return { icon: <Terminal size={13} />, verb: 'stopped job', target: s('id') }
    case 'web_fetch':
      return { icon: <Globe size={13} />, verb: 'fetched', target: s('url') }
    case 'todo_write':
      return { icon: <ListChecks size={13} />, verb: 'updated plan', target: '' }
    case 'ask_user':
      return { icon: <MessageCircleQuestion size={13} />, verb: 'asked', target: s('question') }
    case 'spawn_agent':
      return { icon: <Bot size={13} />, verb: 'delegated to', target: s('name') || 'worker' }
    case 'delete_path':
      return { icon: <Trash2 size={13} />, verb: 'deleted', target: s('path') }
    case 'move_path':
      return { icon: <Move size={13} />, verb: 'moved', target: `${s('from')} → ${s('to')}` }
    case 'show':
      return { icon: <Eye size={13} />, verb: 'showed', target: s('path') }
    case 'gesture':
      return { icon: <Smile size={13} />, verb: ({ wave: 'waved', nod: 'nodded', shake: 'shook its head', smile: 'smiled', laugh: 'laughed' } as Record<string, string>)[s('gesture')] ?? 'gestured', target: '' }
    case 'attach_file':
      return { icon: <Paperclip size={13} />, verb: 'attached', target: s('path').split(/[\\/]/).pop() ?? '' }
    case 'web_search':
      return { icon: <Globe size={13} />, verb: 'searched the web', target: s('query') }
    case 'run_snippet':
      return { icon: <Terminal size={13} />, verb: `ran ${s('language') === 'python' ? 'Python' : s('language') === 'ts' ? 'TypeScript' : 'JavaScript'}`, target: (s('code').split('\n')[0] ?? '').slice(0, 90) }
    case 'browser_open':
      return { icon: <Globe size={13} />, verb: 'opened', target: s('url') }
    case 'browser_look':
      return { icon: <Eye size={13} />, verb: 'looked at the page', target: '' }
    case 'check_accessibility':
      return { icon: <Accessibility size={13} />, verb: 'checked accessibility', target: s('url') }
    case 'browser_eval':
      return { icon: <Globe size={13} />, verb: 'ran in the page', target: (s('script').split('\n')[0] ?? '').slice(0, 90) }
    case 'find_references':
      return { icon: <Search size={13} />, verb: 'looked up uses of', target: s('symbol') }
    case 'rename_symbol':
      return { icon: <FilePen size={13} />, verb: 'renamed', target: `${s('symbol')} → ${s('new_name')}` }
    case 'assume':
      return { icon: <Lightbulb size={13} />, verb: 'assumed', target: s('assumption') }
    case 'debug_start':
      return { icon: <Bug size={13} />, verb: 'started debugging', target: s('problem') }
    case 'debug_reproduce':
      return { icon: <Bug size={13} />, verb: 'asked you to make it happen', target: s('steps') }
    case 'debug_read':
      return { icon: <Bug size={13} />, verb: 'read the debug log', target: '' }
    case 'debug_cleanup':
      return { icon: <Bug size={13} />, verb: 'removed the temporary logging', target: '' }
    case 'done_when': {
      const checks = Array.isArray(a['checks']) ? (a['checks'] as Array<Record<string, unknown>>) : []
      return { icon: <ShieldCheck size={13} />, verb: 'will prove it with', target: checks.map((c) => String(c['command'] ?? '')).join(', ') }
    }
    case 'check_project':
      return { icon: <ShieldCheck size={13} />, verb: 'checked the project', target: '' }
    case 'present_plan':
      return { icon: <ListChecks size={13} />, verb: 'presented a plan', target: s('title') }
    case 'NotebookEdit':
      return { icon: <FilePen size={13} />, verb: 'edited notebook', target: s('path') }
    case 'Skill':
      return { icon: <Wrench size={13} />, verb: 'used skill', target: s('skill') }
    case 'ToolSearch':
      return { icon: <Search size={13} />, verb: 'looked for tools', target: s('query') }
    case 'EnterPlanMode':
      return { icon: <ListChecks size={13} />, verb: 'switched to planning', target: '' }
    case 'TaskCreate':
      return { icon: <ListChecks size={13} />, verb: 'added a task', target: s('subject') }
    case 'TaskUpdate':
      return { icon: <ListChecks size={13} />, verb: 'updated a task', target: s('subject') || s('status') }
    default: {
      if (call.name.startsWith('mcp__')) {
        const parts = call.name.split('__')
        const first = Object.values(a).find((v) => typeof v === 'string') as string | undefined
        return { icon: <Wrench size={13} />, verb: `${parts[1]}:${parts.slice(2).join('__')}`, target: first?.slice(0, 80) ?? '' }
      }
      const hint = Object.values(a).find((v) => typeof v === 'string' && v.length > 0) as string | undefined
      return { icon: <Wrench size={13} />, verb: call.name, target: hint ? (hint.split('\n')[0] ?? '').slice(0, 80) : '' }
    }
  }
}

export function ToolRow(props: { item: ToolItem; restored?: boolean; onRestore?: (path: string) => void }): React.JSX.Element {
  const sessionId = useSessions((s) => s.active)
  // an assumption is not a step to inspect but a guess to confirm or correct
  if (props.item.name === 'assume' && !props.item.isError) return <AssumptionCard text={String(props.item.args['assumption'] ?? '')} sessionId={sessionId} />
  return <CallRow {...props} />
}

function CallRow({ item, restored, onRestore }: { item: ToolItem; restored?: boolean; onRestore?: (path: string) => void }): React.JSX.Element {
  const d = describeCall({ id: item.callId, name: item.name, args: item.args })
  // "Why did you do that?": a quick model reads the conversation up to this call and says
  const [why, setWhy] = useState<string | null>(null)
  const askWhy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const sid = useSessions.getState().active
    if (!sid) return
    setWhy('…')
    setOpen(true)
    void prism.agent
      .why(sid, item.id)
      .then(setWhy)
      .catch((err: unknown) => setWhy(`Could not ask: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)}`))
  }
  const hasImages = Array.isArray(item.meta?.['images']) && (item.meta!['images'] as unknown[]).length > 0
  const [open, setOpen] = useState((item.isError && item.name !== 'ask_user') || hasImages)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const openEditor = useLayout((s) => s.openEditor)
  const openPreview = useLayout((s) => s.openPreview)
  const path = typeof item.args['path'] === 'string' ? (item.args['path'] as string) : null
  const isFileTool = ['read_file', 'write_file', 'edit_file'].includes(item.name)
  const command = item.name === 'shell' ? String(item.args['command'] ?? '') : null

  const menuEntries = (): MenuEntry[] => {
    const out: MenuEntry[] = []
    if (path) out.push({ label: 'Open file', onClick: () => (opensInPreview(path) ? openPreview(path) : openEditor(path)) })
    if (command) {
      out.push(
        { label: 'Copy command', onClick: () => void navigator.clipboard.writeText(command) },
        {
          label: 'Run again in my terminal',
          onClick: () => {
            const t = useTerminals.getState()
            useLayout.getState().openTerminal()
            const id = t.active && t.active !== '__agent__' ? t.active : t.list[0]?.id
            if (id) prism.terminals.write(id, command + '\r')
          }
        }
      )
    }
    out.push({ label: 'Copy output', onClick: () => void navigator.clipboard.writeText(item.content) }, { label: 'Copy arguments as JSON', onClick: () => void navigator.clipboard.writeText(JSON.stringify(item.args, null, 2)) })
    if (item.diff && onRestore) out.push({ sep: true }, { label: 'Revert this change', danger: true, onClick: () => onRestore(item.diff!.path) })
    return out
  }

  const openTarget = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!path) return
    if (opensInPreview(path)) openPreview(path)
    else openEditor(path)
  }

  return (
    <div
      className={cx('tool-row', open && 'open', item.isError && 'err')}
      data-item={item.id}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />}
      <div className="tool-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="ticon">{item.isError ? <AlertTriangle size={13} /> : d.icon}</span>
        <span className="verb">{d.verb}</span>
        <span className={cx('target', isFileTool && 'link')} onClick={isFileTool ? openTarget : undefined} title={isFileTool ? 'Open' : undefined}>
          {d.target}
        </span>
        {item.agent && <span className="agent-tag">{item.agent}</span>}
        <span className="tmeta">
          {item.diff && (
            <>
              <span className="plus">+{item.diff.additions}</span>
              <span className="minus">−{item.diff.deletions}</span>
            </>
          )}
          {item.meta && typeof item.meta['matches'] === 'number' && <span>{item.meta['matches'] as number} hits</span>}
          {item.meta && typeof item.meta['count'] === 'number' && <span>{item.meta['count'] as number} files</span>}
          {item.meta && typeof item.meta['exitCode'] === 'number' && (item.meta['exitCode'] as number) !== 0 && <span className="rose">exit {item.meta['exitCode'] as number}</span>}
          {typeof item.meta?.['checkedBy'] === 'string' && (
            <span className="mint" title={`The checker let this through: ${item.meta['checkedBy'] as string}`}>
              checked
            </span>
          )}
          {typeof item.meta?.['tour'] === 'string' && !item.isError && (
            <button
              className="btn sm solid"
              onClick={(e) => {
                e.stopPropagation()
                void playTour(item.meta!['tour'] as string)
              }}
            >
              Play the tour
            </button>
          )}
          <button className="why-btn" title="Why did it do this?" onClick={askWhy}>
            why?
          </button>
          <span>{humanDuration(item.durationMs)}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          {why && (
            <div className={cx('why-answer', why === '…' && 'loading')}>
              <b>Why: </b>
              {why === '…' ? 'asking…' : why}
            </div>
          )}
          <StepBody item={item} restored={restored} onRestore={onRestore} />
        </div>
      )}
    </div>
  )
}

/** What a step did: the diff, the file it read, or what the command printed. */
export function StepBody({ item, restored, onRestore }: { item: ToolItem; restored?: boolean; onRestore?: (path: string) => void }): React.JSX.Element {
  const path = typeof item.args['path'] === 'string' ? (item.args['path'] as string) : null
  return (
    <>
      {item.name === 'shell' && (
        <div className="shell-cmd">
          <span className="prompt">❯</span>
          <span>{String(item.args['command'] ?? '')}</span>
        </div>
      )}
      {item.name === 'debug_start' && !!item.meta?.['debug'] && (
        <div className="debug-guesses">
          <div className="faint xs">Its guesses at the cause, most likely first</div>
          <ol>
            {((item.meta['debug'] as { guesses: string[] }).guesses ?? []).map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ol>
        </div>
      )}
      {item.name === 'run_snippet' && <CodeBlock code={String(item.args['code'] ?? '')} lang={item.args['language'] === 'python' ? 'python' : 'typescript'} maxHeight={200} />}
      {Array.isArray(item.meta?.['images']) && (item.meta!['images'] as unknown[]).length > 0 && (
        <div className="tool-images">
          {(item.meta!['images'] as string[]).map((name) => (
            <ToolImage key={name} name={name} />
          ))}
        </div>
      )}
      {item.diff ? (
        <DiffCard diff={item.diff} restored={restored} onRestore={onRestore ? () => onRestore(item.diff!.path) : undefined} />
      ) : item.name === 'read_file' && path && !item.isError && !item.meta?.['image'] ? (
        <CodeBlock code={stripNumbers(item.content)} lang={languageFor(path)} file={path} maxHeight={360} />
      ) : (
        <pre className={cx('out', item.isError && 'err')}>{item.content.length > 12_000 ? item.content.slice(0, 12_000) + '\n… (truncated in view)' : item.content}</pre>
      )}
    </>
  )
}

function ToolImage({ name }: { name: string }): React.JSX.Element {
  const [big, setBig] = useState(false)
  return (
    <img
      className={cx('tool-image', big && 'big')}
      src={`prism://attach/${name}`}
      alt="tool output"
      title={big ? 'Click to shrink' : 'Click to enlarge'}
      onClick={() => setBig((v) => !v)}
    />
  )
}

function stripNumbers(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n')
    .replace(/\n\n… \d+ more lines[\s\S]*$/, '')
}

export function LiveToolRow({ call, output, agent, startedAt }: { call: ToolCall; output: string; agent?: string; startedAt: number }): React.JSX.Element {
  const d = describeCall(call)
  const [open, setOpen] = useState(call.name === 'shell')
  return (
    <div className={cx('tool-row live', open && output && 'open')}>
      <div className="tool-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="ticon">
          <span className="spinner" />
        </span>
        <span className="verb">{d.verb === '$' ? '$' : d.verb.replace(/ed$/, 'ing').replace(/^wrote$/, 'writing').replace(/^read$/, 'reading').replace(/^found files$/, 'finding').replace(/^searched$/, 'searching').replace(/^fetched$/, 'fetching').replace(/^showed$/, 'showing').replace(/^asked$/, 'asking').replace(/^deleted$/, 'deleting').replace(/^moved$/, 'moving').replace(/^listed$/, 'listing').replace(/^updated plan$/, 'planning')}</span>
        <span className="target">{d.target}</span>
        {agent && <span className="agent-tag">{agent}</span>}
        <span className="tmeta">
          <Elapsed since={startedAt} />
        </span>
      </div>
      {open && output && (
        <div className="tool-body">
          <pre className="out">{output.slice(-6000)}</pre>
        </div>
      )}
    </div>
  )
}

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{humanDuration(Date.now() - since)}</span>
}
