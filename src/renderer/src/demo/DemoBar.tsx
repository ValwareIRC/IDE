// What you see while a lesson plays: the pointer, the light on what a step is about with
// its caption right beside it (so you read where you look, not at the bottom of the
// screen), and a bar of controls: back, pause, next, speed, step by step, listen along.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Footprints, Hand, Pause, Play, Rabbit, Snail, Volume2, VolumeX, X } from 'lucide-react'
import { Markdown } from '@/components/Markdown'
import { cx } from '@/lib/format'
import { nextStep, pauseDemo, playDemo, previousStep, resumeDemo, setDemoSpeed, setListen, setStepwise, stopDemo, useDemo } from './player'
import type { Demo } from './script'

export function DemoPointer(): React.JSX.Element | null {
  const p = useDemo((s) => s.pointer)
  const presses = useDemo((s) => s.presses)
  const speed = useDemo((s) => s.speed)
  if (!p) return null
  return (
    <div className={cx('demo-pointer', p.press && 'press')} style={{ left: p.x, top: p.y, transitionDuration: `${Math.round(850 / speed)}ms` }} aria-hidden>
      <span className="demo-pointer-halo" />
      {/* a new ripple for every press */}
      {presses > 0 && <span key={presses} className="demo-pointer-ripple" />}
      <svg className="demo-pointer-arrow" width="30" height="30" viewBox="0 0 24 24">
        <path d="M4 2.5 L4 19 L8.6 14.9 L11.7 21.5 L14.6 20.2 L11.6 13.7 L17.8 13.7 Z" />
      </svg>
    </div>
  )
}

const BUBBLE_W = 340
const GAP = 16

