import { useEffect, useState } from 'react'
import { AlertTriangle, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, FileDown, FolderOpen, ShieldAlert, X, XCircle } from 'lucide-react'
import type { ApprovalRequest, QuestionRequest, TodoItem, ToolItem } from '@shared/types'
import type { SubagentLive } from '@/state/sessions'
import { describeCall } from './ToolRow'
import { cx, humanDuration, humanSize, timeAgo } from '@/lib/format'
import { prism } from '@/lib/ipc'

export function ApprovalCard({ req, onDecide }: { req: ApprovalRequest; onDecide: (d: 'once' | 'always' | 'deny') => void }): React.JSX.Element {
  const d = describeCall(req.call)
  const cmd = req.call.name === 'shell' ? String(req.call.args['command'] ?? '') : null
  const content = req.call.name === 'write_file' ? String(req.call.args['content'] ?? '') : null
  const edit = req.call.name === 'edit_file' ? req.call.args : null
  // "What does this do?": a plain-English account of the action and its risk, before deciding
  const [explained, setExplained] = useState<string | null>(null)
  const explain = (): void => {
    setExplained('…')
    void prism.agent
      .explainCall(req.call)
      .then(setExplained)
      .catch((e: unknown) => setExplained(`Could not ask: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`))
  }
  return (
    <div className={cx('approval', req.risk)}>
      <div className="a-title">
        {req.risk === 'high' ? <ShieldAlert size={15} className="rose" /> : <AlertTriangle size={15} className="amber" />}
        <span>
          {req.risk === 'high' ? 'Risky action' : 'Approve'}: {d.verb} <span className="mono">{d.target}</span>
        </span>
        {req.agent && <span className="agent-tag">{req.agent}</span>}
      </div>
      {req.concern && (
        <div className="a-concern">
          <b>The checker would not let this through by itself:</b> {req.concern}
        </div>
      )}
      {cmd && <div className="a-cmd">{cmd}</div>}
      {content !== null && <div className="a-cmd">{content.length > 1500 ? content.slice(0, 1500) + '\n…' : content}</div>}
      {edit && (
        <div className="a-cmd">
          <span className="rose">− </span>
          {String(edit['old_string'] ?? '').slice(0, 600)}
          {'\n'}
          <span className="mint">+ </span>
          {String(edit['new_string'] ?? '').slice(0, 600)}
        </div>
      )}
      {explained && <div className={cx('explained', explained === '…' && 'loading')}>{explained === '…' ? 'Working out what this does…' : explained}</div>}
      <div className="a-actions">
        <button className="btn sm solid" onClick={() => onDecide('once')}>
          <Check size={13} /> Allow
        </button>
        <button className="btn sm" onClick={() => onDecide('always')} title={`Always allow: ${req.rule.tool}${req.rule.pattern ? ` ${req.rule.pattern}` : ''}`}>
          Always allow {req.rule.pattern ? <span className="mono faint">{req.rule.pattern}</span> : null}
        </button>
        <button className="btn sm danger" onClick={() => onDecide('deny')}>
          Deny
        </button>
        {!explained && (
          <button className="btn sm ghost" onClick={explain} title="A plain-English account of what this will do, and how risky it is">
            What does this do?
          </button>
        )}
      </div>
    </div>
  )
}

