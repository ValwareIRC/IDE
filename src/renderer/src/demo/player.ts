// Plays a demo: Prism drives itself through the things you would click, while a
// caption says what is happening.
//
// Two rules shape all of this. The speed you choose only hurries up the acting
// (typing, the pointer, the pauses) and never pretends to hurry up real work: a
// command takes as long as the command takes. And the moment you touch anything
// the demo stops where it is, because playback that fights you is unbearable.
import { create } from 'zustand'
import { monaco } from '@/lib/monaco'
import { editorFor } from '@/lib/editorBus'
import { prism } from '@/lib/ipc'
import { useUi, toastError } from '@/state/ui'
import { useLayout } from '@/state/layout'
import { useTerminals } from '@/state/terminals'
import { useEditor } from '@/state/editor'
import { awaitSurface, surface, report } from './bus'
import type { Demo, DemoStep } from './script'
import { enterLikeAHand, findField, findTarget, hoverLikeAHand, pressLikeAHand, setFieldLikeAHand, targetWords, type Target } from './locate'

const SPEED_KEY = 'prism.demo.speed'
const STEPWISE_KEY = 'prism.demo.stepwise'
const LISTEN_KEY = 'prism.demo.listen'

/** Colour and cursor codes, stripped out of terminal output before matching it. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g

export interface DemoPointer {
  x: number
  y: number
  press: boolean
}

/** The part of the screen a step is about: everything else dims, and the caption sits beside it. */
export interface DemoFocus {
  x: number
  y: number
  w: number
  h: number
}

interface DemoState {
  demo: Demo | null
  step: number
  caption: string
  /** Held: either you pressed pause or you touched something. */
  paused: boolean
  /** You interrupted, rather than pressing pause. */
  interrupted: boolean
  /** Your speed, kept between lessons. 1 is as written. */
  speed: number
  pointer: DemoPointer | null
  /** Counts presses, so each one can ripple afresh. */
  presses: number
  focus: DemoFocus | null
  /** Waiting on something real, named so the bar can say what. */
  waiting: string | null
  /** Step by step: after each step, hold until you press Next. Kept between lessons. */
  stepwise: boolean
  /** A step is done and the lesson is waiting for Next. */
  atStepEnd: boolean
  /** Listen along: each caption is also read aloud. Kept between lessons. */
  listen: boolean
  done: boolean
}

export const useDemo = create<DemoState>(() => ({
  demo: null,
  step: 0,
  caption: '',
  paused: false,
  interrupted: false,
  speed: Number(localStorage.getItem(SPEED_KEY)) || 1,
  pointer: null,
  presses: 0,
  focus: null,
  waiting: null,
  stepwise: localStorage.getItem(STEPWISE_KEY) !== 'off',
  atStepEnd: false,
  listen: localStorage.getItem(LISTEN_KEY) === 'on',
  done: false
}))

/** About 140 words a minute, slower than reading alone, because there is also something to watch. */
function readingTime(text: string): number {
  return Math.max(1600, text.trim().split(/\s+/).length * 430)
}

/** Where something is on screen, with a little room around it, or nothing. */
function rectOf(el: Element | null, pad = 6): DemoFocus | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!r.width && !r.height) return null
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
}

/** Puts the light on something named for lessons (data-demo). */
function focusOn(tag: string): void {
  const f = rectOf(document.querySelector(`[data-demo="${tag}"]`))
  if (f) useDemo.setState({ focus: f })
}

function press(): void {
  useDemo.setState((s) => (s.pointer ? { pointer: { ...s.pointer, press: true }, presses: s.presses + 1 } : {}))
}

function release(): void {
  useDemo.setState((s) => (s.pointer ? { pointer: { ...s.pointer, press: false } } : {}))
}

/** Paces one playthrough: the speed, the holding, and giving up on a step. */
class Pacer {
  cancelled = false
  skip = false
  private pace = 1
  private waker: (() => void) | null = null

  setPace(p: number): void {
    this.pace = p > 0 ? p : 1
  }

