import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MicButton } from './MicButton'
import { VoiceBox } from './VoiceBox'
import { PlusMenu } from './PlusMenu'
import { CallButton } from './CallButton'
import { ArrowUp, AtSign, Brain, Eye, FileCode2, Gauge, Image as ImageIcon, Lock, Map as MapIcon, ShieldCheck, Slash, Split, Square, TextCursorInput, Unlock, Wand2, X } from 'lucide-react'
import { TryWaysDialog } from '@/panels/multiverse/Multiverse'
import type { Attachment, Effort, ModelRef, PermissionMode } from '@shared/types'
import { prism } from '@/lib/ipc'
import { useApp, isClaude, modelKey, modelName, refFromKey } from '@/state/app'
import { useSessions } from '@/state/sessions'
import { toastError } from '@/state/ui'
import { Select, type SelectOption } from '@/components/Select'
import { cx } from '@/lib/format'
import { useLayout } from '@/state/layout'
import { useEditor } from '@/state/editor'
import { currentLook, lookKey, useLooking, type Look } from '@/state/looking'
import { cancelRecording, useVoice } from '@/lib/voice'
import { report } from '@/demo/bus'
import { registerSurface } from '@/demo/bus'

const EFFORT_LABEL: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'very high', max: 'the most' }
const EFFORT_NOTE: Record<Effort, string> = {
  low: 'Quick answers, least thinking',
  medium: 'A middling amount of thinking',
  high: 'Thinks things through',
  xhigh: 'Thinks harder, slower and dearer',
  max: 'As much thinking as the model allows'
}

/** A picture is sent no bigger than this on its longest side: more than any model looks at. */
const MAX_SIDE = 2048
/** Below this a picture is sent as it is, unless it is also too big on a side. */
const SMALL_ENOUGH = 1_500_000

/**
 * A picture made small enough to send.
 *
 * A phone camera's photo is several megabytes, and it travels base64 encoded through
 * the encrypted channel — slow over the relay, and larger than some providers take for
 * one image. Shrunk on the device it came from, it arrives quickly and the model loses
 * nothing it would have used. The phone's own turning of a photo (which way up it was
 * held) is kept, because the browser applies it while decoding. Anything that will not
 * decode here, an unusual format say, is sent as it was rather than not at all.
 */
async function fitForSending(f: File): Promise<File> {
  if (!f.type.startsWith('image/') || f.type === 'image/gif' || f.type === 'image/svg+xml') return f
  try {
    const bmp = await createImageBitmap(f)
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    if (scale === 1 && f.size < SMALL_ENOUGH) {
      bmp.close()
      return f
    }
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')?.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    // a screenshot may have see-through parts, which a JPEG would turn black
    const png = f.type === 'image/png'
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.86))
    if (!blob || blob.size >= f.size) return f
    return new File([blob], (f.name || 'photo').replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg'), { type: blob.type })
  } catch {
    return f
  }
}

/** Longest selection sent with a message; past that the agent is told to read the file itself. */
const LOOK_LINES = 400
const LOOK_CHARS = 16_000

function lookNote(l: Look): string {
  if (!l.text) return `@${l.path} (the file I have open)`
  const lines = l.text.split('\n')
  const cut = lines.length > LOOK_LINES || l.text.length > LOOK_CHARS
  const body = cut ? lines.slice(0, LOOK_LINES).join('\n').slice(0, LOOK_CHARS) : l.text
  const more = cut ? ', shortened: read the file for the rest' : ''
  return `@${l.path} (lines ${l.line}-${l.endLine}, what I have selected${more})\n` + '```\n' + body + '\n```'
}

interface Suggest {
  kind: 'file' | 'command'
  items: Array<{ value: string; label: string; sub?: string }>
  query: string
  start: number
}

