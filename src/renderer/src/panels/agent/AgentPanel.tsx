import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, ArrowDown, ArrowLeft, Brain, Clock3, Radar, Eye, EyeOff, FileDiff, History, MoreHorizontal, Paperclip, Plus, GitBranch, Wallet, RotateCcw, Scale, Shrink, Sparkles, Trash2, Square, Undo2, X } from 'lucide-react'
import type { GadgetIdea, LearnOffer, ModelRef, TranscriptItem } from '@shared/types'
import { useSessions, type ChangedFile, type LiveRun, type Queued } from '@/state/sessions'
import { useApp, isClaude, modelKey, modelLabel, thoughtIsSummary } from '@/state/app'
import { useLayout } from '@/state/layout'
import { toastError, useUi } from '@/state/ui'
import { Markdown } from '@/components/Markdown'
import { Composer } from './Composer'
import { impactOfSession } from '@/panels/impact/ImpactPanel'
import { resolveDrift } from '@/panels/spec/SpecPanel'
import { VisualCard } from './VisualCard'
import { BackgroundBar, BudgetButton, NoticeCard, VerdictCard } from './Background'
import { OfferCard } from './OfferCard'
import { GadgetIdeaCard } from './GadgetIdeaCard'
import { LiveToolRow, ToolRow } from './ToolRow'
import { ApprovalCard, AttachmentList, AttachmentsPanel, Plan, QuestionCard, SubagentCard } from './Cards'
import { buildSegments, Turn, useConv, type Segment } from './Turns'
import { clockStamp, cx, humanCost, humanDuration, humanTokens, timeAgo } from '@/lib/format'
import { opensInPreview } from '@/lib/languages'
import { Logo } from '@/components/Logo'
import { ContextMenu, type MenuEntry } from '@/components/ContextMenu'
import { prism } from '@/lib/ipc'
import { undoRequest } from '@/state/refactor'
import { bringIn, discardCopy } from '@/panels/review/CopyChanges'
import { useStickToBottom } from '@/lib/stickToBottom'
import { branchFrom, bringBack } from '@/lib/branch'
import { LiveThinking } from './Turns'
import { FindBar } from './FindBar'
import { CallBar } from './CallBar'
import { clearHighlights, highlightTerms, useFind } from '@/state/find'
import { matchItems, terms, type ConvPart } from '@shared/convSearch'
import { readAloud, useReading } from '@/lib/speech'
import { useCall } from '@/lib/call'

const NO_ITEMS: TranscriptItem[] = []
const NO_CHECKPOINTS: never[] = []
const NO_QUEUE: Queued[] = []

function queueTitle(q: Queued): string {
  const pics = q.attachments.length
  const note = pics ? `\n\n${pics} picture${pics === 1 ? ' goes' : 's go'} with it` : ''
  return `${q.text}${note}\n\nClick to change it`
}