/** The light: the screen dims around what the step is about, and the caption sits beside it. */
function DemoCoach(): React.JSX.Element | null {
  const demo = useDemo((s) => s.demo)
  const focus = useDemo((s) => s.focus)
  const caption = useDemo((s) => s.caption)
  const step = useDemo((s) => s.step)
  const atStepEnd = useDemo((s) => s.atStepEnd)
  const done = useDemo((s) => s.done)
  const bubble = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(120)
  useLayoutEffect(() => {
    if (bubble.current) setH(bubble.current.offsetHeight)
  })
  if (!demo || done) return null

  // beside the light where there is room (right, then left, then below, then above); in the middle when there is none
  const vw = window.innerWidth
  const vh = window.innerHeight
  let pos: React.CSSProperties
  if (!focus) pos = { left: (vw - BUBBLE_W) / 2, top: Math.max(60, vh * 0.32) }
  else {
    const clampY = (y: number): number => Math.min(Math.max(12, y), vh - h - 120)
    const clampX = (x: number): number => Math.min(Math.max(12, x), vw - BUBBLE_W - 12)
    if (focus.x + focus.w + GAP + BUBBLE_W < vw - 12) pos = { left: focus.x + focus.w + GAP, top: clampY(focus.y) }
    else if (focus.x - GAP - BUBBLE_W > 12) pos = { left: focus.x - GAP - BUBBLE_W, top: clampY(focus.y) }
    else if (focus.y + focus.h + GAP + h < vh - 120) pos = { left: clampX(focus.x), top: focus.y + focus.h + GAP }
    else pos = { left: clampX(focus.x), top: Math.max(12, focus.y - GAP - h) }
  }

  return (
    <>
      {focus && <div className="demo-light" style={{ left: focus.x, top: focus.y, width: focus.w, height: focus.h }} aria-hidden />}
      {caption && (
        <div ref={bubble} className={cx('demo-bubble demo-bar-part', !focus && 'centred')} style={{ ...pos, width: BUBBLE_W }} role="status" aria-live="polite">
          <div className="demo-bubble-step faint">
            Step {Math.min(step + 1, demo.steps.length)} of {demo.steps.length}
          </div>
          <div className="demo-caption md">
            <Markdown text={caption} />
          </div>
          {atStepEnd && (
            <div className="demo-bubble-next">
              <button className="btn sm solid" onClick={nextStep} autoFocus>
                Next <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export function DemoBar(): React.JSX.Element | null {
  const demo = useDemo((s) => s.demo)
  const step = useDemo((s) => s.step)
  const caption = useDemo((s) => s.caption)
  const paused = useDemo((s) => s.paused)
  const interrupted = useDemo((s) => s.interrupted)
  const waiting = useDemo((s) => s.waiting)
  const speed = useDemo((s) => s.speed)
  const stepwise = useDemo((s) => s.stepwise)
  const listen = useDemo((s) => s.listen)
  const atStepEnd = useDemo((s) => s.atStepEnd)
  const done = useDemo((s) => s.done)

  // touching anything stops the lesson where it is: it is your editor, not its editor.
  // The arrow keys move between steps, and space pauses or carries on.
  useEffect(() => {
    if (!demo) return
    const mine = (e: Event): boolean => !!(e.target as Element | null)?.closest?.('.demo-bar, .demo-bar-part')
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && useDemo.getState().atStepEnd && !mine(e))) {
        e.preventDefault()
        e.stopPropagation()
        return nextStep()
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        return previousStep()
      }
      if (e.key === ' ' && !mine(e)) {
        e.preventDefault()
        e.stopPropagation()
        return useDemo.getState().paused ? resumeDemo() : pauseDemo(false)
      }
      if (mine(e) || useDemo.getState().paused || useDemo.getState().atStepEnd) return
      pauseDemo(true)
    }
    const onTouch = (e: Event): void => {
      if (!e.isTrusted) return
      if (mine(e) || useDemo.getState().paused || useDemo.getState().atStepEnd) return
      pauseDemo(true)
    }
    const opts = { capture: true } as const
    window.addEventListener('pointerdown', onTouch, opts)
    window.addEventListener('keydown', onKey, opts)
    window.addEventListener('wheel', onTouch, opts)
    return () => {
      window.removeEventListener('pointerdown', onTouch, opts)
      window.removeEventListener('keydown', onKey, opts)
      window.removeEventListener('wheel', onTouch, opts)
    }
  }, [demo])

  if (!demo) return null
  return (
    <>
      <DemoCoach />
      <div className="demo-bar" role="region" aria-label={`Lesson: ${demo.title}`}>
        <div className="demo-head">
          <b className="truncate">{demo.title}</b>
          <span className="faint xs">
            {Math.min(step + 1, demo.steps.length)} of {demo.steps.length}
          </span>
          <span className="grow" />
          <button className="icon-btn sm" title="End the lesson" aria-label="End the lesson" onClick={stopDemo}>
            <X size={13} />
          </button>
        </div>

        {done && caption && <div className="demo-caption md"><Markdown text={caption} /></div>}

        {waiting && (
          <div className="demo-waiting xs faint">
            <span className="dot live" /> {waiting}: this takes as long as it really takes
          </div>
        )}

        {interrupted && (
          <div className="demo-yours xs">
            <Hand size={12} /> You took over. The lesson is holding here.
          </div>
        )}

        {done ? (
          <div className="demo-foot">
            <button className="btn sm ghost" onClick={previousStep}>
              <ChevronLeft size={13} /> Last step again
            </button>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => playDemo(demo)}>
              From the start
            </button>
            <button className="btn sm solid" onClick={stopDemo}>
              Done
            </button>
          </div>
        ) : (
          <div className="demo-foot">
            <button className="btn sm ghost" onClick={previousStep} title="Back one step (←)" disabled={step === 0 && !atStepEnd}>
              <ChevronLeft size={13} /> Back
            </button>
            {paused ? (
              <button className="btn sm solid" onClick={resumeDemo} title="Carry on (space)">
                <Play size={12} /> {interrupted ? 'Carry on' : 'Play'}
              </button>
            ) : (
              <button className="btn sm ghost" onClick={() => pauseDemo(false)} title="Pause (space)" disabled={atStepEnd}>
                <Pause size={12} /> Pause
              </button>
            )}
            <button className={cx('btn sm', atStepEnd ? 'solid' : 'ghost')} onClick={nextStep} title={atStepEnd ? 'Next step (→)' : 'Finish this step now (→)'}>
              {atStepEnd ? 'Next' : 'Skip'} <ChevronRight size={13} />
            </button>
            <span className="grow" />
            <button className={cx('btn sm ghost demo-toggle', stepwise && 'on')} role="switch" aria-checked={stepwise} onClick={() => setStepwise(!stepwise)} title="Step by step: wait for you to press Next after each step">
              <Footprints size={13} /> Step by step
            </button>
            <button className={cx('btn sm ghost demo-toggle', listen && 'on')} role="switch" aria-checked={listen} onClick={() => setListen(!listen)} title="Listen along: read each caption aloud as well">
              {listen ? <Volume2 size={13} /> : <VolumeX size={13} />} Listen along
            </button>
            <div className="demo-speed" title="How fast it acts. Real work, like a command running, is never hurried.">
              <Snail size={13} className="faint" />
              <input type="range" min={0.5} max={2} step={0.25} value={speed} aria-label="Speed" onChange={(e) => setDemoSpeed(Number(e.target.value))} />
              <Rabbit size={13} className="faint" />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export type { Demo }
