// Recording a lesson by doing it. While recording, everything a person does on the surfaces
// a lesson can drive (bus.ts) becomes a step in the same words the player uses, so playing
// it back clicks the same things, with the pointer, in the same order. Captions are typed:
// one waiting in the bar goes with the next thing done.
//
// A lesson never types into anyone's work. Typing into a real file while recording becomes
// typing into the lesson's own copy of that file (its stage), laid down when it plays and
// removed when it ends.
import { create } from 'zustand'
import { diffLines } from 'diff'
import { editorFor } from '@/lib/editorBus'
import { useEditor } from '@/state/editor'
import { useUi } from '@/state/ui'
import { onAction, type DoneAction } from './bus'
import { FIELD, clickable, describeField, describeTarget, targetWords, type Target } from './locate'
import type { Demo, DemoStep } from './script'

const VIEWS = new Set(['explorer', 'search', 'outline', 'git', 'sessions', 'gadgets'])

/** Where a recorded lesson keeps its copy of a file it types into. */
const stageOf = (path: string): string => `.prism/demo-stage/${path.replace(/[\\/]+/g, '__')}`

interface RecorderState {
  recording: boolean
  steps: DemoStep[]
  stage: Array<{ path: string; content: string }>
  /** Typed in the bar: the caption for whatever is done next. */
  caption: string
  /** A lesson being edited (just recorded, or opened from the list), and where it is kept. */
  draft: { demo: Demo; id: string | null; scope: 'project' | 'personal' } | null
  /** The Lessons list is open. */
  listOpen: boolean
  /** Point mode (F8): the next thing clicked becomes a spotlight step instead of being pressed. */
  picking: boolean
  /** In point mode, what is under the mouse. */
  hover: { x: number; y: number; w: number; h: number } | null
}

export const useRecorder = create<RecorderState>(() => ({ recording: false, steps: [], stage: [], caption: '', draft: null, listOpen: false, picking: false, hover: null }))

let off: (() => void) | null = null
/** Said once per recording: only typing that adds lines can be played back. */
let toldAboutRemovals = false

function add(step: DemoStep): void {
  useRecorder.setState((s) => {
    const say = s.caption.trim()
    return { steps: [...s.steps, say ? { ...step, say } : step], caption: '' }
  })
}

/** Changes the last step instead of adding one (typing into Search is one step, not one per letter). */
function replaceLast(step: DemoStep): void {
  useRecorder.setState((s) => {
    const prev = s.steps[s.steps.length - 1]
    const say = s.caption.trim() || prev?.say
    return { steps: [...s.steps.slice(0, -1), say ? { ...step, say } : step], caption: s.caption.trim() ? '' : s.caption }
  })
}

const last = (): DemoStep | undefined => {
  const st = useRecorder.getState().steps
  return st[st.length - 1]
}

/** The added lines of a save, each typed after the nearest written line above it. */
export function typedIn(before: string, after: string): { pieces: Array<{ after: string; line: number; text: string }>; removed: boolean } {
  const pieces: Array<{ after: string; line: number; text: string }> = []
  let removed = false
  const done: string[] = []
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (part.removed) {
      removed = true
      continue
    }
    if (part.added) {
      // after the nearest written line above it, remembering which line that was (a "}" is everywhere);
      // with nothing written above it, at the very top of the file
      let at = done.length - 1
      while (at >= 0 && !done[at]!.trim()) at--
      pieces.push(at >= 0 ? { after: done[at]!, line: at + 1, text: lines.join('\n') } : { after: '', line: 0, text: lines.join('\n') })
    }
    done.push(...lines)
  }
  return { pieces, removed }
}

/**
 * The side bar view a step needs open, added when the lesson would not have it open by
 * then: it may already have been open when recording began, or opened with a shortcut.
 */
function ensureView(view: 'explorer' | 'search'): void {
  const rails = useRecorder.getState().steps.filter((s) => s.do === 'rail' || s.do === 'gadget.open')
  const lastRail = rails[rails.length - 1]
  const showing = lastRail?.do === 'rail' ? lastRail.view : lastRail?.do === 'gadget.open' ? 'gadgets' : null
  if (showing !== view) useRecorder.setState((s) => ({ steps: [...s.steps, { do: 'rail', view }] }))
}

// ---- typing in the code editor, caught as it happens

/** Files typed into since the last step: what each held when this stretch of typing began. */
const typedSince = new Map<string, string>()
/**
 * Which file a lesson types into, for each file typed in: the file itself when the lesson made it (it was
 * empty when the typing began), else the lesson's own copy, so playing it never touches anyone's work.
 */
const typesInto = new Map<string, string>()
let editorOff: (() => void) | null = null

