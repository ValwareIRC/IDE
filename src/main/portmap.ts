// Asks the home router to pass one port through to this computer, so a paired phone can reach Prism from
// outside without a relay. UPnP first (most home routers), then NAT-PMP (Apple and some others). The opening
// is leased: renewed while Prism runs, closed again when it stops.
import { createSocket } from 'node:dgram'
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'

import type { RemoteOutside as PortMapState } from '@shared/types'

const LEASE_SEC = 3600
const SSDP = { host: '239.255.255.250', port: 1900 }

/** Addresses the router hands out to more than one home (carrier-grade NAT) or never routes. */
export function notPublic(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
}

function sameSubnet(ip: string, other: string, mask: string): boolean {
  const n = (s: string): number[] => s.split('.').map(Number)
  const [x, y, m] = [n(ip), n(other), n(mask)]
  return m.every((v, i) => (x[i]! & v) === (y[i]! & v))
}

/** This computer's address on the router's network. */
function localFor(router: string): string | null {
  if (router.startsWith('127.')) return '127.0.0.1'
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal && sameSubnet(n.address, router, n.netmask)) return n.address
  }
  return null
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(xml)
  return m ? m[1]!.trim() : null
}

// ---------------------------------------------------------------- UPnP

export interface Igd {
  control: string
  service: string
  router: string
}

/** Routers on this network that answer a UPnP search, by where their description lives. */
export async function discover(ms = 2500): Promise<string[]> {
  const found = new Set<string>()
  const gw = await gateway()
  // one search per network adapter (a computer with WSL or a VPN has several), and one straight to the gateway
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address)
  const queries = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'].map(
    (st) => `M-SEARCH * HTTP/1.1
HOST: ${SSDP.host}:${SSDP.port}
MAN: "ssdp:discover"
MX: 2
ST: ${st}

`
  )
  const one = (iface: string | null): Promise<void> =>
    new Promise((resolve) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: true })
      const done = (): void => {
        try {
          sock.close()
        } catch {
          /* closed */
        }
        resolve()
      }
      sock.on('error', done)
      sock.on('message', (msg) => {
        const loc = /^location:s*(S+)/im.exec(msg.toString('utf8'))
        if (loc?.[1]) found.add(loc[1])
      })
      sock.bind(0, () => {
        try {
          if (iface) sock.setMulticastInterface(iface)
          for (const q of queries) {
            sock.send(q, SSDP.port, SSDP.host)
            if (gw && !iface) sock.send(q, SSDP.port, gw)
          }
        } catch {
          /* that adapter cannot send */
        }
        setTimeout(done, ms)
      })
    })
  await Promise.all([one(null), ...addrs.map((a) => one(a))])
  return [...found]
}

export async function igdAt(location: string): Promise<Igd | null> {
  const r = await fetch(location, { signal: AbortSignal.timeout(4000) }).catch(() => null)
  if (!r?.ok) return null
  const xml = await r.text()
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    const block = m[1]!
    const service = tag(block, 'serviceType') ?? ''
    if (!/WAN(IP|PPP)Connection/.test(service)) continue
    const control = tag(block, 'controlURL')
    if (!control) continue
    const base = tag(xml, 'URLBase') || location
    return { control: new URL(control, base).toString(), service, router: new URL(location).hostname }
  }
  return null
}

export async function soap(igd: Igd, action: string, args: Record<string, string | number>): Promise<string> {
  const body =
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${igd.service}">${Object.entries(args)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('')}</u:${action}></s:Body></s:Envelope>`
  const r = await fetch(igd.control, { method: 'POST', body, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${igd.service}#${action}"` }, signal: AbortSignal.timeout(5000) })
  const text = await r.text()
  if (!r.ok) {
    const code = tag(text, 'errorCode')
    const e = new Error(`${tag(text, 'errorDescription') ?? `router said ${r.status}`}${code ? ` (${code})` : ''}`) as Error & { code?: string }
    e.code = code ?? undefined
    throw e
  }
  return text
}

// ---------------------------------------------------------------- NAT-PMP

/** The default gateway, from the system's route table. */
function gateway(): Promise<string | null> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    execFile(win ? 'route' : 'ip', win ? ['print', '-4', '0.0.0.0'] : ['-4', 'route', 'show', 'default'], { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null)
      const m = win ? /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(out) : /default via (\d+\.\d+\.\d+\.\d+)/.exec(out)
      resolve(m?.[1] ?? null)
    })
  })
}

function pmp(router: string, req: Buffer, expectOp: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4')
    let wait = 250
    let tries = 0
    let timer: NodeJS.Timeout
    const end = (e: Error | null, b?: Buffer): void => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* closed */
      }
      if (e) reject(e)
      else resolve(b!)
    }
    const send = (): void => {
      if (tries++ >= 4) return end(new Error('the router did not answer NAT-PMP'))
      sock.send(req, 5351, router)
      timer = setTimeout(send, wait)
      wait *= 2
    }
    sock.on('error', (e) => end(e))
    sock.on('message', (b) => {
      if (b.length < 8 || b[1] !== expectOp) return
      const result = b.readUInt16BE(2)
      if (result !== 0) return end(new Error(`the router refused (NAT-PMP ${result})`))
      end(null, b)
    })
    sock.bind(0, send)
  })
}

// ---------------------------------------------------------------- the opening

