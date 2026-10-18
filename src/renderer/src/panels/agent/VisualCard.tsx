import { useEffect, useRef, useState } from 'react'
import { Columns2, Eye, Highlighter, SplitSquareHorizontal } from 'lucide-react'
import { cx } from '@/lib/format'

type View = 'slide' | 'side' | 'changes'

const src = (name: string): string => `prism://attach/${name}`

/** The page before and after a turn: drag to compare, side by side, or with what changed marked. */
export function VisualCard({ url, before, after }: { url: string; before: string; after: string }): React.JSX.Element {
  const [view, setView] = useState<View>('slide')
  const [split, setSplit] = useState(50)
  const [share, setShare] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  const drag = (e: React.PointerEvent): void => {
    const el = box.current
    if (!el) return
    const move = (x: number): void => {
      const r = el.getBoundingClientRect()
      setSplit(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)))
    }
    move(e.clientX)
    const onMove = (ev: PointerEvent): void => move(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
  }

  // the changed places: the new picture, dimmed, with every pixel that differs painted over
  useEffect(() => {
    if (view !== 'changes' || !canvas.current) return
    let gone = false
    const load = (s: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const im = new Image()
        im.crossOrigin = 'anonymous'
        im.onload = () => resolve(im)
        im.onerror = reject
        im.src = s
      })
    void Promise.all([load(src(before)), load(src(after))]).then(([a, b]) => {
      if (gone || !canvas.current) return
      const w = Math.max(a.width, b.width)
      const h = Math.max(a.height, b.height)
      const c = canvas.current
      c.width = w
      c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(a, 0, 0)
      const pa = g.getImageData(0, 0, w, h)
      g.clearRect(0, 0, w, h)
      g.drawImage(b, 0, 0)
      const pb = g.getImageData(0, 0, w, h)
      const out = g.createImageData(w, h)
      let changed = 0
      for (let i = 0; i < pb.data.length; i += 4) {
        const d = Math.abs(pa.data[i]! - pb.data[i]!) + Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) + Math.abs(pa.data[i + 2]! - pb.data[i + 2]!)
        if (d > 40) {
          changed++
          out.data[i] = 255
          out.data[i + 1] = 70
          out.data[i + 2] = 140
          out.data[i + 3] = 255
        } else {
          // what did not change, faded so the changes stand out
          out.data[i] = pb.data[i]! * 0.35
          out.data[i + 1] = pb.data[i + 1]! * 0.35
          out.data[i + 2] = pb.data[i + 2]! * 0.35
          out.data[i + 3] = 255
        }
      }
      g.putImageData(out, 0, 0)
      setShare(changed / (w * h))
    })
    return () => {
      gone = true
    }
  }, [view, before, after])

  return (
    <div className="visual-card">
      <div className="visual-head">
        <Eye size={13} className="accent" />
        <b>The page, before and after</b>
        <span className="faint xs truncate" title={url}>
          {url}
        </span>
        <span className="grow" />
        <div className="seg">
          <button className={cx(view === 'slide' && 'on')} onClick={() => setView('slide')} title="Drag across to compare">
            <SplitSquareHorizontal size={12} />
          </button>
          <button className={cx(view === 'side' && 'on')} onClick={() => setView('side')} title="Side by side">
            <Columns2 size={12} />
          </button>
          <button className={cx(view === 'changes' && 'on')} onClick={() => setView('changes')} title="Mark what changed">
            <Highlighter size={12} />
          </button>
        </div>
      </div>
      {view === 'slide' && (
        <div className="visual-slide" ref={box} onPointerDown={drag}>
          <img src={src(after)} alt="after" draggable={false} />
          <img src={src(before)} alt="before" draggable={false} className="visual-top" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
          <div className="visual-bar" style={{ left: `${split}%` }}>
            <span>before</span>
            <span>after</span>
          </div>
        </div>
      )}
      {view === 'side' && (
        <div className="visual-side">
          <figure>
            <img src={src(before)} alt="before" />
            <figcaption>before</figcaption>
          </figure>
          <figure>
            <img src={src(after)} alt="after" />
            <figcaption>after</figcaption>
          </figure>
        </div>
      )}
      {view === 'changes' && (
        <div className="visual-changes">
          <canvas ref={canvas} />
          <div className="faint xs">{share === null ? 'Comparing…' : share < 0.0005 ? 'Almost nothing changed on screen.' : `About ${Math.max(1, Math.round(share * 100))}% of the page changed, shown in pink.`}</div>
        </div>
      )}
    </div>
  )
}
