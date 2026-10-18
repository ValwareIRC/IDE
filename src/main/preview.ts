// The in-app browser, seen from the main process. The page itself is a
// <webview> inside the Browser panel (renderer); the panel tells us which
// web contents that is, and from then on the agent's browser_* tools can load a
// page, look at it and run script in it. A small static server makes plain
// HTML folders reachable over http, so module scripts and fetch work.
import { webContents, type WebContents, BrowserWindow, session } from 'electron'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import type { BrowserConsoleEntry, DevScript } from '@shared/types'
import type { Workspace } from '@core/fs/workspace'
import { placeOf } from '@shared/place'
import { auditScript, boxesFor, highlightScript, outlineScript, toReport } from './a11y'
import type { A11yReport } from '@shared/a11y'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
}

const LEVELS = ['log', 'info', 'warn', 'error'] as const

/** What became of script run in a page: its value, or the page went somewhere else before it finished. */
type InPage = { kind: 'done'; value: unknown } | { kind: 'left'; url: string }

/**
 * Runs script in a page without ever waiting for ever. A script whose page reloads or
 * follows a link can never report back (location.reload() once left a turn waiting
 * for 54 minutes), and one that loops or waits on something that never happens would
 * hang the same way. So the wait also ends when the page navigates, closes or crashes,
 * or after `ms`.
 */
function inPage(wc: WebContents, code: string, ms: number): Promise<InPage> {
  return new Promise<InPage>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.off('did-start-navigation', onNav as never)
      wc.off('destroyed', onGone)
      wc.off('render-process-gone', onGone)
      fn()
    }
    // newer Electron hands the details on the event; older passes them one by one
    const onNav = (e: unknown, url?: unknown, inPlace?: unknown, mainFrame?: unknown): void => {
      const d = (e ?? {}) as { url?: string; isSameDocument?: boolean; isMainFrame?: boolean }
      const main = typeof d.isMainFrame === 'boolean' ? d.isMainFrame : mainFrame === true
      const same = typeof d.isSameDocument === 'boolean' ? d.isSameDocument : inPlace === true
      if (main && !same) finish(() => resolve({ kind: 'left', url: String(d.url ?? url ?? '') }))
    }
    const onGone = (): void => finish(() => reject(new Error('the page closed or crashed while the script ran.')))
    const timer = setTimeout(() => finish(() => reject(new Error(`it had not finished after ${Math.round(ms / 1000)} seconds, so Prism stopped waiting. A script that waits for something (a timer, a click, a page load) has to finish within that time.`))), ms)
    wc.on('did-start-navigation', onNav as never)
    wc.once('destroyed', onGone)
    wc.once('render-process-gone', onGone)
    wc.executeJavaScript(code, true).then(
      (value) => finish(() => resolve({ kind: 'done', value })),
      (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
    )
  })
}