export class PortMap {
  private st: PortMapState = { state: 'off', how: null, external: null, error: null }
  private renew: NodeJS.Timeout | null = null
  private undo: (() => Promise<void>) | null = null
  private gen = 0

  /** `find` and `gw` are where routers are looked for (tests point them at a stand-in). */
  constructor(
    private onChange: () => void,
    private find: () => Promise<string[]> = () => discover(),
    private gw: () => Promise<string | null> = gateway
  ) {}

  state(): PortMapState {
    return this.st
  }

  private set(s: Partial<PortMapState>): void {
    this.st = { ...this.st, ...s }
    this.onChange()
  }

  /** Open `port` on the router (or keep it open). */
  async open(port: number): Promise<void> {
    const gen = ++this.gen
    await this.close(true)
    this.set({ state: 'trying', how: null, external: null, error: null })
    const why: string[] = []
    try {
      if (await this.viaUpnp(port, gen)) return
    } catch (e) {
      why.push(`UPnP: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (gen !== this.gen) return
    try {
      if (await this.viaPmp(port, gen)) return
    } catch (e) {
      why.push(`NAT-PMP: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (gen !== this.gen) return
    // nobody answering is the usual case: the router has it switched off
    const silent = why.every((w) => /no router answered|did not answer|no gateway/.test(w))
    const gw = silent ? await this.gw().catch(() => null) : null
    this.set({
      state: 'failed',
      error: silent
        ? `Your router${gw ? ` (${gw})` : ''} did not answer, so router port opening is probably switched off. Turn on UPnP in the router's own settings page${gw ? ` (http://${gw})` : ''}, then switch this off and on again. Or use a relay.`
        : why.join('; ')
    })
  }

  private async viaUpnp(port: number, gen: number): Promise<boolean> {
    let igd: Igd | null = null
    for (const loc of await this.find()) {
      igd = await igdAt(loc).catch(() => null)
      if (igd) break
    }
    if (!igd) throw new Error('no router answered')
    const me = localFor(igd.router)
    if (!me) throw new Error('this computer is not on the router\'s network')
    const ext = tag(await soap(igd, 'GetExternalIPAddress', {}), 'NewExternalIPAddress') ?? ''
    const map = async (lease: number): Promise<number> => {
      for (let p = port; p < port + 5; p++) {
        try {
          await soap(igd!, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: p, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: me, NewEnabled: 1, NewPortMappingDescription: 'Prism phone app', NewLeaseDuration: lease })
          return p
        } catch (e) {
          // 718: that outside port is taken by something else; 725: this router only takes leases that never end
          const code = (e as { code?: string }).code
          if (code === '725' && lease) return map(0)
          if (code !== '718') throw e
        }
      }
      throw new Error('every port tried is taken on the router')
    }
    let outside = await map(LEASE_SEC)
    if (gen !== this.gen) return true
    this.undo = async () => {
      await soap(igd!, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: outside, NewProtocol: 'TCP' }).catch(() => {})
    }
    this.renew = setInterval(() => void map(LEASE_SEC).then((p) => (outside = p)).catch((e: unknown) => this.set({ state: 'failed', error: `Renewing: ${e instanceof Error ? e.message : String(e)}` })), (LEASE_SEC / 2) * 1000)
    this.opened('UPnP', ext, outside)
    return true
  }

  private async viaPmp(port: number, gen: number): Promise<boolean> {
    const router = await this.gw()
    if (!router) throw new Error('no gateway found')
    const a = await pmp(router, Buffer.from([0, 0]), 128)
    const ext = `${a[8]}.${a[9]}.${a[10]}.${a[11]}`
    const ask = (lease: number): Promise<number> => {
      const b = Buffer.alloc(12)
      b[0] = 0
      b[1] = 2 // TCP
      b.writeUInt16BE(port, 4)
      b.writeUInt16BE(port, 6)
      b.writeUInt32BE(lease, 8)
      return pmp(router, b, 130).then((r) => r.readUInt16BE(10))
    }
    const outside = await ask(LEASE_SEC)
    if (gen !== this.gen) return true
    this.undo = async () => {
      await ask(0).catch(() => {})
    }
    this.renew = setInterval(() => void ask(LEASE_SEC).catch((e: unknown) => this.set({ state: 'failed', error: `Renewing: ${e instanceof Error ? e.message : String(e)}` })), (LEASE_SEC / 2) * 1000)
    this.opened('NAT-PMP', ext, outside)
    return true
  }

  private opened(how: 'UPnP' | 'NAT-PMP', ext: string, outside: number): void {
    if (!ext || notPublic(ext)) {
      // no use to anyone: closed again
      if (this.renew) clearInterval(this.renew)
      this.renew = null
      void this.undo?.()
      this.undo = null
      this.set({ state: 'failed', how, external: null, error: `The router opened the port, but its own outside address (${ext || 'unknown'}) is shared with other customers of your internet provider, so phones cannot reach it from outside. Use a relay instead.` })
      return
    }
    this.set({ state: 'open', how, external: `ws://${ext}:${outside}`, error: null })
  }

  /** Close the opening on the router. */
  async close(keepGen = false): Promise<void> {
    if (!keepGen) this.gen++
    if (this.renew) clearInterval(this.renew)
    this.renew = null
    const undo = this.undo
    this.undo = null
    if (undo) await undo()
    if (!keepGen) this.set({ state: 'off', how: null, external: null, error: null })
  }
}
