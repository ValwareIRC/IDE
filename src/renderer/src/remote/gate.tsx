// The phone app's front door: pair with a Prism (scan its QR code, or type its address and code), or connect to
// the one already paired. Once connected, window.prism is built over the encrypted channel and the app starts.
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import jsQR from 'jsqr'
import '@fontsource-variable/inter'
import '../styles/tokens.css'
import '../styles/base.css'
import './gate.css'
import { makeApi } from '@shared/api'
import { connect, forgetPairing, pair, readOffer, savedPairing, type ConnState, type PairOffer, type Pairing } from './connection'
import { fingerprint, unb64 } from '@shared/remoteCrypto'
import { installAssets } from './assets'
import { isWatcher, startBackgroundWatcher, startWatching } from './watch'

declare global {
  interface Window {
    __prismMobile?: { state: ConnState; host: string; onState: Set<(s: ConnState) => void>; retry?: () => void }
  }
}

function Scanner({ onFound, onCancel }: { onFound: (text: string) => void; onCancel: () => void }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const look = (): void => {
      const v = video.current
      if (v && v.readyState >= 2) {
        canvas.width = v.videoWidth
        canvas.height = v.videoHeight
        ctx.drawImage(v, 0, 0)
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
        if (code?.data) return onFound(code.data)
      }
      raf = requestAnimationFrame(look)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play()
        }
        raf = requestAnimationFrame(look)
      })
      .catch(() => setError('The camera could not be used. Allow it for Prism in the phone settings, or type the code instead.'))
    return () => {
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [onFound])
  return (
    <div className="gate-scan">
      {error ? <div className="gate-error">{error}</div> : <video ref={video} playsInline muted />}
      <div className="gate-frame" />
      <button className="gate-btn ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

/**
 * The hidden WebView behind a home screen widget (android/.../WidgetShot.java) has
 * nobody to show a pairing screen to, so a failure is reported to it instead and the
 * widget says plainly that Prism cannot be reached.
 */
function tellWidget(why: string): boolean {
  if (!new URLSearchParams(window.location.search).get('widget')) return false
  const host = (window as unknown as { PrismWidgetHost?: { failed?(why: string): void } }).PrismWidgetHost
  host?.failed?.(why)
  return !!host
}

function Gate(): React.JSX.Element {
  const [saved, setSaved] = useState<Pairing | null>(() => savedPairing())
  const [mode, setMode] = useState<'connect' | 'pair' | 'scan' | 'type'>(() => (savedPairing() ? 'connect' : 'pair'))
  const [state, setState] = useState<ConnState>({ state: 'connecting' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem('prism-device-name') ?? 'My phone')
  const [address, setAddress] = useState('')
  const [relay, setRelay] = useState('')
  const [hostId, setHostId] = useState('')
  const [code, setCode] = useState('')
  const started = useRef(false)
  // one attempt at a time: coming back to the app and pressing Try again can both ask at once
  const starting = useRef(false)

  const start = (p: Pairing): void => {
    if (starting.current) return
    starting.current = true
    setError(null)
    setMode('connect')
    const listeners = new Set<(s: ConnState) => void>()
    const onState = (s: ConnState): void => {
      setState(s)
      if (window.__prismMobile) window.__prismMobile.state = s
      for (const l of listeners) l(s)
    }
    let retry = (): void => {}
    void connect(p, onState, (c) => {
      retry = c.retry
      if (window.__prismMobile) window.__prismMobile.retry = c.retry
    })
      .then((t) => {
        if (started.current) return
        started.current = true
        window.__prismMobile = { state: { state: 'connected' }, host: p.hostName, onState: listeners, retry }
        window.prism = makeApi(t)
        installAssets(window.prism)
        document.documentElement.classList.add('mobile')
        void import('../boot')
        // the part that keeps in touch after the app is closed; not from inside a widget's page
        if (!new URLSearchParams(window.location.search).get('widget')) void startBackgroundWatcher()
      })
      .catch((e: unknown) => {
        setState({ state: 'lost' })
        const why = e instanceof Error ? e.message : String(e)
        setError(why)
        tellWidget(why)
      })
      .finally(() => {
        starting.current = false
      })
  }

  useEffect(() => {
    if (saved && mode === 'connect') start(saved)
    else if (!saved) tellWidget('This phone is not paired with Prism yet')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the app again is a reason to try again. Without this, a first connection
  // that failed while the phone was in a pocket stayed failed until the app was closed
  // and opened, which is the very thing nobody should have to do.
  useEffect(() => {
    const back = (): void => {
      if (document.visibilityState === 'hidden' || started.current) return
      const p = savedPairing()
      if (p && !busy) start(p)
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('online', back)
    return () => {
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('online', back)
    }
  }, [busy]) // eslint-disable-line react-hooks/exhaustive-deps

  const doPair = async (offer: PairOffer): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      localStorage.setItem('prism-device-name', name)
      const p = await pair(offer, name.trim() || 'My phone')
      setSaved(p)
      start(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMode('pair')
    } finally {
      setBusy(false)
    }
  }

  const fromText = (text: string): void => {
    const offer = readOffer(text.trim())
    if (!offer) {
      setError('That is not a Prism pairing code. On the computer: Settings, Phone app, Pair a device.')
      setMode('pair')
      return
    }
    void doPair(offer)
  }

  const typed = (): void => {
    const direct = address.trim() ? [address.trim().startsWith('ws') ? address.trim() : `ws://${address.trim()}${/:\d+$/.test(address.trim()) ? '' : ':8793'}`] : []
    if (!code.trim() || (!direct.length && !(relay.trim() && hostId.trim()))) {
      setError('Fill in the code, and either the address on this network or the relay and Prism id.')
      return
    }
    void doPair({ id: hostId.trim(), code: code.trim(), direct, relay: relay.trim() })
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-logo">◆ Prism</div>
        {mode === 'connect' && saved && (
          <>
            <div className="gate-title">{state.state === 'connected' ? 'Connected' : error ? 'Could not connect' : `Connecting to ${saved.hostName}…`}</div>
            <div className="gate-sub">Prism's key {fingerprint(unb64(saved.hostKey))}</div>
            {error && <div className="gate-error">{error}</div>}
            {error && (
              <div className="gate-row">
                <button className="gate-btn" onClick={() => start(saved)}>
                  Try again
                </button>
                <button
                  className="gate-btn ghost"
                  onClick={() => {
                    forgetPairing()
                    setSaved(null)
                    setMode('pair')
                    setError(null)
                  }}
                >
                  Pair with another Prism
                </button>
              </div>
            )}
            {!error && <div className="gate-spinner" />}
          </>
        )}
        {mode === 'pair' && (
          <>
            <div className="gate-title">Pair with Prism on your computer</div>
            <div className="gate-sub">On the computer: Settings, Phone app, Pair a device. Then scan the code it shows.</div>
            <label className="gate-field">
              <span>This phone's name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {error && <div className="gate-error">{error}</div>}
            <button className="gate-btn" disabled={busy} onClick={() => setMode('scan')}>
              Scan the QR code
            </button>
            <button className="gate-btn ghost" disabled={busy} onClick={() => setMode('type')}>
              Type it in instead
            </button>
            {busy && <div className="gate-spinner" />}
          </>
        )}
        {mode === 'scan' && <Scanner onFound={fromText} onCancel={() => setMode('pair')} />}
        {mode === 'type' && (
          <>
            <div className="gate-title">Type what Prism shows</div>
            <label className="gate-field">
              <span>Pairing code</span>
              <input value={code} placeholder="ABCDE-FGHJK-…" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="gate-field">
              <span>Address on this network</span>
              <input value={address} placeholder="192.168.1.20:8793" inputMode="url" onChange={(e) => setAddress(e.target.value)} />
            </label>
            <div className="gate-sub">Or, away from home, through a relay:</div>
            <label className="gate-field">
              <span>Relay</span>
              <input value={relay} placeholder="wss://relay.example.com" inputMode="url" onChange={(e) => setRelay(e.target.value)} />
            </label>
            <label className="gate-field">
              <span>Prism id</span>
              <input value={hostId} onChange={(e) => setHostId(e.target.value)} />
            </label>
            <label className="gate-field">
              <span>Or paste the whole pairing text</span>
              <textarea rows={2} onChange={(e) => e.target.value.trim().startsWith('{') && fromText(e.target.value)} />
            </label>
            {error && <div className="gate-error">{error}</div>}
            <div className="gate-row">
              <button className="gate-btn" disabled={busy} onClick={typed}>
                Pair
              </button>
              <button className="gate-btn ghost" onClick={() => setMode('pair')}>
                Back
              </button>
            </div>
            {busy && <div className="gate-spinner" />}
          </>
        )}
      </div>
    </div>
  )
}

// the background service opens this same page to keep in touch, and shows none of it
if (isWatcher()) void startWatching()
else createRoot(document.getElementById('root')!).render(<Gate />)
