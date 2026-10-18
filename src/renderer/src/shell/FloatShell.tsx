// One tab, out on the desktop. No title bar and nothing around it: at rest this is
// just the gadget (or the terminal, or the diff) sitting on your desktop. A strip to
// drag it by and the few controls it needs fade in when the pointer is over it.
import { useEffect, useState } from 'react'
import { GripHorizontal, Pin, PinOff, SunDim, X } from 'lucide-react'
import { prism } from '@/lib/ipc'
import { cx } from '@/lib/format'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { COMPONENTS, type Params } from './Dock'
import '@/styles/float.css'

export interface FloatSpec {
  kind: string
  key: string
  title: string
  params: Record<string, unknown>
}

/** The tab this window was opened for, which the main process put in the address. */
export function floatSpec(): FloatSpec | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('float')
    if (!raw) return null
    const spec = JSON.parse(raw) as FloatSpec
    return spec && typeof spec.kind === 'string' && typeof spec.key === 'string' ? spec : null
  } catch {
    return null
  }
}

const OPACITIES = [1, 0.85, 0.65, 0.45]

export function FloatShell({ spec }: { spec: FloatSpec }): React.JSX.Element {
  const [over, setOver] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [dim, setDim] = useState(0)
  const [moving, setMoving] = useState(false)

  // the window follows the pointer in the main process (see main/float.ts); letting go
  // anywhere, even off the window, ends it
  useEffect(() => {
    if (!moving) return
    const stop = (): void => {
      setMoving(false)
      void prism.float.drag(false)
    }
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [moving])

  // the window grows upwards to make room for the strip, so none of the gadget is
  // covered and none of it moves (see main/float.ts)
  const up = over || moving
  useEffect(() => {
    void prism.float.bar(up)
  }, [up])

  useEffect(() => {
    document.title = spec.title
    document.body.classList.add('floating')
    return () => document.body.classList.remove('floating')
  }, [spec.title])

  const Host = COMPONENTS[spec.kind as keyof typeof COMPONENTS] as unknown as ((p: { params: Params; api: unknown }) => React.JSX.Element) | undefined

  const nextDim = (): void => {
    const i = (dim + 1) % OPACITIES.length
    setDim(i)
    void prism.float.opacity(OPACITIES[i]!)
  }

  const togglePin = (): void => {
    const on = !pinned
    setPinned(on)
    void prism.float.pin(on)
  }

  return (
    <div className="floater" onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)}>
      <div className={cx('floater-bar', up && 'show')}>
        <span
          className="floater-grip"
          title={`${spec.title} — drag to move`}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            setMoving(true)
            void prism.float.drag(true)
          }}
        >
          <GripHorizontal size={12} />
          <span className="floater-title">{spec.title}</span>
        </span>
        <button className="floater-btn" title={`Make it ${OPACITIES[(dim + 1) % OPACITIES.length]! < 1 ? 'see-through' : 'solid'}`} onClick={nextDim}>
          <SunDim size={13} />
        </button>
        <button className={cx('floater-btn', pinned && 'on')} title={pinned ? 'Let other windows cover it' : 'Keep it above other windows'} onClick={togglePin}>
          {pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button className="floater-btn" title="Put it away" onClick={() => void prism.float.close()}>
          <X size={13} />
        </button>
      </div>
      <div className="floater-body">
        {Host ? (
          <ErrorBoundary label={spec.title}>
            <Host
              params={{ ...spec.params, kind: spec.kind } as Params}
              api={{ id: spec.key, title: spec.title, close: () => void prism.float.close(), updateParameters: () => {}, setTitle: () => {} }}
            />
          </ErrorBoundary>
        ) : (
          <div className="empty">
            <div className="title">This cannot be shown on its own</div>
            <div className="faint small">{spec.kind}</div>
          </div>
        )}
      </div>
    </div>
  )
}
