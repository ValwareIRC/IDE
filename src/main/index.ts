import { serveModelFile } from './voice'
import { app, BrowserWindow, Menu, net, protocol, session, shell, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Host, type Client } from './host'
import type { Services } from './services'
import { registerIpc } from './ipc'
import { Floats } from './float'
import { disposeSpeech } from './speech'
import { disposeKokoro } from './kokoro'
import { GADGET_BASE_CSS, GADGET_SDK_JS } from '@core/gadgets/sdk'
import { GADGET_KIT_CSS, GADGET_KIT_JS } from '@core/gadgets/kit'
import { placeOf } from '@shared/place'
import { bootLog } from './bootlog'
import { handedPath, placeHanded } from './handover'
import { CH } from '@shared/ipc'

bootLog(`Prism ${app.getVersion()} starting on ${process.platform}`, process.argv.slice(1).join(' '))

app.setName('prism')
// The installer's shortcuts carry this id; Windows groups the window and names notifications by it.
// A development copy runs as electron.exe, and sharing the id let a taskbar pin made from Prism
// point at that electron.exe instead, so it shows as "Electron"; it gets an id of its own.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.valware.prism' : 'com.valware.prism.dev')

// A second profile, so a development copy can run beside the everyday one.
if (process.env['PRISM_USER_DATA']) app.setPath('userData', process.env['PRISM_USER_DATA'])

if (process.env['PRISM_DEBUG_PORT']) app.commandLine.appendSwitch('remote-debugging-port', process.env['PRISM_DEBUG_PORT'])

// prism://wb-<workbench>/<path> serves files from that window's project to previews (prism://workspace/ is the first);
// prism://attach/<file> serves pasted/picked attachments;
// prism://theme/<file> serves a theme's background picture.
protocol.registerSchemesAsPrivileged([
  { scheme: 'prism', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } },
  // prism-gadget://<id>/<file> serves a gadget's UI in its own origin, isolated from the app.
  { scheme: 'prism-gadget', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }
])

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.md': 'text/plain', '.txt': 'text/plain'
}
const mimeOf = (path: string): string => MIME[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'

/** Gadget files are UTF-8; without this a page with no <meta charset> shows "…" as garbage. */
function withCharset(type: string): string {
  return (type.startsWith('text/') || type.startsWith('application/javascript') || type.startsWith('application/json')) && !/charset=/i.test(type) ? `${type}; charset=utf-8` : type
}

let host: Host | null = null
const windows = new Set<BrowserWindow>()
let floats: Floats | null = null

/** The workbench a prism:// address points at. */
function benchFor(hostname: string): Services | null {
  if (!host) return null
  if (hostname.startsWith('wb-')) return host.byId(hostname.slice(3)) ?? null
  return host.workbenches().find((b) => b.workspace) ?? null
}

/** A window on a project (or on none). The first one opens the last project. */
function openWindow(root: string | null): BrowserWindow {
  const near = BrowserWindow.getFocusedWindow() ?? [...windows].pop()
  const win = createWindow(near ? near.getBounds() : null)
  const id = `win:${win.webContents.id}`
  const client: Client = {
    id,
    kind: 'window',
    send: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    },
    window: () => (win.isDestroyed() ? null : win),
    focus: () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
  host!.attach(client, root)
  windows.add(win)
  win.on('focus', () => (lastFocused = win))
  win.on('closed', () => {
    if (lastFocused === win) lastFocused = null
    windows.delete(win)
    host?.detach(id)
  })
  return win
}

/** The Prism window used last: Explorer has the focus when "Open with Prism" is chosen, so the focused one will not do. */
let lastFocused: BrowserWindow | null = null

/** Open a file or folder handed to Prism (main/handover.ts says where each goes). */
function openHanded(path: string): boolean {
  if (!host) return false
  const where = placeHanded(path, host.workbenches().map((b) => b.workspace?.root ?? '').filter(Boolean))
  if (!where) return false
  bootLog('handed', path, '->', where.root ?? '(no project)', where.file ?? '')
  const windowOf = (w: BrowserWindow | null | undefined): Client | undefined =>
    w && !w.isDestroyed() ? host!.clientById(`win:${w.webContents.id}`)?.client : undefined
  let there: Client | undefined
  if (where.root) {
    const bench = host.byRoot(where.root)
    there = bench ? host.clientsOf(bench).find((c) => c.kind === 'window') : undefined
  } else {
    there = windowOf(lastFocused) ?? windowOf([...windows].pop())
  }
  if (there) {
    if (where.file && !where.root) host.clientById(there.id)?.wb.allowOutside(where.file)
    there.focus()
    if (where.file) there.send(CH.WinHandedFile, where.file)
    return true
  }
  const win = openWindow(where.root)
  if (where.file) {
    if (!where.root) host.clientById(`win:${win.webContents.id}`)?.wb.allowOutside(where.file)
    host.handedFiles.set(win.webContents.id, where.file)
  }
  return true
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window.json')
}

function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as WindowState
    if (s.width > 400 && s.height > 300) return s
  } catch {
    /* first run */
  }
  return { width: 1560, height: 980, maximized: false }
}

