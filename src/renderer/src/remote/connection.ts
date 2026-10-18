// The phone app's side of the encrypted channel to Prism (see shared/remoteCrypto.ts). Pairing once keeps
// Prism's key and how to reach it; connecting tries the direct addresses first (same Wi-Fi or a VPN), then
// the relay. Requests and events then travel exactly as they would over a window's IPC.
import { Channel, PROTOCOL, b64, channelKeys, codeProof, newKeyPair, publicOf, random, sameBytes, unb64 } from '@shared/remoteCrypto'
import type { Transport } from '@shared/api'
import type { Unsubscribe } from '@shared/ipc'

export interface Pairing {
  hostId: string
  hostKey: string
  hostName: string
  deviceSecret: string
  direct: string[]
  relay: string
}

const KEY = 'prism-remote-pairing'

export function savedPairing(): Pairing | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Pairing | null
    return p && p.hostKey && p.deviceSecret ? p : null
  } catch {
    return null
  }
}

export function forgetPairing(): void {
  localStorage.removeItem(KEY)
}

/** What a pairing QR code (or the text under it) holds. */
export interface PairOffer {
  id: string
  key?: string
  code: string
  name?: string
  direct: string[]
  relay: string
}

export function readOffer(text: string): PairOffer | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (o['prism'] !== PROTOCOL || typeof o['code'] !== 'string') return null
    return { id: String(o['id'] ?? ''), key: typeof o['key'] === 'string' ? o['key'] : undefined, code: o['code'], name: String(o['name'] ?? ''), direct: Array.isArray(o['direct']) ? (o['direct'] as unknown[]).map(String) : [], relay: String(o['relay'] ?? '') }
  } catch {
    return null
  }
}

function open(url: string, ms: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    const t = setTimeout(() => {
      ws.close()
      reject(new Error(`${url} did not answer`))
    }, ms)
    ws.onopen = () => {
      clearTimeout(t)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(t)
      reject(new Error(`Could not reach ${url}`))
    }
  })
}

/** The first address that answers: the direct ones together, then the relay. */
async function reach(direct: string[], relay: string, hostId: string): Promise<{ ws: WebSocket; via: string }> {
  if (direct.length) {
    try {
      const ws = await Promise.any(direct.map((u) => open(u, 3500)))
      return { ws, via: ws.url }
    } catch {
      /* not on the same network: try the relay */
    }
  }
  if (relay) {
    const url = `${relay.replace(/\/+$/, '')}/client?id=${encodeURIComponent(hostId)}`
    return { ws: await open(url, 8000), via: 'relay' }
  }
  throw new Error(direct.length ? 'Prism did not answer on this network, and no relay is set.' : 'There is no address to reach Prism at.')
}

/** Where Prism says it can be reached now (its home address can change) goes first; what was known stays after it. */
function addrsOf(w: Record<string, unknown>, known: string[]): string[] {
  const a = w['addrs']
  const now = Array.isArray(a) ? a.map(String).filter((x) => /^wss?:\/\//.test(x)) : []
  return [...new Set([...now, ...known])].slice(0, 8)
}

function firstText(ws: WebSocket): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    ws.onmessage = (e) => {
      try {
        resolve(JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)) as Record<string, string>)
      } catch {
        reject(new Error('Prism answered with something unreadable.'))
      }
    }
    ws.onclose = () => reject(new Error('Prism closed the connection.'))
  })
}

/** Pair with the Prism that showed this offer; keeps what is needed to connect again. */
export async function pair(offer: PairOffer, deviceName: string): Promise<Pairing> {
  const me = newKeyPair()
  const eph = newKeyPair()
  const nonce = random(16)
  const { ws } = await reach(offer.direct, offer.relay, offer.id)
  try {
    const answer = firstText(ws)
    ws.send(JSON.stringify({ t: 'pair', v: PROTOCOL, device: b64(me.public), eph: b64(eph.public), nonce: b64(nonce), name: deviceName, proof: b64(codeProof(offer.code, 'pair', me.public, eph.public, nonce)) }))
    const w = await answer
    if (w['t'] === 'refused') throw new Error(w['why'] ?? 'Prism refused.')
    const hostKey = unb64(w['host'] ?? '')
    // Prism proves it knows the code too, so nothing in between can pretend to be it
    if (!sameBytes(unb64(w['proof'] ?? ''), codeProof(offer.code, 'host', hostKey, unb64(w['eph'] ?? ''), unb64(w['nonce'] ?? ''), nonce))) throw new Error('That was not the Prism showing this code.')
    if (offer.key && w['host'] !== offer.key) throw new Error('That was not the Prism in the QR code.')
    const p: Pairing = { hostId: offer.id, hostKey: w['host']!, hostName: w['name'] ?? offer.name ?? 'Prism', deviceSecret: b64(me.secret), direct: addrsOf(w, offer.direct), relay: offer.relay }
    localStorage.setItem(KEY, JSON.stringify(p))
    return p
  } finally {
    ws.close()
  }
}

