// Remote clients (the Prism phone app): they reach this Prism directly (same network, or a VPN) or through a
// relay, pair once, and then work exactly as a window does, over an encrypted channel (shared/remoteCrypto.ts).
// Things only a window can do here (file dialogs, window controls, opening things on this computer's
// desktop) are refused.
import { app } from 'electron'
import { networkInterfaces, hostname } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { CH } from '@shared/ipc'
import { Channel, PROTOCOL, b64, channelKeys, codeProof, fingerprint, hostIdOf, newKeyPair, newPairCode, publicOf, random, sameBytes, unb64, type KeyPair } from '@shared/remoteCrypto'
import { RELAY_BINARY, RELAY_CLOSE, RELAY_OPEN, RELAY_TEXT, readRelayFrame, relayFrame } from '@shared/relayFrames'
import type { Vault } from '@core/store/vault'
import type { Client, Host } from './host'
import { PortMap } from './portmap'
import type { RemoteDevice as Device, RemoteInfo, Settings as AllSettings } from '@shared/types'

type Settings = AllSettings['remote']

/** What a phone may not ask for: these need this computer's screen. */
const WINDOW_ONLY = new Set<string>([
  CH.WinMinimize, CH.WinMaximize, CH.WinClose, CH.WinZoom, CH.WinNew,
  CH.WorkspaceOpen, CH.AppReveal, CH.AppOpenExternal, CH.FileOpen, CH.FileReveal, CH.FacePick,
  CH.SessionExport, CH.SessionImport, CH.AttachPick,
  CH.ThemeExport, CH.ThemeExportAll, CH.ThemeImport, CH.ThemePicture,
  CH.ExtendOpenFolder, CH.GadgetOpenDir, CH.VoiceDictate,
  CH.PreviewAttach, CH.PreviewDetach
])

interface Conn {
  via: 'direct' | 'relay'
  sendText(text: string): void
  sendBinary(bytes: Uint8Array): void
  close(): void
}

export class RemoteHost {
  private identity: KeyPair
  private devices: Device[] = []
  private pairing: { code: string; until: number } | null = null
  private server: WebSocketServer | null = null
  private port = 0
  private relay: { url: string; ws: WebSocket | null; connected: boolean; error: string | null; conns: Map<number, (kind: number, payload: Uint8Array) => void>; retry: NodeJS.Timeout | null } | null = null
  private live = 0
  private unpaired = 0
  private seq = 0
  private error: string | null = null
  private file: string
  private settings: Settings = { enabled: false, port: 8793, relay: '', upnp: false }
  private outside = new PortMap(() => {})

