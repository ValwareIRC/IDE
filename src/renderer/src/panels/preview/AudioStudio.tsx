import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Repeat, Volume2 } from 'lucide-react'
import { toastError } from '@/state/ui'
import { cx } from '@/lib/format'

const clock = (s: number): string => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`
}

/** A sound as a picture: its waveform, with a playhead you can click to move. */
export function AudioStudio({ url, path }: { url: string; path: string }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<{ duration: number; rate: number; channels: number } | null>(null)
  const [peaks, setPeaks] = useState<Float32Array[] | null>(null)
  const [width, setWidth] = useState(800)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [failed, setFailed] = useState(false)
  // the player gets the sound as an in-memory file: a workspace address cannot always be jumped around in
  const [src, setSrc] = useState<string | null>(null)

  // decode once; the peaks are worked out again whenever the panel's width changes
  const samples = useRef<Float32Array[] | null>(null)
  useEffect(() => {
    let alive = true
    setInfo(null)
    setPeaks(null)
    setFailed(false)
    samples.current = null
    setSrc(null)
    let made: string | null = null
    void (async () => {
      const ctx = new AudioContext()
      try {
        const res = await fetch(url)
        const bytes = await res.arrayBuffer()
        if (!alive) return
        made = URL.createObjectURL(new Blob([bytes], { type: res.headers.get('content-type') ?? 'audio/wav' }))
        setSrc(made)
        // decoding consumes the bytes it is given, so it gets its own copy
        const buf = await ctx.decodeAudioData(bytes.slice(0))
        if (!alive) return
        samples.current = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c))
        setInfo({ duration: buf.duration, rate: buf.sampleRate, channels: buf.numberOfChannels })
      } catch (e) {
        if (alive) {
          setFailed(true)
          toastError(e, 'This sound could not be decoded for a waveform')
        }
      } finally {
        void ctx.close()
      }
    })()
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [url])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const chans = samples.current
    if (!chans || !info) return
    setPeaks(
      chans.map((data) => {
        const out = new Float32Array(width * 2)
        const step = data.length / width
        for (let x = 0; x < width; x += 1) {
          let lo = 1
          let hi = -1
          const end = Math.min(data.length, Math.floor((x + 1) * step))
          // every few samples is plenty for a picture
          const skip = Math.max(1, Math.floor(step / 400))
          for (let i = Math.floor(x * step); i < end; i += skip) {
            const v = data[i]!
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
          out[x * 2] = lo
          out[x * 2 + 1] = hi
        }
        return out
      })
    )
  }, [info, width])

  // draw: played part in the accent colour, the rest fainter
  useEffect(() => {
    const c = canvas.current
    if (!c || !peaks || !info) return
    const dpr = window.devicePixelRatio || 1
    const h = peaks.length > 1 ? 220 : 160
    c.width = width * dpr
    c.height = h * dpr
    c.style.width = `${width}px`
    c.style.height = `${h}px`
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, h)
    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--accent').trim() || '#8ad8ff'
    const faint = css.getPropertyValue('--text-4').trim() || '#4a5064'
    const playedTo = (time / info.duration) * width
    const lane = h / peaks.length
    peaks.forEach((p, ch) => {
      const mid = lane * ch + lane / 2
      for (let x = 0; x < width; x += 1) {
        const lo = p[x * 2]!
        const hi = p[x * 2 + 1]!
        g.fillStyle = x <= playedTo ? accent : faint
        const y1 = mid - hi * (lane / 2 - 6)
        const y2 = mid - lo * (lane / 2 - 6)
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }
    })
    g.fillStyle = css.getPropertyValue('--text').trim() || '#fff'
    g.fillRect(Math.min(width - 1, playedTo), 0, 1, h)
  }, [peaks, time, width, info])

  // the playhead moves smoothly while playing
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      setTime(audio.current?.currentTime ?? 0)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed
  }, [speed])
  useEffect(() => {
    if (audio.current) audio.current.volume = volume
  }, [volume])

  const toggle = (): void => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play().catch(toastError)
    else a.pause()
  }

  const seek = (e: React.MouseEvent): void => {
    const a = audio.current
    const c = canvas.current
    if (!a || !c || !info) return
    const r = c.getBoundingClientRect()
    a.currentTime = Math.max(0, Math.min(info.duration, ((e.clientX - r.left) / r.width) * info.duration))
    setTime(a.currentTime)
  }

  return (
    <div
      className="studio"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault()
          toggle()
        }
      }}
    >
      <div className="studio-bar">
        <button className="btn sm solid" onClick={toggle} title="Play or pause (Space)">
          {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Pause' : 'Play'}
        </button>
        <span className="mono small">
          {clock(time)} <span className="faint">/ {clock(info?.duration ?? 0)}</span>
        </span>
        <button className={cx('icon-btn sm', loop && 'on')} title="Play again when it ends" onClick={() => setLoop((v) => !v)}>
          <Repeat size={13} />
        </button>
        <span className="studio-sep" />
        <div className="seg">
          {[0.5, 1, 1.5, 2].map((s) => (
            <button key={s} className={cx(speed === s && 'on')} onClick={() => setSpeed(s)} title={`Speed ${s}×`}>
              {s}×
            </button>
          ))}
        </div>
        <span className="studio-sep" />
        <Volume2 size={13} className="faint" />
        <input className="range" style={{ width: 90 }} type="range" min={0} max={1} step={0.02} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        <span className="grow" />
        {info && (
          <span className="small faint mono">
            {info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} channels`} · {info.duration.toFixed(1)} s
          </span>
        )}
      </div>
      <div className="studio-stage audio" ref={wrap}>
        {peaks ? <canvas ref={canvas} className="wave" onClick={seek} title="Click to move to that moment" /> : <div className="empty">{failed ? 'No waveform for this file, but it can still be played.' : 'Reading the sound…'}</div>}
      </div>
      <audio ref={audio} src={src ?? undefined} loop={loop} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)} aria-label={path} />
    </div>
  )
}