/** `trying` while it is still going to have another go by itself; without it, it has stopped until asked. */
export type ConnState = { state: 'connecting' | 'connected' | 'lost'; via?: string; error?: string; trying?: boolean }

/**
 * After a dropped connection, the gaps between goes before it stops trying. Roughly
 * half a minute in all: long enough to ride out a lift or a wifi handover, short enough
 * not to sit draining the battery against a computer that has been switched off.
 */
const RETRY_MS = [1000, 3000, 7000, 15000]

/** How long a still-open connection has to answer, after the app comes back, before it is treated as dead. */
const CHECK_MS = 4000

/** How often an open app on screen makes sure its connection is still really there. */
const ALIVE_MS = 25_000

/** Once the quick goes are spent, how often the background watcher tries again. */
const KEEP_TRYING_MS = 60_000

/**
 * How long a call waits for an answer before it says so, rather than waiting for ever.
 *
 * Shorter than the 25 seconds the Android widget allows (WidgetShot.PATIENCE_MS), so a
 * call that is never answered has time to say which call it was before the widget gives
 * up and says only that Prism did not answer.
 */
const ANSWER_MS = 12_000

/**
 * Calls that do real work on the computer before they answer, and how long each gets.
 *
 * Twelve seconds suits a question; it does not suit turning a recording into words,
 * which the computer allows itself 45 seconds for — the first time, Whisper has to load.
 * Cutting in at twelve replaced the computer's own explanation with a worse one, and
 * failed a recording that would have come back fine. Each of these waits longer than
 * the computer does, so if anything gives up first it is the side that knows why.
 */
const SLOW_MS: Record<string, number> = {
  'voice:on-computer': 60_000,
  'voice:transcribe': 120_000,
  // sending can first ask a model how hard the message is, compact, and load rules
  'agent:send': 90_000,
  'agent:sharpen': 90_000,
  'agent:quick-ask': 90_000,
  'agent:judge-ways': 180_000,
  // a gadget's handler is whatever its author wrote: a build, a download
  'gadget:call': 180_000
}

