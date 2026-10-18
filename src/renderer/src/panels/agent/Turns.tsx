// The conversation laid out the way the user chose (Settings, Appearance, Conversation). Each request becomes
// a segment: what was asked, the steps taken, the answer, and what needs the user (guesses to check, proof,
// the reviewer's opinion). "classic" is drawn by AgentPanel itself; every other layout is drawn here.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Brain, ChevronRight, Eye, Footprints, ChevronLeft, XCircle } from 'lucide-react'
import type { AssistantItem, ConversationLayout, Settings, SystemItem, ToolItem, TranscriptItem, UserItem } from '@shared/types'
import { thoughtIsSummary, useApp } from '@/state/app'
import { useSessions, type LiveRun } from '@/state/sessions'
import { Markdown, type Linker } from '@/components/Markdown'
import { prism } from '@/lib/ipc'
import { cx, humanDuration } from '@/lib/format'
import { useStickToBottom } from '@/lib/stickToBottom'
import { AttachmentList } from './Cards'
import { describeCall, StepBody } from './ToolRow'
import { AssumptionCard, VerdictCard } from './Background'

export type Conv = Settings['conversation']
export const CONV_DEFAULT: Conv = { layout: 'rail', spacing: 'compact', linkedWords: true, needsUnder: true, noRepeat: true, thinking: 'opened', times: true, drawn: 40 }
const NO_CONV = {}
export const useConv = (): Conv => {
  const c = useApp((s) => s.settings?.conversation)
  return useMemo(() => ({ ...CONV_DEFAULT, ...(c ?? NO_CONV) }), [c])
}

export const LAYOUTS: Array<{ id: ConversationLayout; label: string; blurb: string }> = [
  { id: 'rail', label: 'Margin rail', blurb: "The answer on the left, each sentence's steps in the margin beside it." },
  { id: 'strip', label: 'Step strip', blurb: 'Each request is one card: its steps as chips along the top, the answer underneath.' },
  { id: 'folded', label: 'Folded', blurb: 'You watch the steps while it works; when it finishes they fold into one line above the answer.' },
  { id: 'tidy', label: 'Tidy list', blurb: 'Every step in order, all looking the same, each opening on click; then the answer.' },
  { id: 'answer', label: 'Answer only', blurb: 'Just the answer. Underlined words show what backs them up; the steps are one click away.' },
  { id: 'classic', label: 'Classic', blurb: 'Every step as it happened, each in its own style, then the answer.' }
]

// ------------------------------------------------------------ segments

export interface Step {
  item: ToolItem
  /** What it thought or said before this step. */
  thought: string
  /** The items that thought came from. */
  from: string[]
}

export interface Segment {
  key: string
  user: UserItem | null
  /** News that woke the agent when nobody wrote (a finished job, a timer, failed checks). */
  opener: SystemItem | null
  steps: Step[]
  answer: AssistantItem | null
  answerThought: string
  verdicts: SystemItem[]
  reviews: SystemItem[]
  /** Everything else, before and after the answer. */
  before: TranscriptItem[]
  after: TranscriptItem[]
}

const WAKES = new Set(['job', 'watch', 'timer', 'helper', 'team', 'session', 'session-reply', 'lead', 'checks', 'stuck', 'budget'])
const join = (...parts: Array<string | null | undefined>): string => parts.map((p) => p?.trim()).filter(Boolean).join('\n\n')

/**
 * A streaming answer only ever changes the last turn. Handing React the very same Segment objects for the
 * turns that did not change lets it skip them: without this, every word re-rendered the whole conversation,
 * which on a long one (thousands of items) locked the window up for as long as the agent was working.
 */
const segCache = new Map<string, Segment>()

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// steps are built fresh every time, so they are compared by what they hold
function sameSteps(a: readonly Step[], b: readonly Step[]): boolean {
  return a.length === b.length && a.every((x, i) => x.item === b[i]!.item && x.thought === b[i]!.thought && sameList(x.from, b[i]!.from))
}

function sameSeg(a: Segment, b: Segment): boolean {
  return (
    a.user === b.user &&
    a.opener === b.opener &&
    a.answer === b.answer &&
    a.answerThought === b.answerThought &&
    sameSteps(a.steps, b.steps) &&
    sameList(a.verdicts, b.verdicts) &&
    sameList(a.reviews, b.reviews) &&
    sameList(a.before, b.before) &&
    sameList(a.after, b.after)
  )
}

function keepUnchanged(next: Segment[]): Segment[] {
  if (segCache.size > 4000) segCache.clear()
  return next.map((seg) => {
    const old = segCache.get(seg.key)
    if (old && sameSeg(old, seg)) return old
    segCache.set(seg.key, seg)
    return seg
  })
}