const lessonsOwn = (path: string): boolean => path.startsWith('.prism/demo-stage/') || path.startsWith('.prism/lessons/')

function watchEditor(): () => void {
  return useEditor.subscribe((s, prev) => {
    if (document.body.classList.contains('demo-playing')) return
    for (const [path, doc] of Object.entries(s.docs)) {
      const was = prev.docs[path]
      // a file just opened is not typed into; one already followed keeps where its typing began
      if (!was || doc.content === was.content || typedSince.has(path) || lessonsOwn(path)) continue
      typedSince.set(path, was.content)
    }
  })
}

/** The typing since the last step becomes steps of its own, before whatever is done next. */
function flushTyping(): void {
  for (const [path, base] of [...typedSince]) {
    typedSince.delete(path)
    const now = useEditor.getState().docs[path]?.content
    if (now === undefined || now === base) continue
    let into = typesInto.get(path)
    if (!into) {
      const target = base === '' ? path : stageOf(path)
      into = target
      typesInto.set(path, target)
      if (target !== path) useRecorder.setState((st) => ({ stage: [...st.stage, { path: target, content: base }] }))
    }
    const { pieces, removed } = typedIn(base, now)
    for (const piece of pieces) add({ do: 'type', file: into, after: piece.after, line: piece.line, text: piece.text })
    if (removed && !toldAboutRemovals) {
      toldAboutRemovals = true
      useUi.getState().toast('info', 'Only added lines play back', 'A lesson types the lines you add; lines you changed or deleted are left as they were.')
    }
  }
}

function onDone(a: DoneAction): void {
  // what a lesson does while playing is not you doing it
  if (document.body.classList.contains('demo-playing')) return
  flushTyping()
  if (a.surface === 'tree') ensureView('explorer')
  if (a.surface === 'search') ensureView('search')
  const prev = last()
  switch (`${a.surface}:${a.what}`) {
    case 'rail:opened':
      if (a.detail && VIEWS.has(a.detail)) add({ do: 'rail', view: a.detail as 'explorer' })
      return
    case 'tree:expanded': {
      if (!a.detail) return
      // opening a folder inside the one just opened: the player walks down to it anyway
      if (prev?.do === 'tree.expand' && a.detail.startsWith(`${prev.path}/`)) replaceLast({ do: 'tree.expand', path: a.detail })
      else add({ do: 'tree.expand', path: a.detail })
      return
    }
    case 'tree:opened':
      if (a.detail) add({ do: 'tree.open', path: a.detail })
      return
    case 'search:typed': {
      const q = a.detail ?? ''
      if (prev?.do === 'search.type') {
        if (q.trim()) replaceLast({ do: 'search.type', query: q })
        else useRecorder.setState((s) => ({ steps: s.steps.slice(0, -1) }))
      } else if (q.trim()) add({ do: 'search.type', query: q })
      return
    }
    case 'search:opened':
      if (a.detail) add({ do: 'search.open', file: a.detail })
      return
    case 'gadget:opened':
      if (!a.detail) return
      // the player clicks the gadgets list itself on the way
      if (prev?.do === 'rail' && prev.view === 'gadgets' && !prev.say) useRecorder.setState((s) => ({ steps: s.steps.slice(0, -1) }))
      add({ do: 'gadget.open', id: a.detail })
      return
    case 'agent:asked':
      if (!a.detail) return
      add({ do: 'agent.ask', text: a.detail })
      add({ do: 'agent.wait' })
      return
    case 'terminal:ran':
      if (a.detail) add({ do: 'terminal', command: a.detail })
      return
    case 'editor:saved': {
      const into = a.detail ? typesInto.get(a.detail) : undefined
      const prevSave = last()
      if (into && !(prevSave?.do === 'save' && prevSave.file === into)) add({ do: 'save', file: into })
      return
    }
  }
}

// ---- every click, wherever it lands

/** Things recorded by what they do rather than where they were clicked (see onDone). */
const BY_MEANING = /^(rail:(explorer|search|outline|git|sessions|gadgets)$|tree:|search:|gadget:|agent:send$|agent:input$)/
/** Places to type into: a click there only puts the cursor in, and what is typed is caught another way. */
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"], .monaco-editor, .xterm'
/** The recorder's own bar and the lesson's own screens. */
const OURS = '.demo-bar, .demo-bar-part, .record-bar, .record-pick'

/** The submenu last rested on, so a click inside it can open it first when played. */
let lastSubmenu: Target | null = null
/** After a press picked something to point at, the release and click that follow are swallowed too. */
let swallow = false
let handsOff: (() => void) | null = null

