// A relay for Prism's phone app: it lets a phone reach a Prism that has no address of its own.
//
// Prism keeps one connection here and every phone's traffic travels down it, each frame tagged with the phone
// it belongs to (see src/shared/relayFrames.ts). A phone connects exactly as it would to Prism directly, so it
// needs no idea the relay exists.
//
// The relay cannot read any of it. Everything after the first message is sealed between the phone and the
// computer with keys neither of them ever sends here (src/shared/remoteCrypto.ts). It forwards bytes and
// nothing else: it keeps no messages, writes no files and logs no payloads.
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8794)
// Set it and the address gains a secret segment (wss://host/relay/<secret>), so only someone who knows it can
// use the relay at all. Left empty, anyone who finds the address can.
const SECRET = (process.env.RELAY_SECRET || '').trim()
// A phone asking for a file preview can pull tens of megabytes; this is a little over Prism's own cap.
const MAX_PAYLOAD = 48 * 1024 * 1024
const MAX_HOSTS = 50
const MAX_PHONES_PER_HOST = 20
// How long a computer's slot is held after it drops, so a reconnect keeps its id.
const HOLD_MS = 5 * 60 * 1000

const KIND = { OPEN: 1, TEXT: 2, BINARY: 3, CLOSE: 4 }

const frame = (kind, conn, payload = Buffer.alloc(0)) => {
  const out = Buffer.allocUnsafe(5 + payload.length)
  out[0] = kind
  out.writeUInt32BE(conn, 1)
  if (payload.length) Buffer.from(payload).copy(out, 5)
  return out
}
const readFrame = (buf) => ({ kind: buf[0], conn: buf.readUInt32BE(1), payload: buf.subarray(5) })

/** id -> { ws, key, conns: Map<number, WebSocket>, next, forget } */
const hosts = new Map()

const log = (...a) => console.log(new Date().toISOString(), ...a)

function paths(url) {
  const u = new URL(url, 'http://x')
  const parts = u.pathname.split('/').filter(Boolean)
  if (SECRET) {
    if (parts.shift() !== SECRET) return null
  }
  return { what: parts[0] || '', id: u.searchParams.get('id') || '', key: u.searchParams.get('key') || '' }
}

const http = createServer((req, res) => {
  const p = paths(req.url || '/')
  if (p && p.what === 'healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, computers: hosts.size }))
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })

http.on('upgrade', (req, socket, head) => {
  const refuse = (code, why) => {
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }
  const p = paths(req.url || '/')
  if (!p) return refuse(404, 'Not Found')

  if (p.what === 'host') {
    if (!p.id || !p.key) return refuse(400, 'Bad Request')
    const had = hosts.get(p.id)
    // the id belongs to whoever claimed it first: a different key cannot take it over
    if (had && had.key !== p.key) return refuse(409, 'Conflict')
    if (!had && hosts.size >= MAX_HOSTS) return refuse(503, 'Service Unavailable')
    return wss.handleUpgrade(req, socket, head, (ws) => addHost(p.id, p.key, ws))
  }

  if (p.what === 'client') {
    const host = hosts.get(p.id)
    if (!host || !host.ws || host.ws.readyState !== host.ws.OPEN) return refuse(502, 'Bad Gateway')
    if (host.conns.size >= MAX_PHONES_PER_HOST) return refuse(503, 'Service Unavailable')
    return wss.handleUpgrade(req, socket, head, (ws) => addClient(host, ws))
  }

  refuse(404, 'Not Found')
})

function addHost(id, key, ws) {
  const had = hosts.get(id)
  if (had) {
    // a second connection with the right key replaces the old one (a reconnect after a silent drop)
    clearTimeout(had.forget)
    if (had.ws && had.ws !== ws) try { had.ws.close() } catch {}
    for (const c of had.conns.values()) try { c.close() } catch {}
  }
  const host = { ws, key, conns: new Map(), next: 1, forget: null }
  hosts.set(id, host)
  log('computer here', id)

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length < 5) return
    const f = readFrame(buf)
    const client = host.conns.get(f.conn)
    if (!client) return
    if (f.kind === KIND.CLOSE) {
      host.conns.delete(f.conn)
      try { client.close() } catch {}
      return
    }
    // back to the phone exactly as Prism would have sent it: text stays text, sealed frames stay binary
    if (client.readyState === client.OPEN) client.send(f.payload, { binary: f.kind === KIND.BINARY })
  })

  const gone = () => {
    if (hosts.get(id) !== host) return
    for (const c of host.conns.values()) try { c.close() } catch {}
    host.conns.clear()
    host.ws = null
    // the slot is held briefly so a reconnect keeps the same address
    host.forget = setTimeout(() => {
      if (hosts.get(id) === host) {
        hosts.delete(id)
        log('computer gone', id)
      }
    }, HOLD_MS)
  }
  ws.on('close', gone)
  ws.on('error', gone)
}

function addClient(host, ws) {
  const conn = host.next++
  if (host.next > 0xffffffff) host.next = 1
  host.conns.set(conn, ws)
  host.ws.send(frame(KIND.OPEN, conn))

  ws.on('message', (data, isBinary) => {
    if (!host.ws || host.ws.readyState !== host.ws.OPEN) return
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
    host.ws.send(frame(isBinary ? KIND.BINARY : KIND.TEXT, conn, payload))
  })
  const gone = () => {
    if (host.conns.get(conn) !== ws) return
    host.conns.delete(conn)
    if (host.ws && host.ws.readyState === host.ws.OPEN) host.ws.send(frame(KIND.CLOSE, conn))
  }
  ws.on('close', gone)
  ws.on('error', gone)
}

http.listen(PORT, '127.0.0.1', () => log(`relay on 127.0.0.1:${PORT}${SECRET ? ' (behind a secret segment)' : ' (open)'}`))