/** Anything else a page is asked for (a picture, a debugger command) gives up after `ms` too. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export class PreviewManager {
  private guest: WebContents | null = null
  /**
   * Whether the user follows the agent (the switch in the agent panel). When they do, the
   * agent browses in their Browser panel, where they watch it. When they do not, it
   * browses in a hidden page of its own and their Browser panel is left alone.
   */
  private follow = true
  private own: BrowserWindow | null = null
  private ownIdle: NodeJS.Timeout | null = null
  private logs: BrowserConsoleEntry[] = []
  private seen = 0
  private muteSyntaxUntil = 0
  private waiters: Array<(wc: WebContents) => void> = []
  private server: { root: string; url: string; http: Server } | null = null

  constructor(
    private workspace: () => Workspace | null,
    private send: (channel: string, payload: unknown) => void
  ) {}

  /** The Browser panel's page came to life (or was replaced). */
  attach(id: number): void {
    const wc = webContents.fromId(id)
    if (!wc || wc === this.guest) return
    this.guest = wc
    if (this.follow) {
      this.logs = []
      this.seen = 0
    }
    this.listen(wc)
    wc.once('destroyed', () => {
      if (this.guest === wc) this.guest = null
    })
    for (const w of this.waiters.splice(0)) w(wc)
  }

  /** What a page prints, kept for browser_open and browser_look to report. */
  private listen(wc: WebContents): void {
    wc.on('console-message', (ev) => {
      // the panel's page speaks for the agent only while the agent browses there
      if (wc === this.guest && !this.follow) return
      const e = ev as unknown as { level: number | string; message: string; lineNumber: number; sourceId: string }
      const level = typeof e.level === 'number' ? (LEVELS[e.level] ?? 'log') : e.level === 'warning' ? 'warn' : ((LEVELS as readonly string[]).includes(e.level) ? (e.level as BrowserConsoleEntry['level']) : 'log')
      const text = String(e.message)
      // Electron's own advice about the page, and syntax errors from our own script attempts, are not the page speaking
      if (text.startsWith('%cElectron Security Warning') || (Date.now() < this.muteSyntaxUntil && text.includes('SyntaxError'))) return
      this.logs.push({ level, text: text.slice(0, 4000), source: e.sourceId ?? '', line: e.lineNumber ?? 0, ts: Date.now() })
      if (this.logs.length > 600) {
        const cut = this.logs.length - 500
        this.logs.splice(0, cut)
        this.seen = Math.max(0, this.seen - cut)
      }
    })
    // links that want a new window open in the same page instead of nowhere
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
  }

  /** The agent panel's follow switch, reported by the window. */
  setFollow(on: boolean): void {
    if (this.follow === on) return
    this.follow = on
    this.logs = []
    this.seen = 0
  }

  /** The agent's own hidden page, made on first use and let go after ten quiet minutes. */
  private ownPage(): WebContents {
    if (this.ownIdle) clearTimeout(this.ownIdle)
    this.ownIdle = setTimeout(() => {
      this.own?.destroy()
      this.own = null
    }, 10 * 60_000)
    if (this.own && !this.own.isDestroyed()) return this.own.webContents
    this.own = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true, session: session.fromPartition('persist:preview'), backgroundThrottling: false } })
    this.own.webContents.setAudioMuted(true)
    this.listen(this.own.webContents)
    const win = this.own
    win.on('closed', () => {
      if (this.own === win) this.own = null
    })
    return win.webContents
  }

  detach(id: number): void {
    if (this.guest?.id === id) this.guest = null
  }

  /**
   * The page to work in: the agent's own hidden one when the user is not following it,
   * otherwise the Browser panel's, opening the panel first when there is none. forUser:
   * always the panel's (the user's own buttons there).
   */
  private async ensure(forUser = false): Promise<WebContents> {
    if (!forUser && !this.follow) return this.ownPage()
    if (this.guest && !this.guest.isDestroyed()) return this.guest
    this.send('preview:open', null)
    return new Promise<WebContents>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The Browser panel did not open.')), 10_000)
      this.waiters.push((wc) => {
        clearTimeout(t)
        resolve(wc)
      })
    })
  }

  /** http(s) addresses as they are; anything else is a file in the workspace, served over http. */
  async resolve(target: string): Promise<string> {
    const t = target.trim()
    if (/^https?:\/\//i.test(t)) return t
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`
    const ws = this.workspace()
    if (!ws) throw new Error('Open a folder first.')
    const rel = t.replace(/^\.?[\\/]+/, '').split('\\').join('/')
    const isFile = !rel || (await ws.exists(rel).catch(() => false))
    if (!isFile) {
      // not a file here: something like example.com/docs is an address
      if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`
      throw new Error(`${rel} is not a file in this project, and does not look like a web address.`)
    }
    return `${await this.serve()}${rel.split('/').map(encodeURIComponent).join('/')}`
  }

  /** Bring the panel to the front and return its page, which may be a fresh one if the panel had to be re-attached. */
  private async front(): Promise<WebContents> {
    if (!this.follow) return this.ownPage()
    await this.ensure()
    this.send('preview:focus', null)
    await new Promise((r) => setTimeout(r, 350))
    return this.ensure()
  }

  async open(target: string): Promise<{ url: string; title: string; console: BrowserConsoleEntry[] }> {
    const url = await this.resolve(target)
    const wc = await this.front()
    this.seen = this.logs.length
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t)
        wc.off('did-finish-load', done)
        wc.off('did-fail-load', done)
        resolve()
      }
      const t = setTimeout(done, 12_000)
      wc.once('did-finish-load', done)
      wc.once('did-fail-load', done)
      void wc.loadURL(url).catch(() => done())
    })
    // scripts that run on load get a moment to report
    await new Promise((r) => setTimeout(r, 600))
    if (wc.isDestroyed()) throw new Error('The Browser panel was closed while the page was loading.')
    return { url: wc.getURL(), title: wc.getTitle(), console: this.fresh() }
  }

  /** Console lines since the agent last looked, problems only by default. */
  fresh(all = false): BrowserConsoleEntry[] {
    const out = this.logs.slice(this.seen).filter((l) => all || l.level === 'error' || l.level === 'warn')
    this.seen = this.logs.length
    return out.slice(-60)
  }

  async look(): Promise<{ url: string; title: string; image: { mime: string; base64: string } | null; console: BrowserConsoleEntry[]; text: string }> {
    const wc = await this.front()
    const img = await within(wc.capturePage(), 15_000, 'Taking the picture').catch(() => null)
    const scaled = img && !img.isEmpty() ? (img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img) : null
    const read = await inPage(wc, 'document.body ? document.body.innerText.slice(0, 3000) : ""', 10_000).catch(() => null)
    const text = read?.kind === 'done' ? String(read.value ?? '') : ''
    return { url: wc.getURL(), title: wc.getTitle(), image: scaled ? { mime: 'image/jpeg', base64: scaled.toJPEG(82).toString('base64') } : null, console: this.fresh(), text }
  }

  /**
   * Run script in the page. It is tried as one expression first (so `document.title` returns its value), then as
   * statements. A script that does not parse makes the whole wrapper fail before anything runs, so the second try
   * can never repeat a side effect; errors thrown while running are caught inside the page and reported with their text.
   * It never waits more than 45 seconds, and a script that makes the page reload or follow a link is reported as that.
   */
  async evaluate(script: string): Promise<string> {
    const wc = await this.ensure()
    const wrap = (body: string): string =>
      `(async () => { try { const __r = await (async () => { ${body}\n })(); let __s; try { __s = typeof __r === 'string' ? __r : JSON.stringify(__r, null, 2) } catch { __s = String(__r) } return { ok: true, value: __s === undefined ? 'undefined' : __s } } catch (e) { return { ok: false, error: String((e && e.stack) || e) } } })()`
    type Out = { ok: boolean; value?: string; error?: string }
    let r = null as Out | null
    let parsed = false
    for (const body of [`return (\n${script}\n)`, script]) {
      // a failed parse is reported in the page's console; that is our doing, not the page's
      this.muteSyntaxUntil = Date.now() + 400
      let got: InPage
      try {
        got = await inPage(wc, wrap(body), 45_000)
      } catch (e) {
        // a script that did not parse fails at once; anything else (too slow, page gone) is the answer
        if (e instanceof Error && /seconds|closed or crashed/.test(e.message)) throw e
        continue
      }
      parsed = true
      if (got.kind === 'left') return `The page went to ${got.url || 'another address'} before the script finished (it reloaded or followed a link), so the script's own result was lost. Use browser_look to see where it is now.`
      r = got.value as Out
      break
    }
    if (!parsed || !r) throw new Error('it is not valid JavaScript.')
    if (!r.ok) throw new Error(r.error ?? 'it threw an error.')
    return r.value ?? 'undefined'
  }

  /** The address open in the Browser panel, when it is a web page. */
  pageUrl(): string | null {
    const url = this.guest && !this.guest.isDestroyed() ? this.guest.getURL() : ''
    return /^https?:/i.test(url) ? url : null
  }

  /**
   * A picture of a page, drawn in a hidden window of its own: the Browser panel's tab may be behind others, and a
   * hidden page cannot be photographed. Same cookies and storage as the panel, so a signed-in page looks the same.
   */
  async render(url: string, width = 1280, height = 800): Promise<Buffer | null> {
    const win = new BrowserWindow({ show: false, width, height, webPreferences: { offscreen: true, session: session.fromPartition('persist:preview'), backgroundThrottling: false } })
    try {
      win.webContents.setAudioMuted(true)
      await Promise.race([win.loadURL(url), new Promise((r) => setTimeout(r, 15_000))]).catch(() => {})
      // fonts, pictures and scripts that draw after load
      await new Promise((r) => setTimeout(r, 1200))
      const img = await within(win.webContents.capturePage(), 15_000, 'Taking the picture')
      if (img.isEmpty()) return null
      return (img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img).toPNG()
    } catch {
      return null
    } finally {
      win.destroy()
    }
  }

  /**
   * A picture of a page at an exact size and sharpness, for gadgets (store screenshots,
   * design boards, accessibility checks): drawn in a hidden window like render, but at
   * the size asked for and never shrunk afterwards.
   */
  async capture(url: string, o: { width: number; height: number; scale: number; waitMs: number }): Promise<{ mime: string; base64: string }> {
    const win = new BrowserWindow({ show: false, width: o.width, height: o.height, useContentSize: true, webPreferences: { offscreen: true, session: session.fromPartition('persist:preview'), backgroundThrottling: false } })
    try {
      win.webContents.setAudioMuted(true)
      const dbg = win.webContents.debugger
      let cdp = false
      try {
        dbg.attach('1.3')
        await within(dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.scale, mobile: o.width < 700 }), 10_000, 'Setting the size')
        cdp = true
      } catch {
        /* drawn at the window's own scale instead */
      }
      await Promise.race([win.loadURL(url), new Promise((r) => setTimeout(r, 15_000))]).catch(() => {})
      await new Promise((r) => setTimeout(r, o.waitMs))
      if (cdp) {
        try {
          const shot = (await within(dbg.sendCommand('Page.captureScreenshot', { format: 'png' }), 20_000, 'Taking the picture')) as { data: string }
          if (shot.data) return { mime: 'image/png', base64: shot.data }
        } catch {
          /* fall back to the window's own picture */
        }
      }
      const img = await within(win.webContents.capturePage(), 15_000, 'Taking the picture')
      if (img.isEmpty()) throw new Error('The page drew nothing.')
      return { mime: 'image/png', base64: img.toPNG().toString('base64') }
    } finally {
      win.destroy()
    }
  }

  /**
   * Checks a page for accessibility problems (main/a11y.ts): the page open in the
   * Browser panel, or an address or file of its own in a hidden window. Comes back with
   * the problems in plain words and a picture with each one boxed and numbered.
   */
  async audit(target?: string, forUser = false): Promise<{ report: A11yReport; image: { mime: string; base64: string } | null }> {
    let win: BrowserWindow | null = null
    let wc: WebContents
    if (target?.trim()) {
      const url = await this.resolve(target)
      win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true, session: session.fromPartition('persist:preview'), backgroundThrottling: false } })
      win.webContents.setAudioMuted(true)
      await Promise.race([win.loadURL(url), new Promise((r) => setTimeout(r, 15_000))]).catch(() => {})
      await new Promise((r) => setTimeout(r, 1200))
      wc = win.webContents
    } else wc = await this.ensure(forUser)
    try {
      const got = await inPage(wc, auditScript(), 90_000)
      if (got.kind === 'left') throw new Error(`the page went to ${got.url || 'another address'} while it was being checked. Check it again once it has settled.`)
      const report = toReport(got.value as Parameters<typeof toReport>[0])
      let image: { mime: string; base64: string } | null = null
      try {
        await inPage(wc, outlineScript(boxesFor(report)), 10_000)
        await new Promise((r) => setTimeout(r, 120))
        const img = await within(wc.capturePage(), 15_000, 'Taking the picture')
        if (!img.isEmpty()) {
          const scaled = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img
          image = { mime: 'image/jpeg', base64: scaled.toJPEG(82).toString('base64') }
        }
      } catch {
        /* the list is what matters; the picture is a help */
      } finally {
        await inPage(wc, outlineScript(null), 10_000).catch(() => {})
      }
      return { report, image }
    } finally {
      win?.destroy()
    }
  }

  /** Points at one problem's elements in the Browser panel's page. */
  async highlight(selectors: string[]): Promise<boolean> {
    const wc = await this.ensure(true)
    const got = await inPage(wc, highlightScript(selectors), 10_000).catch(() => null)
    return got?.kind === 'done' && Boolean(got.value)
  }

  /** The static server's address when it is running, without starting it. */
  base(): string | null {
    return this.server?.url ?? null
  }

  /** A plain static server for the workspace folder. One per workspace, started on first use. */
  async serve(): Promise<string> {
    const ws = this.workspace()
    if (!ws) throw new Error('Open a folder first.')
    if (this.server && this.server.root === ws.root) return this.server.url
    this.server?.http.close()
    this.server = null
    const far = placeOf(ws.root).kind === 'ssh'
    const http = createServer((req, res) => {
      if (far) {
        // a folder on another computer: each file is fetched from there
        const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '')
        void (async () => {
          try {
            const target = (await ws.kind(path || '.')) === 'dir' ? `${path.replace(/\/$/, '')}${path ? '/' : ''}index.html` : path
            const buf = await ws.readRaw(target)
            res.writeHead(200, { 'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
            res.end(buf)
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(`Nothing at /${path}`)
          }
        })()
        return
      }
      try {
        const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '')
        let abs = ws.abs(path || '.')
        if (existsSync(abs) && statSync(abs).isDirectory()) abs = join(abs, 'index.html')
        if (!existsSync(abs)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`Nothing at /${path}`)
          return
        }
        res.writeHead(200, { 'Content-Type': TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
        createReadStream(abs).pipe(res)
      } catch {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not allowed')
      }
    })
    const url = await new Promise<string>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        const a = http.address()
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/`)
      })
    })
    this.server = { root: ws.root, url, http }
    return url
  }

  /** The scripts in package.json that usually start a dev server, and how to run them here. */
  scripts(): DevScript[] {
    const ws = this.workspace()
    if (!ws) return []
    try {
      const pkg = JSON.parse(readFileSync(join(ws.root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const pm = existsSync(join(ws.root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(ws.root, 'yarn.lock')) ? 'yarn' : existsSync(join(ws.root, 'bun.lockb')) || existsSync(join(ws.root, 'bun.lock')) ? 'bun' : 'npm'
      return ['dev', 'start', 'serve', 'preview', 'develop']
        .filter((n) => typeof pkg.scripts?.[n] === 'string')
        .map((n) => ({ name: n, script: pkg.scripts![n]!, command: `${pm} run ${n}` }))
    } catch {
      return []
    }
  }

  dispose(): void {
    this.server?.http.close()
    this.server = null
    if (this.ownIdle) clearTimeout(this.ownIdle)
    this.own?.destroy()
    this.own = null
  }
}
