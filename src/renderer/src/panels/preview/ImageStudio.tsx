import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Columns2, GitCompare, Maximize, Pipette, SplitSquareHorizontal, X } from 'lucide-react'
import { prism } from '@/lib/ipc'
import { toastError, useUi } from '@/state/ui'
import { copyText } from '@/lib/copy'
import { cx, humanSize } from '@/lib/format'

type Backdrop = 'checks' | 'dark' | 'light'
type CompareMode = 'slide' | 'side' | 'diff'

interface Pixel {
  x: number
  y: number
  r: number
  g: number
  b: number
  a: number
}

const hex = (p: Pixel): string => `#${[p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // without this the pixels of a picture from the workspace may not be read
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The picture could not be read.'))
    img.src = url
  })
}

/** Zoom, pan, read single pixels, and compare a picture with an earlier version or another file. */
export function ImageStudio({ url, path }: { url: string; path: string }): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const pixels = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [bytes, setBytes] = useState<number | null>(null)
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const [fitted, setFitted] = useState(true)
  const [backdrop, setBackdrop] = useState<Backdrop>('checks')
  const [pixel, setPixel] = useState<Pixel | null>(null)
  const [other, setOther] = useState<{ url: string; label: string } | null>(null)
  const [mode, setMode] = useState<CompareMode>('slide')
  const [split, setSplit] = useState(0.5)
  const [diffUrl, setDiffUrl] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<string[]>([])
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; split: boolean } | null>(null)

  const fit = useCallback((): void => {
    const el = stage.current
    if (!el || !size) return
    const pad = 32
    const cols = other && mode === 'side' ? 2 : 1
    const zoom = Math.min((el.clientWidth - pad) / (size.w * cols + (cols - 1) * 16), (el.clientHeight - pad) / size.h, 1) || 1
    setView({ zoom, x: (el.clientWidth - size.w * cols * zoom - (cols - 1) * 16 * zoom) / 2, y: (el.clientHeight - size.h * zoom) / 2 })
    setFitted(true)
  }, [size, other, mode])

  // the picture itself: its size, its weight, and its pixels for the inspector
  useEffect(() => {
    let alive = true
    setSize(null)
    pixels.current = null
    void (async () => {
      try {
        const img = await load(url)
        if (!alive) return
        setSize({ w: img.naturalWidth, h: img.naturalHeight })
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d', { willReadFrequently: true })
        if (g && c.width * c.height <= 64_000_000) {
          g.drawImage(img, 0, 0)
          pixels.current = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }
        }
        const blob = await fetch(url).then((r) => r.blob())
        if (alive) setBytes(blob.size)
      } catch (e) {
        if (alive) toastError(e)
      }
    })()
    return () => {
      alive = false
    }
  }, [url])

  useLayoutEffect(() => {
    if (fitted) fit()
  }, [fit, fitted])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => fitted && fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit, fitted])

  // what differs between the two pictures, drawn in a loud colour over a faded copy
  useEffect(() => {
    setDiffUrl(null)
    if (!other || mode !== 'diff') return
    let alive = true
    void (async () => {
      try {
        const [a, b] = await Promise.all([load(other.url), load(url)])
        const w = Math.max(a.naturalWidth, b.naturalWidth)
        const h = Math.max(a.naturalHeight, b.naturalHeight)
        const read = (img: HTMLImageElement): Uint8ClampedArray => {
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const g = c.getContext('2d')!
          g.drawImage(img, 0, 0)
          return g.getImageData(0, 0, w, h).data
        }
        const da = read(a)
        const db = read(b)
        const out = new ImageData(w, h)
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!) + Math.abs(da[i + 3]! - db[i + 3]!)
          if (d > 12) {
            out.data[i] = 255
            out.data[i + 1] = 60
            out.data[i + 2] = 140
            out.data[i + 3] = 255
          } else {
            const grey = (db[i]! + db[i + 1]! + db[i + 2]!) / 3
            out.data[i] = out.data[i + 1] = out.data[i + 2] = grey
            out.data[i + 3] = Math.round(db[i + 3]! * 0.35)
          }
        }
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.putImageData(out, 0, 0)
        if (alive) setDiffUrl(c.toDataURL())
      } catch (e) {
        if (alive) toastError(e)
      }
    })()
    return () => {
      alive = false
    }
  }, [other, mode, url])

  const zoomAt = (factor: number, cx: number, cy: number): void =>
    setView((v) => {
      const zoom = Math.max(0.02, Math.min(64, v.zoom * factor))
      const k = zoom / v.zoom
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })

  const onWheel = (e: React.WheelEvent): void => {
    const r = stage.current!.getBoundingClientRect()
    setFitted(false)
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
  }

  const at = (e: React.MouseEvent): { ix: number; iy: number; sx: number } => {
    const r = stage.current!.getBoundingClientRect()
    const sx = e.clientX - r.left
    return { ix: Math.floor((sx - view.x) / view.zoom), iy: Math.floor((e.clientY - r.top - view.y) / view.zoom), sx }
  }

  const onMove = (e: React.MouseEvent): void => {
    const d = drag.current
    if (d?.split && size) {
      setSplit(Math.max(0, Math.min(1, (at(e).sx - view.x) / (size.w * view.zoom))))
      return
    }
    if (d) {
      setFitted(false)
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
      return
    }
    const p = pixels.current
    const { ix, iy } = at(e)
    if (!p || ix < 0 || iy < 0 || ix >= p.w || iy >= p.h) return setPixel(null)
    const i = (iy * p.w + ix) * 4
    setPixel({ x: ix, y: iy, r: p.data[i]!, g: p.data[i + 1]!, b: p.data[i + 2]!, a: p.data[i + 3]! })
  }

  const copy = (): void => {
    if (!pixel) return
    void copyText(hex(pixel))
    useUi.getState().toast('success', `Copied ${hex(pixel)}`)
  }

  const compareWithCommit = async (): Promise<void> => {
    try {
      const b64 = await prism.git.blob(path)
      if (!b64) return useUi.getState().toast('info', 'No earlier version', 'This file has not been committed yet, so there is nothing to compare it with.')
      const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
      const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`
      setOther({ url: `data:${type};base64,${b64}`, label: 'last commit' })
      setAsking(false)
    } catch (e) {
      toastError(e)
    }
  }

  const compareWithFile = async (p: string): Promise<void> => {
    try {
      setOther({ url: await prism.fs.assetUrl(p), label: p })
      setAsking(false)
    } catch (e) {
      toastError(e)
    }
  }

  useEffect(() => {
    if (!asking) return
    let alive = true
    void prism.fs
      .quickOpen(query, 30)
      .then((list) => alive && setFound(list.filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f) && f !== path).slice(0, 8)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [asking, query, path])

  const w = size ? size.w * view.zoom : 0
  const h = size ? size.h * view.zoom : 0
  const crisp = view.zoom >= 3
  const imgStyle = { width: w, height: h, imageRendering: crisp ? ('pixelated' as const) : ('auto' as const) }

  return (
    <div className="studio">
      <div className="studio-bar">
        <button className="btn sm ghost" onClick={fit} title="Fit the picture in the panel">
          <Maximize size={12} /> Fit
        </button>
        <button
          className="btn sm ghost"
          title="Actual size"
          onClick={() => {
            const el = stage.current
            if (!el || !size) return
            setFitted(false)
            setView({ zoom: 1, x: (el.clientWidth - size.w) / 2, y: (el.clientHeight - size.h) / 2 })
          }}
        >
          100%
        </button>
        <span className="mono small faint">{Math.round(view.zoom * 100)}%</span>
        <span className="studio-sep" />
        <div className="seg">
          {(['checks', 'dark', 'light'] as const).map((b) => (
            <button key={b} className={cx(backdrop === b && 'on')} onClick={() => setBackdrop(b)} title={`Background: ${b}`}>
              {b}
            </button>
          ))}
        </div>
        <span className="studio-sep" />
        {other ? (
          <>
            <span className="chip accent truncate" title={other.label}>
              vs {other.label}
            </span>
            <div className="seg">
              <button className={cx(mode === 'slide' && 'on')} onClick={() => setMode('slide')} title="Drag the line across the picture">
                <SplitSquareHorizontal size={12} />
              </button>
              <button className={cx(mode === 'side' && 'on')} onClick={() => setMode('side')} title="Side by side">
                <Columns2 size={12} />
              </button>
              <button className={cx(mode === 'diff' && 'on')} onClick={() => setMode('diff')} title="Show only what is different">
                <GitCompare size={12} />
              </button>
            </div>
            <button className="icon-btn sm" title="Stop comparing" onClick={() => setOther(null)}>
              <X size={13} />
            </button>
          </>
        ) : (
          <button className={cx('btn sm ghost', asking && 'on')} onClick={() => setAsking((v) => !v)}>
            <GitCompare size={12} /> Compare
          </button>
        )}
        <span className="grow" />
        {size && (
          <span className="small faint mono">
            {size.w} × {size.h}
            {bytes !== null ? ` · ${humanSize(bytes)}` : ''}
          </span>
        )}
      </div>
      {asking && !other && (
        <div className="studio-ask">
          <button className="btn sm" onClick={() => void compareWithCommit()}>
            With the last commit
          </button>
          <span className="faint small">or another picture:</span>
          <input className="input sm" autoFocus placeholder="Type part of its name" value={query} onChange={(e) => setQuery(e.target.value)} />
          {found.map((f) => (
            <button key={f} className="chip clickable" onClick={() => void compareWithFile(f)} title={f}>
              {f.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <div
        ref={stage}
        className={cx('studio-stage', `bd-${backdrop}`, drag.current && 'dragging')}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          const onLine = (e.target as HTMLElement).closest('.studio-split-handle')
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, split: !!onLine }
        }}
        onMouseMove={onMove}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => {
          drag.current = null
          setPixel(null)
        }}
        onDoubleClick={(e) => {
          if (fitted) {
            const r = stage.current!.getBoundingClientRect()
            setFitted(false)
            zoomAt(1 / view.zoom, e.clientX - r.left, e.clientY - r.top)
          } else fit()
        }}
        onClick={(e) => e.detail === 1 && e.altKey && copy()}
      >
        {size && (
          <div className="studio-layer" style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
            {other && mode === 'side' && <img src={other.url} alt="before" draggable={false} style={{ ...imgStyle, marginRight: 16 * view.zoom }} />}
            <div className="studio-pic" style={{ width: w, height: h }}>
              {other && mode === 'diff' ? diffUrl ? <img src={diffUrl} alt="difference" draggable={false} style={imgStyle} /> : null : <img src={url} alt={path} draggable={false} style={imgStyle} />}
              {other && mode === 'slide' && (
                <>
                  <div className="studio-before" style={{ width: w * split }}>
                    <img src={other.url} alt="before" draggable={false} style={imgStyle} />
                  </div>
                  <div className="studio-split-handle" style={{ left: w * split }} title="Drag: the earlier picture is on the left" />
                </>
              )}
            </div>
          </div>
        )}
        {!size && <div className="empty">Loading…</div>}
      </div>
      <div className="studio-foot">
        <Pipette size={12} className="faint" />
        {pixel ? (
          <>
            <span className="studio-swatch" style={{ background: `rgba(${pixel.r}, ${pixel.g}, ${pixel.b}, ${pixel.a / 255})` }} />
            <span className="mono small">{hex(pixel)}</span>
            <span className="mono small faint">
              rgba({pixel.r}, {pixel.g}, {pixel.b}, {(pixel.a / 255).toFixed(2)})
            </span>
            <span className="mono small faint">
              x {pixel.x} · y {pixel.y}
            </span>
          </>
        ) : (
          <span className="small faint">Move over the picture to read a pixel. Scroll to zoom, drag to move, double-click for actual size, Alt+click to copy the colour.</span>
        )}
      </div>
    </div>
  )
}