/** A live connection to the paired Prism, as the transport window.prism is built on. Reconnects by itself. */
export function connect(
  p: Pairing,
  onState: (s: ConnState) => void,
  controls?: (c: { retry(): void; check(): Promise<void> }) => void,
  opts: { keepTrying?: boolean } = {}
): Promise<Transport> {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0
  let live: { ws: WebSocket; ch: Channel } | null = null
  let closed = false
  let connecting = false
  let tries = 0
  let next: ReturnType<typeof setTimeout> | null = null

  const attempt = async (): Promise<void> => {
    onState({ state: 'connecting' })
    const me = { secret: unb64(p.deviceSecret) }
    const eph = newKeyPair()
    const nonce = random(16)
    const { ws, via } = await reach(p.direct, p.relay, p.hostId)
    const answer = firstText(ws)
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, device: b64(publicOf(me.secret)), eph: b64(eph.public), nonce: b64(nonce) }))
    const w = await answer
    if (w['t'] === 'refused') {
      ws.close()
      throw new Error(w['why'] ?? 'Prism refused.')
    }
    if (w['host'] !== p.hostKey) {
      ws.close()
      throw new Error('That was not the Prism this phone is paired with.')
    }
    const now = addrsOf(w, p.direct)
    if (now.join() !== p.direct.join()) {
      p.direct = now
      localStorage.setItem(KEY, JSON.stringify(p))
    }
    const ch = new Channel(channelKeys('client', { eph: eph.secret, static: me.secret }, { eph: unb64(w['eph']!), static: unb64(p.hostKey) }, nonce, unb64(w['nonce']!)))
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return
      let m: { id?: number; r?: unknown; e?: string; ev?: string; p?: unknown }
      try {
        m = ch.open(new Uint8Array(e.data as ArrayBuffer)) as typeof m
      } catch {
        ws.close()
        return
      }
      if (m.ev) for (const cb of listeners.get(m.ev) ?? []) cb(m.p)
      else if (m.id !== undefined) {
        const w2 = pending.get(m.id)
        pending.delete(m.id)
        if (m.e !== undefined) w2?.reject(new Error(m.e))
        else w2?.resolve(m.r)
      }
    }
    ws.onclose = () => dropped(ws, 'The connection to Prism was lost.')
    live = { ws, ch }
    onState({ state: 'connected', via })
    // what the app showed is stale after a gap: it asks again
    for (const cb of listeners.get('remote:reconnected') ?? []) cb(null)
  }

  const transport: Transport = {
    platform: 'android' as Transport['platform'],
    debug: false,
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      if (!live) return Promise.reject(new Error('Not connected to Prism right now.'))
      const id = ++seq
      // A call with no answer used to wait for ever. On a screen that is a spinner you
      // can give up on; in the hidden page behind a home screen widget there is nobody
      // to give up, so it hung until Android said "Prism did not answer" — which names
      // neither the call nor the reason.
      const patience = SLOW_MS[channel] ?? ANSWER_MS
      const out = new Promise<T>((resolve, reject) => {
        const giveUp = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Prism did not answer "' + channel + '" within ' + Math.round(patience / 1000) + ' seconds.'))
        }, patience)
        pending.set(id, {
          resolve: (v) => { clearTimeout(giveUp); (resolve as (x: unknown) => void)(v) },
          reject: (e) => { clearTimeout(giveUp); reject(e) }
        })
      })
      live.ws.send(live.ch.seal({ id, ch: channel, a: args }))
      return out
    },
    on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
      const set = listeners.get(channel) ?? new Set()
      set.add(cb as (payload: unknown) => void)
      listeners.set(channel, set)
      return () => set.delete(cb as (payload: unknown) => void)
    },
    send(channel: string, ...args: unknown[]): void {
      if (live) live.ws.send(live.ch.seal({ ch: channel, a: args, one: 1 }))
    }
  }
  /**
   * The connection has gone. Handled once per socket: a check that finds it dead and
   * the socket's own close can both arrive, and two lots of retrying is worse than one.
   */
  function dropped(ws: WebSocket, why: string): void {
    if (live?.ws !== ws) return
    live = null
    for (const w2 of pending.values()) w2.reject(new Error('The connection to Prism was lost.'))
    pending.clear()
    try {
      ws.onclose = null
      ws.close()
    } catch {
      /* already gone */
    }
    if (closed) return
    tries = 0
    onState({ state: 'lost', error: why + ' Trying again…', trying: true })
    if (next) clearTimeout(next)
    next = setTimeout(tryAgain, RETRY_MS[0])
  }

  /**
   * One more go, and if it fails, another a little later — a few times, then stop.
   *
   * It used to try exactly once, three seconds after the drop. A phone that has just
   * been put away has usually had its network suspended, so that one go failed, and
   * nothing ever tried again: the app sat saying it could not connect until it was
   * closed and opened. Now it tries a handful of times, and after that it waits for a
   * reason — the app being opened again, the network coming back, or Try again.
   */
  function tryAgain(): void {
    if (closed || live || connecting) return
    if (next) {
      clearTimeout(next)
      next = null
    }
    connecting = true
    attempt()
      .then(() => {
        tries = 0
      })
      .catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e)
        if (tries < RETRY_MS.length - 1) {
          tries++
          onState({ state: 'lost', error: why + ' Trying again…', trying: true })
          next = setTimeout(tryAgain, RETRY_MS[tries])
        } else if (opts.keepTrying) {
          // the background watcher has nobody to come back to it: it carries on, slowly
          onState({ state: 'lost', error: why + ' Trying again in a minute.', trying: true })
          next = setTimeout(tryAgain, KEEP_TRYING_MS)
        } else {
          onState({ state: 'lost', error: why + ' Stopped trying for now — it will try again when you come back to the app.', trying: false })
        }
      })
      .finally(() => {
        connecting = false
      })
  }

  /**
   * The app is in front of someone again. Android often kills a put-away app's
   * connection without telling it, so one that still looks open is asked something
   * small, and silence is treated as a drop rather than trusted.
   */
  async function wake(force = false): Promise<void> {
    if (closed || (!force && document.visibilityState === 'hidden')) return
    if (!live) {
      tries = 0
      tryAgain()
      return
    }
    const was = live
    const quiet = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer')), CHECK_MS))
    try {
      await Promise.race([transport.invoke('app:info'), quiet])
    } catch {
      dropped(was.ws, 'The connection had gone quiet while the app was away.')
    }
  }

  window.addEventListener('beforeunload', () => {
    closed = true
    live?.ws.close()
  })
  // A phone network can drop a connection without telling either end. Coming back to
  // the app checked for that, but an app left open in front of someone never did: it
  // went on saying "connected" while nothing arrived, and once showed a run as still
  // going half an hour after it had finished. While it is on screen it now asks a
  // small question every so often, and silence counts as a drop.
  setInterval(() => {
    if (live && document.visibilityState === 'visible') void wake()
  }, ALIVE_MS)
  // Only a connection that has worked once looks after itself from then on. Before
  // that, the pairing screen is in charge of trying again: a first attempt that failed
  // and kept listening would quietly reconnect a connection nothing is using.
  return attempt().then(
    () => {
      document.addEventListener('visibilitychange', () => void wake())
      window.addEventListener('online', () => void wake())
      controls?.({
        retry: () => {
          tries = 0
          tryAgain()
        },
        check: () => wake(true)
      })
      return transport
    },
    (e: unknown) => {
      closed = true
      throw e
    }
  )
}
