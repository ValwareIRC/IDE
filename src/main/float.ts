// Tabs taken out of Prism and put on the desktop. A floating tab is a window of its
// own with no frame, kept above other windows and out of the taskbar, so what is in
// it — a gadget, a terminal, a diff — sits on the desktop and stays visible while
// you work in something else. Size, place, pinning and opacity are remembered per
// tab, and closing Prism's own window leaves them be: Prism waits in the
// notification area instead of quitting.
import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FloatSpec {
  /** Which panel: the same kinds the dock knows. */
  kind: string
  /** Identifies this exact tab, so its place on screen comes back: `gadget:system-pulse`. */
  key: string
  title: string
  params: Record<string, unknown>
}

interface Placed {
  x?: number
  y?: number
  width: number
  height: number
  /** Kept above other windows. */
  pinned: boolean
  /** 0.3 to 1. */
  opacity: number
}

export interface FloatDeps {
  userData: string
  preload: string
  /** Set while the dev server is running; the packaged app loads a file instead. */
  rendererUrl: string | null
  indexFile: string
  background(): string
  /** Gives the window a client id on the host, so every panel works as it does in a window. */
  attach(win: BrowserWindow, id: string, root: string | null): void
  detach(id: string): void
  /** Bring a real Prism window back, from the notification area. */
  showMain(): void
  /** True while a full Prism window is open. */
  mainOpen(): boolean
}

const MIN_W = 180
const MIN_H = 120
/** The strip at the top, in pixels; it must match .floater-bar.show in float.css. */
const BAR = 26

export class Floats {
  private wins = new Map<string, BrowserWindow>()
  private tray: Tray | null = null
  private saveTimers = new Map<string, NodeJS.Timeout>()
  private dragging: { timer: NodeJS.Timeout } | null = null
  /** How much taller a window is right now because its strip is showing, by key. */
  private grown = new Map<string, number>()

  constructor(private deps: FloatDeps) {}

  private file(): string {
    return join(this.deps.userData, 'floats.json')
  }

  private placed(): Record<string, Placed> {
    try {
      return JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, Placed>
    } catch {
      return {}
    }
  }

  private remember(key: string, p: Placed): void {
    const all = this.placed()
    all[key] = p
    try {
      writeFileSync(this.file(), JSON.stringify(all, null, 2))
    } catch {
      /* losing a window's place is not worth an error */
    }
  }

