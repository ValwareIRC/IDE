// The lessons you make: the bar shown while recording one, the editor a recording opens
// in (captions, pace, order), and the list of lessons to play, edit or record.
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Circle, Crosshair, GraduationCap, MessageSquareText, MousePointerClick, Play, Square, Trash2, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { prism } from '@/lib/ipc'
import { toastError, useUi } from '@/state/ui'
import { useApp } from '@/state/app'
import { cx } from '@/lib/format'
import { playDemo } from './player'
import { addSay, cancelRecording, describe, pointAtSelection, setPicking, startRecording, stopRecording, useRecorder } from './recorder'
import type { Demo, DemoStep } from './script'
import { BUILTIN_LESSONS } from './builtinLessons'

/** While recording: what has been caught so far, a caption for the next thing, and the way out. */
export function RecordBar(): React.JSX.Element | null {
  const recording = useRecorder((s) => s.recording)
  const steps = useRecorder((s) => s.steps)
  const caption = useRecorder((s) => s.caption)
  const picking = useRecorder((s) => s.picking)
  const hover = useRecorder((s) => s.hover)
  if (!recording) return null
  const lastStep = steps[steps.length - 1]
  return (
    <>
    {picking && hover && <div className="record-pick" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} aria-hidden />}
    <div className="demo-bar record-bar" role="region" aria-label="Recording a lesson">
      <div className="record-head">
        <span className="record-dot" aria-hidden />
        <b>Recording a lesson</b>
        <span className="faint small">
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {lastStep ? ` · last: ${describe(lastStep)}` : ' · do the first thing'}
        </span>
      </div>
      <textarea
        className="input record-caption"
        rows={2}
        aria-label="Caption for what you do next"
        placeholder="Caption for what you do next (optional). It shows while that step plays."
        value={caption}
        onChange={(e) => useRecorder.setState({ caption: e.target.value })}
      />
      <div className="record-btns">
        <button className="btn sm" title="Add the caption as a step of its own, to read before the next thing happens" disabled={!caption.trim()} onClick={() => addSay(caption)}>
          <MessageSquareText size={13} /> Caption on its own
        </button>
        <button className={cx('btn sm', picking && 'solid')} title="The next thing you click is lit up when the lesson plays, instead of being pressed. F8 does the same without leaving an open menu." onClick={() => setPicking(!picking)}>
          <Crosshair size={13} /> {picking ? 'Click what to point at… (Esc)' : 'Point at something (F8)'}
        </button>
        <button
          className="btn sm"
          title="Light up what you have selected in the open file, and dim the rest"
          onClick={() => {
            const why = pointAtSelection()
            if (why) useUi.getState().toast('info', 'Nothing to point at', why)
          }}
        >
          <MousePointerClick size={13} /> Point at the selection
        </button>
        <span className="grow" />
        <button className="btn sm ghost" onClick={cancelRecording}>
          Throw away
        </button>
        <button className="btn sm solid" onClick={stopRecording}>
          <Square size={12} /> Stop
        </button>
      </div>
      <div className="faint small">Every click is recorded as you go, menus included. Captions can also be written afterwards, in the editor that opens when you stop.</div>
    </div>
    </>
  )
}

const PACES: Array<[number, string]> = [
  [0.5, 'slower'],
  [1, 'normal'],
  [2, 'faster']
]