export function Composer({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const models = useApp((s) => s.models)
  const settings = useApp((s) => s.settings)
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId))
  // only whether it is working: subscribing to the whole live run re-rendered the
  // message box on every streamed word
  const running = useSessions((s) => (sessionId ? !!s.live[sessionId]?.running : false))
  const commands = useSessions((s) => s.commands)
  const draft = useSessions((s) => (sessionId ? (s.draft[sessionId] ?? '') : ''))
  const setDraft = useSessions((s) => s.setDraft)
  const send = useSessions((s) => s.send)
  const abort = useSessions((s) => s.abort)
  const setMode = useSessions((s) => s.setMode)
  const setModel = useSessions((s) => s.setModel)
  const pending = useSessions((s) => s.pending)
  const [local, setLocal] = useState(draft)
  const localRef = useRef(local)
  localRef.current = local

  // The draft is kept per session so it survives switching away. Writing it on every keystroke wakes every
  // watcher of the session store, which on a long conversation cost tens of milliseconds a letter; it is
  // written shortly after typing stops instead, and at once when it matters (sending, switching, closing).
  const draftTimer = useRef<number | null>(null)
  const keepDraft = useCallback(
    (id: string, text: string, now = false): void => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current)
      draftTimer.current = null
      if (now) return setDraft(id, text)
      draftTimer.current = window.setTimeout(() => {
        draftTimer.current = null
        setDraft(id, text)
      }, 400)
    },
    [setDraft]
  )
  const cancelDraft = useCallback((): void => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current)
    draftTimer.current = null
  }, [])
  /** Write it now. Anything that empties or replaces the box must come through here, or a save still waiting
      would put the old words back a moment later (it did: sending left the message in the box). */
  const writeDraft = useCallback((id: string, text: string): void => {
    cancelDraft()
    setDraft(id, text)
  }, [cancelDraft, setDraft])

  // whatever is half-typed is kept when the panel goes away or the session changes
  useEffect(() => {
    return () => {
      if (!draftTimer.current) return
      window.clearTimeout(draftTimer.current)
      draftTimer.current = null
      if (sessionId) writeDraft(sessionId, localRef.current)
    }
  }, [sessionId, setDraft])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [sel, setSel] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // the phone's own picker for pictures: gallery or camera, whichever Android offers
  const photoRef = useRef<HTMLInputElement>(null)
  // "Sharpen": a precise rewrite of the draft, offered next to it
  const [sharp, setSharp] = useState<string | null>(null)
  // "Try it N ways": the same request in several copies of the project at once
  const [ways, setWays] = useState(false)
  // a phone has room for one row of buttons, not two: the rest go in the +
  const compact = !!window.__prismMobile
  // a voice note being taken: it has the message box to itself while it does
  const recording = useVoice((s) => s.state) !== 'idle'
  // leaving the conversation throws away a recording nobody will come back for. This
  // lives here rather than on the microphone button, which stops being on screen the
  // moment recording starts — and took the recording with it when it did.
  useEffect(() => () => cancelRecording(), [])
  // the file and selection in front of the user: offered with the message, and removable
  const looks = useLooking((s) => s.looks)
  const docs = useEditor((s) => s.docs)
  const dismissed = useLooking((s) => s.dismissed)
  const wantLook = settings?.agent.editorContext ?? 'selection-and-file'
  // a file closed while text was selected in it is gone, not still "what you are looking at"
  const open = useMemo(() => Object.fromEntries(Object.entries(looks).filter(([p]) => docs[p])), [looks, docs])
  const look = useMemo(() => {
    if (wantLook === 'off') return null
    const l = currentLook({ looks: open })
    if (!l || (wantLook === 'selection' && !l.text)) return null
    return lookKey(l) === dismissed ? null : l
  }, [open, dismissed, wantLook])
  const sharpen = (): void => {
    const text = local.trim()
    if (!text) return
    setSharp('…')
    void prism.agent
      .sharpen(text)
      .then(setSharp)
      .catch((e: unknown) => {
        setSharp(null)
        toastError(e, 'Could not sharpen it')
      })
  }
  // what was picked here: shown at once and sent with the next message, whatever the saved session says meanwhile
  // (`was*` is what the session held when it was picked: a change to anything else came from elsewhere and wins)
  const [choice, setChoice] = useState<{ for: string | null; model?: ModelRef | null; mode?: PermissionMode; wasModel?: string; wasMode?: PermissionMode }>({ for: null })
  const mine = choice.for === (sessionId ?? null) ? choice : null

  useEffect(() => {
    setLocal(draft)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // the draft was set from outside (the editor's "ask about this", a rewind): show it
  useEffect(() => {
    setLocal((cur) => (cur === draft ? cur : draft))
  }, [draft])

  // text and pictures handed over from another panel
  const inbox = useSessions((s) => (sessionId ? s.inbox[sessionId] : undefined))
  useEffect(() => {
    if (!sessionId || !inbox) return
    useSessions.getState().takeInbox(sessionId)
    const base = useSessions.getState().draft[sessionId] ?? ''
    const next = base && !base.endsWith('\n') ? `${base}\n\n${inbox.text}` : base + inbox.text
    setLocal(next)
    writeDraft(sessionId, next)
    if (inbox.attachments.length) setAttachments((p) => [...p, ...inbox.attachments].slice(0, 8))
    requestAnimationFrame(() => {
      const ta = taRef.current
      ta?.focus()
      ta?.setSelectionRange(next.length, next.length)
    })
  }, [inbox, sessionId, writeDraft])

  // Chromium sizes the box itself (field-sizing). Where it cannot, fall back to measuring — but that read
  // forces the whole document to lay out again, which on a long conversation costs tens of ms a keystroke.
  const autoGrows = useMemo(() => typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'), [])
  useEffect(() => {
    if (autoGrows) return
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(260, ta.scrollHeight)}px`
  }, [local, autoGrows])

  const modelOptions = useMemo<Array<SelectOption<string>>>(() => {
    return models
      .filter((m) => m.supportsTools)
      .map((m) => ({
        value: m.key,
        label: (
          <span>
            {m.favorite ? '★ ' : ''}
            {modelName(m)}
          </span>
        ),
        sub: m.note ?? [m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k context` : null, m.reasoning ? 'reasoning' : null, m.supportsVision ? 'vision' : null].filter(Boolean).join(' · '),
        group: m.endpointName
      }))
  }, [models])

  // Auto: the session keeps no model and the routing rules choose one per message
  const routingOn = !!settings?.routing?.enabled && ((settings.routing.rules?.length ?? 0) > 0 || !!settings.routing.byDifficulty)
  // before the first message there is no session: what was picked waits in `pending`
  const picked = mine && 'model' in mine ? mine.model : session ? session.model : pending.model
  const isAuto = routingOn && picked === null && (!!session || pending.model !== undefined)
  const currentModel: ModelRef | null = isAuto ? null : (picked ?? settings?.roles.lead ?? null)
  const mode: PermissionMode = mine?.mode ?? session?.mode ?? pending.mode ?? settings?.permissions.mode ?? 'ask'
  // changed from somewhere else (the palette, another panel): follow that instead
  useEffect(() => {
    if (!mine || !session) return
    const now = modelKey(session.model)
    const modelElsewhere = 'model' in mine && now !== mine.wasModel && now !== modelKey(mine.model)
    const modeElsewhere = mine.mode !== undefined && session.mode !== mine.wasMode && session.mode !== mine.mode
    if (modelElsewhere || modeElsewhere) setChoice({ for: null })
  }, [mine, session])
  const pickModel = (model: ModelRef | null): void => {
    const key = sessionId ?? null
    setChoice((c) => ({ ...(c.for === key ? c : {}), for: key, model, wasModel: modelKey(session?.model) }))
    void setModel(model, sessionId ?? undefined)
  }
  const pickMode = (m: PermissionMode): void => {
    const key = sessionId ?? null
    setChoice((c) => ({ ...(c.for === key ? c : {}), for: key, mode: m, wasMode: session?.mode }))
    void setMode(m, sessionId ?? undefined)
  }


  const update = (text: string, caret: number): void => {
    setLocal(text)
    if (sessionId) keepDraft(sessionId, text)
    // slash commands at the very start
    const slash = text.match(/^\/([\w-]*)$/)
    if (slash && caret <= text.length) {
      const q = slash[1] ?? ''
      // Claude Code's own commands only mean something in a Claude session
      const claudeSession = isClaude(currentModel)
      const items = commands.filter((c) => c.name.startsWith(q) && (c.source !== 'claude' || claudeSession)).map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, sub: c.description }))
      setSuggest(items.length ? { kind: 'command', items, query: q, start: 0 } : null)
      setSel(0)
      return
    }
    const before = text.slice(0, caret)
    const at = before.match(/(?:^|\s)@([\w./\\-]*)$/)
    if (at) {
      const q = at[1] ?? ''
      const start = caret - q.length - 1
      void prism.fs.quickOpen(q, 8).then((files) => {
        // earlier conversations too: what was said there comes with the message
        const convs = useSessions
          .getState()
          .sessions.filter((x) => x.id !== sessionId && q.length >= 2 && x.title.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 4)
          .map((x) => ({ value: `@[${x.title.replace(/[[\]]/g, '')}](conversation:${x.id}) `, label: `Conversation: ${x.title}`, sub: 'what was said there comes with your message' }))
        setSuggest({ kind: 'file', items: [...files.map((f) => ({ value: `@${f} `, label: f.split('/').pop() ?? f, sub: f })), ...convs], query: q, start })
        setSel(0)
      }).catch(() => setSuggest(null))
      return
    }
    setSuggest(null)
  }

  const applySuggestion = (item: { value: string }): void => {
    if (!suggest) return
    const ta = taRef.current
    const caret = ta?.selectionStart ?? local.length
    const end = suggest.kind === 'command' ? local.length : caret
    const next = local.slice(0, suggest.start) + item.value + local.slice(end)
    setLocal(next)
    if (sessionId) writeDraft(sessionId, next)
    setSuggest(null)
    requestAnimationFrame(() => {
      ta?.focus()
      const p = suggest.start + item.value.length
      ta?.setSelectionRange(p, p)
    })
  }

  // how hard Claude is asked to think; only some Claude models offer a choice
  const [effort, setEffort] = useState<Effort | null>(null)
  const efforts = useMemo(() => (currentModel ? (models.find((m) => m.endpointId === currentModel.endpointId && m.modelId === currentModel.modelId)?.efforts ?? []) : []), [models, currentModel])
  useEffect(() => {
    if (!sessionId) return setEffort(null)
    let alive = true
    void prism.sessions.extras(sessionId).then((x) => alive && setEffort(x.effort ?? null)).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  const pickEffort = (e: Effort | null): void => {
    setEffort(e)
    if (sessionId) void prism.sessions.setExtras(sessionId, { effort: e }).catch(toastError)
  }
  // A demo types in here and presses send through the same path a person's keystrokes
  // take, so what is recorded is the real thing working rather than a reenactment.
  //
  // The words are handed to doSend rather than left for it to read, and whether it is
  // working is asked of the store rather than remembered: a demo takes hold of this
  // object before it starts typing, and what that object could see at that moment was
  // an empty box. It sent nothing, said nothing about it, and then waited for an answer
  // to a message that had never gone anywhere.
  useEffect(
    () =>
      registerSurface('agent', {
        setText: (text) => update(text, text.length),
        text: () => localRef.current,
        send: () => void doSend(localRef.current),
        // whether anything at all is working, not one remembered session: sending with
        // no session open makes a new one, and the old id would never say yes
        running: () => Object.values(useSessions.getState().live).some((l) => l?.running)
      }),
    [sessionId]
  )

  const doSend = async (say?: string): Promise<void> => {
    cancelDraft()
    // a voice note sent without review hands its words straight in: setLocal would not
    // have reached this closure yet
    const typed = (say ?? local).trim()
    // a picture on its own is a message too
    if (!typed && !attachments.length) return
    if (typed) report({ surface: 'agent', what: 'asked', detail: typed })
    const text = look ? `${typed}\n\n${lookNote(look)}` : typed
    // a passing question: answered in a side chat, this conversation stays as it is
    const side = /^\/(side|btw)\s+([\s\S]+)/.exec(typed)
    if (side && sessionId) {
      setLocal('')
      writeDraft(sessionId, '')
      setSuggest(null)
      void import('@/lib/branch').then((b) => b.sideChat(sessionId, side[2]!))
      return
    }
    if (running) {
      setLocal('')
      if (sessionId) writeDraft(sessionId, '')
      setSuggest(null)
      // the agent is working: this reaches it before its next step rather than waiting for the turn to end
      const took = sessionId && !attachments.length ? await prism.agent.steer(sessionId, text).catch(() => false) : false
      // steering is text only, so anything with a picture waits in the queue, pictures and all
      if (!took) useSessions.getState().enqueue(text, sessionId ?? undefined, attachments)
      setAttachments([])
      return
    }
    const att = attachments
    setAttachments([])
    setLocal('')
    setSuggest(null)
    await send(text, { attachments: att, model: currentModel ?? undefined, mode, ...(isAuto ? { auto: true } : {}) }, sessionId ?? undefined)
  }

  const insertAtCursor = (snippet: string): void => {
    const ta = taRef.current
    const caret = ta?.selectionStart ?? local.length
    const next = local.slice(0, caret) + snippet + local.slice(caret)
    setLocal(next)
    if (sessionId) writeDraft(sessionId, next)
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(caret + snippet.length, caret + snippet.length)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggest && suggest.items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(suggest.items.length - 1, s + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(0, s - 1))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        applySuggestion(suggest.items[sel]!)
        return
      }
      if (e.key === 'Escape') {
        setSuggest(null)
        return
      }
    }
    // a recipe's {{blanks}}: Tab selects the next one to type over
    if (e.key === 'Tab' && !e.shiftKey && /\{\{[^}]*\}\}/.test(local)) {
      const ta = e.currentTarget
      const re = /\{\{[^}]*\}\}/g
      re.lastIndex = ta.selectionEnd
      const m = re.exec(local) ?? /\{\{[^}]*\}\}/.exec(local)
      if (m) {
        e.preventDefault()
        ta.setSelectionRange(m.index, m.index + m[0].length)
        return
      }
    }
    // Enter sends and Shift+Enter is a new line, or the other way round with Ctrl+Enter (Settings, Agent).
    // On the phone the keyboard's return key is the only way to start a new line, and there
    // is a send button beside the box, so there it always makes a new line.
    const sendWithCtrl = settings?.agent.sendKey === 'ctrl-enter'
    if (e.key === 'Enter' && !window.__prismMobile && (sendWithCtrl ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey)) {
      e.preventDefault()
      void doSend()
    }
    if (e.key === 'Escape' && running) void abort(sessionId ?? undefined)
  }

  const onPaste = async (e: React.ClipboardEvent): Promise<void> => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    for (const f of files.slice(0, 6)) await addFile(f)
  }

  const addFile = async (original: File): Promise<void> => {
    try {
      const f = await fitForSending(original)
      const buf = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const a = await prism.attachments.fromData(f.name || 'pasted.png', f.type || 'image/png', btoa(bin))
      setAttachments((p) => [...p, a].slice(0, 8))
    } catch (err) {
      toastError(err, 'Could not attach image')
    }
  }

  const pick = async (): Promise<void> => {
    // On the phone the picture is on the phone. Asking the computer to open its own file
    // dialog is refused — rightly, it is a thing only a window there can do — which is
    // why "Attach a picture, from this phone" did nothing at all.
    if (window.__prismMobile) {
      photoRef.current?.click()
      return
    }
    try {
      const picked = await prism.attachments.pick()
      setAttachments((p) => [...p, ...picked].slice(0, 8))
    } catch (err) {
      toastError(err)
    }
  }

  const modeIcon = mode === 'auto' ? <Unlock size={12} /> : mode === 'auto-edit' ? <ShieldCheck size={12} /> : mode === 'plan' ? <MapIcon size={12} /> : <Lock size={12} />

  return (
    <div
      className={cx('composer', running && 'working')}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
        for (const f of files.slice(0, 6)) void addFile(f)
        const many = e.dataTransfer.getData('application/x-prism-paths')
        const mention = e.dataTransfer.getData('application/x-prism-path')
        if (many) insertAtCursor((JSON.parse(many) as string[]).map((p) => `@${p} `).join(''))
        else if (mention) insertAtCursor(`@${mention} `)
      }}
    >
      {suggest && suggest.items.length > 0 && (
        <div className="suggest">
          {suggest.items.map((it, i) => (
            <button key={it.value} className={cx('menu-item', i === sel && 'sel')} onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => applySuggestion(it)}>
              {suggest.kind === 'file' ? <AtSign size={12} className="faint" /> : <Slash size={12} className="faint" />}
              <span className="grow truncate">
                {it.label}
                {it.sub && <span className="faint"> {it.sub}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {sharp && (
        <div className={cx('sharpened', sharp === '…' && 'loading')}>
          <div className="sharpened-head">
            <Wand2 size={12} /> {sharp === '…' ? 'Sharpening your request…' : 'A sharper version'}
            <span className="grow" />
            {sharp !== '…' && (
              <>
                <button
                  className="btn sm solid"
                  onClick={() => {
                    setLocal(sharp)
                    if (sessionId) writeDraft(sessionId, sharp)
                    setSharp(null)
                    taRef.current?.focus()
                  }}
                >
                  Use this
                </button>
                <button className="btn sm ghost" onClick={() => setSharp(null)}>
                  Keep mine
                </button>
              </>
            )}
          </div>
          {sharp !== '…' && <div className="sharpened-text selectable">{sharp}</div>}
        </div>
      )}
      {look && (
        <div className="look-strip">
          <Eye size={12} />
          <span className="look-lead">Going with your message:</span>
          <button
            className="look-chip"
            title={look.text ? `Lines ${look.line} to ${look.endLine} of ${look.path}. Click to show it.` : `${look.path}. Its name goes with your message, not what is in it. Click to show it.`}
            onClick={() => useLayout.getState().openEditor(look.path, { line: look.line })}
          >
            {look.text ? <TextCursorInput size={12} /> : <FileCode2 size={12} />}
            <span className="look-name">{look.path.split('/').pop()}</span>
            <span className="look-where">{look.text ? `lines ${look.line}-${look.endLine}` : 'open file, name only'}</span>
          </button>
          <button className="look-off" title="Leave it out of this message" onClick={() => useLooking.getState().dismiss(lookKey(look))}>
            <X size={11} />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attach-strip">
          {attachments.map((a) => (
            <div key={a.id} className="attach-thumb" title={a.name}>
              <img src={`prism://attach/${a.path.split(/[\\/]/).pop()}`} alt={a.name} />
              <button onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}>
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Send sits beside what you are sending, at the top right, rather than at
          the end of the row of toggles underneath. Stop takes the same place
          while the agent is working, so the main action never moves. */}
      <div className="composer-input">
        {recording ? (
          <VoiceBox
            onDone={(said, now) => {
              const words = said.trim()
              if (!words) return
              // Always after what is already there. The box is rebuilt once the recording
              // ends, so its caret is back at the start by now: reading it put every voice
              // note in front of the text instead of after it.
              const before = local.replace(/\s+$/, '')
              const joined = before + (before ? ' ' : '') + words
              setLocal(joined)
              if (sessionId) writeDraft(sessionId, joined)
              if (now) void doSend(joined)
              else requestAnimationFrame(() => taRef.current?.focus())
            }}
          />
        ) : (
          <>
            {compact && (
              <PlusMenu
                canSharpen={!!local.trim() && sharp !== '…'}
                canTryWays={!!local.trim() && !running}
                reasoning={!!settings?.agent.reasoning}
                onImage={() => void pick()}
                onReasoning={() => void useApp.getState().updateSettings({ agent: { reasoning: !settings?.agent.reasoning } })}
                onSharpen={sharpen}
                onTryWays={() => setWays(true)}
              />
            )}
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])].filter((f) => f.type.startsWith('image/'))
                for (const f of files.slice(0, 6)) void addFile(f)
                // cleared, so picking the same picture again still counts as a change
                e.target.value = ''
              }}
            />
            <textarea
              ref={taRef}
              data-demo="agent:input"
              enterKeyHint={window.__prismMobile ? "enter" : undefined}
              value={local}
              placeholder={
                // on a phone the long hints wrapped onto three lines, making an empty box three lines tall
                compact
                  ? running ? 'Steer it while it works…' : 'Message Prism…'
                  : running ? 'Working… type to steer it: it reads this before its next step (Esc stops)' : 'Ask Prism anything. @ mentions a file, / runs a command.'
              }
              onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onKeyDown={onKeyDown}
              onPaste={(e) => void onPaste(e)}
              rows={1}
              spellCheck={false}
            />
            {/* the three ways of saying something, side by side: a note, a call, or the words you typed */}
            {/* Two buttons, never three. The microphone always stays, so a voice note can
                be added to something half-typed. The other one is whatever this moment
                calls for: stop it while it works, send what you have written, or — with
                nothing written — start a call. */}
            <span className="send-group">
              <MicButton focusBox={() => taRef.current?.focus()} />
              {running ? (
                <button className="send-btn stop" title="Stop (Esc)" onClick={() => void abort(sessionId ?? undefined)}>
                  <Square size={13} fill="currentColor" />
                </button>
              ) : local.trim() || attachments.length ? (
                <button className="send-btn" data-demo="agent:send" title="Send (Enter)" onClick={() => void doSend()}>
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              ) : (
                <CallButton sessionId={sessionId} />
              )}
            </span>
          </>
        )}
      </div>
      <div className="composer-bar">
        <span className="demo-wrap" data-demo="agent:model">
        <Select
          value={isAuto ? '__auto__' : modelKey(currentModel)}
          options={routingOn ? [{ value: '__auto__', label: 'Auto', sub: 'Your routing rules pick the model for each message' }, ...modelOptions] : modelOptions}
          searchable
          width={320}
          placeholder="Pick a model"
          size="sm"
          onChange={(k) => {
            if (k === '__auto__') return pickModel(null)
            const ref = refFromKey(k)
            if (ref) pickModel(ref)
          }}
        />
        </span>
        <span className="demo-wrap" data-demo="agent:mode">
        <Select
          value={mode}
          size="sm"
          icon={modeIcon}
          options={[
            { value: 'plan', label: 'Plan first', sub: 'Prism only reads, then shows you a plan to approve' },
            { value: 'ask', label: 'Ask first', sub: 'Approve each edit and command' },
            { value: 'auto-edit', label: 'Edit freely', sub: 'Edits run; commands ask' },
            { value: 'auto', label: 'Full auto', sub: 'Everything runs, only your block rules apply' }
          ]}
          onChange={(m) => pickMode(m as PermissionMode)}
          align="left"
          width={300}
        />
        </span>
        {efforts.length > 0 && (
          <Select
            value={effort ?? '__default__'}
            size="sm"
            icon={<Gauge size={13} />}
            options={[
              { value: '__default__', label: compact ? 'Claude decides' : 'Effort: Claude decides', sub: 'It judges how much thinking each message needs' },
              ...efforts.map((e) => ({ value: e, label: compact ? EFFORT_LABEL[e] : `Effort: ${EFFORT_LABEL[e]}`, sub: EFFORT_NOTE[e] }))
            ]}
            onChange={(v) => pickEffort(v === '__default__' ? null : (v as Effort))}
            align="left"
            width={300}
          />
        )}
        {/* On a phone these four live in the + beside Send; there is no room for a row of them. */}
        {!compact && (
          <>
            <button className="icon-btn sm" data-demo="agent:attach" title="Attach image" onClick={() => void pick()}>
              <ImageIcon size={14} />
            </button>
            <button
              className={cx('icon-btn sm', settings?.agent.reasoning && 'on')}
              title={settings?.agent.reasoning ? 'Reasoning on: the model thinks before acting' : 'Reasoning off: faster, cheaper'}
              onClick={() => void useApp.getState().updateSettings({ agent: { reasoning: !settings?.agent.reasoning } })}
            >
              <Brain size={14} />
            </button>
            <button className="icon-btn sm" data-demo="agent:sharpen" title="Sharpen: rewrite this request so it says exactly what to do and how to tell it is done" disabled={!local.trim() || sharp === '…'} onClick={sharpen}>
              <Wand2 size={14} />
            </button>
            <button className="icon-btn sm" data-demo="agent:ways" title="Try it several ways at once: different models, each in its own copy of the project, compared side by side" disabled={!local.trim() || running} onClick={() => setWays(true)}>
              <Split size={14} />
            </button>
          </>
        )}
        {ways && (
          <TryWaysDialog
            prompt={local.trim()}
            mode={mode}
            onStarted={() => {
              setLocal('')
              if (sessionId) writeDraft(sessionId, '')
            }}
            onClose={() => {
              setWays(false)
            }}
          />
        )}
        <span className="grow" />
        {!running && local.trim() && <Forecast sessionId={sessionId} model={currentModel} draft={local} />}
        {running && local.trim() && (
          <>
            <button className="btn sm" title="It reads this before its next step" onClick={() => void doSend()}>
              Tell it now
            </button>
            <button
              className="btn sm ghost"
              title="Send when the agent finishes"
              onClick={() => {
                useSessions.getState().enqueue(local.trim(), sessionId ?? undefined, attachments)
                setAttachments([])
                setLocal('')
                if (sessionId) writeDraft(sessionId, '')
              }}
            >
              Queue
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** About what sending this will cost: the context so far, how many steps requests in this session usually take, and the model's prices. */
function Forecast({ sessionId, model, draft }: { sessionId: string | null; model: ModelRef | null; draft: string }): React.JSX.Element | null {
  const info = useApp((s) => s.models.find((m) => model && m.endpointId === model.endpointId && m.modelId === model.modelId))
  const live = useSessions((s) => (sessionId ? s.live[sessionId] : undefined))
  const items = useSessions((s) => (sessionId ? s.items[sessionId] : undefined))
  if (!info || !info.inputPrice) return null
  const users = items?.filter((i) => i.kind === 'user').length ?? 0
  const steps = users ? Math.max(2, Math.min(30, Math.round((items?.filter((i) => i.kind === 'assistant').length ?? 0) / users))) : 6
  const ctx = (live?.contextTokens || 7000) + Math.ceil(draft.length / 3.5)
  const cost = (n: number): number => {
    let input = 0
    for (let i = 0; i < n; i++) input += ctx + 1800 * i
    return (input * (info.inputPrice ?? 0) + n * 500 * (info.outputPrice ?? 0)) / 1_000_000
  }
  const lo = cost(Math.max(1, Math.round(steps * 0.5)))
  const hi = cost(Math.round(steps * 1.8))
  const money = (n: number): string => (n < 0.01 ? '<$0.01' : `$${n < 1 ? n.toFixed(2) : n.toFixed(2)}`)
  return (
    <span className="forecast" title={`An estimate: about ${steps} steps (what requests in this session usually take), starting from ${Math.round(ctx / 1000)}k of context, at ${info.modelId}'s prices.`}>
      {money(lo) === money(hi) ? `about ${money(hi)}` : `${money(lo)}–${money(hi)}`}
    </span>
  )
}