  /** Ends the current wait early; what happens next depends on the flags. */
  wake(): void {
    const w = this.waker
    this.waker = null
    w?.()
  }

  cancel(): void {
    this.cancelled = true
    this.wake()
  }

  skipStep(): void {
    this.skip = true
    this.wake()
  }

  get over(): boolean {
    return this.cancelled || this.skip
  }

  private async hold(): Promise<void> {
    while (useDemo.getState().paused && !this.cancelled) {
      await new Promise<void>((r) => {
        this.waker = r
      })
    }
  }

  /**
   * Waits, scaled by your speed and this step's pace. `floor` is a length the
   * speed may not go below, so a caption is never gone before it is read.
   */
  async wait(ms: number, floor = 0): Promise<void> {
    let left = Math.max(ms / (useDemo.getState().speed * this.pace), floor)
    while (left > 0) {
      await this.hold()
      if (this.over) return
      const from = Date.now()
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          this.waker = null
          r()
        }, left)
        this.waker = () => {
          clearTimeout(t)
          r()
        }
      })
      if (this.over) return
      left -= Date.now() - from
    }
  }
}

let pacer: Pacer | null = null
let dim: monaco.editor.IEditorDecorationsCollection | null = null
let stage: string[] = []
let term: { id: string; off: () => void; seen: string } | null = null

/** The line a step points at: its text where it is now, else nothing. */
function lineOf(content: string, anchor: string): number | null {
  const want = anchor.trim()
  if (!want) return null
  const lines = content.split(/\r?\n/)
  const exact = lines.findIndex((l) => l.trim() === want)
  if (exact >= 0) return exact + 1
  const part = lines.findIndex((l) => l.includes(want))
  return part >= 0 ? part + 1 : null
}

