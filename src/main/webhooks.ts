// Web addresses for automation triggers: http://127.0.0.1:<port>/hook/<key> on this computer, for scripts, git
// hooks and local tools. Each trigger's key is random and kept here (userData), never in the project's files.
// One server for every open project; the key says which project and trigger it is.
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class Webhooks {
  private keys: Record<string, string> = {}
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private port = 0
  private file: string

  constructor(
    userData: string,
    /** Start the trigger in that project; false when the project is not open or the trigger is off. */
    private fire: (root: string, triggerId: string, body: string) => boolean
  ) {
    this.file = join(userData, 'webhook-keys.json')
    try {
      if (existsSync(this.file)) this.keys = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      this.keys = {}
    }
  }

  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        const m = /^\/hook\/([a-f0-9]{32})$/.exec(req.url ?? '')
        const at = m ? Object.entries(this.keys).find(([, k]) => k === m[1]) : undefined
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (!at) return json(404, { error: 'No trigger has that address.' })
        const [where] = at
        const sep = where.lastIndexOf('::')
        let body = ''
        req.on('data', (d: Buffer) => {
          if (body.length < 64_000) body += d.toString('utf8')
        })
        req.on('end', () => (this.fire(where.slice(0, sep), where.slice(sep + 2), body) ? json(200, { ok: true, started: true }) : json(409, { error: 'That trigger is switched off, or its project is not open in Prism.' })))
      })
      const done = (): void => {
        const a = server.address()
        this.port = typeof a === 'object' && a ? a.port : 0
        server.unref()
        this.server = server
        resolve()
      }
      server.once('error', () => server.listen(0, '127.0.0.1', done))
      server.listen(8792, '127.0.0.1', done)
    })
    return this.starting
  }

  /** The trigger's address; made (with a new key) the first time it is asked for. */
  url(root: string, triggerId: string): string | null {
    const k = `${root}::${triggerId}`
    if (!this.keys[k]) {
      this.keys[k] = randomBytes(16).toString('hex')
      try {
        writeFileSync(this.file, JSON.stringify(this.keys))
      } catch {
        /* kept until restart */
      }
    }
    void this.start()
    return this.server && this.port ? `http://127.0.0.1:${this.port}/hook/${this.keys[k]}` : null
  }
}