  constructor(
    private host: Host,
    userData: string,
    private vault: Vault
  ) {
    this.file = join(userData, 'remote-devices.json')
    const saved = vault.get('remote-identity')
    this.identity = saved ? { secret: unb64(saved), public: publicOf(unb64(saved)) } : newKeyPair()
    if (!saved) vault.set('remote-identity', b64(this.identity.secret))
    try {
      if (existsSync(this.file)) this.devices = JSON.parse(readFileSync(this.file, 'utf8')) as Device[]
    } catch {
      this.devices = []
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.devices, null, 2))
    } catch {
      /* kept in memory */
    }
  }

  get hostId(): string {
    return hostIdOf(this.identity.public)
  }

  info(): RemoteInfo {
    const direct: string[] = []
    if (this.server) {
      for (const list of Object.values(networkInterfaces())) {
        for (const n of list ?? []) if (n.family === 'IPv4' && (!n.internal || process.env['PRISM_REMOTE_HOST'])) direct.push(`ws://${n.address}:${this.port}`)
      }
    }
    const pairing = this.pairing && this.pairing.until > Date.now() ? this.pairing : null
    const out = this.outside.state()
    // home network first, then the router opening
    const reach = out.external ? [...direct, out.external] : direct
    return {
      on: this.settings.enabled,
      hostId: this.hostId,
      fingerprint: fingerprint(this.identity.public),
      name: hostname(),
      direct,
      relay: this.relay ? { url: this.relay.url, connected: this.relay.connected, error: this.relay.error } : null,
      devices: this.devices,
      connected: this.live,
      outside: out,
      pairing: pairing ? { ...pairing, qr: JSON.stringify({ prism: PROTOCOL, id: this.hostId, key: b64(this.identity.public), code: pairing.code, name: hostname(), direct: reach, relay: this.relay?.url ?? '' }) } : null,
      error: this.error
    }
  }

  /** A one-time code for pairing a new device, good for ten minutes. */
  startPairing(): RemoteInfo {
    this.pairing = { code: newPairCode(), until: Date.now() + 10 * 60_000 }
    return this.info()
  }

  forget(pub: string): void {
    this.devices = this.devices.filter((d) => d.pub !== pub)
    this.save()
  }

  /** Settings changes arrive in bursts; each waits for the one before, so two servers never race for the port. */
  apply(s: Settings): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow(s)).catch((e: unknown) => {
      this.error = e instanceof Error ? e.message : String(e)
    })
    return this.applying
  }

  private applying: Promise<void> = Promise.resolve()

  private async applyNow(s: Settings): Promise<void> {
    const was = this.settings
    this.settings = s
    if (!s.enabled) {
      this.stopDirect()
      this.stopRelay()
      if (this.outside.state().state !== 'off') await this.outside.close()
      return
    }
    let restarted = false
    if (!this.server || was.port !== s.port) {
      this.stopDirect()
      await this.startDirect(s.port)
      restarted = true
    }
    // the router is asked in the background: it can take several seconds
    if (s.upnp && this.server && (restarted || !was.upnp || this.outside.state().state === 'off')) void this.outside.open(this.port)
    else if ((!s.upnp || !this.server) && this.outside.state().state !== 'off') await this.outside.close()
    if ((this.relay?.url ?? '') !== s.relay.trim()) {
      this.stopRelay()
      if (s.relay.trim()) this.startRelay(s.relay.trim())
    }
  }

  /** Quitting: the router opening is closed (best effort; its lease runs out in an hour anyway). */
  dispose(): void {
    void this.outside.close()
    this.stopDirect()
    this.stopRelay()
  }

  // ---------------------------------------------------------------- direct

  private async startDirect(port: number): Promise<void> {
    this.error = null
    // PRISM_REMOTE_HOST=127.0.0.1 keeps it on this computer (tests)
    const server = new WebSocketServer({ host: process.env['PRISM_REMOTE_HOST'] || '0.0.0.0', port, maxPayload: 64 * 1024 * 1024 })
    server.on('connection', (ws) => {
      const conn: Conn = { via: 'direct', sendText: (t) => ws.send(t), sendBinary: (b) => ws.send(b), close: () => ws.close() }
      const feed = guarded(this.accept(conn), conn)
      ws.on('message', (data: RawData, isBinary) => feed(isBinary ? 'binary' : 'text', toBytes(data)))
      ws.on('close', () => feed('close', new Uint8Array()))
      ws.on('error', () => ws.close())
    })
    const failed = await new Promise<string | null>((resolve) => {
      server.once('listening', () => resolve(null))
      server.once('error', (e) => resolve(e.message))
    })
    if (failed) {
      server.close()
      this.error = `Could not listen on port ${port}: ${failed}`
      return
    }
    const a = server.address()
    this.port = typeof a === 'object' && a ? a.port : port
    this.server = server
  }

  private stopDirect(): void {
    this.server?.clients.forEach((c) => c.close())
    this.server?.close()
    this.server = null
  }

  // ---------------------------------------------------------------- relay

  private startRelay(url: string): void {
    let key = this.vault.get('remote-relay-key')
    if (!key) {
      key = b64(random(24))
      this.vault.set('remote-relay-key', key)
    }
    const r = (this.relay = { url, ws: null as WebSocket | null, connected: false as boolean, error: null as string | null, conns: new Map<number, (kind: number, payload: Uint8Array) => void>(), retry: null as NodeJS.Timeout | null })
    const connect = (): void => {
      if (this.relay !== r) return
      const ws = new WebSocket(`${url.replace(/\/+$/, '')}/host?id=${encodeURIComponent(this.hostId)}&key=${encodeURIComponent(key!)}`)
      r.ws = ws
      ws.on('open', () => {
        r.connected = true
        r.error = null
      })
      ws.on('message', (data: RawData) => {
        let f: ReturnType<typeof readRelayFrame>
        try {
          f = readRelayFrame(toBytes(data))
        } catch {
          return
        }
        if (f.kind === RELAY_OPEN) {
          const conn: Conn = {
            via: 'relay',
            sendText: (t) => ws.send(relayFrame(RELAY_TEXT, f.conn, new TextEncoder().encode(t))),
            sendBinary: (b) => ws.send(relayFrame(RELAY_BINARY, f.conn, b)),
            close: () => ws.send(relayFrame(RELAY_CLOSE, f.conn))
          }
          const feed = guarded(this.accept(conn), conn)
          r.conns.set(f.conn, (kind, payload) => feed(kind === RELAY_TEXT ? 'text' : kind === RELAY_BINARY ? 'binary' : 'close', payload))
        } else {
          const to = r.conns.get(f.conn)
          to?.(f.kind, f.payload)
          if (f.kind === RELAY_CLOSE) r.conns.delete(f.conn)
        }
      })
      const lost = (why: string): void => {
        r.connected = false
        r.error = why
        for (const to of r.conns.values()) to(RELAY_CLOSE, new Uint8Array())
        r.conns.clear()
        if (this.relay === r) r.retry = setTimeout(connect, 10_000)
      }
      ws.on('unexpected-response', (_req, res) => lost(`The relay said ${res.statusCode}${res.statusCode === 409 ? ': another Prism already uses this address there' : ''}.`))
      ws.on('error', (e) => lost(e.message))
      ws.on('close', () => lost(r.error ?? 'The relay closed the connection.'))
    }
    connect()
  }

  private stopRelay(): void {
    const r = this.relay
    this.relay = null
    if (!r) return
    if (r.retry) clearTimeout(r.retry)
    r.ws?.close()
  }

  // ---------------------------------------------------------------- one connection

  /** The handshake, then requests. Returns where the connection's messages go. */
  private accept(conn: Conn): (kind: 'text' | 'binary' | 'close', data: Uint8Array) => void {
    let channel: Channel | null = null
    let clientId: string | null = null
    // with the port open to the internet, strangers can knock: only so many may be mid-hello at once
    let waiting = true
    const settled = (): void => {
      if (waiting) this.unpaired--
      waiting = false
    }
    if (++this.unpaired > 16) {
      settled()
      conn.close()
    }
    const timer = setTimeout(() => !channel && conn.close(), 15_000)
    const refuse = (why: string): void => {
      conn.sendText(JSON.stringify({ t: 'refused', why }))
      conn.close()
    }
    return (kind, data) => {
      if (kind === 'close') {
        clearTimeout(timer)
        settled()
        if (clientId) {
          this.host.detach(clientId)
          this.live = Math.max(0, this.live - 1)
        }
        return
      }
      if (!channel) {
        if (kind !== 'text') return refuse('Say hello first.')
        let m: Record<string, string>
        try {
          m = JSON.parse(new TextDecoder().decode(data)) as Record<string, string>
        } catch {
          return refuse('That was not a hello.')
        }
        try {
          const device = unb64(m['device'] ?? '')
          const eph = unb64(m['eph'] ?? '')
          const cnonce = unb64(m['nonce'] ?? '')
          if (device.length !== 32 || eph.length !== 32 || cnonce.length !== 16) return refuse('That hello is not well formed.')
          const myEph = newKeyPair()
          const hnonce = random(16)
          let hostProof: string | undefined
          if (m['t'] === 'pair') {
            const p = this.pairing
            if (!p || p.until < Date.now()) return refuse('Pairing is not open on Prism. Open Settings, Phone app, and press Pair a device.')
            if (!sameBytes(unb64(m['proof'] ?? ''), codeProof(p.code, 'pair', device, eph, cnonce))) return refuse('That pairing code is not the one Prism shows.')
            hostProof = b64(codeProof(p.code, 'host', this.identity.public, myEph.public, hnonce, cnonce))
            this.pairing = null
            const pub = b64(device)
            this.devices = [...this.devices.filter((d) => d.pub !== pub), { pub, name: String(m['name'] ?? 'A phone').slice(0, 60), pairedAt: Date.now(), lastSeen: Date.now() }]
            this.save()
          } else if (m['t'] === 'hello') {
            const known = this.devices.find((d) => d.pub === b64(device))
            if (!known) return refuse('This device is not paired with this Prism (or was unpaired). Pair it again.')
            known.lastSeen = Date.now()
            this.save()
          } else return refuse('Say hello first.')
          conn.sendText(JSON.stringify({ t: 'welcome', v: PROTOCOL, host: b64(this.identity.public), eph: b64(myEph.public), nonce: b64(hnonce), name: hostname(), addrs: this.info().direct.concat(this.outside.state().external ?? []).filter((a) => !a.includes('127.0.0.1')), ...(hostProof ? { proof: hostProof } : {}) }))
          settled()
          channel = new Channel(channelKeys('host', { eph: myEph.secret, static: this.identity.secret }, { eph, static: device }, cnonce, hnonce))
          clearTimeout(timer)
          // the client is on the project in front on this computer, if any, until it picks another
          const ch = channel
          const id = `remote:${++this.seq}`
          const client: Client = { id, kind: 'remote', send: (c, p) => conn.sendBinary(ch.seal({ ev: c, p })), window: () => null, focus: () => {} }
          const front = this.host.workbenches().find((b) => b.workspace && this.host.clientsOf(b).some((c) => c.kind === 'window'))
          this.host.attach(client, front?.workspace?.root ?? null)
          clientId = id
          this.live++
        } catch (e) {
          console.error('[remote] hello', e)
          return refuse('That hello could not be read.')
        }
        return
      }
      if (kind !== 'binary' || !clientId) return
      let msg: { id?: number; ch?: string; a?: unknown[]; one?: number }
      try {
        msg = channel.open(data) as typeof msg
      } catch {
        return conn.close()
      }
      const ch = msg.ch ?? ''
      const args = Array.isArray(msg.a) ? msg.a : []
      const reply = (body: Record<string, unknown>): void => {
        if (msg.id !== undefined) conn.sendBinary(channel!.seal({ id: msg.id, ...body }))
      }
      if (WINDOW_ONLY.has(ch)) return reply({ e: 'That only works in a Prism window on the computer.' })
      const dispatch = this.host.dispatch
      // the phone app can be newer than the app on the computer: say so rather than naming a channel
      if (!dispatch || !dispatch.has(ch)) return reply({ e: `This computer runs Prism ${app.getVersion()}, which does not have that yet (${ch}). Update Prism on the computer.` })
      if (msg.one) {
        try {
          dispatch.send(clientId, ch, args)
        } catch {
          /* nothing to answer */
        }
        return
      }
      dispatch.invoke(clientId, ch, args).then(
        (r) => reply({ r: r === undefined ? null : r }),
        (e: unknown) => reply({ e: e instanceof Error ? e.message : String(e) })
      )
    }
  }
}

/** Whatever a connection sends, a mistake handling it ends that connection only. */
function guarded(feed: (kind: 'text' | 'binary' | 'close', data: Uint8Array) => void, conn: Conn): typeof feed {
  return (kind, data) => {
    try {
      feed(kind, data)
    } catch (e) {
      console.error('[remote]', e)
      if (kind !== 'close') conn.close()
    }
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