export function AgentPanel({ sessionId }: { sessionId?: string }): React.JSX.Element {
  // A pinned panel follows one session; the main panel follows whichever is active.
  const active = useSessions((s) => sessionId ?? s.active)
  const session = useSessions((s) => s.sessions.find((x) => x.id === (sessionId ?? s.active)))
  const items = useSessions((s) => (active ? (s.items[active] ?? NO_ITEMS) : NO_ITEMS))
  const live = useSessions((s) => (active ? s.live[active] : undefined))
  const copy = useSessions((s) => (active ? s.copies[active] : undefined))
  const checkpoints = useSessions((s) => (active ? (s.checkpoints[active] ?? NO_CHECKPOINTS) : NO_CHECKPOINTS))
  const queue = useSessions((s) => (active ? (s.queue[active] ?? NO_QUEUE) : NO_QUEUE))
  const ensure = useSessions((s) => s.ensure)
  const create = useSessions((s) => s.create)
  const approve = useSessions((s) => s.approve)
  const answer = useSessions((s) => s.answer)
  const abort = useSessions((s) => s.abort)
  const compact = useSessions((s) => s.compact)
  const restore = useSessions((s) => s.restore)
  const rewind = useSessions((s) => s.rewind)
  const dequeue = useSessions((s) => s.dequeue)
  const loadCheckpoints = useSessions((s) => s.loadCheckpoints)
  const models = useApp((s) => s.models)
  const workspace = useApp((s) => s.workspace)
  const follow = useUi((s) => s.follow)
  const setFollow = useUi((s) => s.setFollow)
  const openEditor = useLayout((s) => s.openEditor)
  const openPreview = useLayout((s) => s.openPreview)
  const { ref: scrollRef, stuck, toBottom, release } = useStickToBottom<HTMLDivElement>(!!workspace)
  const [find, setFind] = useState<{ open: boolean; query: string; where: ConvPart[]; errorsOnly: boolean; index: number; focus: number }>({ open: false, query: '', where: [], errorsOnly: false, index: 0, focus: 0 })
  const [reveal, setReveal] = useState<{ itemId: string; nonce: number } | null>(null)
  const [restored, setRestored] = useState<Set<string>>(new Set())
  const [histOpen, setHistOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const phone = !!window.__prismMobile
  const [changesOpen, setChangesOpen] = useState(false)
  const [, tick] = useState(0)
  const [sideOf, setSideOf] = useState<string | null>(null)
  const [queueEdit, setQueueEdit] = useState<{ index: number; text: string } | null>(null)
  /** How many turns are drawn (Settings, Appearance). The rest are not on the page until asked for. */
  const drawn = useApp((s) => s.settings?.conversation?.drawn ?? TURNS_SHOWN)
  /** The phone holds only the latest part of a long conversation until more is wanted. */
  const partial = useSessions((s) => (active ? !!s.partial[active] : false))
  const loading = useSessions((s) => (active ? !!s.loading[active] : false))
  const [limit, setLimit] = useState(drawn)
  useEffect(() => setLimit(drawn), [active, drawn])
  useEffect(() => {
    setSideOf(null)
    if (active) void prism.sessions.extras(active).then((x) => setSideOf(x.sideOf ?? null)).catch(() => {})
  }, [active])
  const mainTitle = useSessions((s) => (sideOf ? s.sessions.find((x) => x.id === sideOf)?.title : undefined))

  useEffect(() => {
    if (active) {
      void ensure(active)
      void loadCheckpoints(active)
    }
    setRestored(new Set())
    setChangesOpen(false)
  }, [active, loadCheckpoints, ensure])

  useEffect(() => {
    if (!live?.running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live?.running])

  // a different session opens at its latest
  useEffect(() => toBottom(), [active, toBottom])

  // ---- find in this conversation
  const matches = useMemo(() => (find.open ? matchItems(items, { text: find.query, where: find.where, errorsOnly: find.errorsOnly }) : []), [find.open, find.query, find.where, find.errorsOnly, items]) // eslint-disable-line react-hooks/exhaustive-deps
  const findTerms = useMemo(() => terms(find.query), [find.query])
  const current = matches[Math.min(find.index, matches.length - 1)]
  const go = (itemId: string): void => {
    release()
    setReveal({ itemId, nonce: Date.now() })
  }
  useEffect(() => {
    if (find.open && current) go(current.itemId)
  }, [find.open, current?.itemId, find.index]) // eslint-disable-line react-hooks/exhaustive-deps
  // once the step is open, bring the match into view and mark every match
  useEffect(() => {
    if (!find.open) clearHighlights()
    if (!find.open && !reveal) return
    let raf = 0
    const t = setTimeout(() => {
      raf = requestAnimationFrame(() => {
        const box = scrollRef.current
        if (!box) return
        const id = reveal?.itemId
        const seg = id ? segments.find((s) => s.steps.some((x) => x.item.id === id || x.from.includes(id))) : undefined
        const stepId = seg?.steps.find((x) => x.item.id === id || x.from.includes(id ?? ''))?.item.id
        // a match inside a step shows in that step's opened detail (one per request)
        const step = stepId ? box.querySelector(`.step[data-step="${stepId}"]`) : null
        const target = (step?.closest('.turn')?.querySelector('.step-detail') ?? step) || (id ? box.querySelector(`[data-item="${id}"]`) : null)
        // it is older than what is drawn: draw the rest and come back for it
        if (!target && id && limit < Number.MAX_SAFE_INTEGER) return setLimit(Number.MAX_SAFE_INTEGER)
        if (target) target.scrollIntoView({ block: 'center' })
        if (find.open) highlightTerms(box, findTerms, target)
        else if (target) {
          // shown without a search: a brief glow says which one
          target.classList.add('reveal-flash')
          window.setTimeout(() => target.classList.remove('reveal-flash'), 1600)
        }
      })
    }, 60)
    return () => {
      clearTimeout(t)
      cancelAnimationFrame(raf)
    }
  }, [reveal?.nonce, find.open, findTerms, items.length, limit]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearHighlights(), [])
  const moveFind = (d: 1 | -1): void => setFind((f) => ({ ...f, index: matches.length ? (f.index + d + matches.length) % matches.length : 0 }))
  const openFind = (query?: string): void => setFind((f) => ({ ...f, open: true, query: query ?? f.query, index: 0, focus: f.focus + 1 }))

  // the search across conversations opens this one at a match
  const findReq = useFind((s) => s.request)
  useEffect(() => {
    if (!findReq || sessionId || findReq.sessionId !== active || !items.some((x) => x.id === findReq.itemId)) return
    if (!findReq.text.trim()) {
      go(findReq.itemId)
      useFind.getState().done()
      return
    }
    const list = matchItems(items, { text: findReq.text, where: [], errorsOnly: false })
    const at = Math.max(0, list.findIndex((m) => m.itemId === findReq.itemId))
    setFind((f) => ({ ...f, open: true, query: findReq.text, where: [], errorsOnly: false, index: at, focus: f.focus + 1 }))
    useFind.getState().done()
  }, [findReq, active, items]) // eslint-disable-line react-hooks/exhaustive-deps

  // these three are handed to every turn, so they must keep their identity: a new function each render would
  // re-render the whole conversation for every streamed word
  const running = live?.running ?? false
  const itemsRef = useRef(items)
  itemsRef.current = items
  const openFile = useCallback((p: string): void => (opensInPreview(p) ? openPreview(p) : openEditor(p)), [openPreview, openEditor])
  const grouped = useMemo(() => groupItems(items), [items])
  const conv = useConv()
  const classic = conv.layout === 'classic'
  const segments = useMemo(() => (classic ? [] : buildSegments(items)), [items, classic])
  const shown = useMemo(() => withLive(segments, live?.running ?? false), [segments, live?.running])
  /** Settled turns and the one being worked on: only the last follows the live run. */
  const past = useMemo(() => shown.slice(0, -1), [shown])
  const liveSeg = shown[shown.length - 1]
  // Only the latest turns are on the page at all. A conversation of thousands is
  // thousands of boxes for the browser to keep placing, and it pays that price for
  // anything that touches the panel — including every letter typed into the
  // message box. Earlier turns are put back a hundred at a time on request, and
  // searching or jumping to a message brings the lot back first.
  // Searching needs the whole conversation on the page; closing the search puts
  // the cap back. This must never latch on, or the cap is off for good.
  useEffect(() => {
    if (find.open) {
      if (active) void useSessions.getState().loadAll(active)
      setLimit(Number.MAX_SAFE_INTEGER)
    } else setLimit(drawn)
  }, [find.open, drawn, active])
  const hidden = Math.max(0, past.length - limit)
  const visible = useMemo(() => (hidden ? past.slice(hidden) : past), [past, hidden])
  // the classic layout draws items rather than turns, and needs the same cap
  const hiddenRows = Math.max(0, grouped.length - limit * 3)
  const rows = useMemo(() => (hiddenRows ? grouped.slice(hiddenRows) : grouped), [grouped, hiddenRows])
  /** Keeps what you were reading still under your eyes as older turns appear above it. */
  const showEarlier = useCallback((): void => {
    if (active) void useSessions.getState().loadAll(active)
    const box = scrollRef.current
    const was = box?.scrollHeight ?? 0
    setLimit((n) => n + MORE_TURNS)
    requestAnimationFrame(() => {
      if (box) box.scrollTop += box.scrollHeight - was
    })
  }, [scrollRef, active])
  const changed = useMemo(() => Object.values(live?.changed ?? {}), [live?.changed])

  const sendOpinion = useCallback(
    (text: string, model: string): void =>
      void useSessions.getState().send(`Another model (${model}) reviewed your last answer and said:\n\n${text}\n\nTake what is right in that into account, correct your work if needed, and say what you changed or why you disagree.`, undefined, active ?? undefined),
    [active]
  )

  const renderItem = useCallback(
    (item: TranscriptItem, opts?: { body?: React.ReactNode; noReasoning?: boolean }): React.ReactNode => (
      <ItemView
        item={item}
        times={conv.times}
        startedAt={item.kind === 'assistant' ? startOf(itemsRef.current, item.id) : undefined}
        body={opts?.body}
        noReasoning={opts?.noReasoning}
        onOpenFile={openFile}
        models={models}
        canRewind={!running}
        onOpinion={async (itemId, ref) => {
          if (!active) return
          try {
            await prism.agent.opinion(active, itemId, ref)
          } catch (e) {
            toastError(e, 'The second opinion failed')
          }
        }}
        onSendOpinion={sendOpinion}
        onRewind={() => {
          if (window.confirm('Rewind to this message? Files changed since will be restored and the later conversation removed.')) void rewind(item.id, active ?? undefined)
        }}
        onUndoRequest={() => active && void undoRequest(active, item.id)}
        onRegenerate={() => {
          // Rewind to the user message before this answer and send it again.
          const all = itemsRef.current
          const idx = all.findIndex((x) => x.id === item.id)
          const user = all.slice(0, idx).reverse().find((x) => x.kind === 'user')
          if (!user || user.kind !== 'user') return
          if (!window.confirm('Regenerate this answer? Files changed since will be restored first.')) return
          const text = user.text
          void rewind(user.id, active ?? undefined).then(() => useSessions.getState().send(text, undefined, active ?? undefined))
        }}
      />
    ),
    [conv.times, models, running, active, openFile, sendOpinion, rewind]
  )
  // how big the conversation is: what every step sends; between turns it is known from the last answer
  const lastSize = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === 'assistant' && it.usage?.inputTokens) return it.usage.inputTokens
    }
    return 0
  }, [items])
  const size = (live?.running && live.contextTokens) || lastSize
  const warnK = useApp((s) => s.settings?.agent.sizeWarnK ?? 200)
  const big = warnK > 0 && size > warnK * 1000
  const [hushed, setHushed] = useState<Record<string, number>>({})
  // "not now" lasts until it grows another 100k
  const showBig = big && !!active && !live?.running && !(hushed[active] && size < hushed[active] + 100_000)

  if (!workspace) {
    return (
      <div className="agent">
        <div className="agent-empty">
          <Logo size={40} />
          <div className="big">Open a folder to start</div>
          <div className="dim">The agent works inside one project at a time.</div>
        </div>
      </div>
    )
  }

  const elapsed = live?.startedAt ? (live.endedAt ?? Date.now()) - live.startedAt : 0
  const ctxPct = live?.contextWindow ? Math.min(100, Math.round((live.contextTokens / live.contextWindow) * 100)) : 0
  const showStrip = live && (live.running || live.usage.input > 0)

  return (
    <div
      className="agent"
      data-space={conv.spacing}
      onKeyDownCapture={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !(e.target as HTMLElement).closest('.monaco-editor')) {
          e.preventDefault()
          e.stopPropagation()
          openFind()
        }
      }}
    >
      <div className="agent-head">
        <div className="agent-head-row">
          <span className={cx('dot', live?.running && 'live')} />
          <span className="agent-title">{session?.title ?? 'New session'}</span>
          {size > 0 && (
            <span className={cx('agent-size', big && 'big')} title={`This conversation is about ${humanTokens(size)} tokens. Every step the model takes sends all of it.`}>
              {humanTokens(size)}
            </span>
          )}
          <span className="grow" />
          {live?.running && (
            <button className="icon-btn" title="Stop" onClick={() => void abort(active ?? undefined)}>
              <Square size={13} />
            </button>
          )}
          <button className={cx('icon-btn', filesOpen && 'on')} title="Files handed over in this conversation" onClick={() => setFilesOpen((v) => !v)} disabled={!active}>
            <Paperclip size={14} />
          </button>
          {phone ? (
            <>
              {!live?.running && (
                <button className="icon-btn" title="New session" onClick={() => void create()}>
                  <Plus size={15} />
                </button>
              )}
              {/* On a phone the row only has room for the title and the buttons used most;
                  the rest are one tap further, in here. */}
              <button className={cx('icon-btn', moreMenu && 'on')} title="More" onClick={(e) => setMoreMenu({ x: e.clientX, y: e.clientY + 16 })}>
                <MoreHorizontal size={16} />
              </button>
              {moreMenu && (
                <ContextMenu
                  x={moreMenu.x}
                  y={moreMenu.y}
                  onClose={() => setMoreMenu(null)}
                  entries={[
                    { label: 'Checkpoints', icon: <History size={14} />, disabled: !!live?.running || !checkpoints.length, onClick: () => setHistOpen((v) => !v) },
                    { label: 'Summarise the conversation', icon: <Shrink size={14} />, disabled: !!live?.running || !items.length, onClick: () => void compact(active ?? undefined) },
                    { label: 'Time machine', icon: <Clock3 size={14} />, disabled: !!live?.running || !active || !items.length, onClick: () => active && useLayout.getState().openTimeline(active) },
                    { label: 'Budget per request', icon: <Wallet size={14} />, disabled: !active, onClick: () => setBudgetOpen(true) },
                    { label: follow ? 'Stop following the agent' : 'Follow the agent', icon: follow ? <EyeOff size={14} /> : <Eye size={14} />, onClick: () => setFollow(!follow) }
                  ]}
                />
              )}
              {active && <BudgetButton sessionId={active} open={budgetOpen} setOpen={setBudgetOpen} />}
            </>
          ) : (
            <>
              {!live?.running && (
                <>
                  <button className={cx('icon-btn', histOpen && 'on')} title="Checkpoints" onClick={() => setHistOpen((v) => !v)} disabled={!checkpoints.length}>
                    <History size={14} />
                  </button>
                  <button className="icon-btn" title="Compact context" onClick={() => void compact(active ?? undefined)} disabled={!items.length}>
                    <Shrink size={14} />
                  </button>
                  <button className="icon-btn" title="Time machine: step through what this session did" onClick={() => active && useLayout.getState().openTimeline(active)} disabled={!active || !items.length}>
                    <Clock3 size={14} />
                  </button>
                  <button className="icon-btn" title="New session" onClick={() => void create()}>
                    <Plus size={15} />
                  </button>
                </>
              )}
              {active && <BudgetButton sessionId={active} />}
              <button className={cx('icon-btn', follow && 'on')} title={follow ? 'Following the agent: files open as it edits them' : 'Not following the agent'} onClick={() => setFollow(!follow)}>
                {follow ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </>
          )}
        </div>
        {live?.running && <div className="shimmer-bar" />}
        {active && sideOf && (
          <div className="side-banner">
            <span className="grow truncate">
              Side chat of <b>{mainTitle ?? 'another conversation'}</b>: that one is untouched.
            </span>
            <button className="btn sm primary" disabled={!!live?.running} onClick={() => bringBack(active, sideOf)} title="Put this side chat's latest answer in that conversation's message box">
              Bring it back
            </button>
          </div>
        )}
        {showStrip && live && (
          <div className="hud-strip">
            <Ring pct={ctxPct} />
            <div className="hud-cell clickable" onClick={() => useLayout.getState().openContext()} title={`${humanTokens(live.contextTokens)} of ${live.contextWindow ? humanTokens(live.contextWindow) : '?'} tokens in the model's context window. Click to see what is in it.`}>
              <span className="hud-v">{ctxPct}%</span>
              <span className="hud-k">context</span>
            </div>
            <div className="hud-cell" title="Model calls so far in this turn">
              <span className="hud-v">{live.step}</span>
              <span className="hud-k">steps</span>
            </div>
            <div className="hud-cell" title={`${humanTokens(live.usage.input)} in, ${humanTokens(live.usage.output)} out this turn`}>
              <span className="hud-v">{humanTokens(live.usage.input + live.usage.output)}</span>
              <span className="hud-k">tokens</span>
            </div>
            {live.tps !== null && (
              <div className="hud-cell" title="Output speed of the latest model call">
                <span className="hud-v">{live.tps}</span>
                <span className="hud-k">tok/s</span>
              </div>
            )}
            <div className="hud-cell" title="Estimated from the model's list prices; flat-rate plans cost nothing extra">
              <span className="hud-v">{live.usage.cost > 0 ? humanCost(live.usage.cost) : '—'}</span>
              <span className="hud-k">cost</span>
            </div>
            <div className="hud-cell" title="Wall-clock time for this turn">
              <span className="hud-v">{humanDuration(elapsed)}</span>
              <span className="hud-k">{live.running ? 'elapsed' : 'took'}</span>
            </div>
            <span className="grow" />
            {changed.length > 0 && (
              <button className={cx('chip clickable', changesOpen ? 'accent' : '')} onClick={() => setChangesOpen((v) => !v)} title="Files changed in this turn">
                <FileDiff size={11} /> {changed.length} file{changed.length === 1 ? '' : 's'}
              </button>
            )}
            <StepDots step={live.step} running={live.running} />
          </div>
        )}
        {live?.running && live.status && (
          <div className="agent-status">
            <span className="spinner" />
            <span className="text">{live.status}</span>
          </div>
        )}
        {changesOpen && changed.length > 0 && (
          <ChangesList
            files={changed}
            onOpen={(p) => openFile(p)}
            onDiff={(p) => {
              const it = [...items].reverse().find((i) => i.kind === 'tool' && i.diff?.path === p)
              if (it && it.kind === 'tool' && it.diff) useLayout.getState().openDiff(p, it.diff.before ?? '', it.diff.after ?? '')
            }}
            onRevert={(f) => f.checkpointId && void useSessions.getState().restoreFile(f.checkpointId, f.path)}
            onReview={() => active && useLayout.getState().openReview(active)}
            onImpact={active && !live?.running ? () => void impactOfSession(active) : undefined}
          />
        )}
        {active && copy && (
          <div className="copy-banner">
            <GitBranch size={13} className="accent" />
            <span className="grow truncate" title={copy.path}>
              Working in its own copy · <span className="mono">{copy.branch}</span> · your files are untouched
            </span>
            <button className="btn sm ghost" onClick={() => useLayout.getState().openCopyChanges(active)}>
              See changes
            </button>
            <button className="btn sm primary" disabled={!!live?.running} onClick={() => void bringIn(active)}>
              Bring into my project
            </button>
            <button className="icon-btn sm" title="Delete the copy and its branch" disabled={!!live?.running} onClick={() => void discardCopy(active)}>
              <Trash2 size={12} />
            </button>
          </div>
        )}
        {live && <Plan todos={live.todos} />}
        {filesOpen && active && <AttachmentsPanel sessionId={active} onGo={go} onClose={() => setFilesOpen(false)} />}
        {histOpen && checkpoints.length > 0 && (
          <div className="agent-plan">
            <div className="plan-summary">Checkpoints</div>
            {checkpoints.slice(0, 8).map((cp) => (
              <div key={cp.id} className="plan-row">
                <RotateCcw size={11} className="faint" />
                <span className="truncate grow" title={cp.files.join('\n')}>
                  {cp.label || 'turn'} · {cp.files.length} file{cp.files.length === 1 ? '' : 's'}
                </span>
                <span className="faint xs">{timeAgo(cp.ts)}</span>
                <button className="btn sm ghost" onClick={() => void restore(cp.id)}>
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {find.open && (
        <FindBar
          query={find.query}
          onQuery={(query) => setFind((f) => ({ ...f, query, index: 0 }))}
          where={find.where}
          onWhere={(where) => setFind((f) => ({ ...f, where, index: 0 }))}
          errorsOnly={find.errorsOnly}
          onErrorsOnly={(errorsOnly) => setFind((f) => ({ ...f, errorsOnly, index: 0 }))}
          count={matches.length}
          index={Math.min(find.index, Math.max(0, matches.length - 1))}
          onMove={moveFind}
          onClose={() => setFind((f) => ({ ...f, open: false }))}
          onSearchAll={() => {
            useFind.getState().presetSearch({ text: find.query, where: find.where, errorsOnly: find.errorsOnly })
            useLayout.getState().openSearchChats()
          }}
          focusKey={find.focus}
        />
      )}
      <div className="transcript" ref={scrollRef} tabIndex={-1}>
        {loading && (
          <div className="loading-row">
            <span className="spinner" />
            <span>Fetching this conversation…</span>
          </div>
        )}
        {items.length === 0 && !loading && !live?.running && models.length === 0 && (
          <div className="agent-empty">
            <Sparkles size={28} className="accent" />
            <div className="big">Connect a model first</div>
            <div className="dim small">Prism talks to any OpenAI-compatible server, Anthropic or Gemini. Add one and probe it; the models appear here.</div>
            <button className="btn solid" onClick={() => useLayout.getState().openSettings('models')}>
              Open provider settings
            </button>
          </div>
        )}
        {items.length === 0 && !loading && !live?.running && models.length > 0 && (
          <div className="agent-empty">
            <Sparkles size={28} className="accent" />
            <div className="big">What should we build?</div>
            <div className="dim small">
              Prism can read, edit and run this project. Use <span className="kbd">@</span> to point at files and <span className="kbd">/</span> for commands.
            </div>
            <div className="hints">
              {['/explain', 'Find and fix the failing tests', 'Add a README for this project', '/review'].map((h) => (
                <button key={h} className="hint-chip" onClick={() => void useSessions.getState().send(h, undefined, active ?? undefined)}>
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}
        {!classic && (
          <>
            {(hidden > 0 || partial) && (
              <button className="earlier-btn" onClick={showEarlier} title="They are all still here; they are just not drawn until you ask, so the app stays quick">
                {hidden > 0 ? `Show earlier messages · ${hidden} above` : 'Show earlier messages'}
              </button>
            )}
            {/* Everything already answered is its own component, so a streamed
                word compares one set of props instead of rebuilding every turn. */}
            <PastTurns segs={visible} sessionId={active} conv={conv} renderItem={renderItem} onOpenFile={openFile} onSendOpinion={sendOpinion} reveal={reveal} />
            {liveSeg && <Turn key={liveSeg.key} seg={liveSeg} sessionId={active} live={live} conv={conv} renderItem={renderItem} onOpenFile={openFile} onSendOpinion={sendOpinion} reveal={reveal} />}
          </>
        )}
        {classic && hiddenRows > 0 && (
          <button className="earlier-btn" onClick={showEarlier} title="They are all still here; they are just not drawn until you ask, so the app stays quick">
            Show earlier messages · {hiddenRows} above
          </button>
        )}
        {classic &&
          rows.map((g, i) =>
          g.kind === 'files' ? (
            <AttachmentList key={'f' + g.items[0]!.id} sessionId={active} items={g.items} />
          ) : g.kind === 'tools' ? (
            <div className="tool-group" key={`g${i}`}>
              {g.items.map((it) => (
                <ToolRow
                  key={it.id}
                  item={it}
                  restored={it.diff ? restored.has(it.diff.path) : false}
                  onRestore={
                    it.diff
                      ? () => {
                          const cp = checkpoints[0]
                          if (cp) void useSessions.getState().restoreFile(cp.id, it.diff!.path).then(() => setRestored((s) => new Set(s).add(it.diff!.path)))
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div key={g.item.id} data-item={g.item.id}>
              {renderItem(g.item)}
            </div>
          )
        )}
        {live && <LiveView cardsOnly={!classic} live={live} onPlan={(p) => active && useLayout.getState().openPlan(active, p.planId, p.title)} onReview={(r) => active && useLayout.getState().openReview(active, r.reviewId, r.title)} onApprove={(id, d) => void approve(id, d, active ?? undefined)} onAnswer={(id, a) => void answer(id, a, active ?? undefined)} />}
        {live && !live.running && live.lastReason && live.lastReason !== 'completed' && (
          <div className="run-note">{live.lastReason === 'aborted' ? 'stopped' : live.lastReason === 'max-steps' ? 'step limit reached' : live.lastReason === 'budget' ? 'paused: budget reached' : live.lastReason === 'stuck' ? 'stopped: it was going round in circles' : 'ended with an error'}</div>
        )}
      </div>

      {!stuck && (
        <div className="to-latest-anchor">
          <button className="to-latest" onClick={toBottom} title="Back to the latest, and keep following">
            <ArrowDown size={12} /> Latest
          </button>
        </div>
      )}
      {queue.length > 0 && (
        <div className="queue-strip">
          <span className="hud-label">Queued</span>
          {queue.map((q, i) =>
            queueEdit?.index === i ? (
              <input
                key={i}
                className="input sm queue-edit"
                autoFocus
                value={queueEdit.text}
                onChange={(e) => setQueueEdit({ index: i, text: e.target.value })}
                onBlur={() => {
                  useSessions.getState().editQueue(i, queueEdit.text, active ?? undefined)
                  setQueueEdit(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setQueueEdit(null)
                }}
              />
            ) : (
              <span key={i} className="chip queue-chip" title={queueTitle(q)}>
                {i > 0 && (
                  <button className="icon-btn sm" style={{ width: 16, height: 16 }} title="Send this one earlier" onClick={() => useSessions.getState().moveQueue(i, -1, active ?? undefined)}>
                    <ArrowLeft size={10} />
                  </button>
                )}
                <span className="truncate" style={{ maxWidth: 220, cursor: 'text' }} onClick={() => setQueueEdit({ index: i, text: q.text })}>
                  {q.attachments.length > 0 && <ImageIcon size={10} style={{ marginRight: 4, verticalAlign: -1 }} />}
                  {q.text}
                </span>
                <button className="icon-btn sm" style={{ width: 16, height: 16 }} title="Take it out of the queue" onClick={() => dequeue(i, active ?? undefined)}>
                  <X size={10} />
                </button>
              </span>
            )
          )}
        </div>
      )}
      {showBig && active && (
        <div className="size-warn">
          <span className="grow size-warn-text" title="Every step sends the whole conversation, so a long one uses up your plan or credit fast. Summarising keeps what matters and makes each step much cheaper.">
            Long conversation (<b>{humanTokens(size)}</b>): every step costs more.
          </span>
          <button className="btn sm size-warn-go" onClick={() => void compact(active)}>
            Summarise
          </button>
          <button className="btn sm ghost size-warn-new" onClick={() => void create()}>
            New session
          </button>
          <button className="icon-btn sm size-warn-close" title="Not now" onClick={() => setHushed((h) => ({ ...h, [active]: size }))}>
            <X size={11} />
          </button>
        </div>
      )}
      {active && live?.background && <BackgroundBar sessionId={active} state={live.background} />}
      <CallBar />
      <EndedOrComposer sessionId={active} running={!!live?.running} />
    </div>
  )
}

/**
 * Biteback: a conversation the agent ended takes no more messages (main/agent-host.ts), so in
 * place of the message box it says so, and offers a fresh one. Its handover is its last answer.
 */
function EndedOrComposer({ sessionId, running }: { sessionId: string | null; running: boolean }): React.JSX.Element {
  const [ended, setEnded] = useState<{ reason: string } | null>(null)
  const sessions = useSessions((s) => s.sessions)
  useEffect(() => {
    if (!sessionId) return setEnded(null)
    let live = true
    void prism.sessions
      .extras(sessionId)
      .then((e) => live && setEnded(e.ended ?? null))
      .catch(() => {})
    return () => {
      live = false
    }
    // looked at again when the list changes or a turn finishes: that is when an ending happens
  }, [sessionId, sessions, running])
  if (!ended) return <Composer sessionId={sessionId} />
  return (
    <div className="ended-box">
      <div>
        <b>The agent ended this conversation.</b> {ended.reason}
      </div>
      <div className="faint small">Its handover, what's done and what it would do next, is its last answer above. The reason is in the Decisions ledger too.</div>
      <div>
        <button className="btn primary" onClick={() => void useSessions.getState().create()}>
          Start a new conversation
        </button>
      </div>
    </div>
  )
}

function Ring({ pct }: { pct: number }): React.JSX.Element {
  const r = 11
  const c = 2 * Math.PI * r
  const color = pct > 85 ? 'var(--rose)' : pct > 65 ? 'var(--amber)' : 'var(--accent)'
  return (
    <svg className="ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden>
      <circle cx="15" cy="15" r={r} style={{ stroke: 'var(--line-strong)' }} strokeWidth="3" fill="none" />
      <circle
        cx="15"
        cy="15"
        r={r}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform="rotate(-90 15 15)"
        style={{ stroke: color, transition: 'stroke-dasharray 400ms var(--ease)', filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  )
}

function StepDots({ step, running }: { step: number; running: boolean }): React.JSX.Element {
  const n = Math.min(step, 24)
  return (
    <span className="step-dots" title={`${step} steps`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={cx(i === n - 1 && running && 'now')} />
      ))}
      {step > 24 && <span className="faint xs">+{step - 24}</span>}
    </span>
  )
}

function ChangesList({ files, onOpen, onDiff, onRevert, onReview, onImpact }: { files: ChangedFile[]; onOpen: (p: string) => void; onDiff: (p: string) => void; onRevert: (f: ChangedFile) => void; onReview: () => void; onImpact?: () => void }): React.JSX.Element {
  return (
    <div className="agent-plan changes">
      <div className="plan-row">
        <span className="hud-label grow">Changed this turn</span>
        {onImpact && (
          <button className="btn sm" onClick={onImpact} title="Which uses of the changed code could break, and which tests to run">
            <Radar size={12} /> What could break
          </button>
        )}
        <button className="btn sm primary" onClick={onReview} title="Go through every change piece by piece and undo what you do not want">
          Review changes
        </button>
      </div>
      {files.map((f) => (
        <div key={f.path} className="plan-row">
          <span className="truncate grow mono" style={{ cursor: 'pointer' }} onClick={() => onOpen(f.path)} title="Open">
            {f.path}
          </span>
          {f.created && <span className="chip mint">new</span>}
          {f.deleted && <span className="chip rose">deleted</span>}
          <span className="mint xs">+{f.additions}</span>
          <span className="rose xs">−{f.deletions}</span>
          {!f.deleted && (
            <button className="icon-btn sm" title="Side-by-side diff" onClick={() => onDiff(f.path)}>
              <FileDiff size={12} />
            </button>
          )}
          <button className="icon-btn sm" title="Revert this file" disabled={!f.checkpointId} onClick={() => onRevert(f)}>
            <Undo2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

type ToolIt = Extract<TranscriptItem, { kind: 'tool' }>
type Group = { kind: 'tools'; items: ToolIt[] } | { kind: 'item'; item: TranscriptItem } | { kind: 'files'; items: ToolIt[] }

function groupItems(items: TranscriptItem[]): Group[] {
  const out: Group[] = []
  // Files handed over are drawn at the end of the turn, under the answer that follows
  // them, not among the steps where they happened.
  let files: ToolIt[] = []
  const flush = (): void => {
    if (files.length) out.push({ kind: 'files', items: files })
    files = []
  }
  for (const it of items) {
    if (it.kind === 'user') flush()
    if (it.kind === 'tool') {
      if (it.meta?.['attach'] && !it.isError) files.push(it)
      const last = out[out.length - 1]
      if (last && last.kind === 'tools') last.items.push(it)
      else out.push({ kind: 'tools', items: [it] })
    } else if (it.kind === 'assistant' && !it.text.trim() && !it.reasoning) {
      continue
    } else {
      out.push({ kind: 'item', item: it })
    }
  }
  flush()
  return out
}

/**
 * The turns that are finished. Nothing here changes while the agent streams, so
 * the whole list is skipped in one comparison rather than a thousand.
 */
const PastTurns = memo(function PastTurns(p: {
  segs: Segment[]
  sessionId: string | null
  conv: ReturnType<typeof useConv>
  renderItem: (item: TranscriptItem, opts?: { body?: React.ReactNode; noReasoning?: boolean }) => React.ReactNode
  onOpenFile: (path: string) => void
  onSendOpinion: (text: string, model: string) => void
  reveal: { itemId: string; nonce: number } | null
}): React.JSX.Element {
  // Turns are grouped in blocks of fifty. A turn off screen already skips its own
  // contents, but a thousand of them are still a thousand boxes to place, and the
  // browser redoes that for anything that touches the panel — every letter typed
  // into the message box. Off-screen blocks are skipped whole, so a long
  // conversation costs tens of boxes instead of thousands, and nothing is dropped
  // from the page: scrolling back and find still reach all of it.
  const blocks: Segment[][] = []
  for (let i = 0; i < p.segs.length; i += BLOCK) blocks.push(p.segs.slice(i, i + BLOCK))
  return (
    <>
      {blocks.map((block, i) => (
        <div className="turn-block" key={block[0]?.key ?? i}>
          {block.map((seg) => (
            <Turn key={seg.key} seg={seg} sessionId={p.sessionId} conv={p.conv} renderItem={p.renderItem} onOpenFile={p.onOpenFile} onSendOpinion={p.onSendOpinion} reveal={p.reveal} />
          ))}
        </div>
      ))}
    </>
  )
})

const BLOCK = 50
/** Turns drawn to begin with, and how many more each "show earlier" brings back. */
const TURNS_SHOWN = 40
const MORE_TURNS = 100

/**
 * While it works on something nobody has answered yet, the live segment is the
 * last one (or a new one). It takes `running` rather than the whole live run so
 * the list it returns does not change on every streamed word.
 */
function withLive(segs: Segment[], running: boolean): Segment[] {
  const last = segs[segs.length - 1]
  if (!running || (last && !last.answer)) return segs
  return [...segs, { key: 'live', user: null, opener: null, steps: [], answer: null, answerThought: '', verdicts: [], reviews: [], before: [], after: [] }]
}

function startOf(items: TranscriptItem[], id: string): number | undefined {
  const i = items.findIndex((x) => x.id === id)
  for (let j = i - 1; j >= 0; j--) {
    const x = items[j]!
    if (x.kind === 'user') return x.ts
    if (x.kind === 'assistant' && !x.toolCalls.length && x.text.trim()) return undefined
  }
  return undefined
}

function Stamp({ ts, startedAt }: { ts: number; startedAt?: number }): React.JSX.Element {
  return (
    <div className="msg-time" title={new Date(ts).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' })}>
      {clockStamp(ts)}
      {startedAt && ts > startedAt ? <span> · took {humanDuration(ts - startedAt)}</span> : null}
    </div>
  )
}

function ItemView({
  item,
  times,
  startedAt,
  body,
  noReasoning,
  onOpenFile,
  models,
  canRewind,
  onRewind,
  onUndoRequest,
  onRegenerate,
  onOpinion,
  onSendOpinion
}: {
  item: TranscriptItem
  times?: boolean
  startedAt?: number
  body?: React.ReactNode
  noReasoning?: boolean
  onOpenFile: (p: string) => void
  models: ReturnType<typeof useApp.getState>['models']
  canRewind: boolean
  onRewind: () => void
  onUndoRequest: () => void
  onRegenerate: () => void
  onOpinion: (itemId: string, model: ModelRef) => Promise<void>
  onSendOpinion: (text: string, model: string) => void
}): React.JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [opinionMenu, setOpinionMenu] = useState<{ x: number; y: number } | null>(null)
  const [asking, setAsking] = useState(false)
  const reading = useReading((st) => st.id === item.id)
  // a call already says everything out loud; a second voice over it would be noise
  const onCall = useCall((st) => !!st.on)
  const text = item.kind === 'user' || item.kind === 'assistant' ? item.text : item.kind === 'system' ? item.text : ''
  const entries = (): MenuEntry[] => {
    const out: MenuEntry[] = [{ label: 'Copy text', onClick: () => void navigator.clipboard.writeText(text) }]
    if (item.kind === 'user') {
      out.push(
        { label: 'Edit and resend', disabled: !canRewind, onClick: onRewind },
        { label: 'Rewind to here', disabled: !canRewind, onClick: onRewind },
        { label: 'Undo just this request (keep what came after)', disabled: !canRewind, onClick: onUndoRequest },
        { label: 'Branch from here (a new session with this message to change)', onClick: () => void branchFrom(item.id) },
        {
          label: 'Save as a recipe',
          onClick: () => {
            const app = useApp.getState()
            const recipes = app.settings?.recipes ?? []
            void app
              .updateSettings({ recipes: [...recipes, { id: Math.random().toString(16).slice(2, 10), name: text.replace(/\s+/g, ' ').slice(0, 48), text }] })
              .then(() => useUi.getState().toast('success', 'Saved as a recipe', 'Find it in Ctrl+Shift+P as "Recipe: …". Rename it, or put {{blanks}} to fill in, under Settings, Helpers & extras.'))
              .catch(toastError)
          }
        }
      )
    }
    if (item.kind === 'assistant') {
      out.push({ label: 'Regenerate', disabled: !canRewind, onClick: onRegenerate })
      out.push({ label: 'Branch from here (a new session that carries on from this answer)', onClick: () => void branchFrom(item.id) })
    }
    return out
  }
  const ctx = (e: React.MouseEvent): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  const menuEl = menu ? <ContextMenu x={menu.x} y={menu.y} entries={entries()} onClose={() => setMenu(null)} /> : null
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user-wrap" data-item={item.id} onContextMenu={ctx}>
          {menuEl}
          <div className="msg-user">
            {item.text}
            {item.attachments.length > 0 && (
              <div className="attach-row">
                {item.attachments.map((a) => (
                  <img key={a.id} src={`prism://attach/${a.path.split(/[\\/]/).pop()}`} alt={a.name} title={a.description ?? a.name} />
                ))}
              </div>
            )}
          </div>
          {times !== false && <Stamp ts={item.ts} />}
          {canRewind && (
            <div className="msg-user-acts">
              <button className="rewind-btn" title="Take out only what this request changed, keeping everything done since" onClick={onUndoRequest}>
                <Undo2 size={11} /> undo just this
              </button>
              <button className="rewind-btn" title="Rewind to here: restore files and remove everything after this message" onClick={onRewind}>
                <RotateCcw size={11} /> rewind
              </button>
            </div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="msg-assistant" data-item={item.id} onContextMenu={ctx}>
          {menuEl}
          {item.reasoning && !noReasoning && (
            <details className="thinking">
              <summary>
                <Brain size={11} /> <span className="thinking-label">{thoughtIsSummary(item.model) ? 'thinking summary' : 'thought'}</span>
                <span className="thinking-peek">{item.reasoning.trim().split('\n')[0]}</span>
              </summary>
              <div className="thinking-text">{item.reasoning}</div>
            </details>
          )}
          {body ?? (item.text.trim() && <Markdown text={item.text} onOpenFile={onOpenFile} />)}
          {times !== false && item.text.trim() && !item.toolCalls.length && <Stamp ts={item.ts} startedAt={startedAt} />}
          <div className="msg-meta">
            <span>{modelLabel(models, item.model)}</span>
            {item.usage && (
              <span>
                {humanTokens(item.usage.inputTokens)}↑ {humanTokens(item.usage.outputTokens)}↓
              </span>
            )}
            {item.usage?.latencyMs !== undefined && <span>{humanDuration(item.usage.latencyMs)}</span>}
            {item.text.trim() && !onCall && (
              <button className="msg-copy" title={reading ? 'Stop reading it out' : 'Read it out loud'} onClick={() => void readAloud(item.id, item.text)}>
                {reading ? 'stop' : 'play'}
              </button>
            )}
            <button className="msg-copy" title="Copy" onClick={() => void navigator.clipboard.writeText(item.text)}>
              copy
            </button>
            {item.text.trim() && !item.agent && (
              <button className="msg-copy" title="Have another model check this answer" disabled={asking} onClick={(e) => setOpinionMenu({ x: e.clientX, y: e.clientY })}>
                {asking ? 'asking…' : 'second opinion'}
              </button>
            )}
            {opinionMenu && (
              <ContextMenu
                x={opinionMenu.x}
                y={opinionMenu.y}
                onClose={() => setOpinionMenu(null)}
                entries={[...models]
                  .filter((m) => modelKey(m) !== modelKey(item.model) && !isClaude(m))
                  .sort((a, b) => Number(b.favorite) - Number(a.favorite))
                  .slice(0, 14)
                  .map((m) => ({
                    label: `${m.favorite ? '★ ' : ''}${m.modelId}`,
                    hint: m.endpointName,
                    onClick: () => {
                      setAsking(true)
                      void onOpinion(item.id, { endpointId: m.endpointId, modelId: m.modelId }).finally(() => setAsking(false))
                    }
                  }))}
              />
            )}
          </div>
        </div>
      )
    case 'system':
      if (item.subkind === 'compaction') {
        return (
          <details className="sys-item compaction">
            <summary>
              <Shrink size={12} /> Context compacted · earlier conversation summarised
            </summary>
            <div className="md" style={{ marginTop: 8 }}>
              <Markdown text={item.text} />
            </div>
          </details>
        )
      }
      if (item.subkind === 'info' && item.meta?.['offer']) return <OfferCard offer={item.meta['offer'] as LearnOffer} />
      if (item.subkind === 'info' && item.meta?.['gadgetIdea']) return <GadgetIdeaCard idea={item.meta['gadgetIdea'] as GadgetIdea} />
      if (item.subkind === 'info' && Array.isArray(item.meta?.['specDrift'])) {
        const drift = item.meta['specDrift'] as Array<{ title: string; note: string }>
        return (
          <div className="sys-item info spec-note">
            <div>{item.text}</div>
            {drift.map((d) => (
              <div key={d.title} className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <span className="small">“{d.title}”</span>
                <button className="btn sm" onClick={() => void resolveDrift(d.title, 'spec', useSessions.getState().active)}>
                  Update the spec
                </button>
                <button className="btn sm" onClick={() => void resolveDrift(d.title, 'code', useSessions.getState().active)}>
                  Fix the code
                </button>
                <button className="btn sm ghost" onClick={() => void resolveDrift(d.title, 'ignore', useSessions.getState().active)}>
                  It is fine
                </button>
              </div>
            ))}
          </div>
        )
      }
      if (item.subkind === 'notice' && item.meta?.['source'] === 'steer') {
        return (
          <div className="msg-user-wrap steered">
            <div className="msg-user">
              {item.text}
              <div className="steer-tag">sent while it was working</div>
            </div>
          </div>
        )
      }
      if (item.subkind === 'notice') return <NoticeCard item={item} />
      if (item.subkind === 'info' && Array.isArray(item.meta?.['verdict'])) return <VerdictCard item={item} />
      if (item.subkind === 'visual') return <VisualCard url={String(item.meta?.['url'] ?? '')} before={String(item.meta?.['before'] ?? '')} after={String(item.meta?.['after'] ?? '')} />
      if (item.subkind === 'opinion') {
        return (
          <div className="opinion">
            <div className="opinion-head">
              <Scale size={13} className={item.meta?.['review'] ? (item.meta?.['ok'] ? 'mint' : 'amber') : 'violet'} />
              <b>{item.meta?.['review'] ? (item.meta?.['ok'] ? 'Reviewed: looks right' : 'Review of this turn') : 'Second opinion'}</b>
              <span className="faint">· {String(item.meta?.['model'] ?? 'another model')}</span>
              <span className="grow" />
              <button className="btn sm ghost" title="Give this review to Prism so it can act on it" onClick={() => onSendOpinion(item.text, String(item.meta?.['model'] ?? 'another model'))}>
                Send to Prism
              </button>
            </div>
            <Markdown text={item.text} onOpenFile={onOpenFile} />
          </div>
        )
      }
      return <div className={cx('sys-item', item.subkind)}>{item.text}</div>
    default:
      return null
  }
}

function LiveView({ live, cardsOnly, onApprove, onAnswer, onReview, onPlan }: { live: LiveRun; cardsOnly?: boolean; onPlan: (p: LiveRun['plans'][number]) => void; onReview: (r: LiveRun['reviews'][number]) => void; onApprove: (id: string, d: 'once' | 'always' | 'deny') => void; onAnswer: (id: string, a: string) => void }): React.JSX.Element | null {
  const subs = Object.values(live.subagents)
  if (!live.running && !live.approvals.length && !live.questions.length && !live.reviews.length && !live.plans.length && !subs.some((s) => s.status === 'running')) return null
  return (
    <>
      {live.reasoning && !cardsOnly && <LiveThinking text={live.reasoning} summary={thoughtIsSummary(live.model)} />}
      {live.text && !cardsOnly && (
        <div className="msg-assistant">
          <Markdown text={live.text} />
          <span className="cursor-blink" />
        </div>
      )}
      {live.pendingTools.length > 0 && !cardsOnly && (
        <div className="tool-group">
          {live.pendingTools.map((t) => (
            <LiveToolRow key={t.call.id} call={t.call} output={t.output} agent={t.agent} startedAt={t.startedAt} />
          ))}
        </div>
      )}
      {subs.length > 0 && (
        <div className="subagents">
          {subs.map((sa) => (
            <SubagentCard key={sa.name} sa={sa} />
          ))}
        </div>
      )}
      {live.approvals.map((a) => (
        <ApprovalCard key={a.approvalId} req={a} onDecide={(d) => onApprove(a.approvalId, d)} />
      ))}
      {live.plans.map((p) => (
        <div key={p.planId} className="approval low">
          <div className="row" style={{ gap: 8 }}>
            <span className="grow">
              <b>Prism has a plan:</b> {p.title} <span className="faint">· nothing has been changed yet</span>
            </span>
            <button className="btn sm solid" onClick={() => onPlan(p)}>
              Read the plan
            </button>
          </div>
        </div>
      ))}
      {live.reviews.map((r) => (
        <div key={r.reviewId} className="approval low">
          <div className="row" style={{ gap: 8 }}>
            <span className="grow">
              <b>Prism proposes:</b> {r.title} <span className="faint">· {r.files.length} file{r.files.length === 1 ? '' : 's'}, nothing written yet</span>
            </span>
            <button className="btn sm solid" onClick={() => onReview(r)}>
              Review
            </button>
          </div>
        </div>
      ))}
      {live.questions.map((q) => (
        <QuestionCard key={q.questionId} req={q} onAnswer={(a) => onAnswer(q.questionId, a)} />
      ))}
      {live.running && !cardsOnly && !live.text && !live.reasoning && !live.pendingTools.length && !live.approvals.length && !live.questions.length && (
        <div className="live-wait">
          <span className="wait-orb" />
          <span className="wait-text">{live.status ?? 'Thinking…'}</span>
        </div>
      )}
    </>
  )
}

void prism