/** Boxes typed into elsewhere: the editor and terminal (caught when saved, and as commands), the message box and Search (caught as what they do). */
const TYPED_ELSEWHERE = '.monaco-editor, .xterm, [data-demo="agent:input"], [data-demo="search:input"]'
/** What is being typed into a box, saved as one step when you press Enter, click elsewhere or leave the box. */
let typing: { el: Element; target: Target; text: string } | null = null

function boxOf(e: Event): HTMLInputElement | HTMLTextAreaElement | null {
  const el = e.target as Element | null
  if (!el?.matches?.(FIELD) || el.closest(TYPED_ELSEWHERE) || el.closest(OURS)) return null
  return el as HTMLInputElement | HTMLTextAreaElement
}

function onType(e: Event): void {
  if (!e.isTrusted || document.body.classList.contains('demo-playing')) return
  const box = boxOf(e)
  if (!box) return
  if (typing && typing.el !== box) saveTyping(false)
  typing = { el: box, target: typing?.el === box ? typing.target : describeField(box), text: box.value }
}

/** The typing so far becomes a step. */
function saveTyping(enter: boolean): void {
  flushTyping()
  const t = typing
  typing = null
  if (!t || (!t.text && !enter)) return
  add(enter ? { do: 'fill', target: t.target, text: t.text, enter: true } : { do: 'fill', target: t.target, text: t.text })
}

function onLeave(e: Event): void {
  if (typing && e.target === typing.el) saveTyping(false)
}