export function QuestionCard({ req, onAnswer }: { req: QuestionRequest; onAnswer: (a: string) => void }): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [other, setOther] = useState('')
  const submit = (): void => {
    const parts = [...picked]
    if (other.trim()) parts.push(other.trim())
    if (parts.length) onAnswer(parts.join('; '))
  }
  return (
    <div className="question">
      <div className="a-title">
        <Bot size={15} className="accent" />
        <span>{req.question}</span>
      </div>
      {req.options.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {req.options.map((o) => (
            <button
              key={o.label}
              className={cx('q-option', picked.has(o.label) && 'on')}
              onClick={() => {
                if (req.multi) {
                  setPicked((p) => {
                    const n = new Set(p)
                    if (n.has(o.label)) n.delete(o.label)
                    else n.add(o.label)
                    return n
                  })
                } else onAnswer(o.label)
              }}
            >
              <span>{o.label}</span>
              {o.description && <span className="d">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input
          className="input sm grow"
          placeholder={req.options.length ? 'Or type something else…' : 'Your answer…'}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="btn sm primary" onClick={submit} disabled={!picked.size && !other.trim()}>
          Answer
        </button>
      </div>
    </div>
  )
}

/**
 * The one line a folded plan shows: what is being done now, or failing that what comes
 * next, or that it is all done. Folded, the plan is a glance, and a glance wants the
 * present, not a count.
 */
function nowLine(todos: TodoItem[]): { text: string; kind: 'active' | 'next' | 'done' } {
  const active = todos.find((t) => t.status === 'active')
  if (active) return { text: active.text, kind: 'active' }
  const next = todos.find((t) => t.status === 'pending')
  if (next) return { text: 'Next: ' + next.text, kind: 'next' }
  return { text: 'All done', kind: 'done' }
}

export function Plan({ todos }: { todos: TodoItem[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  // Put away for this plan only: the items it was put away with are remembered, and a
  // plan with a new item in it is a new plan, so it shows itself again.
  const [hidden, setHidden] = useState<string | null>(null)
  const which = todos.map((t) => t.id).join(',')
  if (!todos.length || hidden === which) return null
  const done = todos.filter((t) => t.status === 'done').length
  const now = nowLine(todos)
  return (
    <div className={cx('agent-plan', !open && 'folded')}>
      <div className="plan-summary" onClick={() => setOpen((v) => !v)} title={open ? 'Fold the plan away' : 'Show the whole plan'}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Plan</span>
        <span className="faint">
          {done}/{todos.length}
        </span>
        <span className="meter" style={{ width: 60, flex: 'none' }}>
          <i style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
        {!open && <span className={cx('plan-now truncate', now.kind)}>{now.text}</span>}
        <button
          className="icon-btn sm plan-close"
          title="Put the plan away (it comes back when a new one starts)"
          onClick={(e) => {
            e.stopPropagation()
            setHidden(which)
          }}
        >
          <X size={11} />
        </button>
      </div>
      {open &&
        todos.map((t) => (
          <div key={t.id} className={cx('plan-row', t.status)}>
            <span className="pbox">{t.status === 'done' && <Check size={9} />}</span>
            <span className="truncate">{t.text}</span>
          </div>
        ))}
    </div>
  )
}

export interface Attached {
  itemId: string
  name: string
  size: number
  note: string
}

/** The files a turn's attach_file calls handed over, in order. */
export function attachedIn(items: ToolItem[]): Attached[] {
  const out: Attached[] = []
  for (const it of items) {
    const a = it.meta?.['attach'] as { name?: unknown; size?: unknown; note?: unknown } | undefined
    if (!a || it.isError || typeof a.name !== 'string') continue
    out.push({ itemId: it.id, name: a.name, size: Number(a.size) || 0, note: typeof a.note === 'string' ? a.note : '' })
  }
  return out
}

type PhoneFiles = { save(o: { name: string; data: string; append: boolean }): Promise<void>; open(o: { name: string }): Promise<void> }

/**
 * Fetches the file through the paired connection a piece at a time. In the app it is
 * saved on the phone and opened (an APK opens in the installer); in a phone's browser
 * it is handed to the browser as a download.
 */
async function fetchToPhone(sessionId: string, f: Attached, progress: (done: number) => void): Promise<void> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  const native = Capacitor.isNativePlatform() ? registerPlugin<PhoneFiles>('Files') : null
  const pieces: BlobPart[] = []
  let at = 0
  for (;;) {
    const part = await prism.files.part(sessionId, f.itemId, at)
    if (native) await native.save({ name: f.name, data: part.data, append: at > 0 })
    else pieces.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)))
    at = part.next
    progress(part.size ? at / part.size : 1)
    if (at >= part.size || !part.data) break
  }
  if (native) return native.open({ name: f.name })
  const url = URL.createObjectURL(new Blob(pieces))
  const a = Object.assign(document.createElement('a'), { href: url, download: f.name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function AttachmentCard({ sessionId, file }: { sessionId: string; file: Attached }): React.JSX.Element {
  const phone = !!window.__prismMobile
  const [busy, setBusy] = useState<number | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const fail = (e: unknown): void => setTrouble(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
  const go = (): void => {
    setTrouble(null)
    if (!phone) return void prism.files.open(sessionId, file.itemId).catch(fail)
    if (busy !== null) return
    setBusy(0)
    void fetchToPhone(sessionId, file, setBusy)
      .catch(fail)
      .finally(() => setBusy(null))
  }
  return (
    <div className="attach-card">
      <button className="attach-main" onClick={go} title={phone ? 'Download it to this phone and open it' : 'Open it'}>
        <span className="attach-icon">
          <FileDown size={16} />
        </span>
        <span className="attach-text">
          <span className="attach-name truncate">{file.name}</span>
          <span className="attach-sub truncate">
            {trouble ?? (busy !== null ? `Downloading… ${Math.round(busy * 100)}%` : [humanSize(file.size), file.note].filter(Boolean).join(' · '))}
          </span>
        </span>
        {busy !== null && <span className="attach-bar" style={{ width: `${busy * 100}%` }} />}
      </button>
      {!phone && (
        <button className="icon-btn sm" title="Show it in its folder" onClick={() => void prism.files.reveal(sessionId, file.itemId).catch(fail)}>
          <FolderOpen size={13} />
        </button>
      )}
    </div>
  )
}

export function AttachmentList({ sessionId, items }: { sessionId: string | null; items: ToolItem[] }): React.JSX.Element | null {
  const files = attachedIn(items)
  if (!sessionId || !files.length) return null
  return (
    <div className="attach-list">
      {files.map((f) => (
        <AttachmentCard key={f.itemId} sessionId={sessionId} file={f} />
      ))}
    </div>
  )
}

/**
 * Every file handed over in one conversation, newest first, with a search that matches
 * the name, the note or the kind of file (".apk", "mp4"). On the phone it rises from the
 * bottom of the screen; on the computer it opens under the conversation's title.
 */
export function AttachmentsPanel({ sessionId, onGo, onClose }: { sessionId: string; onGo: (itemId: string) => void; onClose: () => void }): React.JSX.Element {
  const phone = !!window.__prismMobile
  const [files, setFiles] = useState<Array<Attached & { ts: number }> | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let gone = false
    void prism.sessions.items(sessionId).then((items) => {
      if (gone) return
      const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
      const at = new Map(tools.map((t) => [t.id, t.ts]))
      setFiles(attachedIn(tools).map((f) => ({ ...f, ts: at.get(f.itemId) ?? 0 })).reverse())
    })
    return () => {
      gone = true
    }
  }, [sessionId])
  const words = query.toLowerCase().replace(/^\*?\./, '').split(/\s+/).filter(Boolean)
  const shown = (files ?? []).filter((f) => words.every((w) => `${f.name} ${f.note}`.toLowerCase().includes(w)))
  const list = (
    <>
      <input className="input sm attach-search" autoFocus={!phone} placeholder="Search by name or kind, like apk or mp4" value={query} onChange={(e) => setQuery(e.target.value)} />
      {files === null ? (
        <div className="faint small attach-empty">Looking…</div>
      ) : !files.length ? (
        <div className="faint small attach-empty">No files have been handed over in this conversation yet.</div>
      ) : !shown.length ? (
        <div className="faint small attach-empty">Nothing matches “{query}”.</div>
      ) : (
        <div className="attach-history">
          {shown.map((f) => (
            <div key={f.itemId} className="attach-row">
              <AttachmentCard sessionId={sessionId} file={f} />
              <button
                className="btn sm ghost"
                title="Show where it was handed over"
                onClick={() => {
                  onGo(f.itemId)
                  onClose()
                }}
              >
                {f.ts ? timeAgo(f.ts) : 'show'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
  if (phone)
    return (
      <div className="m-sheet-back" onClick={onClose}>
        <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="m-sheet-head">
            <span>Files in this conversation</span>
            <button className="m-icon" onClick={onClose} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="m-sheet-body attach-sheet">{list}</div>
        </div>
      </div>
    )
  return (
    <div className="agent-plan attach-panel">
      <div className="plan-summary">
        <span>Files in this conversation</span>
        <span className="faint">{files?.length ?? ''}</span>
        <button className="icon-btn sm plan-close" title="Close" onClick={onClose}>
          <X size={11} />
        </button>
      </div>
      {list}
    </div>
  )
}

export function SubagentCard({ sa }: { sa: SubagentLive }): React.JSX.Element {
  return (
    <div className="sub-card">
      <div className="sh">
        {sa.status === 'running' ? <span className="spinner" /> : sa.status === 'done' ? <CheckCircle2 size={13} className="mint" /> : <XCircle size={13} className="rose" />}
        <span className="truncate">{sa.name}</span>
        <span className="m">{sa.model.modelId}</span>
      </div>
      <div className="task">{sa.task}</div>
      {sa.status === 'running' && (
        <>
          <div className="feed">
            {sa.tools.slice(-6).map((t, i) => {
              const d = describeCall(t.call)
              return (
                <div key={i} className="truncate">
                  {t.done ? (t.isError ? '✕' : '✓') : '◌'} {d.verb} {d.target}
                </div>
              )
            })}
          </div>
          {(sa.text || sa.reasoning) && <div className="live-text">{(sa.text || sa.reasoning).slice(-300)}</div>}
        </>
      )}
      {sa.status !== 'running' && sa.summary && <div className="live-text">{sa.summary.slice(0, 400)}</div>}
      {sa.durationMs !== undefined && <div className="faint xs">{humanDuration(sa.durationMs)}</div>}
    </div>
  )
}