export function buildSegments(items: TranscriptItem[]): Segment[] {
  const out: Segment[] = []
  const st: { cur: Segment | null; pending: string; from: string[] } = { cur: null, pending: '', from: [] }
  const open = (user: UserItem | null, opener: SystemItem | null, key: string): Segment => {
    const seg: Segment = { key, user, opener, steps: [], answer: null, answerThought: '', verdicts: [], reviews: [], before: [], after: [] }
    out.push(seg)
    st.cur = seg
    st.pending = ''
    st.from = []
    return seg
  }
  for (const it of items) {
    if (it.kind === 'user') {
      open(it, null, it.id)
      continue
    }
    if (it.kind === 'system') {
      const source = String(it.meta?.['source'] ?? '')
      if (it.subkind === 'notice' && WAKES.has(source) && (!st.cur || st.cur.answer)) {
        open(null, it, it.id)
        continue
      }
      const seg = st.cur ?? open(null, null, it.id)
      if (it.subkind === 'info' && Array.isArray(it.meta?.['verdict'])) seg.verdicts.push(it)
      else if (it.subkind === 'opinion' && it.meta?.['review']) seg.reviews.push(it)
      else (seg.answer ? seg.after : seg.before).push(it)
      continue
    }
    if (it.kind === 'assistant' && it.agent) continue
    const seg = st.cur ?? open(null, null, it.id)
    if (seg.answer) {
      // more work after an answer with no new message: the answer becomes what it said along the way
      st.pending = join(seg.answerThought, seg.answer.text)
      st.from.push(seg.answer.id)
      seg.before.push(...seg.after)
      seg.after = []
      seg.answer = null
      seg.answerThought = ''
    }
    if (it.kind === 'assistant') {
      if (it.toolCalls.length) {
        st.pending = join(st.pending, it.reasoning, it.text)
        st.from.push(it.id)
      } else if (it.text.trim()) {
        seg.answer = it
        seg.answerThought = join(st.pending, it.reasoning)
        st.pending = ''
        st.from = []
      } else {
        st.pending = join(st.pending, it.reasoning)
        st.from.push(it.id)
      }
    } else {
      seg.steps.push({ item: it, thought: st.pending, from: st.from })
      st.pending = ''
      st.from = []
    }
  }
  return keepUnchanged(out)
}

const isAssume = (it: ToolItem): boolean => it.name === 'assume' && !it.isError
const isRun = (it: ToolItem): boolean => ['shell', 'run_snippet', 'check_project', 'browser_look'].includes(it.name)
const exitOf = (it: ToolItem): number | null => (typeof it.meta?.['exitCode'] === 'number' ? (it.meta['exitCode'] as number) : null)
const failed = (it: ToolItem): boolean => it.isError || (exitOf(it) ?? 0) !== 0

// ------------------------------------------------------------ linking words to steps

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PROOF_WORDS = String.raw`all \d+ (?:tests? |checks? )?pass(?:ed)?|tests? (?:now )?pass(?:ed|es)?|checks? pass(?:ed|es)?|verified|checked|proven`

