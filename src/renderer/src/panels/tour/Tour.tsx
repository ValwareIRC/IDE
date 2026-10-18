import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { ChevronLeft, ChevronRight, Compass, Play, Trash2, X } from 'lucide-react'
import type { CodeTour } from '@shared/types'
import { prism } from '@/lib/ipc'
import { editorFor } from '@/lib/editorBus'
import { monaco } from '@/lib/monaco'
import { useApp } from '@/state/app'
import { useLayout } from '@/state/layout'
import { toastError } from '@/state/ui'
import { Markdown } from '@/components/Markdown'

const TOUR_DIR = '.prism/tours'

interface Playing {
  path: string
  tour: CodeTour
  step: number
  /** The step's line could not be found by its text; it is shown at the remembered line. */
  moved: boolean
}

export const useTour = create<{ playing: Playing | null }>(() => ({ playing: null }))

/** The line a step points at: its text where it is now, else the remembered line. */
function findAnchor(content: string, anchor: string, line: number): { line: number; moved: boolean } {
  const want = anchor.trim()
  const lines = content.split(/\r?\n/)
  const exact = lines.findIndex((l) => l.trim() === want)
  if (exact >= 0) return { line: exact + 1, moved: false }
  const part = want ? lines.findIndex((l) => l.includes(want)) : -1
  if (part >= 0) return { line: part + 1, moved: false }
  return { line: Math.min(line, lines.length), moved: true }
}

let decorations: monaco.editor.IEditorDecorationsCollection | null = null

async function show(p: Playing): Promise<void> {
  const s = p.tour.steps[p.step]
  if (!s) return
  let at = { line: s.line, moved: true }
  try {
    at = findAnchor((await prism.fs.read(s.file)).content, s.anchor, s.line)
  } catch {
    /* the file is gone: the bar says so */
  }
  useTour.setState({ playing: { ...p, moved: at.moved } })
  useLayout.getState().openEditor(s.file, { line: at.line })
  // the line itself is marked while its step is shown
  for (let i = 0; i < 20; i++) {
    const ed = editorFor(s.file)
    if (ed) {
      decorations?.clear()
      decorations = ed.createDecorationsCollection([{ range: new monaco.Range(at.line, 1, at.line, 1), options: { isWholeLine: true, className: 'tour-line', linesDecorationsClassName: 'tour-gutter' } }])
      ed.revealLineInCenter(at.line)
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function playTour(path: string, from = 0): Promise<void> {
  try {
    const tour = JSON.parse((await prism.fs.read(path)).content) as CodeTour
    if (!Array.isArray(tour.steps) || !tour.steps.length) throw new Error('That tour has no steps.')
    await show({ path, tour, step: Math.min(from, tour.steps.length - 1), moved: false })
  } catch (e) {
    toastError(e, 'Could not play that tour')
  }
}

function stop(): void {
  decorations?.clear()
  decorations = null
  useTour.setState({ playing: null })
}

/** The card shown while a tour plays: the note for this step, and the way on. */
export function TourBar(): React.JSX.Element | null {
  const p = useTour((s) => s.playing)
  useEffect(() => {
    if (!p) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return
      if (e.key === 'ArrowRight' && p.step < p.tour.steps.length - 1) void show({ ...p, step: p.step + 1 })
      if (e.key === 'ArrowLeft' && p.step > 0) void show({ ...p, step: p.step - 1 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])
  if (!p) return null
  const s = p.tour.steps[p.step]!
  const last = p.step === p.tour.steps.length - 1
  return (
    <div className="tour-bar">
      <div className="tour-head">
        <Compass size={14} className="accent" />
        <b className="truncate">{p.tour.title}</b>
        <span className="faint xs">
          {p.step + 1} of {p.tour.steps.length}
        </span>
        <span className="grow" />
        <button className="icon-btn sm" title="End the tour" onClick={stop}>
          <X size={13} />
        </button>
      </div>
      <div className="tour-where mono xs faint">{s.file}</div>
      <div className="tour-note md">
        <Markdown text={s.note} />
      </div>
      {p.moved && <div className="amber xs">This line has changed since the tour was made, so this is where it used to be.</div>}
      <div className="tour-foot">
        <div className="tour-dots">
          {p.tour.steps.map((_, i) => (
            <i key={i} className={i === p.step ? 'on' : i < p.step ? 'seen' : ''} onClick={() => void show({ ...p, step: i })} />
          ))}
        </div>
        <span className="grow" />
        <button className="btn sm ghost" disabled={p.step === 0} onClick={() => void show({ ...p, step: p.step - 1 })} title="Alt+←">
          <ChevronLeft size={12} /> Back
        </button>
        {last ? (
          <button className="btn sm solid" onClick={stop}>
            Done
          </button>
        ) : (
          <button className="btn sm solid" onClick={() => void show({ ...p, step: p.step + 1 })} title="Alt+→">
            Next <ChevronRight size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

/** The project's tours, and a way to ask for a new one. */
export function ToursPanel(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const [tours, setTours] = useState<Array<{ path: string; tour: CodeTour }> | null>(null)
  const [topic, setTopic] = useState('')
  const load = useCallback(async () => {
    try {
      const list = (await prism.fs.list(TOUR_DIR).catch(() => [])).filter((e) => e.kind === 'file' && e.name.endsWith('.json'))
      const out: Array<{ path: string; tour: CodeTour }> = []
      for (const e of list) {
        try {
          out.push({ path: e.path, tour: JSON.parse((await prism.fs.read(e.path)).content) as CodeTour })
        } catch {
          /* not a tour */
        }
      }
      setTours(out)
    } catch (e) {
      toastError(e)
    }
  }, [])
  useEffect(() => {
    void load()
    return prism.fs.onChanged((changes) => {
      if (changes.some((c) => c.path.startsWith(TOUR_DIR))) void load()
    })
  }, [load, workspace])

  const ask = async (): Promise<void> => {
    if (!topic.trim()) return
    const { useSessions } = await import('@/state/sessions')
    useLayout.getState().openAgent()
    await useSessions.getState().send(`/tour ${topic.trim()}`)
    setTopic('')
  }

  return (
    <div className="tours">
      <div className="review-bar">
        <Compass size={15} className="accent" />
        <span className="review-title">Tours</span>
        <span className="faint xs">guided walks through the code, kept in {TOUR_DIR}</span>
      </div>
      <div className="tours-body">
        <div className="tours-ask">
          <input className="input" value={topic} placeholder="Show me how… (for example: a request reaches the database)" onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void ask()} />
          <button className="btn solid" disabled={!topic.trim()} onClick={() => void ask()}>
            Make a tour
          </button>
        </div>
        {tours?.map((t) => (
          <div key={t.path} className="card ep-card">
            <Compass size={16} className="extend-icon" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ep-name">{t.tour.title}</div>
              <div className="faint xs">
                {t.tour.steps.length} steps · {[...new Set(t.tour.steps.map((s) => s.file))].length} files
              </div>
            </div>
            <button className="btn sm solid" onClick={() => void playTour(t.path)}>
              <Play size={12} /> Play
            </button>
            <button className="icon-btn" title="Delete" onClick={() => window.confirm(`Delete the tour "${t.tour.title}"?`) && void prism.fs.delete(t.path).then(load).catch(toastError)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {tours && !tours.length && <div className="faint small">No tours yet. Ask for one above, or type /tour in the agent.</div>}
      </div>
    </div>
  )
}