function hush(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

function onPress(e: PointerEvent): void {
  if (!e.isTrusted || (e.button !== 0 && e.button !== 2)) return
  const el = e.target as Element | null
  if (!el?.closest || el.closest(OURS)) return
  if (typing && el !== typing.el) saveTyping(false)
  flushTyping()
  if (useRecorder.getState().picking && e.button === 0) {
    // pointing, not pressing: nothing underneath hears it, so an open menu stays open
    hush(e)
    swallow = true
    add({ do: 'point', target: describeTarget(el).target })
    useRecorder.setState({ picking: false, hover: null })
    return
  }
  if (document.body.classList.contains('demo-playing') || el.closest(TYPING)) return
  const named = el.closest('[data-demo]')?.getAttribute('data-demo')
  if ((named && BY_MEANING.test(named)) || el.closest('.search-hit')) return
  // empty space between things does nothing, and a box of many things cannot be found again
  if (!clickable(el)) return
  const { el: hit, target } = describeTarget(el)
  // an item in a submenu is only there once the submenu has been rested on
  if (hit.closest('.menu-dropdown.nested') && lastSubmenu && last()?.do !== 'hover') add({ do: 'hover', target: lastSubmenu })
  add(e.button === 2 ? { do: 'click', target, right: true } : { do: 'click', target })
}

function onAfterPress(e: Event): void {
  if (!swallow || !e.isTrusted) return
  hush(e)
  if (e.type === 'click') swallow = false
}

function onMove(e: MouseEvent): void {
  const el = e.target as Element | null
  if (!el?.closest) return
  // a menu item with an arrow opens a submenu when rested on
  const item = el.closest('.menu-item')
  if (item?.querySelector('.lucide-chevron-right')) lastSubmenu = describeTarget(item).target
  if (!useRecorder.getState().picking || el.closest(OURS)) return
  const r = describeTarget(el).el.getBoundingClientRect()
  useRecorder.setState({ hover: { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 } })
}

function onKey(e: KeyboardEvent): void {
  if (!e.isTrusted) return
  // Enter in a box being typed into: the typing and the Enter are one step, saved before the box can close
  if (e.key === 'Enter' && typing && e.target === typing.el && !e.shiftKey) {
    typing.text = (typing.el as HTMLInputElement).value
    return saveTyping(true)
  }
  if (e.key === 'F8') {
    hush(e)
    setPicking(!useRecorder.getState().picking)
  } else if (e.key === 'Escape' && useRecorder.getState().picking) {
    // only the picking is cancelled: a menu that is open stays open
    hush(e)
    setPicking(false)
  }
}

/** Point mode: the next thing clicked becomes a spotlight step instead of being pressed. */
export function setPicking(on: boolean): void {
  useRecorder.setState({ picking: on, hover: null })
}

function listenToHands(): () => void {
  const opts = { capture: true } as const
  const after = ['pointerup', 'mousedown', 'mouseup', 'click'] as const
  window.addEventListener('pointerdown', onPress, opts)
  for (const t of after) window.addEventListener(t, onAfterPress, opts)
  window.addEventListener('mousemove', onMove, opts)
  window.addEventListener('keydown', onKey, opts)
  window.addEventListener('input', onType, opts)
  window.addEventListener('focusout', onLeave, opts)
  return () => {
    window.removeEventListener('input', onType, opts)
    window.removeEventListener('focusout', onLeave, opts)
    window.removeEventListener('pointerdown', onPress, opts)
    for (const t of after) window.removeEventListener(t, onAfterPress, opts)
    window.removeEventListener('mousemove', onMove, opts)
    window.removeEventListener('keydown', onKey, opts)
  }
}

export function startRecording(): void {
  if (useRecorder.getState().recording) return
  typing = null
  typedSince.clear()
  typesInto.clear()
  editorOff = watchEditor()
  toldAboutRemovals = false
  lastSubmenu = null
  swallow = false
  useRecorder.setState({ recording: true, steps: [], stage: [], caption: '', draft: null, picking: false, hover: null })
  off = onAction(onDone)
  handsOff = listenToHands()
}

/** Stops, and opens what was recorded in the lesson editor. */
export function stopRecording(): void {
  saveTyping(false)
  flushTyping()
  editorOff?.()
  editorOff = null
  off?.()
  off = null
  handsOff?.()
  handsOff = null
  useRecorder.setState({ picking: false, hover: null })
  const s = useRecorder.getState()
  const steps = s.caption.trim() ? [...s.steps, { do: 'say' as const, say: s.caption.trim() }] : s.steps
  useRecorder.setState({ recording: false, caption: '', draft: { demo: { title: '', ...(s.stage.length ? { stage: s.stage } : {}), steps }, id: null, scope: 'project' } })
}

export function cancelRecording(): void {
  editorOff?.()
  editorOff = null
  typedSince.clear()
  off?.()
  off = null
  handsOff?.()
  handsOff = null
  useRecorder.setState({ recording: false, steps: [], stage: [], caption: '', picking: false, hover: null })
}

/** A caption on its own: something to read before the next thing happens. */
export function addSay(text: string): void {
  flushTyping()
  const say = text.trim()
  if (!say) return
  useRecorder.setState((s) => ({ steps: [...s.steps, { do: 'say', say }], caption: '' }))
}

/** Light up what is selected in the open file, so the lesson can point at it too. */
export function pointAtSelection(): string | null {
  flushTyping()
  const file = useEditor.getState().active
  const ed = file ? editorFor(file) : null
  const model = ed?.getModel()
  const sel = ed?.getSelection()
  if (!file || !model || !sel) return 'Select something in an open file first.'
  const first = model.getLineContent(sel.startLineNumber)
  const lastLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
  if (!first.trim()) return 'Start the selection on a line with something written on it, so the lesson can find it again.'
  const picked = model.getValueInRange(sel)
  add({
    do: 'spotlight',
    file,
    anchor: first,
    ...(lastLine > sel.startLineNumber ? { through: model.getLineContent(lastLine) } : {}),
    ...(sel.startLineNumber === sel.endLineNumber && picked.trim() ? { select: picked } : {})
  })
  return null
}

/** What a step does, in a few words, for the lesson editor. */
export function describe(st: DemoStep): string {
  switch (st.do) {
    case 'say': return 'Caption only'
    case 'rail': return `Open ${st.view} in the side bar`
    case 'tree.expand': return `Open the folder ${st.path}`
    case 'tree.open': return `Open ${st.path}`
    case 'search.type': return `Search for “${st.query}”`
    case 'search.open': return `Open ${st.file ?? `result ${(st.index ?? 0) + 1}`} from the search`
    case 'spotlight': return `Light up “${st.select ?? st.anchor.trim()}” in ${st.file}`
    case 'spotlight.off': return 'Stop lighting up'
    case 'type': return `Type ${st.text.split('\n').length} line${st.text.includes('\n') ? 's' : ''} into ${st.file.replace('.prism/demo-stage/', '').replace(/__/g, '/')}`
    case 'save': return 'Save the file'
    case 'terminal': return `Run ${st.command}`
    case 'await.output': return `Wait for “${st.match}” in the terminal`
    case 'gadget.open': return `Open the ${st.id} gadget`
    case 'gadget.press': return `Press “${st.find}” in ${st.gadget}`
    case 'agent.ask': return `Ask the agent: “${st.text.slice(0, 80)}”`
    case 'agent.wait': return 'Wait for the answer'
    case 'point': return `Point at ${st.target ? targetWords(st.target) : (st.at ?? '').replace(':', ': ')}`
    case 'fill': return `Type “${st.text}” into ${targetWords(st.target)}${st.enter ? ' and press Enter' : ''}`
    case 'click': return `${st.right ? 'Right-click' : 'Click'} ${targetWords(st.target)}`
    case 'hover': return `Rest on ${targetWords(st.target)}`
    case 'open': return `Open ${st.what}${st.section ? `, ${st.section}` : ''}`
    case 'close': return `Close ${st.what}`
  }
}