/** Which step backs up each file, command and "tests pass" in an answer. */
export function makeLinker(steps: Step[]): Linker & { mentions(text: string): string[] } {
  const files = new Map<string, string>()
  const base = new Map<string, string | null>()
  const cmds: Array<{ cmd: string; id: string }> = []
  let proof: string | null = null
  for (const { item } of steps) {
    const path = item.diff?.path ?? (typeof item.args['path'] === 'string' ? (item.args['path'] as string) : null)
    if (path && (item.diff || !files.has(path))) {
      files.set(path, item.id)
      const b = path.split('/').pop() ?? path
      if (b !== path && b.includes('.') && b.length >= 4) base.set(b, base.has(b) && base.get(b) !== item.id && !item.diff ? base.get(b)! : item.id)
    }
    if (item.name === 'shell') {
      const c = String(item.args['command'] ?? '').split('\n')[0]!.trim()
      if (c.length >= 4) cmds.push({ cmd: c, id: item.id })
    }
    if (isRun(item) && !failed(item)) proof = item.id
  }
  for (const [b, id] of base) if (id && !files.has(b)) files.set(b, id)
  const keys = [...files.keys()].sort((a, b) => b.length - a.length)
  const fileRe = keys.length ? String.raw`(?<![\w/.-])(?:${keys.map(esc).join('|')})(?![\w/-])` : null
  const re = new RegExp([fileRe ? `(${fileRe})` : '', proof ? `(\\b(?:${PROOF_WORDS})\\b)` : ''].filter(Boolean).join('|') || '(?!)', 'gi')
  const idFor = (m: RegExpExecArray): string | null => (m[1] ? (files.get(m[1]) ?? files.get([...files.keys()].find((k) => k.toLowerCase() === m[1]!.toLowerCase()) ?? '') ?? null) : proof)
  const inCode = (s: string): string | null => {
    const t = s.trim().replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '')
    if (files.has(t)) return files.get(t)!
    const c = [...cmds].reverse().find((x) => x.cmd === s.trim() || (s.trim().length >= 6 && x.cmd.includes(s.trim())))
    return c?.id ?? null
  }
  return {
    inCode,
    inText(s) {
      const out: Array<string | { text: string; id: string }> = []
      let at = 0
      re.lastIndex = 0
      for (let m = re.exec(s); m; m = re.exec(s)) {
        const id = idFor(m)
        if (!id) continue
        if (m.index > at) out.push(s.slice(at, m.index))
        out.push({ text: m[0], id })
        at = m.index + m[0].length
      }
      if (at < s.length) out.push(s.slice(at))
      return out.length ? out : [s]
    },
    mentions(text) {
      const ids: string[] = []
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const id = idFor(m)
        if (id && !ids.includes(id)) ids.push(id)
      }
      for (const code of text.match(/`[^`\n]+`/g) ?? []) {
        const id = inCode(code.slice(1, -1))
        if (id && !ids.includes(id)) ids.push(id)
      }
      return ids
    }
  }
}

/** The answer's top-level blocks, so each can have its steps beside it. */
export function splitBlocks(md: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  const isList = (l: string): boolean => /^\s*([-*+]|\d+[.)])\s/.test(l)
  for (const l of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (!fence && !l.trim()) {
      if (cur.length) out.push(cur.join('\n'))
      cur = []
      continue
    }
    // a list item (or its indented continuation) after a blank line stays with its list
    if (!cur.length && out.length && (isList(l) || /^\s{2,}\S/.test(l)) && out[out.length - 1]!.split('\n').some(isList)) cur = [out.pop()!, '']
    cur.push(l)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

/** Steps go beside the block that mentions them; the ones nobody mentions join the next one that is. */
function placeSteps(blocks: string[], steps: Step[], linker: ReturnType<typeof makeLinker>): Step[][] {
  const where = new Map<string, number>()
  blocks.forEach((b, i) => linker.mentions(b).forEach((id) => !where.has(id) && where.set(id, i)))
  const per: Step[][] = blocks.map(() => [])
  let pending: Step[] = []
  let last = 0
  for (const s of steps) {
    pending.push(s)
    const at = where.get(s.item.id)
    if (at !== undefined) {
      per[at]!.push(...pending)
      pending = []
      last = at
    }
  }
  if (pending.length) per[last]?.push(...pending)
  return per
}

// ------------------------------------------------------------ one step

const SHORT_VERB: Record<string, string> = { 'found files': 'found', 'searched the web': 'searched', 'looked up uses of': 'uses of', 'looked at the page': 'looked', 'ran in the page': 'ran in page' }

function stepLabel(item: ToolItem, short: boolean): { icon: ReactNode; verb: string; target: string } {
  const full = describeCall({ id: item.callId, name: item.name, args: item.args })
  const d = full.verb === '$' ? { ...full, verb: 'ran' } : full
  if (!short) return d
  const isFile = typeof item.args['path'] === 'string' && !!d.target
  return { icon: d.icon, verb: SHORT_VERB[d.verb] ?? d.verb, target: isFile ? (d.target.split('/').pop() ?? d.target) : d.target }
}

function StepTag({ item }: { item: ToolItem }): React.JSX.Element | null {
  if (item.diff)
    return (
      <span className="step-tag">
        <span className="mint">+{item.diff.additions}</span> <span className="rose">−{item.diff.deletions}</span>
      </span>
    )
  const exit = exitOf(item)
  if (exit !== null && exit !== 0) return <span className="step-tag rose">exit {exit}</span>
  if (item.isError) return <span className="step-tag rose">failed</span>
  if (typeof item.meta?.['matches'] === 'number') return <span className="step-tag">{item.meta['matches'] as number} hits</span>
  if (typeof item.meta?.['count'] === 'number') return <span className="step-tag">{item.meta['count'] as number} files</span>
  if (typeof item.meta?.['checkedBy'] === 'string') return <span className="step-tag checked" title={`The checker let this through: ${item.meta['checkedBy'] as string}`}>checked</span>
  return null
}

function StepLine({ step, short, open, fresh, showThought, onClick }: { step: Step; short?: boolean; open?: boolean; fresh?: boolean; showThought?: boolean; onClick?: () => void }): React.JSX.Element {
  const { item } = step
  const d = stepLabel(item, !!short)
  return (
    <>
      <div className={cx('step', open && 'open', failed(item) && 'bad', isAssume(item) && 'assume', fresh && 'fresh')} data-step={item.id} onClick={onClick} title={short ? `${d.verb} ${describeCall({ id: item.callId, name: item.name, args: item.args }).target}` : undefined}>
        <span className="step-ic">{failed(item) ? <XCircle size={13} /> : d.icon}</span>
        <span className="step-lbl">
          {d.verb} {d.target && <b>{d.target}</b>}
        </span>
        {item.agent && <span className="agent-tag">{item.agent}</span>}
        <StepTag item={item} />
      </div>
      {showThought && step.thought && <Thought text={step.thought} />}
    </>
  )
}

function LiveLine({ call, startedAt, short }: { call: LiveRun['pendingTools'][number]['call']; startedAt: number; short?: boolean }): React.JSX.Element {
  const raw = describeCall(call)
  const d = raw.verb === '$' ? { ...raw, verb: 'running' } : raw
  const target = short && typeof call.args['path'] === 'string' ? (d.target.split('/').pop() ?? d.target) : d.target
  return (
    <div className="step live fresh">
      <span className="step-ic">
        <span className="spinner" />
      </span>
      <span className="step-lbl">
        {short ? (SHORT_VERB[d.verb] ?? d.verb) : d.verb} {target && <b>{target}</b>}
      </span>
      <span className="step-tag">
        <Since t={startedAt} />
      </span>
    </div>
  )
}

function Since({ t }: { t: number }): React.JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [])
  return <>{humanDuration(Date.now() - t)}</>
}

function Thought({ text }: { text: string }): React.JSX.Element {
  const [all, setAll] = useState(false)
  return (
    <div
      className={cx('step-thought', all && 'all')}
      title={all ? undefined : 'Show all'}
      onClick={(e) => {
        e.stopPropagation()
        setAll((v) => !v)
      }}
    >
      {text}
    </div>
  )
}

/** A step opened: what it was thinking, why it did it (asked on demand), and what it did. */
export function StepDetail({ step, sessionId, thinking, whyOpen }: { step: Step; sessionId: string | null; thinking: Conv['thinking']; whyOpen?: boolean }): React.JSX.Element {
  const { item } = step
  const [why, setWhy] = useState<string | null>(null)
  const summary = useSessions((s) => thoughtIsSummary(s.sessions.find((x) => x.id === sessionId)?.model))
  const ask = (): void => {
    if (!sessionId) return
    setWhy('…')
    void prism.agent
      .why(sessionId, item.id)
      .then(setWhy)
      .catch((e: unknown) => setWhy(`Could not ask: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`))
  }
  useEffect(() => {
    if (whyOpen && why === null) ask()
  }, [whyOpen]) // eslint-disable-line react-hooks/exhaustive-deps
  const showThought = thinking !== 'never' && !!step.thought
  return (
    <div className="step-detail">
      {(showThought || !isAssume(item)) && (
        <div className="sd-meta">
          {showThought && (
            <div className="sd-line">
              <span className="sd-k">{summary ? 'Thinking summary' : 'Thinking'}</span>
              <Thought text={step.thought} />
            </div>
          )}
          {typeof item.meta?.['checkedBy'] === 'string' && (
            <div className="sd-line">
              <span className="sd-k">Checked</span>
              <span className="sd-why-text">Let through without asking you: {item.meta['checkedBy'] as string}</span>
            </div>
          )}
          {why ? (
            <div className="sd-line">
              <span className="sd-k">Why</span>
              <span className={cx('sd-why-text', why === '…' && 'loading')}>{why === '…' ? 'asking…' : why}</span>
            </div>
          ) : (
            !isAssume(item) && (
              <button className="sd-why" onClick={ask} title="A quick model explains what it was after">
                why?
              </button>
            )
          )}
        </div>
      )}
      {isAssume(item) ? <AssumptionCard text={String(item.args['assumption'] ?? '')} sessionId={sessionId} /> : <StepBody item={item} />}
    </div>
  )
}

// ------------------------------------------------------------ what needs the user

function ReviewRow({ item, onSend }: { item: SystemItem; onSend: (text: string, model: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ok = !!item.meta?.['ok']
  const first = item.text.trim().split(/\n\s*\n/)[0] ?? ''
  const more = item.text.trim().length > first.length
  return (
    <div className={cx('need', ok ? 'calm' : 'amber')}>
      <div className="need-row">
        <Eye size={13} className="need-ic" />
        <span className="need-txt">
          <b>Reviewer{ok ? ': looks right' : ''}</b> <span className="faint">· {String(item.meta?.['model'] ?? 'another model')}</span>
        </span>
        {more && (
          <button className="need-btn ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'less' : 'more'}
          </button>
        )}
        {!ok && (
          <button className="need-btn" onClick={() => onSend(item.text, String(item.meta?.['model'] ?? 'another model'))}>
            Send to Prism
          </button>
        )}
      </div>
      {!(ok && /^looks right\.?$/i.test(item.text.trim())) && (
        <div className="need-body">
          <Markdown text={open || !more ? item.text : first} />
        </div>
      )}
    </div>
  )
}

function Needs({ seg, sessionId, onSendOpinion }: { seg: Segment; sessionId: string | null; onSendOpinion: (text: string, model: string) => void }): React.JSX.Element | null {
  const guesses = seg.steps.filter((s) => isAssume(s.item))
  const verdict = seg.verdicts[seg.verdicts.length - 1]
  if (!guesses.length && !verdict && !seg.reviews.length) return null
  return (
    <div className="needs">
      {guesses.map((g) => (
        <div key={g.item.id} data-item={g.item.id}>
          <AssumptionCard text={String(g.item.args['assumption'] ?? '')} sessionId={sessionId} />
        </div>
      ))}
      {verdict && <VerdictCard item={verdict} />}
      {seg.reviews.map((r) => (
        <ReviewRow key={r.id} item={r} onSend={onSendOpinion} />
      ))}
    </div>
  )
}

// ------------------------------------------------------------ hover card for linked words

function LinkPop({ step, rect }: { step: Step; rect: DOMRect }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: rect.left, top: rect.bottom + 6 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)), top: rect.bottom + h + 12 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - h - 6) })
  }, [rect])
  return createPortal(
    <div className="link-pop" ref={ref} style={pos}>
      <StepLine step={step} />
      <div className="link-pop-body">
        <StepBody item={step.item} />
      </div>
    </div>,
    document.body
  )
}

// ------------------------------------------------------------ one segment

export interface TurnProps {
  seg: Segment
  sessionId: string | null
  /** Set on the segment that is still being worked on. */
  live?: LiveRun
  conv: Conv
  renderItem: (item: TranscriptItem, opts?: { body?: ReactNode; noReasoning?: boolean }) => ReactNode
  onOpenFile: (path: string) => void
  onSendOpinion: (text: string, model: string) => void
  /** Show this item (a find match): open the step it is in. */
  reveal?: { itemId: string; nonce: number } | null
}

function TurnInner(p: TurnProps): React.JSX.Element {
  const { seg, conv, live } = p
  const [openId, setOpenId] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState(false)
  const [thoughtOpen, setThoughtOpen] = useState(false)
  useEffect(() => {
    const id = p.reveal?.itemId
    if (!id) return
    const step = seg.steps.find((s) => s.item.id === id || s.from.includes(id))
    if (step) {
      setUnfolded(true)
      setOpenId(step.item.id)
    } else if (seg.answer?.id === id) setThoughtOpen(true)
  }, [p.reveal?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null)
  const linker = useMemo(() => makeLinker(seg.steps), [seg.steps])
  const link = conv.linkedWords ? linker : undefined
  const steps = conv.needsUnder ? seg.steps.filter((s) => !isAssume(s.item)) : seg.steps
  const running = !!live?.running
  const toggle = (id: string): void => setOpenId((o) => (o === id ? null : id))
  const byId = (id: string): Step | undefined => seg.steps.find((s) => s.item.id === id)

  const onOver = (e: React.MouseEvent): void => {
    const ln = (e.target as HTMLElement).closest<HTMLElement>('.ln[data-step]')
    const id = ln?.dataset['step']
    if (!ln || !id) return setHover(null)
    if (hover?.id !== id) setHover({ id, rect: ln.getBoundingClientRect() })
    // light the step it belongs to
    ln.closest('.turn')?.querySelectorAll(`.step[data-step="${id}"]`).forEach((x) => x.classList.add('lit'))
  }
  const onOut = (e: React.MouseEvent): void => {
    const ln = (e.target as HTMLElement).closest('.ln[data-step]')
    if (ln && !ln.contains(e.relatedTarget as Node)) {
      setHover(null)
      ln.closest('.turn')?.querySelectorAll('.step.lit').forEach((x) => x.classList.remove('lit'))
    }
  }
  const onClick = (e: React.MouseEvent): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.ln[data-step]')?.dataset['step']
    if (id) {
      setHover(null)
      setUnfolded(true)
      setOpenId(id)
    }
    useWork.getState().select(p.sessionId, seg.key)
  }

  const head = seg.user ? p.renderItem(seg.user) : seg.opener ? p.renderItem(seg.opener) : null
  const before = seg.before.map((it) => (
    <div key={it.id} data-item={it.id}>
      {p.renderItem(it)}
    </div>
  ))
  const after = [...seg.after, ...(conv.needsUnder ? [] : [...seg.verdicts, ...seg.reviews])].map((it) => (
    <div key={it.id} data-item={it.id}>
      {p.renderItem(it)}
    </div>
  ))
  const needs = conv.needsUnder && !running ? <Needs seg={seg} sessionId={p.sessionId} onSendOpinion={p.onSendOpinion} /> : null
  const pending = running ? (live?.pendingTools ?? []) : []

  const working = running && !seg.answer ? <Working live={live!} conv={conv} /> : null
  const answerThought =
    seg.answer && seg.answerThought && conv.thinking !== 'never' ? (
      <details className="answer-thought" open={conv.thinking === 'always' || thoughtOpen}>
        <summary>{thoughtIsSummary(seg.answer.model) ? 'thinking summary' : 'thinking'}</summary>
        <Thought text={seg.answerThought} />
      </details>
    ) : null
  const answer = (body: ReactNode): ReactNode => (seg.answer ? p.renderItem(seg.answer, { body, noReasoning: true }) : null)
  const plainAnswer = seg.answer ? <Markdown text={seg.answer.text} onOpenFile={p.onOpenFile} link={link} /> : null

  const list = (short?: boolean): ReactNode => (
    <div className="step-list">
      {steps.map((s, i) => (
        <div key={s.item.id}>
          <StepLine step={s} short={short} open={openId === s.item.id} fresh={running && i === steps.length - 1 && !pending.length} showThought={conv.thinking === 'always'} onClick={() => toggle(s.item.id)} />
          {openId === s.item.id && <StepDetail step={s} sessionId={p.sessionId} thinking={conv.thinking} />}
        </div>
      ))}
      {pending.map((t) => (
        <LiveLine key={t.call.id} call={t.call} startedAt={t.startedAt} short={short} />
      ))}
    </div>
  )

  let body: ReactNode
  const layout = conv.layout
  if (layout === 'tidy') {
    body = (
      <>
        {(steps.length > 0 || pending.length > 0) && list()}
        {before}
        {working}
        {answerThought}
        {answer(plainAnswer)}
      </>
    )
  } else if (layout === 'folded') {
    const showList = running || unfolded
    body = (
      <>
        {!running && steps.length > 0 && (
          <button className={cx('fold-line', unfolded && 'unf')} onClick={() => setUnfolded((v) => !v)}>
            <ChevronRight size={12} className="chev" />
            <span className="truncate">{summaryOf(seg)}</span>
          </button>
        )}
        {showList && (steps.length > 0 || pending.length > 0) && <div className="fold-body">{list()}</div>}
        {before}
        {working}
        {answerThought}
        {answer(plainAnswer)}
      </>
    )
  } else if (layout === 'answer') {
    body = (
      <>
        {before}
        {working}
        {answerThought}
        {answer(plainAnswer)}
        {!running && steps.length > 0 && (
          <button className={cx('fold-line small', unfolded && 'unf')} onClick={() => setUnfolded((v) => !v)}>
            <ChevronRight size={12} className="chev" />
            {unfolded ? 'Hide' : 'Show'} the {steps.length} step{steps.length === 1 ? '' : 's'}
          </button>
        )}
        {unfolded && !running && <div className="fold-body">{list()}</div>}
      </>
    )
  } else if (layout === 'strip') {
    const open = steps.find((s) => s.item.id === openId)
    body = (
      <div className="turn-card">
        {(steps.length > 0 || pending.length > 0) && (
          <div className="chips">
            {steps.map((s, i) => (
              <StepLine key={s.item.id} step={s} short open={openId === s.item.id} fresh={running && i === steps.length - 1 && !pending.length} onClick={() => toggle(s.item.id)} />
            ))}
            {pending.map((t) => (
              <LiveLine key={t.call.id} call={t.call} startedAt={t.startedAt} short />
            ))}
          </div>
        )}
        {open && <StepDetail step={open} sessionId={p.sessionId} thinking={conv.thinking} />}
        {before}
        {working}
        {answerThought}
        {answer(plainAnswer)}
        {needs}
        {after}
      </div>
    )
  } else {
    // margin rail
    if (!seg.answer) {
      body = (
        <>
          {before}
          <div className="mr-grid">
            <div className="mr-main">{working ?? <span className="faint small">No answer.</span>}</div>
            <div className="mr-side">
              {steps.map((s, i) => (
                <StepLine key={s.item.id} step={s} short open={openId === s.item.id} fresh={running && i === steps.length - 1 && !pending.length} onClick={() => toggle(s.item.id)} />
              ))}
              {pending.map((t) => (
                <LiveLine key={t.call.id} call={t.call} startedAt={t.startedAt} short />
              ))}
            </div>
            {openId && byId(openId) && (
              <div className="mr-detail">
                <StepDetail step={byId(openId)!} sessionId={p.sessionId} thinking={conv.thinking} />
              </div>
            )}
          </div>
        </>
      )
    } else {
      body = (
        <>
          {before}
          {answerThought}
          {answer(<RailAnswer text={seg.answer.text} steps={steps} linker={linker} link={link} openId={openId} onToggle={toggle} sessionId={p.sessionId} conv={conv} onOpenFile={p.onOpenFile} />)}
        </>
      )
    }
  }

  return (
    <div className={cx('turn', `turn-${layout}`, running && 'running')} data-seg={seg.key} onMouseOver={onOver} onMouseOut={onOut} onClick={onClick}>
      {head}
      {body}
      <AttachmentList sessionId={p.sessionId} items={steps.map((st) => st.item)} />
      {layout !== 'strip' && needs}
      {layout !== 'strip' && after}
      {hover && byId(hover.id) && <LinkPop step={byId(hover.id)!} rect={hover.rect} />}
    </div>
  )
}

function RailAnswer({ text, steps, linker, link, openId, onToggle, sessionId, conv, onOpenFile }: { text: string; steps: Step[]; linker: ReturnType<typeof makeLinker>; link?: Linker; openId: string | null; onToggle: (id: string) => void; sessionId: string | null; conv: Conv; onOpenFile: (p: string) => void }): React.JSX.Element {
  const blocks = useMemo(() => splitBlocks(text), [text])
  const per = useMemo(() => placeSteps(blocks, steps, linker), [blocks, steps, linker])
  const [lit, setLit] = useState<number | null>(null)
  return (
    <div className="mr-grid">
      {blocks.map((b, i) => {
        const open = per[i]!.find((s) => s.item.id === openId)
        return (
          <div className="mr-row" key={i}>
            <div className={cx('mr-main', lit === i && 'lit')} onMouseEnter={() => setLit(i)} onMouseLeave={() => setLit(null)}>
              <Markdown text={b} onOpenFile={onOpenFile} link={link} />
            </div>
            <div className={cx('mr-side', lit === i && 'lit')} onMouseEnter={() => setLit(i)} onMouseLeave={() => setLit(null)}>
              {per[i]!.map((s) => (
                <StepLine key={s.item.id} step={s} short open={openId === s.item.id} onClick={() => onToggle(s.item.id)} />
              ))}
            </div>
            {open && (
              <div className="mr-detail">
                <StepDetail step={open} sessionId={sessionId} thinking={conv.thinking} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Working({ live, conv }: { live: LiveRun; conv: Conv }): React.JSX.Element {
  const now = live.pendingTools[live.pendingTools.length - 1]
  const doing = now ? `${describeCall(now.call).verb} ${describeCall(now.call).target}` : live.status
  const [openThought, setOpenThought] = useState(false)
  const thought = conv.thinking !== 'never' && live.reasoning?.trim() ? live.reasoning : null
  return (
    <div className="turn-working">
      {live.text ? (
        <div className="msg-assistant">
          <Markdown text={live.text} />
          <span className="cursor-blink" />
        </div>
      ) : (
        <div className="tw-line">
          <span className="tw-dot" />
          <span>Working {live.startedAt ? <Since t={live.startedAt} /> : null}</span>
          {doing && <span className="tw-now truncate">· {doing}</span>}
        </div>
      )}
      {thought &&
        (conv.thinking === 'always' || openThought ? (
          <LiveThinking text={thought} summary={thoughtIsSummary(live.model)} onClose={conv.thinking === 'always' ? undefined : () => setOpenThought(false)} />
        ) : (
          <button className="tw-peek" onClick={() => setOpenThought(true)} title="Watch it think">
            <Brain size={11} /> <span className="truncate">{thought.trim().split('\n').pop()}</span>
          </button>
        ))}
    </div>
  )
}

/** Thinking as it arrives, following the newest words unless the user scrolls back through it. */
export function LiveThinking({ text, onClose, summary }: { text: string; onClose?: () => void; summary?: boolean }): React.JSX.Element {
  const { ref } = useStickToBottom<HTMLDivElement>()
  return (
    <div className="thinking live">
      <div className="thinking-head" onClick={onClose} title={onClose ? 'Hide' : undefined}>
        <Brain size={11} /> {summary ? 'thinking summary' : 'thinking'}
      </div>
      <div className="thinking-text" ref={ref}>
        {text.slice(-6000)}
      </div>
    </div>
  )
}

function summaryOf(seg: Segment): string {
  const tools = seg.steps.map((s) => s.item)
  const reads = new Set(tools.filter((t) => t.name === 'read_file').map((t) => String(t.args['path'] ?? ''))).size
  const changed = tools.filter((t) => t.diff)
  const files = new Set(changed.map((t) => t.diff!.path)).size
  const add = changed.reduce((a, t) => a + t.diff!.additions, 0)
  const del = changed.reduce((a, t) => a + t.diff!.deletions, 0)
  const runs = tools.filter(isRun)
  const bad = runs.filter(failed).length
  const start = seg.user?.ts ?? seg.opener?.ts ?? tools[0]?.ts
  const end = seg.answer?.ts ?? tools[tools.length - 1]?.ts
  const parts = [start && end && end > start ? `Worked ${humanDuration(end - start)}` : `${tools.length} steps`]
  if (reads) parts.push(`read ${reads} file${reads === 1 ? '' : 's'}`)
  if (files) parts.push(`changed ${files} file${files === 1 ? '' : 's'} +${add} −${del}`)
  if (runs.length) parts.push(`ran ${runs.length}${bad ? `, ${bad} failed` : ''}`)
  const other = tools.filter((t) => t.name !== 'read_file' && !t.diff && !isRun(t) && !isAssume(t) && t.name !== 'done_when').length
  if (other > 0 && parts.length > 1) parts.push(`${other} more step${other === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// ------------------------------------------------------------ the work pane

const useWork = create<{ sel: { sessionId: string; key: string } | null; select: (sessionId: string | null, key: string) => void }>((set) => ({
  sel: null,
  select: (sessionId, key) => sessionId && set({ sel: { sessionId, key } })
}))

const NO_ITEMS: TranscriptItem[] = []

/** Every step of one request, opened, beside the conversation. Click a request in the conversation to show it here. */
export function WorkPane(): React.JSX.Element {
  const active = useSessions((s) => s.active)
  const items = useSessions((s) => (s.active ? (s.items[s.active] ?? NO_ITEMS) : NO_ITEMS))
  const live = useSessions((s) => (s.active ? s.live[s.active] : undefined))
  const sel = useWork((s) => s.sel)
  const conv = useConv()
  const segs = useMemo(() => buildSegments(items), [items])
  const chosen = sel && sel.sessionId === active ? segs.findIndex((s) => s.key === sel.key) : -1
  const idx = chosen >= 0 ? chosen : segs.length - 1
  const seg = segs[idx]
  const go = (d: number): void => {
    const next = segs[idx + d]
    if (next) useWork.getState().select(active, next.key)
  }
  const running = !!live?.running && idx === segs.length - 1
  return (
    <div className="work-pane">
      <div className="work-head">
        <Footprints size={13} className="accent" />
        <span className="truncate grow">{seg ? (seg.user?.text ?? seg.opener?.text.split('\n')[0] ?? 'Request') : 'Nothing yet'}</span>
        <button className="icon-btn sm" title="The request before" disabled={idx <= 0} onClick={() => go(-1)}>
          <ChevronLeft size={13} />
        </button>
        <span className="faint xs">{segs.length ? `${idx + 1} of ${segs.length}` : ''}</span>
        <button className="icon-btn sm" title="The request after" disabled={idx >= segs.length - 1} onClick={() => go(1)}>
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="work-body">
        {!seg && <div className="faint small">The steps of a request show here. Click a request in the conversation to choose it.</div>}
        {seg?.steps.map((s) => (
          <div className="work-step" key={s.item.id}>
            <StepLine step={s} />
            <StepDetail step={s} sessionId={active} thinking={conv.thinking === 'never' ? 'never' : 'always'} />
          </div>
        ))}
        {running && live?.pendingTools.map((t) => <LiveLine key={t.call.id} call={t.call} startedAt={t.startedAt} />)}
      </div>
    </div>
  )
}

/** A turn re-renders only when its own segment changed (see keepUnchanged). */
export const Turn = memo(TurnInner)