  /** The window for this tab, brought to the front if it is already out on the desktop. */
  open(spec: FloatSpec, root: string | null): void {
    const existing = this.wins.get(spec.key)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }
    const saved = this.placed()[spec.key]
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.max(MIN_W, saved?.width ?? 420)
    const height = Math.max(MIN_H, saved?.height ?? 320)
    const onScreen = saved?.x !== undefined && saved?.y !== undefined && screen.getAllDisplays().some((d) => saved.x! < d.bounds.x + d.bounds.width - 40 && saved.y! < d.bounds.y + d.bounds.height - 40 && saved.x! + width > d.bounds.x + 40 && saved.y! + height > d.bounds.y + 40)
    const pinned = saved?.pinned ?? true
    const win = new BrowserWindow({
      width,
      height,
      ...(onScreen ? { x: saved.x, y: saved.y } : { x: area.x + area.width - width - 40, y: area.y + 40 }),
      minWidth: MIN_W,
      minHeight: MIN_H,
      show: false,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: pinned,
      backgroundColor: this.deps.background(),
      title: spec.title,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        webviewTag: true
      }
    })
    if (pinned) win.setAlwaysOnTop(true, 'floating')
    win.setOpacity(saved?.opacity ?? 1)

    // a page in the Browser panel is a stranger here too
    win.webContents.on('will-attach-webview', (_e, prefs, params) => {
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      params.partition = 'persist:preview'
    })
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools()
    })
    // shown at its first drawing, or anyway once loaded: a hidden window on Wayland may never
    // get that drawing (see createWindow in main/index.ts)
    let shown = false
    const reveal = (): void => {
      if (shown || win.isDestroyed()) return
      shown = true
      win.show()
    }
    win.once('ready-to-show', reveal)
    win.webContents.once('did-finish-load', () => setTimeout(reveal, 2000))
    setTimeout(reveal, 10_000)

    // every request from a window is attributed to `win:<id>` (main/ipc.ts), so a
    // floating tab must be known by that name too or nothing it asks for is answered
    const id = `win:${win.webContents.id}`
    this.wins.set(spec.key, win)
    this.deps.attach(win, id, root)

    const save = (): void => {
      const old = this.saveTimers.get(spec.key)
      if (old) clearTimeout(old)
      this.saveTimers.set(
        spec.key,
        setTimeout(() => {
          if (win.isDestroyed()) return
          const b = win.getNormalBounds()
          const extra = this.grown.get(spec.key) ?? 0
          this.remember(spec.key, { x: b.x, y: b.y + extra, width: b.width, height: b.height - (extra ? BAR : 0), pinned: win.isAlwaysOnTop(), opacity: win.getOpacity() })
        }, 300)
      )
    }
    win.on('resize', save)
    win.on('move', save)
    win.on('closed', () => {
      this.stopDragging()
      this.grown.delete(spec.key)
      this.wins.delete(spec.key)
      this.deps.detach(id)
      this.updateTray()
    })

    const search = `?float=${encodeURIComponent(JSON.stringify(spec))}`
    if (this.deps.rendererUrl) void win.loadURL(this.deps.rendererUrl + search)
    else void win.loadFile(this.deps.indexFile, { search })
    this.updateTray()
  }

  private byContents(webContentsId: number): { key: string; win: BrowserWindow } | null {
    for (const [key, win] of this.wins) if (!win.isDestroyed() && win.webContents.id === webContentsId) return { key, win }
    return null
  }

  pin(webContentsId: number, on: boolean): void {
    const f = this.byContents(webContentsId)
    if (!f) return
    f.win.setAlwaysOnTop(on, 'floating')
    const p = this.placed()[f.key]
    const b = f.win.getNormalBounds()
    this.remember(f.key, { x: b.x, y: b.y, width: b.width, height: b.height, pinned: on, opacity: p?.opacity ?? f.win.getOpacity() })
  }

  opacity(webContentsId: number, value: number): void {
    const f = this.byContents(webContentsId)
    if (!f) return
    const v = Math.min(1, Math.max(0.3, value))
    f.win.setOpacity(v)
    const b = f.win.getNormalBounds()
    this.remember(f.key, { x: b.x, y: b.y, width: b.width, height: b.height, pinned: f.win.isAlwaysOnTop(), opacity: v })
  }

  close(webContentsId: number): void {
    this.byContents(webContentsId)?.win.close()
  }

  /**
   * The strip appearing and going again. It is given room of its own above the window
   * rather than taking it from what is inside: the window grows upwards by exactly the
   * strip's height, so the gadget keeps every pixel it had and nothing of it is covered.
   */
  bar(webContentsId: number, on: boolean): void {
    const f = this.byContents(webContentsId)
    if (!f) return
    const had = this.grown.get(f.key) ?? 0
    if (on === had > 0) return
    const b = f.win.getBounds()
    if (on) {
      // hard against the top of the screen there is nowhere to grow into, so it takes
      // what room there is and the rest comes off the bottom
      const top = screen.getDisplayMatching(b).workArea.y
      const up = Math.max(0, Math.min(BAR, b.y - top))
      this.grown.set(f.key, up)
      f.win.setBounds({ x: b.x, y: b.y - up, width: b.width, height: b.height + BAR })
    } else {
      this.grown.set(f.key, 0)
      f.win.setBounds({ x: b.x, y: b.y + had, width: b.width, height: Math.max(MIN_H, b.height - BAR) })
    }
  }

  /**
   * Dragging the strip at the top. Electron can do this itself with a drag region, but
   * an element that is one receives no mouse events at all — so the strip would vanish
   * the moment the pointer reached it, and flicker as the pointer fell back onto what
   * was underneath. The window follows the pointer here instead.
   */
  drag(webContentsId: number, on: boolean): void {
    this.stopDragging()
    if (!on) return
    const f = this.byContents(webContentsId)
    if (!f) return
    const held = screen.getCursorScreenPoint()
    const at = f.win.getBounds()
    const dx = held.x - at.x
    const dy = held.y - at.y
    const since = Date.now()
    const timer = setInterval(() => {
      // a mouse let go outside the window may never be reported: never drag for ever
      if (f.win.isDestroyed() || Date.now() - since > 60_000) {
        this.stopDragging()
        return
      }
      const now = screen.getCursorScreenPoint()
      const b = f.win.getBounds()
      f.win.setBounds({ x: now.x - dx, y: now.y - dy, width: b.width, height: b.height })
    }, 16)
    this.dragging = { timer }
  }

  private stopDragging(): void {
    if (!this.dragging) return
    clearInterval(this.dragging.timer)
    this.dragging = null
  }

  /** What is out on the desktop, for the tray menu and for the dock to show which tabs are popped out. */
  keys(): string[] {
    return [...this.wins.keys()]
  }

  closeAll(): void {
    this.stopDragging()
    for (const win of [...this.wins.values()]) if (!win.isDestroyed()) win.close()
  }

  /**
   * With floating tabs out and no Prism window, the only way back is the notification
   * area — so the icon appears exactly then, and goes when it is not needed.
   */
  updateTray(): void {
    const need = this.wins.size > 0 && !this.deps.mainOpen()
    if (!need) {
      this.tray?.destroy()
      this.tray = null
      return
    }
    if (!this.tray) {
      const icon = trayIcon()
      if (icon.isEmpty()) return
      this.tray = new Tray(icon)
      this.tray.setToolTip('Prism')
      this.tray.on('click', () => this.deps.showMain())
    }
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Prism', click: () => this.deps.showMain() },
        { type: 'separator' },
        ...[...this.wins.entries()].map(([key, win]) => ({
          label: `Show ${win.isDestroyed() ? key : win.getTitle()}`,
          click: () => {
            if (!win.isDestroyed()) {
              win.show()
              win.focus()
            }
          }
        })),
        { type: 'separator' },
        { label: 'Close floating tabs', click: () => this.closeAll() },
        { label: 'Quit Prism', click: () => app.quit() }
      ])
    )
  }
}

/** The app's own icon, which the installed copy keeps beside its program. */
function trayIcon(): Electron.NativeImage {
  const places = [join(process.resourcesPath, 'icon.png'), join(app.getAppPath(), 'build', 'icon.png'), join(app.getAppPath(), '..', 'build', 'icon.png'), join(process.cwd(), 'build', 'icon.png')]
  for (const p of places) {
    if (!existsSync(p)) continue
    const im = nativeImage.createFromPath(p)
    if (!im.isEmpty()) return im.resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}