function createWindow(beside: Electron.Rectangle | null): BrowserWindow {
  // another window opens a little down and to the right of the one in front
  const state = beside ? { x: beside.x + 32, y: beside.y + 32, width: beside.width, height: beside.height, maximized: false } : loadWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: /^#[0-9a-f]{6}$/i.test(host?.shared.settings.get().appearance.bg ?? '') ? host!.shared.settings.get().appearance.bg : '#07080c',
    title: 'Prism',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // the Browser panel shows pages in a <webview>
      webviewTag: true
    }
  })
  // a page in the Browser panel is a stranger: it gets no preload script and no access to Node
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    params.partition = 'persist:preview'
  })
  // The window stays hidden until the page has drawn once, so it never flashes empty. But a
  // hidden window may never get that first drawing: on Wayland it has no surface until it is
  // shown, and Chromium can hold the frame back for want of one, so both sides wait for ever
  // (an OS port saw that most starts). So it is shown anyway once the page has loaded, or
  // after a while whatever has happened.
  let shown = false
  const reveal = (why: string): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    bootLog(`window ${win.id}: shown (${why})`)
    if (state.maximized) win.maximize()
    win.show()
  }
  win.once('ready-to-show', () => reveal('first drawing'))
  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('page loaded but not drawn after 2 s'), 2000))
  setTimeout(() => reveal('nothing after 10 s'), 10_000)
  const wc = win.webContents
  bootLog(`window ${win.id}: created`)
  wc.on('did-start-loading', () => bootLog(`window ${win.id}: loading started`))
  wc.on('dom-ready', () => bootLog(`window ${win.id}: page parsed`))
  wc.on('did-finish-load', () => bootLog(`window ${win.id}: page loaded`))
  // A page process that dies (or never starts: "launch-failed") is replaced with a fresh load,
  // but not in a loop: three tries a minute at most.
  const restarts: number[] = []
  wc.on('render-process-gone', (_e, details) => {
    console.error('[prism] renderer gone', details)
    bootLog(`window ${win.id}: page process gone`, details)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    while (restarts.length && now - restarts[0]! > 60_000) restarts.shift()
    if (restarts.length >= 3) return
    restarts.push(now)
    setTimeout(() => {
      if (win.isDestroyed()) return
      bootLog(`window ${win.id}: loading the page again`)
      wc.reload()
    }, 500)
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools()
  })
  win.on('maximize', () => win.webContents.send('win:maximized-changed', true))
  win.on('unmaximize', () => win.webContents.send('win:maximized-changed', false))
  let saveTimer: NodeJS.Timeout | null = null
  const saveState = (): void => {
    if ([...windows][0] !== win) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        const b = win.getNormalBounds()
        writeFileSync(windowStateFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } satisfies WindowState))
      } catch {
        /* not important */
      }
    }, 300)
  }
  win.on('resize', saveState)
  win.on('move', saveState)
  win.on('maximize', saveState)
  win.on('unmaximize', saveState)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'file:')) e.preventDefault()
  })
  win.webContents.on('console-message', (ev) => {
    // the page's own start-up steps (renderer/src/lib/bootMark.ts)
    if (ev.message.startsWith('[boot] ')) return bootLog(`window ${win.id} page: ${ev.message.slice(7)}`)
    if (ev.level === 'error' || ev.level === 'warning' || process.env['PRISM_VERBOSE']) {
      console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[prism] load failed', code, desc, url)
    bootLog(`window ${win.id}: load failed`, code, desc)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/** "0.11.1" > "0.11.0" */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

// a second launch hands over its version and program path, so a newly installed Prism can replace an older one still open
const gotLock = app.requestSingleInstanceLock({ version: app.getVersion(), exe: process.execPath })
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, cwd, data) => {
    const other = (data ?? {}) as { version?: string; exe?: string }
    // "Open with Prism" on something while Prism is open: open it here and stop
    const handed = handedPath(argv, cwd, !!process.defaultApp)
    // (unless it is a newer Prism, which is offered the switch below)
    const isNewer = typeof other.version === 'string' && newer(other.version, app.getVersion())
    if (handed && !isNewer && openHanded(handed)) return
    const front = BrowserWindow.getFocusedWindow() ?? [...windows].pop() ?? null
    if (front) {
      if (front.isMinimized()) front.restore()
      front.focus()
    }
    const mainWindow = front
    if (typeof other.version !== 'string' || typeof other.exe !== 'string' || !newer(other.version, app.getVersion())) return
    const box: Electron.MessageBoxSyncOptions = {
      type: 'question',
      title: 'A newer Prism was opened',
      message: `Prism ${other.version} was opened while this older Prism ${app.getVersion()} is still running.`,
      detail: 'Only one Prism can run at a time. Switch to the newer one? Anything the agent is doing now is stopped; your sessions are kept.',
      buttons: ['Switch to the newer one', 'Keep this one'],
      defaultId: 0,
      cancelId: 1
    }
    const answer = mainWindow ? dialog.showMessageBoxSync(mainWindow, box) : dialog.showMessageBoxSync(box)
    if (answer !== 0) return
    app.relaunch({ execPath: other.exe, args: [] })
    app.quit()
  })

  app.on('child-process-gone', (_e, details) => bootLog('a helper process is gone', details))

  app.whenReady().then(() => {
    bootLog('Electron is ready')
    // Electron's default menu would steal Ctrl+W (close window) and Ctrl+R (reload); Prism has its own menu bar.
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-read' || permission === 'media'))

    bootLog('starting the services')
    host = new Host()
    bootLog('services started')
    protocol.handle('prism', (req) => {
      const u = new URL(req.url)
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
      try {
        let abs: string | null = null
        const project = u.hostname === 'workspace' || u.hostname.startsWith('wb-')
        const ws = project ? benchFor(u.hostname)?.workspace : null
        const services = host
        if (project && ws && placeOf(ws.root).kind === 'ssh') {
          // the file is on another computer: fetch it through the workspace
          return ws.readRaw(rel).then(
            (buf) => new Response(new Uint8Array(buf), { headers: { 'Content-Type': withCharset(mimeOf(rel)), 'Access-Control-Allow-Origin': '*' } }),
            () => new Response('not found', { status: 404 })
          )
        }
        const any = services?.workbenches()[0]
        if (u.hostname === 'hf' && services) return serveModelFile(services.shared.userData, rel, req)
        if (project) abs = ws?.abs(rel) ?? null
        else if (u.hostname.startsWith('out-')) abs = services?.byId(u.hostname.slice(4))?.outsideAsset(rel) ?? null
        else if (u.hostname === 'attach') abs = any?.attachmentPath(rel) ?? null
        else if (u.hostname === 'theme') abs = any?.themeFile(rel) ?? null
        if (!abs) return new Response('not found', { status: 404 })
        return net.fetch(pathToFileURL(abs).toString(), { headers: req.headers }).then((r) => {
          // every header is kept (ranges matter for seeking in sound and video); one is added
          const headers = new Headers(r.headers)
          headers.set('Access-Control-Allow-Origin', '*')
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers })
        })
      } catch {
        return new Response('forbidden', { status: 403 })
      }
    })

    protocol.handle('prism-gadget', (req) => {
      const u = new URL(req.url)
      const id = u.hostname
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
      const cors = { 'Access-Control-Allow-Origin': '*' }
      if (id === '_sdk') {
        if (rel === 'prism.js') return new Response(GADGET_SDK_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...cors } })
        if (rel === 'base.css') return new Response(GADGET_BASE_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8', ...cors } })
        if (rel === 'kit.css') return new Response(GADGET_KIT_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8', ...cors } })
        if (rel === 'kit.js') return new Response(GADGET_KIT_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...cors } })
        return new Response('not found', { status: 404 })
      }
      // a gadget belongs to one project, or to the user (then every project has it)
      const abs = host?.workbenches().map((b) => b.gadgets.resolveFile(id, rel)).find((p) => !!p) ?? null
      if (!abs) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(abs).toString()).then(
        (r) => new Response(r.body, { status: r.status, headers: { 'Content-Type': withCharset(r.headers.get('content-type') ?? 'application/octet-stream'), ...cors } })
      )
    })

    try {
      const dispatch = registerIpc(host)
      host.dispatch = dispatch
      bootLog('requests registered')
    } catch (err) {
      console.error('[prism] IPC registration failed:', err)
    }
    host.newWindow = (root) => void openWindow(root)
    floats = host.floats = new Floats({
      userData: app.getPath('userData'),
      preload: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'] ?? null,
      indexFile: join(__dirname, '../renderer/index.html'),
      background: () => (/^#[0-9a-f]{6}$/i.test(host?.shared.settings.get().appearance.bg ?? '') ? host!.shared.settings.get().appearance.bg : '#07080c'),
      attach: (win, id, root) =>
        void host!.attach(
          {
            id,
            kind: 'window',
            send: (channel, payload) => {
              if (!win.isDestroyed()) win.webContents.send(channel, payload)
            },
            window: () => (win.isDestroyed() ? null : win),
            focus: () => {
              if (win.isDestroyed()) return
              if (win.isMinimized()) win.restore()
              win.show()
              win.focus()
            }
          },
          root
        ),
      detach: (id) => host?.detach(id),
      mainOpen: () => windows.size > 0,
      showMain: () => {
        const open = [...windows][0]
        if (open && !open.isDestroyed()) {
          if (open.isMinimized()) open.restore()
          open.show()
          open.focus()
          return
        }
        const last = host?.shared.settings.get().recentWorkspaces[0] ?? null
        openWindow(last && existsSync(last) ? last : null)
      }
    })
    const last = host.shared.settings.get().recentWorkspaces[0]
    // an SSH folder is opened without asking the other computer first; if it cannot be reached, the first use says so
    const handed = handedPath(process.argv, process.cwd(), !!process.defaultApp)
    if (handed && openHanded(handed)) return
    bootLog('opening the first window', last ?? '(no project)')
    openWindow(last && (placeOf(last).kind === 'ssh' || existsSync(last)) ? last : null)
  })

  app.on('before-quit', () => {
    host?.dispose()
    disposeSpeech()
    disposeKokoro()
  })
  // tabs out on the desktop outlive the window they came from: Prism waits in the
  // notification area instead of quitting (see main/float.ts)
  app.on('window-all-closed', () => {
    if (floats?.keys().length) floats.updateTray()
    else app.quit()
  })
}