/** Waits up to `ms` for a thing to be on screen (a menu takes a moment to open). The real time, whatever the speed. */
async function waitFor(t: Target, p: Pacer, ms: number): Promise<Element | null> {
  const until = Date.now() + ms
  for (;;) {
    const el = findTarget(t)
    if (el || p.cancelled || Date.now() > until) return el
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Glides the pointer to a thing on screen and presses it. */
async function pointAt(tag: string, p: Pacer): Promise<Element | null> {
  const el = document.querySelector(`[data-demo="${tag}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  // the light lands first, so the eye is there before the pointer is
  useDemo.setState({ focus: rectOf(el), pointer: { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, press: false } })
  await p.wait(900, 450)
  await p.wait(250)
  press()
  await p.wait(220, 160)
  release()
  return el
}

/** The light on the lines a spotlight step lit up in the editor. */
function focusLines(ed: monaco.editor.IStandaloneCodeEditor, from: number, to: number): void {
  const node = ed.getDomNode()
  if (!node) return
  const box = node.getBoundingClientRect()
  const top = box.top + ed.getTopForLineNumber(from) - ed.getScrollTop()
  const bottom = box.top + ed.getTopForLineNumber(to + 1) - ed.getScrollTop()
  useDemo.setState({ focus: { x: box.left, y: Math.max(box.top, top - 4), w: box.width, h: Math.min(box.bottom, bottom + 4) - Math.max(box.top, top - 4) } })
}

/** An editor for this file, waiting for it to mount after being opened. */
async function editorOf(file: string, p: Pacer): Promise<monaco.editor.IStandaloneCodeEditor | null> {
  for (let i = 0; i < 30; i++) {
    const ed = editorFor(file)
    if (ed?.getModel()) return ed
    await p.wait(100, 100)
    if (p.cancelled) return null
  }
  return null
}

function clearDim(): void {
  dim?.clear()
  dim = null
}

/** Lights one range and fades the rest of the file, so the eye lands. */
function spotlight(ed: monaco.editor.IStandaloneCodeEditor, from: number, to: number): void {
  const model = ed.getModel()
  if (!model) return
  const last = model.getLineCount()
  clearDim()
  const ranges: monaco.editor.IModelDeltaDecoration[] = [{ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className: 'demo-spot', linesDecorationsClassName: 'demo-spot-gutter' } }]
  // the fading has to be `inlineClassName`: a whole-line `className` paints a
  // rectangle behind the text, so making that rectangle faint changes nothing
  if (from > 1) ranges.push({ range: new monaco.Range(1, 1, from - 1, model.getLineMaxColumn(from - 1)), options: { inlineClassName: 'demo-dim' } })
  if (to < last) ranges.push({ range: new monaco.Range(to + 1, 1, last, model.getLineMaxColumn(last)), options: { inlineClassName: 'demo-dim' } })
  dim = ed.createDecorationsCollection(ranges)
}

/** The terminal the demo types into: the panel's own, created if there is none. */
async function terminal(p: Pacer): Promise<{ id: string } | null> {
  useLayout.getState().openTerminal()
  await p.wait(260, 120)
  if (term) return term
  const terminals = useTerminals.getState()
  await terminals.refresh()
  const existing = useTerminals.getState().list.find((t) => t.kind === 'user')
  const info = existing ?? (await terminals.create({ cwd: '.' }))
  if (!info) return null
  useTerminals.getState().setActive(info.id)
  const off = prism.terminals.onData(info.id, (data: string) => {
    // what a demo waits for is the words, and a real terminal is full of colour
    // codes: `console.log('line:', 2)` arrives as `line: ` then an escape then `2`
    if (term) term.seen = (term.seen + data).replace(ANSI, '').slice(-8000)
  })
  term = { id: info.id, off, seen: '' }
  await p.wait(300, 150)
  return term
}

/** Types into a file after the line whose text is `after`, like a person would. */
/** The line whose text is `anchor`, nearest to `near` when it appears more than once (a "}" is everywhere). */
function nearestLine(content: string, anchor: string, near?: number): number | null {
  const want = anchor.trim()
  const lines = content.split(/\r?\n/)
  const hits = lines.flatMap((l, i) => (l.trim() === want ? [i + 1] : []))
  if (!hits.length) return lineOf(content, anchor)
  if (!near) return hits[0]!
  return hits.reduce((best, n) => (Math.abs(n - near) < Math.abs(best - near) ? n : best), hits[0]!)
}

async function typeInto(file: string, after: string, text: string, p: Pacer, near?: number): Promise<void> {
  useLayout.getState().openEditor(file)
  const ed = await editorOf(file, p)
  const model = ed?.getModel()
  if (!ed || !model) return
  ed.focus()
  useDemo.setState({ focus: rectOf(ed.getDomNode(), 2), pointer: null })
  // at the very top: before whatever is there, on a line of its own
  const top = after === ''
  const at = top ? 0 : nearestLine(model.getValue(), after, near)
  if (!top && !at) throw new Error(`"${after.slice(0, 40)}" is not in ${file} any more, so the lesson cannot type after it`)
  let offset = top ? 0 : model.getOffsetAt({ lineNumber: at!, column: model.getLineMaxColumn(at!) })
  const put = (s: string): void => {
    const pos = model.getPositionAt(offset)
    model.applyEdits([{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: s }])
    offset += s.length
    const now = model.getPositionAt(offset)
    ed.setPosition(now)
    ed.revealPositionInCenterIfOutsideViewport(now)
  }
  // whole words at a time: one edit per letter reflows the file 30 times a second for nothing
  const typed = top ? text + (model.getValueLength() ? '\n' : '') : '\n' + text
  const chunks = typed.match(/\s+|\S+/g) ?? []
  for (const [i, chunk] of chunks.entries()) {
    if (p.cancelled) return
    if (p.skip) {
      put(chunks.slice(i).join(''))
      break
    }
    put(chunk)
    await p.wait(chunk.includes('\n') ? 150 : 58)
  }
  report({ surface: 'editor', what: 'typed', detail: file })
}

async function perform(st: DemoStep, p: Pacer): Promise<void> {
  switch (st.do) {
    case 'say':
      return

    case 'rail': {
      await pointAt(`rail:${st.view}`, p)
      useUi.getState().setSide(st.view)
      await p.wait(260)
      return
    }

    case 'tree.expand': {
      // a person opens each folder on the way down, so the demo does too
      const parts = st.path.split('/')
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join('/')
        const tree = await awaitSurface('tree')
        if (!tree) return
        tree.mark(path)
        await pointAt(`tree:${path}`, p)
        tree.expand(path)
        await p.wait(320)
      }
      return
    }

    case 'tree.open': {
      const tree = await awaitSurface('tree')
      if (!tree) return
      tree.mark(st.path)
      await pointAt(`tree:${st.path}`, p)
      tree.open(st.path, true)
      await p.wait(200)
      tree.mark(null)
      return
    }

    case 'search.type': {
      const box = await awaitSurface('search')
      if (!box) return
      await pointAt('search:input', p)
      for (let i = 1; i <= st.query.length; i++) {
        if (p.cancelled) return
        if (p.skip) {
          box.setQuery(st.query)
          break
        }
        box.setQuery(st.query.slice(0, i))
        await p.wait(i === 1 ? 140 : 62)
      }
      box.setQuery(st.query)
      // the search itself takes as long as it takes
      useDemo.setState({ waiting: 'searching' })
      await p.wait(700, 400)
      useDemo.setState({ waiting: null })
      return
    }

    case 'search.open': {
      const box = await awaitSurface('search')
      if (!box) return
      const found = box.found()
      const i = st.file ? found.indexOf(st.file) : (st.index ?? 0)
      if (i < 0) throw new Error(`the search did not find ${st.file}`)
      box.mark(i)
      await pointAt(`search:result:${i}`, p)
      box.open(i)
      await p.wait(240)
      box.mark(null)
      return
    }

    case 'spotlight': {
      const content = (await prism.fs.read(st.file)).content
      const from = lineOf(content, st.anchor)
      if (!from) throw new Error(`"${st.anchor.slice(0, 40)}" is not in ${st.file} any more`)
      const to = st.through ? (lineOf(content, st.through) ?? from) : from
      useLayout.getState().openEditor(st.file, { line: from })
      const ed = await editorOf(st.file, p)
      if (!ed) return
      spotlight(ed, from, Math.max(from, to))
      ed.revealLinesInCenter(from, Math.max(from, to))
      // the editor scrolls smoothly to the lines; the light follows once it has
      await p.wait(260, 200)
      focusLines(ed, from, Math.max(from, to))
      if (st.select) {
        const model = ed.getModel()
        const text = model?.getLineContent(from) ?? ''
        const col = text.indexOf(st.select)
        if (col >= 0) {
          await p.wait(420)
          ed.setSelection(new monaco.Range(from, col + 1, from, col + 1 + st.select.length))
        }
      }
      await p.wait(300)
      return
    }

    case 'spotlight.off':
      clearDim()
      return

    case 'type':
      await typeInto(st.file, st.after, st.text, p, st.line)
      return

    case 'save': {
      await useEditor.getState().save(st.file)
      await p.wait(200)
      return
    }

    case 'terminal': {
      const t = await terminal(p)
      if (!t) throw new Error('there is no terminal to type into')
      useDemo.setState({ focus: rectOf(document.querySelector('.xterm')?.closest('.dv-groupview, .terminal-panel') ?? document.querySelector('.xterm'), 4) })
      for (const ch of st.command) {
        if (p.cancelled) return
        if (p.skip) break
        prism.terminals.write(t.id, ch)
        await p.wait(52)
      }
      if (p.skip) prism.terminals.write(t.id, st.command)
      await p.wait(260)
      if (term) term.seen = ''
      prism.terminals.write(t.id, '\r')
      report({ surface: 'terminal', what: 'ran', detail: st.command })
      return
    }

    case 'await.output': {
      // real work: the speed slider has no say here
      const until = Date.now() + (st.timeout ?? 20000)
      useDemo.setState({ waiting: 'waiting for the command to finish' })
      try {
        for (;;) {
          if (p.cancelled || p.skip) return
          if (term && term.seen.includes(st.match)) return
          if (Date.now() > until) throw new Error(`the terminal never printed "${st.match}"`)
          await new Promise((r) => setTimeout(r, 120))
        }
      } finally {
        useDemo.setState({ waiting: null })
      }
    }

    case 'gadget.open': {
      // the gadgets list first, then the gadget in it — the two clicks a person makes
      await pointAt('rail:gadgets', p)
      useUi.getState().setSide('gadgets')
      await p.wait(420)
      await pointAt(`gadget:${st.id}`, p)
      useLayout.getState().openGadget(st.id)
      // a panel has to mount and its backend has to answer before it is worth looking at
      useDemo.setState({ waiting: 'opening the panel' })
      await p.wait(900, 600)
      useDemo.setState({ waiting: null })
      return
    }

    case 'gadget.press': {
      const ask = (window as unknown as { __prismGadgetPress?: (id: string, find: string, nth: number, press: boolean) => Promise<{ x: number; y: number; width: number; height: number } | null> }).__prismGadgetPress
      if (!ask) throw new Error('gadgets cannot be pressed here')
      const where = await ask(st.gadget, st.find, st.nth ?? 0, false)
      if (!where) throw new Error(`nothing in the ${st.gadget} panel says "${st.find}"`)
      useDemo.setState({ focus: { x: where.x - 6, y: where.y - 6, w: where.width + 12, h: where.height + 12 }, pointer: { x: where.x + Math.min(24, where.width / 2), y: where.y + where.height / 2, press: false } })
      await p.wait(900, 450)
      press()
      await ask(st.gadget, st.find, st.nth ?? 0, true)
      await p.wait(220, 160)
      release()
      await p.wait(300)
      return
    }

    case 'agent.ask': {
      const box = await awaitSurface('agent')
      if (!box) throw new Error('the message box is not there')
      await pointAt('agent:input', p)
      for (let i = 1; i <= st.text.length; i++) {
        if (p.cancelled) return
        if (p.skip) break
        box.setText(st.text.slice(0, i))
        await p.wait(i === 1 ? 160 : 46)
      }
      box.setText(st.text)
      await p.wait(320)
      await pointAt('agent:send', p)
      // asked for again rather than reused: the box re-registers itself as it is typed
      // into, and the one held since before the first letter is a box with nothing in it
      const now = surface('agent') ?? box
      now.send()
      // The box emptying is what proves the message left. Waiting to see it start
      // working instead would call an answer that failed in the first second — a model
      // that will not launch, say — a message that never sent, which is a different
      // fault and sends you looking in the wrong place.
      const off = Date.now() + 6000
      while ((surface('agent') ?? now).text().trim() && Date.now() < off) await new Promise((r) => setTimeout(r, 100))
      if ((surface('agent') ?? now).text().trim()) throw new Error('the message did not send: it is still sat in the box')
      await p.wait(260)
      return
    }

    case 'point': {
      // waits a moment for it to appear: the panel or menu it is in may have just been opened
      const target: Target = st.target ?? { demo: st.at ?? '', kind: '' }
      const el = await waitFor(target, p, 2000)
      if (p.cancelled) return
      // a recorded thing that is gone stops the lesson and says so; a built-in one is not worth stopping for
      if (!el) {
        if (st.target) throw new Error(`it could not find ${targetWords(st.target)} to point at`)
        return
      }
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      useDemo.setState({ focus: rectOf(el), pointer: { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2, press: false } })
      await p.wait(1400, 700)
      return
    }

    case 'fill': {
      // the box may have only just opened (a dialog after a menu item)
      const until = Date.now() + 4000
      let box = findField(st.target)
      while (!box && !p.cancelled && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100))
        box = findField(st.target)
      }
      if (p.cancelled) return
      if (!box) throw new Error(`it could not find ${targetWords(st.target)} to type into`)
      const r = box.getBoundingClientRect()
      useDemo.setState({ focus: rectOf(box), pointer: { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2, press: false } })
      await p.wait(700, 400)
      box.focus()
      for (let i = 1; i <= st.text.length; i++) {
        if (p.cancelled) return
        if (p.skip) break
        setFieldLikeAHand(box, st.text.slice(0, i))
        await p.wait(i === 1 ? 140 : 70)
      }
      setFieldLikeAHand(box, st.text)
      if (st.enter) {
        await p.wait(450, 250)
        enterLikeAHand(box)
        // what Enter opened or closed has a moment to settle
        await p.wait(500, 350)
      }
      return
    }

    case 'click':
    case 'hover': {
      const el = await waitFor(st.target, p, 4000)
      if (p.cancelled) return
      if (!el) throw new Error(`it could not find ${targetWords(st.target)}`)
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      useDemo.setState({ focus: rectOf(el), pointer: { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2, press: false } })
      await p.wait(900, 450)
      if (st.do === 'hover') {
        hoverLikeAHand(el)
        await p.wait(500, 300)
        return
      }
      await p.wait(250)
      press()
      pressLikeAHand(el, st.do === 'click' && st.right)
      await p.wait(220, 160)
      release()
      // what it opened (a menu, a page) has a moment to appear before the next step looks for things in it
      await p.wait(500, 350)
      return
    }

    case 'open': {
      const trigger: Record<string, string> = { settings: 'rail:settings', terminal: 'rail:terminal', palette: 'titlebar:search', agent: 'rail:agent', usage: 'status:usage' }
      if (trigger[st.what]) await pointAt(trigger[st.what]!, p)
      const layout = useLayout.getState()
      if (st.what === 'settings') layout.openSettings(st.section)
      else if (st.what === 'palette') useUi.getState().setPalette('commands')
      else if (st.what === 'terminal') layout.openTerminal()
      else if (st.what === 'browser') layout.openBrowser()
      else if (st.what === 'usage') layout.openUsage()
      else if (st.what === 'agent') layout.openAgent()
      else if (st.what === 'lessons') (await import('./recorder')).useRecorder.setState({ listOpen: true })
      await p.wait(700, 400)
      return
    }

    case 'close': {
      if (st.what === 'palette') useUi.getState().setPalette(null)
      else (await import('./recorder')).useRecorder.setState({ listOpen: false })
      await p.wait(300)
      return
    }

    case 'agent.wait': {
      // the model takes as long as the model takes; the speed slider has no say
      const box = await awaitSurface('agent')
      if (!box) return
      const until = Date.now() + (st.timeout ?? 90000)
      const live = (): boolean => (surface('agent') ?? box).running()
      useDemo.setState({ waiting: 'waiting for the answer' })
      try {
        // it has to start before it can finish, or this returns the moment it is asked.
        // An answer that fails outright never starts, so this gives up rather than
        // standing in front of an error until the timeout runs out.
        const starts = Date.now() + 8000
        while (!live() && Date.now() < starts) await new Promise((r) => setTimeout(r, 100))
        while (live() && Date.now() < until) {
          if (p.cancelled) return
          await new Promise((r) => setTimeout(r, 150))
        }
      } finally {
        useDemo.setState({ waiting: null })
      }
      await p.wait(600)
      return
    }
  }
}

/** Steps that do something real; catching up to an earlier step never runs them again. */
const REAL = new Set<DemoStep['do']>(['terminal', 'await.output', 'agent.ask', 'agent.wait'])

/** Set while a step is done and the lesson waits for Next. */
let toNext: (() => void) | null = null

/** What a step will reach for, so the light can be on it while its caption is read. */
function targetOf(st: DemoStep): string | null {
  switch (st.do) {
    case 'rail': return `rail:${st.view}`
    case 'tree.open': return `tree:${st.path}`
    case 'tree.expand': return `tree:${st.path.split('/')[0]}`
    case 'search.type': return 'search:input'
    case 'gadget.open': return 'rail:gadgets'
    case 'point': return st.at ?? null
    case 'agent.ask': return 'agent:input'
    case 'open': return ({ settings: 'rail:settings', terminal: 'rail:terminal', palette: 'titlebar:search', agent: 'rail:agent', usage: 'status:usage' } as Record<string, string>)[st.what] ?? null
    default: return null
  }
}

/** Reads a caption aloud when Listen along is on; done when it has been said or stopped. */
async function sayAloud(text: string): Promise<void> {
  if (!useDemo.getState().listen) return
  try {
    const { speak } = await import('@/lib/speech')
    await speak(text.replace(/\*\*|\*/g, ''))
  } catch {
    /* no voice here: the words are on screen anyway */
  }
}

async function quiet(): Promise<void> {
  const { stopSpeaking } = await import('@/lib/speech')
  stopSpeaking()
}

/** Holds at the end of a step until Next (or until the lesson is stopped or moved). */
function holdForNext(p: Pacer): Promise<void> {
  useDemo.setState({ atStepEnd: true })
  return new Promise<void>((resolve) => {
    toNext = () => {
      toNext = null
      useDemo.setState({ atStepEnd: false })
      resolve()
    }
    if (p.cancelled) toNext()
  })
}

/** Plays from step `from`; the steps before it are caught up on at once, without the real ones. */
async function run(demo: Demo, from = 0): Promise<void> {
  const p = new Pacer()
  pacer = p
  if (from > 0) {
    useDemo.setState({ waiting: 'catching up to that step' })
    for (let i = 0; i < from; i++) {
      const st = demo.steps[i]
      if (!st || REAL.has(st.do)) continue
      p.skip = true
      try {
        await perform(st, p)
      } catch {
        /* catching up is best effort: the step you asked for is what matters */
      }
      if (p.cancelled) return
    }
    useDemo.setState({ waiting: null })
  }
  for (let i = from; i < demo.steps.length; i++) {
    if (p.cancelled) return
    const st = demo.steps[i]
    if (!st) break
    p.skip = false
    p.setPace(st.pace ?? 1)
    const tag = targetOf(st)
    const recorded = st.do === 'click' || st.do === 'hover' ? st.target : st.do === 'point' ? st.target : undefined
    const lit = st.do === 'fill' ? rectOf(findField(st.target)) : recorded ? rectOf(findTarget(recorded)) : tag ? rectOf(document.querySelector(`[data-demo="${tag}"]`)) : null
    useDemo.setState({ step: i, caption: st.say ?? '', atStepEnd: false, focus: lit })
    // Say it before showing it, with the light already on what it is about. A step
    // that only speaks has nothing else holding the words on screen, so it keeps a
    // floor the speed cannot go under.
    if (st.say) {
      const read = readingTime(st.say)
      await Promise.all([p.wait(read * (st.do === 'say' ? 1 : 0.6), st.do === 'say' ? read * 0.5 : 900), sayAloud(st.say)])
    }
    if (p.cancelled) return
    try {
      await perform(st, p)
    } catch (e) {
      toastError(e, 'The lesson stopped here')
      useDemo.setState({ paused: true, interrupted: false })
      return
    }
    if (p.cancelled) return
    // a step with nothing to read carries straight on: holding there would leave you waiting on nothing
    if (useDemo.getState().stepwise && st.say && i < demo.steps.length - 1) await holdForNext(p)
    else await p.wait(900, 500)
  }
  useDemo.setState({ done: true, pointer: null, focus: null, atStepEnd: false, caption: 'That is the end of the lesson.' })
}

/** The lesson's own files, laid down as they were at its start. */
async function layStage(demo: Demo): Promise<void> {
  for (const f of demo.stage ?? []) {
    await prism.fs.write(f.path, f.content)
    // a tab left open from a previous run still holds the old text, and the
    // demo would then type into that instead of the file it just laid down
    await useEditor.getState().reload(f.path)
    if (!stage.includes(f.path)) stage.push(f.path)
  }
}

export function playDemo(demo: Demo): void {
  stopDemo()
  // what a demo does in the editor is not you looking at anything, and the rest
  // of Prism reads this rather than importing the player
  document.body.classList.add('demo-playing')
  useDemo.setState({ demo, step: 0, caption: '', paused: false, interrupted: false, pointer: null, focus: null, waiting: null, atStepEnd: false, done: false })
  void (async () => {
    try {
      await layStage(demo)
    } catch (e) {
      toastError(e, 'The lesson could not set up its own files')
      return
    }
    await run(demo)
  })()
}

/** Plays step `index` again from its start: earlier steps are caught up on, the files put back first. */
function playFrom(index: number): void {
  const { demo } = useDemo.getState()
  if (!demo) return
  pacer?.cancel()
  toNext?.()
  void quiet()
  clearDim()
  useDemo.setState({ paused: false, interrupted: false, done: false, atStepEnd: false, pointer: null, focus: null, waiting: null })
  void (async () => {
    try {
      await layStage(demo)
    } catch (e) {
      toastError(e, 'The lesson could not put its files back')
      return
    }
    await run(demo, Math.max(0, Math.min(index, demo.steps.length - 1)))
  })()
}

/** Back one step. */
export function previousStep(): void {
  const { step, atStepEnd, done, demo } = useDemo.getState()
  // at the end of a step, or of the lesson, "back" means this step again from where you were looking
  const here = done ? (demo?.steps.length ?? 1) - 1 : step
  playFrom(atStepEnd || done ? here : here - 1)
}

/** On to the next step: when one is waiting for you, go; in the middle of one, finish it now. */
export function nextStep(): void {
  if (toNext) return toNext()
  skipStep()
}

export function setStepwise(on: boolean): void {
  localStorage.setItem(STEPWISE_KEY, on ? 'on' : 'off')
  useDemo.setState({ stepwise: on })
  if (!on) toNext?.()
}

export function setListen(on: boolean): void {
  localStorage.setItem(LISTEN_KEY, on ? 'on' : 'off')
  useDemo.setState({ listen: on })
  if (!on) void quiet()
}

export function stopDemo(): void {
  pacer?.cancel()
  pacer = null
  toNext?.()
  void quiet()
  clearDim()
  term?.off()
  term = null
  // Deleting the stage pulls the file out from under its own open tab, which
  // reports a cursor move; the flag stays up until that has gone through, or
  // the message box ends up offering a file the demo invented.
  const files = stage
  stage = []
  // then the folders they made, deepest first, but only once nothing else is in them
  const folders = [...new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))]
    // only a lesson's own scratch folders: a listing can leave hidden things out, and deleting a folder takes all of it
    .filter((d) => d === 'prism-lesson' || d.startsWith('prism-lesson/') || d === '.prism/demo-stage' || d.startsWith('.prism/demo-stage/'))
    .sort((a, b) => b.split('/').length - a.split('/').length)
  const tidy = async (): Promise<void> => {
    await Promise.all(files.map((path) => prism.fs.delete(path).catch(() => {})))
    for (const d of folders) {
      const left = await prism.fs.list(d).catch(() => null)
      if (left && left.length === 0) await prism.fs.delete(d).catch(() => {})
    }
  }
  void tidy().finally(() =>
    setTimeout(() => {
      // playDemo stops the last demo before starting the next: do not pull the
      // flag down on a demo that has begun in the meantime
      if (!useDemo.getState().demo) document.body.classList.remove('demo-playing')
    }, 400)
  )
  useDemo.setState({ demo: null, pointer: null, focus: null, caption: '', paused: false, interrupted: false, waiting: null, atStepEnd: false, done: false })
}

/** Hold where we are. `yours` means you touched something rather than pressing pause. */
export function pauseDemo(yours = false): void {
  if (useDemo.getState().paused) return
  useDemo.setState({ paused: true, interrupted: yours, pointer: null })
  void quiet()
  pacer?.wake()
}

export function resumeDemo(): void {
  useDemo.setState({ paused: false, interrupted: false })
  pacer?.wake()
}

/** Finish this step at once: the rest of the typing lands in one go. */
export function skipStep(): void {
  useDemo.setState({ paused: false, interrupted: false })
  pacer?.skipStep()
}

export function setDemoSpeed(speed: number): void {
  localStorage.setItem(SPEED_KEY, String(speed))
  useDemo.setState({ speed })
}