/** A lesson's title, steps, captions and pace; then play it, or keep it. */
export function LessonEditor(): React.JSX.Element | null {
  const draft = useRecorder((s) => s.draft)
  const hasProject = !!useApp((s) => s.workspace)
  const [busy, setBusy] = useState(false)
  if (!draft) return null
  const { demo } = draft
  const set = (next: Partial<Demo>): void => useRecorder.setState({ draft: { ...draft, demo: { ...demo, ...next } } })
  const setStep = (i: number, next: Partial<DemoStep>): void => set({ steps: demo.steps.map((s, j) => (j === i ? ({ ...s, ...next } as DemoStep) : s)) })
  const move = (i: number, by: number): void => {
    const steps = [...demo.steps]
    const [s] = steps.splice(i, 1)
    steps.splice(i + by, 0, s!)
    set({ steps })
  }
  const close = (): void => useRecorder.setState({ draft: null })
  const from = (i: number): void => playDemo({ ...demo, title: demo.title || 'Untitled lesson', steps: demo.steps.slice(i) })
  const save = async (): Promise<void> => {
    if (!demo.title.trim()) return useUi.getState().toast('info', 'Give it a title first', 'It is how you will find it in the Lessons list.')
    setBusy(true)
    try {
      const id = await prism.lessons.write(draft.scope, { ...demo, title: demo.title.trim() }, draft.id)
      useRecorder.setState({ draft: null, listOpen: true })
      useUi.getState().toast('success', 'Lesson saved', `${demo.title.trim()}, ${draft.scope === 'project' ? 'in this project' : 'in your own lessons'}.`)
      void id
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={draft.id ? 'Edit the lesson' : 'Your new lesson'}
      icon={<GraduationCap size={16} />}
      onClose={close}
      width={760}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Close without saving
          </button>
          <span className="grow" />
          <button className="btn" disabled={!demo.steps.length} onClick={() => from(0)}>
            <Play size={13} /> Play it
          </button>
          <button className="btn solid" disabled={busy || !demo.steps.length} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="lesson-ed">
        <label className="field">
          <span>Title</span>
          <input className="input" value={demo.title} placeholder="How to make your first UnrealIRCd module" autoFocus onChange={(e) => set({ title: e.target.value })} />
        </label>
        {!draft.id && (
          <div className="lesson-where">
            <span className="faint small">Keep it</span>
            <label className="small">
              <input type="radio" checked={draft.scope === 'project'} disabled={!hasProject} onChange={() => useRecorder.setState({ draft: { ...draft, scope: 'project' } })} /> in this project, so it travels with it
            </label>
            <label className="small">
              <input type="radio" checked={draft.scope === 'personal'} onChange={() => useRecorder.setState({ draft: { ...draft, scope: 'personal' } })} /> in your own lessons, shown in every project
            </label>
          </div>
        )}
        {!demo.steps.length && <div className="faint small">Nothing was recorded. Close this and record again, doing things in the side bar, the editor, the terminal or the message box.</div>}
        <ol className="lesson-steps">
          {demo.steps.map((st, i) => (
            <li key={i} className="lesson-step">
              <div className="lesson-step-head">
                <span className="lesson-num">{i + 1}</span>
                <span className="grow truncate" title={describe(st)}>
                  {describe(st)}
                </span>
                <select className="input sm" aria-label={`Pace of step ${i + 1}`} value={st.pace ?? 1} onChange={(e) => setStep(i, { pace: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })}>
                  {PACES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <button className="icon-btn sm" title="Play from here" aria-label={`Play from step ${i + 1}`} onClick={() => from(i)}>
                  <Play size={13} />
                </button>
                <button className="icon-btn sm" title="Move up" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button className="icon-btn sm" title="Move down" aria-label={`Move step ${i + 1} down`} disabled={i === demo.steps.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button className="icon-btn sm" title="Remove this step" aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: demo.steps.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea className="input" rows={st.say && st.say.length > 90 ? 3 : 1} aria-label={`Caption for step ${i + 1}`} placeholder={st.do === 'say' ? 'What to say' : 'Caption while this happens (optional)'} value={st.say ?? ''} onChange={(e) => setStep(i, { say: e.target.value || undefined })} />
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  )
}

type Listed = { id: string; scope: 'project' | 'personal' | 'builtin'; title: string; steps: number }

/** Every lesson there is: play one, change one, or record a new one. */
export function LessonsList(): React.JSX.Element | null {
  const open = useRecorder((s) => s.listOpen)
  const workspace = useApp((s) => s.workspace)
  const [list, setList] = useState<Listed[] | null>(null)
  const load = (): void =>
    void (async () => {
      const own = await prism.lessons.list()
      const builtin: Listed[] = BUILTIN_LESSONS.map((b) => ({ id: `builtin:${b.id}`, scope: 'builtin', title: b.demo.title, steps: b.demo.steps.length }))
      // the first lesson ever made walks through Prism's own code, so it only works where that is open
      const inPrism = await prism.fs
        .read('src/core/agent/tools/tour.ts')
        .then(() => true)
        .catch(() => false)
      if (inPrism) builtin.push({ id: 'builtin:first', scope: 'builtin', title: 'How a tour finds its place again (Prism’s own code)', steps: 0 })
      setList([...own, ...builtin])
    })().catch(toastError)
  useEffect(() => {
    if (open) load()
  }, [open, workspace])
  if (!open) return null
  const close = (): void => useRecorder.setState({ listOpen: false })
  const play = async (l: Listed): Promise<void> => {
    try {
      const demo =
        l.id === 'builtin:first'
          ? (await import('./firstDemo')).firstDemo
          : l.scope === 'builtin'
            ? BUILTIN_LESSONS.find((b) => `builtin:${b.id}` === l.id)!.demo
            : ((await prism.lessons.read(l.id)) as Demo)
      close()
      playDemo(demo)
    } catch (e) {
      toastError(e, 'The lesson could not be opened')
    }
  }
  const edit = async (l: Listed): Promise<void> => {
    try {
      const demo = (await prism.lessons.read(l.id)) as Demo
      useRecorder.setState({ listOpen: false, draft: { demo, id: l.id, scope: l.scope === 'personal' ? 'personal' : 'project' } })
    } catch (e) {
      toastError(e)
    }
  }
  const remove = async (l: Listed): Promise<void> => {
    if (!window.confirm(`Delete the lesson "${l.title}"?`)) return
    await prism.lessons.remove(l.id).catch(toastError)
    load()
  }
  return (
    <Modal
      title="Lessons"
      icon={<GraduationCap size={16} />}
      onClose={close}
      width={620}
      footer={
        <>
          <span className="faint small grow">Recording catches what you do in the side bar, the file tree, Search, the editor, the terminal and the message box.</span>
          <button
            className="btn solid"
            data-demo="lessons:record"
            onClick={() => {
              close()
              startRecording()
            }}
          >
            <Circle size={12} /> Record a new lesson
          </button>
        </>
      }
    >
      {list === null && <div className="faint small">Loading…</div>}
      {list && (
        <div className="lesson-list">
          {list.map((l) => (
            <div key={l.id} className="lesson-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{l.title}</div>
                <div className="faint small">
                  {l.scope === 'builtin' ? 'Comes with Prism' : l.scope === 'project' ? 'This project' : 'Your own'}
                  {l.steps ? ` · ${l.steps} steps` : ''}
                </div>
              </div>
              <button className="btn sm solid" onClick={() => void play(l)}>
                <Play size={12} /> Play
              </button>
              {l.scope !== 'builtin' && (
                <>
                  <button className="btn sm" onClick={() => void edit(l)}>
                    Edit
                  </button>
                  <button className="icon-btn sm" title="Delete this lesson" aria-label={`Delete ${l.title}`} onClick={() => void remove(l)}>
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** Everything above, mounted once beside the player's own bar. */
export function LessonsLayer(): React.JSX.Element {
  return (
    <>
      <RecordBar />
      <LessonEditor />
      <LessonsList />
    </>
  )
}
